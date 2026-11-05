import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { connect as tlsConnect } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BOT_IP,
  SUBNET,
  DNS_SERVER,
  HOSTNAME,
  SET_HOST,
  SET_NS,
  CHAIN_HOST,
  CHAIN_NS4,
  CHAIN_NS6,
  MAX_LEASE_MS,
  composeOverride,
  denyRules,
  firewallRules,
  policyHash,
  publicAddresses,
  validatePolicy,
} from './policy.mjs';

const ROOT = '/etc/jarvis-egress';
const RUN = '/run/jarvis-egress';
const PUBLIC = `${RUN}/public`;
const PERMIT = `${PUBLIC}/permit.json`;
const OVERRIDE = `${RUN}/compose.json`;
const binaries = {
  iptables: '/usr/sbin/iptables',
  restore: '/usr/sbin/iptables-restore',
  save: '/usr/sbin/iptables-save',
  ip6tables: '/usr/sbin/ip6tables',
  restore6: '/usr/sbin/ip6tables-restore',
  save6: '/usr/sbin/ip6tables-save',
  ipset: '/usr/sbin/ipset',
  nsenter: '/usr/bin/nsenter',
  docker: '/usr/bin/docker',
  systemctl: '/usr/bin/systemctl',
  ufw: '/usr/sbin/ufw',
};
const environment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' };
const fail = () =>
  new Error(
    'Egress operation failed; keep Jarvis stopped and the subnet denied.',
  );
let config;
let controllerStopped = false;
const command = process.argv[2];

function run(program, args = [], options = {}) {
  const binary = binaries[program];
  if (!binary) throw fail();
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: environment,
    ...options,
  });
  if (result.status !== 0 || result.error) {
    if (options.optional) return undefined;
    throw fail();
  }
  return result.stdout.trim();
}
function ip(args) {
  return run('iptables', ['-w', '5', ...args]);
}
function ns(pid, program, args = [], input) {
  return run(
    'nsenter',
    ['-t', String(pid), '-n', '--', binaries[program], ...args],
    input === undefined ? {} : { input },
  );
}
function docker(args, options = {}) {
  return run(
    'docker',
    ['--host', 'unix:///var/run/docker.sock', ...args],
    options,
  );
}

function privateDirectory(path, mode = 0o700) {
  if (!isAbsolute(path) || path.includes('\0') || realpathSync(path) !== path)
    throw fail();
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== 0 ||
    (s.mode & 0o777) !== mode
  )
    throw fail();
}
function readPrivate(path, max = 65536) {
  privateDirectory(dirname(path));
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.uid !== 0 ||
    s.mode & 0o077 ||
    s.size > max
  )
    throw fail();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function atomic(path, value, mode = 0o600) {
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      /* leave no raw diagnostics */
    }
    throw fail();
  }
}
function runtime() {
  if (!existsSync(RUN)) mkdirSync(RUN, { mode: 0o700 });
  privateDirectory(RUN);
  if (!existsSync(PUBLIC)) {
    mkdirSync(PUBLIC, { mode: 0o755 });
    chmodSync(PUBLIC, 0o755);
  }
  privateDirectory(PUBLIC, 0o755);
}
function loadConfig() {
  const c = readPrivate(`${ROOT}/config.json`);
  if (
    !c ||
    Object.keys(c).sort().join(',') !==
      'image,privateDirectory,project,releaseDirectory,version' ||
    c.version !== 1 ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(c.project) ||
    !/^sha256:[a-f0-9]{64}$/.test(c.image)
  )
    throw fail();
  for (const path of [c.releaseDirectory, c.privateDirectory]) {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      !/^[A-Za-z0-9/_.-]+$/.test(path) ||
      realpathSync(path) !== path
    )
      throw fail();
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022)
      throw fail();
  }
  for (const name of ['gate.mjs', 'policy.mjs', 'host.mjs']) {
    const p = `${c.releaseDirectory}/deploy/egress/${name}`,
      s = lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022)
      throw fail();
  }
  config = c;
  return c;
}
function compose(args, optional = false) {
  return docker(
    [
      'compose',
      '-p',
      config.project,
      '-f',
      `${config.releaseDirectory}/deploy/compose.pilot.yaml`,
      '-f',
      OVERRIDE,
      ...args,
    ],
    {
      optional,
      env: {
        ...environment,
        JARVIS_PILOT_IMAGE: config.image,
        JARVIS_PILOT_PRIVATE_DIR: config.privateDirectory,
      },
    },
  );
}
function uniqueFirst(chain, args) {
  const line = `-A ${chain} ${args.join(' ')}`;
  let rows = ip(['-S', chain])
    .split('\n')
    .filter((s) => s.startsWith('-A '));
  if (rows[0] !== line) ip(['-I', chain, '1', ...args]);
  rows = ip(['-S', chain])
    .split('\n')
    .filter((s) => s.startsWith('-A '));
  for (let index = rows.length - 1; index > 0; index--)
    if (rows[index] === line) ip(['-D', chain, String(index + 1)]);
}

/** Denial requires no Docker daemon, config, policy, DNS or ipset availability. */
function deny() {
  // A source-scoped emergency rule comes FIRST before any private-chain edit.
  const safety = [
    '-s',
    SUBNET,
    '-m',
    'comment',
    '--comment',
    'jarvis-1g-safety',
    '-j',
    'DROP',
  ];
  run('iptables', ['-w', '5', '-N', 'DOCKER-USER'], { optional: true });
  uniqueFirst('DOCKER-USER', safety);
  run('ipset', ['flush', SET_HOST], { optional: true });
  run('restore', ['--noflush', '--wait', '5'], { input: denyRules() });
  const inputRule = [
    '-s',
    SUBNET,
    '-m',
    'comment',
    '--comment',
    'jarvis-1g-host-deny',
    '-j',
    'DROP',
  ];
  uniqueFirst('INPUT', inputRule);
  runtime();
  try {
    unlinkSync(PERMIT);
  } catch (e) {
    if (e.code !== 'ENOENT') throw fail();
  }
  atomic(`${RUN}/revocation.json`, { id: randomBytes(32).toString('hex') });
}
function ttl(policy) {
  const seconds = Math.floor((policy.expiresAt - Date.now()) / 1000);
  if (seconds < 1 || seconds > MAX_LEASE_MS / 1000) throw fail();
  return String(seconds);
}
function timedSet(programRun, name, addresses, seconds) {
  programRun('ipset', [
    'create',
    name,
    'hash:ip',
    'family',
    'inet',
    'maxelem',
    '16',
    'timeout',
    '1',
    '-exist',
  ]);
  programRun('ipset', ['flush', name]);
  for (const address of addresses)
    programRun('ipset', ['add', name, address, 'timeout', seconds()]);
}
function hook(table, chain, target, pid) {
  const call = (args) =>
    pid ? ns(pid, 'iptables', ['-w', '5', ...args]) : ip(args);
  const rules = call(['-t', table, '-S', chain])
    .split('\n')
    .filter((s) => s.startsWith('-A '));
  if (rules[0] !== `-A ${chain} -j ${target}`)
    call(['-t', table, '-I', chain, '1', '-j', target]);
}
function proofIdentity(id) {
  const v = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]));
  if (!v.Running || !Number.isSafeInteger(v.Pid) || v.Pid <= 1) throw fail();
  const inode = statSync(`/proc/${v.Pid}/ns/net`).ino;
  const stat = readFileSync(`/proc/${v.Pid}/stat`, 'utf8');
  return {
    pid: v.Pid,
    inode,
    start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
  };
}
function assertIdentity(id, identity) {
  if (JSON.stringify(proofIdentity(id)) !== JSON.stringify(identity))
    throw fail();
}
function assertPrivateRules(save, table, chain, expected) {
  const section = save.split(`*${table}\n`)[1]?.split('COMMIT')[0];
  if (!section) throw fail();
  const lines = section
    .split('\n')
    .filter((line) => line.startsWith(`-A ${chain} `));
  const planned = expected
    .split('\n')
    .filter((line) => line.startsWith(`-A ${chain} `));
  // iptables-save normalizes /32 and explicit -m tcp. Compare normalized tokens.
  const norm = (s) => s.replace(/\/32\b/g, '').replace(/ -m tcp\b/g, '');
  if (lines.map(norm).join('\n') !== planned.map(norm).join('\n')) throw fail();
}
function assertRules(policy, id, identity) {
  validatePolicy(policy);
  assertIdentity(id, identity);
  const rules = firewallRules(policy.addresses);
  const first = ip(['-S', 'DOCKER-USER'])
    .split('\n')
    .find((s) => s.startsWith('-A '));
  if (first !== `-A DOCKER-USER -s ${SUBNET} -j ${CHAIN_HOST}`) throw fail();
  const inputFirst = ip(['-S', 'INPUT'])
    .split('\n')
    .find((s) => s.startsWith('-A '));
  if (
    inputFirst !==
    `-A INPUT -s ${SUBNET} -m comment --comment jarvis-1g-host-deny -j DROP`
  )
    throw fail();
  assertPrivateRules(run('save'), 'filter', CHAIN_HOST, rules.host);
  assertPrivateRules(
    ns(identity.pid, 'save'),
    'raw',
    CHAIN_NS4,
    rules.namespace4,
  );
  assertPrivateRules(
    ns(identity.pid, 'save6'),
    'raw',
    CHAIN_NS6,
    rules.namespace6,
  );
  for (const [p, name] of [
    [undefined, SET_HOST],
    [identity.pid, SET_NS],
  ]) {
    const saved = p
      ? ns(p, 'ipset', ['save', name])
      : run('ipset', ['save', name]);
    const rows = saved.split('\n').filter((line) => line.startsWith('add '));
    if (rows.length !== policy.addresses.length) throw fail();
    const found = [];
    for (const row of rows) {
      const match = new RegExp(`^add ${name} ([0-9.]+) timeout ([0-9]+)$`).exec(
        row,
      );
      if (
        !match ||
        !policy.addresses.includes(match[1]) ||
        Number(match[2]) < 1 ||
        Number(match[2]) > Math.ceil((policy.expiresAt - Date.now()) / 1000)
      )
        throw fail();
      found.push(match[1]);
    }
    if (found.sort().join(',') !== [...policy.addresses].sort().join(','))
      throw fail();
    for (const address of policy.addresses) {
      if (p) ns(p, 'ipset', ['test', name, address]);
      else run('ipset', ['test', name, address]);
    }
  }
  for (const [tool, chain] of [
    ['iptables', CHAIN_NS4],
    ['ip6tables', CHAIN_NS6],
  ]) {
    const output = ns(identity.pid, tool, ['-t', 'raw', '-S', 'OUTPUT'])
      .split('\n')
      .find((s) => s.startsWith('-A '));
    if (output !== `-A OUTPUT -j ${chain}`) throw fail();
  }
}
function platform() {
  if (
    !readFileSync('/etc/os-release', 'utf8').includes('VERSION_ID="24.04"') ||
    !run('iptables', ['--version']).includes('nf_tables')
  )
    throw fail();
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  if (
    info.ServerVersion !== '29.9.3' ||
    info.FirewallBackend?.Driver !== 'iptables' ||
    info.LiveRestoreEnabled !== false ||
    docker(['compose', 'version', '--short']).replace(/^v/, '') !== '5.7.0' ||
    !run('ufw', ['status']).startsWith('Status: active')
  )
    throw fail();
  const forward = ip(['-S', 'FORWARD'])
    .split('\n')
    .filter((line) => line.startsWith('-A '));
  if (forward[0] !== '-A FORWARD -j DOCKER-USER') throw fail();
  run('systemctl', ['is-active', '--quiet', 'jarvis-egress-deny.service']);
  if (
    docker(['image', 'inspect', '--format', '{{.Id}}', config.image]) !==
    config.image
  )
    throw fail();
}
async function tlsVerified(address) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: address,
        port: 443,
        servername: HOSTNAME,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      () => {
        if (!socket.authorized) {
          socket.destroy();
          reject(fail());
          return;
        }
        socket.destroy();
        resolve();
      },
    );
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(fail());
    });
    socket.once('error', () => reject(fail()));
  });
}
async function dnsVerified() {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers([DNS_SERVER]);
  const records = await resolver.resolve4(HOSTNAME, { ttl: true });
  const receivedAt = Date.now();
  const addresses = publicAddresses(records.map((v) => v.address));
  if (records.some((v) => !Number.isSafeInteger(v.ttl) || v.ttl < 30))
    throw fail();
  for (const address of addresses) await tlsVerified(address);
  const expiresAt =
    receivedAt + Math.min(900, ...records.map((v) => v.ttl)) * 1000;
  if (expiresAt <= Date.now()) throw fail();
  return { addresses, expiresAt, receivedAt };
}
async function candidate() {
  deny();
  loadConfig();
  try {
    unlinkSync(`${ROOT}/approved.json`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail();
  }
  const result = await dnsVerified();
  const now = Date.now();
  const p = validatePolicy({
    version: 1,
    hostname: HOSTNAME,
    resolver: DNS_SERVER,
    addresses: result.addresses,
    createdAt: Math.min(now, result.receivedAt),
    expiresAt: result.expiresAt,
  });
  atomic(`${ROOT}/candidate.json`, p);
  process.stdout.write(
    `${JSON.stringify({ candidate: p, sha256: policyHash(p), traffic: 'denied', operatorReviewRequired: true })}\n`,
  );
}
async function approve() {
  deny();
  loadConfig();
  try {
    unlinkSync(`${ROOT}/approved.json`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail();
  }
  if (
    process.argv.length !== 5 ||
    process.argv[3] !== '--sha256' ||
    !/^[a-f0-9]{64}$/.test(process.argv[4])
  )
    throw fail();
  const p = validatePolicy(readPrivate(`${ROOT}/candidate.json`));
  if (policyHash(p) !== process.argv[4]) throw fail();
  const fresh = await dnsVerified();
  if (
    JSON.stringify(fresh.addresses) !== JSON.stringify(p.addresses) ||
    p.expiresAt > fresh.expiresAt
  )
    throw fail();
  validatePolicy(p);
  atomic(`${ROOT}/approved.json`, p);
  process.stdout.write(
    'Policy reviewed; traffic is still denied. Start remains a separate manual action.\n',
  );
}
async function connectivity(id, policy) {
  const identity = proofIdentity(id);
  const dropped = () => {
    const dump = ns(identity.pid, 'save', ['-c']);
    const match = new RegExp(
      `^\\[([0-9]+):[0-9]+\\] -A ${CHAIN_NS4} -j DROP$`,
      'm',
    ).exec(dump);
    if (!match) throw fail();
    return Number(match[1]);
  };
  const before = dropped();
  // No HTTP, credentials or response bodies. Positive TLS handshake and negative sockets only.
  const source = `
import assert from 'node:assert/strict'; import {lookup} from 'node:dns/promises'; import {connect} from 'node:net'; import {connect as tls} from 'node:tls'; import {createSocket} from 'node:dgram';
const expected=${JSON.stringify([policy.addresses[0]])};
const found=(await lookup('api.telegram.org',{all:true,family:4})).map(v=>v.address).sort();assert.deepEqual([...new Set(found)].sort(),expected);
await new Promise((ok,no)=>{const s=tls({host:'api.telegram.org',port:443,servername:'api.telegram.org',rejectUnauthorized:true,minVersion:'TLSv1.2'},()=>{s.destroy();ok()});s.setTimeout(4000,()=>{s.destroy();no(Error())});s.once('error',no)});
for(const [host,port]of [['1.1.1.1',443],['169.254.169.254',443],['172.26.0.2',53],['127.0.0.11',53],['::1',443]]){
 await new Promise((ok,no)=>{const s=connect({host,port});s.setTimeout(400,()=>{s.destroy();ok()});s.once('error',()=>{s.destroy();ok()});s.once('connect',()=>{s.destroy();no(Error())})});
}
for(const host of ['127.0.0.11','172.26.0.2'])await new Promise((ok,no)=>{const s=createSocket('udp4');let answered=false;s.on('message',()=>{answered=true});s.on('error',()=>{});s.send(Buffer.from('000001000001000000000000046e6f6e6507696e76616c69640000010001','hex'),53,host);setTimeout(()=>{s.close();answered?no(Error()):ok()},400)});
process.stdout.write('verified');`;
  if (
    docker(['exec', id, 'node', '--input-type=module', '--eval', source]) !==
    'verified'
  )
    throw fail();
  assertIdentity(id, identity);
  if (dropped() - before < 4) throw fail();
}
async function start() {
  deny();
  loadConfig();
  platform();
  const policy = validatePolicy(readPrivate(`${ROOT}/approved.json`));
  const revision = readPrivate(`${RUN}/revocation.json`).id;
  const mono = performance.now();
  const wall = Date.now();
  const duration = policy.expiresAt - wall;
  atomic(OVERRIDE, composeOverride(policy, config.releaseDirectory, PUBLIC));
  const spec = JSON.parse(compose(['config', '--format', 'json']));
  const s = spec.services.jarvis;
  if (
    s.restart !== 'no' ||
    s.dns?.join(',') !== '127.0.0.1' ||
    s.network_mode ||
    s.ports?.length ||
    s.privileged ||
    s.cap_add?.length ||
    s.user !== '1000:1000' ||
    !s.read_only ||
    s.image !== config.image ||
    !s.cap_drop?.includes('ALL') ||
    s.environment.JARVIS_TELEGRAM_AGENTS_ENABLED !== 'false' ||
    s.environment.JARVIS_AI_MODE !== 'disabled'
  )
    throw fail();
  const previous = compose(['ps', '-q', 'jarvis']);
  if (previous) throw fail();
  let id;
  try {
    compose(['up', '-d', '--no-build', '--force-recreate', 'jarvis']);
    id = compose(['ps', '-q', 'jarvis']);
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw fail();
    const networks = JSON.parse(
      docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', id]),
    );
    if (
      Object.values(networks).length !== 1 ||
      Object.values(networks)[0].IPAddress !== BOT_IP ||
      Object.values(networks)[0].GlobalIPv6Address
    )
      throw fail();
    const identity = proofIdentity(id);
    let challenge;
    for (let n = 0; n < 50; n++) {
      challenge = docker(
        [
          'exec',
          id,
          'node',
          '-e',
          "process.stdout.write(require('node:fs').readFileSync('/tmp/jarvis-egress-challenge','utf8'))",
        ],
        { optional: true },
      );
      if (challenge) break;
      await delay(100);
    }
    if (!/^[a-f0-9]{64}$/.test(challenge)) throw fail();
    timedSet(
      (program, args) => ns(identity.pid, program, args),
      SET_NS,
      policy.addresses,
      () => ttl(policy),
    );
    const rules = firewallRules(policy.addresses);
    ns(identity.pid, 'restore', ['--noflush', '--wait', '5'], rules.namespace4);
    hook('raw', 'OUTPUT', CHAIN_NS4, identity.pid);
    ns(
      identity.pid,
      'restore6',
      ['--noflush', '--wait', '5'],
      rules.namespace6,
    );
    const first6 = ns(identity.pid, 'ip6tables', ['-t', 'raw', '-S', 'OUTPUT'])
      .split('\n')
      .find((v) => v.startsWith('-A '));
    if (first6 !== `-A OUTPUT -j ${CHAIN_NS6}`)
      ns(identity.pid, 'ip6tables', [
        '-t',
        'raw',
        '-I',
        'OUTPUT',
        '1',
        '-j',
        CHAIN_NS6,
      ]);
    timedSet(
      (program, args) => run(program, args),
      SET_HOST,
      policy.addresses,
      () => ttl(policy),
    );
    if (readPrivate(`${RUN}/revocation.json`).id !== revision) throw fail();
    run('restore', ['--noflush', '--wait', '5'], { input: rules.host });
    uniqueFirst('DOCKER-USER', ['-s', SUBNET, '-j', CHAIN_HOST]);
    assertRules(policy, id, identity);
    await connectivity(id, policy);
    assertRules(policy, id, identity);
    if (readPrivate(`${RUN}/revocation.json`).id !== revision) throw fail();
    atomic(
      PERMIT,
      {
        challenge,
        policyHash: policyHash(policy),
        issuedAt: Date.now(),
        expiresAt: policy.expiresAt,
      },
      0o444,
    );
    atomic(`${RUN}/active.json`, { id, identity, policy, challenge });
    process.stdout.write(
      'Egress verified; manual Jarvis session released until the reviewed lease expires.\n',
    );
    while (!controllerStopped) {
      await delay(1000);
      if (
        performance.now() - mono >= duration ||
        Date.now() < wall ||
        readPrivate(`${RUN}/revocation.json`).id !== revision
      )
        throw fail();
      assertRules(policy, id, identity);
    }
  } finally {
    deny();
    if (id) docker(['stop', '--time', '10', id], { optional: true });
  }
}
async function verify() {
  loadConfig();
  platform();
  const active = readPrivate(`${RUN}/active.json`);
  const p = validatePolicy(readPrivate(`${ROOT}/approved.json`));
  if (policyHash(active.policy) !== policyHash(p)) throw fail();
  assertRules(p, active.id, active.identity);
  await connectivity(active.id, p);
  assertRules(p, active.id, active.identity);
  process.stdout.write(
    'Egress rules, namespace, DNS restriction and token-free connectivity verified.\n',
  );
}
process.once('SIGTERM', () => {
  controllerStopped = true;
});
process.once('SIGINT', () => {
  controllerStopped = true;
});
try {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== 0 ||
    !['deny', 'candidate', 'approve', 'verify', 'start', 'stop'].includes(
      command,
    )
  )
    throw fail();
  if (
    command !== 'deny' &&
    [
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'OPENSSL_CONF',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ].some((key) => process.env[key] !== undefined)
  )
    throw fail();
  if (command !== 'approve' && process.argv.length !== 3) throw fail();
  if (command === 'deny') {
    deny();
    process.stdout.write('Pilot subnet denied; grants revoked.\n');
  } else if (command === 'candidate') await candidate();
  else if (command === 'approve') await approve();
  else if (command === 'start') await start();
  else if (command === 'verify') await verify();
  else {
    deny();
    loadConfig();
    if (existsSync(OVERRIDE))
      compose(['stop', '--timeout', '10', 'jarvis'], true);
    process.stdout.write('Pilot stopped and denied.\n');
  }
} catch {
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    try {
      deny();
    } catch {
      /* Preserve existing legacy DROP; never fall back to unrestricted traffic. */
    }
  }
  process.stderr.write(`${fail().message}\n`);
  process.exitCode = 1;
}
