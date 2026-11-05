// Linux kernel regression only. Invoked inside the isolated privileged lab,
// never on the Docker host. The command ports execute real iptables/ipset.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuleManager, ruleTokens, sameRule } from './iptables.mjs';
import {
  CHAIN_HOST,
  CHAIN_NS4,
  CHAIN_NS6,
  DNS_SERVER,
  HOSTNAME,
  SET_HOST,
  SET_NS,
  SUBNET,
  firewallRules,
} from './policy.mjs';

const ROUTER = 'reg-router';
const BOT = 'reg-bot';
const ADDRESS = '149.154.166.110';
const results = [];
const binaries = {
  iptables: '/usr/sbin/iptables',
  ip6tables: '/usr/sbin/ip6tables',
  save: '/usr/sbin/iptables-save',
  save6: '/usr/sbin/ip6tables-save',
  restore: '/usr/sbin/iptables-restore',
  restore6: '/usr/sbin/ip6tables-restore',
  ipset: '/usr/sbin/ipset',
};

function execute(binary, args, input, timeout = 10_000) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout,
    input,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  });
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    0,
    `Kernel fixture command failed: ${binary} ${args.join(' ')} ${result.stderr}`,
  );
  return result.stdout.trim();
}
const run = (program, args = [], input) =>
  execute(binaries[program], args, input);
const ip = (args) => run('iptables', ['-w', '5', ...args]);
const ns = (pid, program, args = [], input) =>
  execute(
    '/usr/bin/nsenter',
    ['-t', String(pid), '-n', '--', binaries[program], ...args],
    input,
  );
const rows = (chain) =>
  ip(['-S', chain])
    .split('\n')
    .filter((line) => line.startsWith('-A '));
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
const hostDeny = [
  '-s',
  SUBNET,
  '-m',
  'comment',
  '--comment',
  'jarvis-1g-host-deny',
  '-j',
  'DROP',
];

function realDeny() {
  assert.match(
    execute('/usr/bin/node', ['/lab/host.mjs', 'deny']),
    /subnet denied; grants revoked/,
  );
}
function matches(line, chain, args) {
  return sameRule(ruleTokens(line), ['-A', chain, ...args]);
}
function countRule(chain, args) {
  return rows(chain).filter((line) => matches(line, chain, args)).length;
}
function identity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return {
    pid,
    inode: statSync(`/proc/${pid}/ns/net`).ino,
    start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
  };
}

async function fixture() {
  assert.match(run('iptables', ['--version']), /nf_tables/);
  ip(['-N', 'DOCKER-USER']);
  ip(['-N', 'ufw-before-input']);
  ip(['-A', 'INPUT', '-p', 'tcp', '--dport', '22', '-j', 'ACCEPT']);
  ip(['-A', 'INPUT', '-j', 'ufw-before-input']);
  ip(['-A', 'DOCKER-USER', '-s', SUBNET, '-j', 'DROP']);
  const originalInput = rows('INPUT');
  const originalUser = rows('DOCKER-USER');
  const originalUfw = ip(['-S', 'ufw-before-input']);

  realDeny();
  assert.ok(matches(rows('DOCKER-USER')[0], 'DOCKER-USER', safety));
  assert.ok(matches(rows('INPUT')[0], 'INPUT', hostDeny));
  const kernelHostCommentQuoted = rows('INPUT')[0].includes('--comment "');
  for (let index = 0; index < 5; index++) realDeny();
  assert.equal(countRule('DOCKER-USER', safety), 1);
  assert.equal(countRule('INPUT', hostDeny), 1);
  results.push(
    'production-deny-repeated-with-real-kernel-comment-serialization-is-idempotent',
  );

  // Seed old duplicate hooks both before and after unrelated rules. Reapplication
  // must converge, preserving every unrelated rule and its relative order.
  ip(['-I', 'DOCKER-USER', '1', ...safety]);
  ip(['-A', 'DOCKER-USER', ...safety]);
  ip(['-I', 'INPUT', '1', ...hostDeny]);
  ip(['-A', 'INPUT', ...hostDeny]);
  ip([
    '-I',
    'INPUT',
    '1',
    '-s',
    '192.0.2.4',
    '-m',
    'comment',
    '--comment',
    'operator -m tcp /32 "quoted" \\ value',
    '-j',
    'DROP',
  ]);
  const unrelatedInput = rows('INPUT').filter(
    (line) => !matches(line, 'INPUT', hostDeny),
  );
  const unrelatedUser = rows('DOCKER-USER').filter(
    (line) => !matches(line, 'DOCKER-USER', safety),
  );
  for (let index = 0; index < 3; index++) realDeny();
  assert.equal(countRule('DOCKER-USER', safety), 1);
  assert.equal(countRule('INPUT', hostDeny), 1);
  assert.deepEqual(rows('INPUT').slice(1), unrelatedInput);
  assert.deepEqual(rows('DOCKER-USER').slice(1), unrelatedUser);
  assert.deepEqual(rows('INPUT').slice(-originalInput.length), originalInput);
  assert.deepEqual(
    rows('DOCKER-USER').slice(-originalUser.length),
    originalUser,
  );
  assert.equal(ip(['-S', 'ufw-before-input']), originalUfw);
  results.push(
    'production-deny-removes-old-duplicates-without-changing-ssh-ufw-or-legacy',
  );

  const sleeper = spawn(
    '/usr/sbin/ip',
    ['netns', 'exec', BOT, '/usr/bin/sleep', '120'],
    { stdio: 'ignore' },
  );
  try {
    const expectedInode = statSync(`/var/run/netns/${BOT}`).ino;
    let actual;
    for (let count = 0; count < 100; count++) {
      actual = identity(sleeper.pid);
      if (actual.inode === expectedInode) break;
      await delay(10);
    }
    assert.equal(actual.inode, expectedInode);
    const ports = {
      ip,
      run,
      ns,
      assertIdentity: (id, expected) => {
        assert.equal(id, 'isolated-fixture');
        assert.deepEqual(identity(sleeper.pid), expected);
      },
    };
    const manager = createRuleManager(ports);
    // Exercise the same uniqueFirst with actual escaped comment serialization;
    // content resembling options must remain comment data, never normalization.
    const escaped = [
      '-s',
      '192.0.2.5',
      '-m',
      'comment',
      '--comment',
      'fixture "quoted" \\ -m tcp /32',
      '-j',
      'DROP',
    ];
    manager.uniqueFirst('INPUT', escaped);
    manager.uniqueFirst('INPUT', escaped);
    assert.match(rows('INPUT')[0], /--comment "/);
    assert.ok(matches(rows('INPUT')[0], 'INPUT', escaped));
    assert.equal(rows('INPUT').length, unrelatedInput.length + 2);
    manager.uniqueFirst('INPUT', hostDeny);
    results.push('production-unique-first-preserves-escaped-comment-content');

    const now = Date.now();
    const policy = {
      version: 1,
      hostname: HOSTNAME,
      resolver: DNS_SERVER,
      addresses: [ADDRESS],
      createdAt: now,
      expiresAt: now + 120_000,
    };
    const rules = firewallRules(policy.addresses);
    function set(programRun, name, seconds = '60') {
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
      programRun('ipset', ['add', name, ADDRESS, 'timeout', seconds]);
    }
    const botRun = (program, args) => ns(actual.pid, program, args);
    set(run, SET_HOST);
    set(botRun, SET_NS);
    run('restore', ['--noflush', '--wait', '5'], rules.host);
    ns(actual.pid, 'restore', ['--noflush', '--wait', '5'], rules.namespace4);
    ns(actual.pid, 'restore6', ['--noflush', '--wait', '5'], rules.namespace6);
    manager.uniqueFirst('DOCKER-USER', ['-s', SUBNET, '-j', CHAIN_HOST]);
    ns(actual.pid, 'iptables', [
      '-t',
      'raw',
      '-I',
      'OUTPUT',
      '1',
      '-j',
      CHAIN_NS4,
    ]);
    ns(actual.pid, 'ip6tables', [
      '-t',
      'raw',
      '-I',
      'OUTPUT',
      '1',
      '-j',
      CHAIN_NS6,
    ]);
    const check = () => manager.assertRules(policy, 'isolated-fixture', actual);
    check();
    results.push(
      'production-assert-rules-accepts-real-installed-nft-rules-and-commented-input',
    );
    // This version leaves the simple INPUT comment unquoted. Replay only its
    // equivalent quoting over the REAL -S dump, without substituting any rules.
    // The escaped-comment test above exercises quotes natively emitted by nft.
    let quoteReplays = 0;
    const quoted = createRuleManager({
      ...ports,
      ip: (args) => {
        const output = ip(args);
        if (args.includes('-S') && args.at(-1) === 'INPUT') {
          quoteReplays++;
          return output.replace(
            /--comment (jarvis-1g-host-deny)(?= |$)/g,
            '--comment "$1"',
          );
        }
        return output;
      },
    });
    quoted.assertRules(policy, 'isolated-fixture', actual);
    assert.equal(quoteReplays, 1);
    results.push(
      'production-assert-rules-accepts-quoted-variant-of-real-input-dump',
    );

    ip([
      '-I',
      'INPUT',
      '1',
      '-s',
      SUBNET,
      '-m',
      'comment',
      '--comment',
      'jarvis-1g-host-deny WRONG',
      '-j',
      'DROP',
    ]);
    assert.throws(check);
    ip(['-D', 'INPUT', '1']);
    check();
    ip(['-I', 'DOCKER-USER', '1', '-j', 'RETURN']);
    assert.throws(check);
    ip(['-D', 'DOCKER-USER', '1']);
    check();
    ip(['-I', CHAIN_HOST, '1', '-d', '1.1.1.1', '-j', 'ACCEPT']);
    assert.throws(check);
    ip(['-D', CHAIN_HOST, '1']);
    check();
    ns(actual.pid, 'ip6tables', [
      '-t',
      'raw',
      '-I',
      'OUTPUT',
      '1',
      '-j',
      'ACCEPT',
    ]);
    assert.throws(check);
    ns(actual.pid, 'ip6tables', ['-t', 'raw', '-D', 'OUTPUT', '1']);
    check();
    set(run, SET_HOST, '300');
    assert.throws(check);
    set(run, SET_HOST);
    check();
    results.push(
      'production-assert-rules-rejects-comment-priority-destination-ipv6-and-ttl-drift',
    );
    process.stdout.write(
      `${JSON.stringify({
        status: 'passed-real-rule-regression',
        scenarios: results,
        iptables: run('iptables', ['--version']),
        realDenyExecutions: 9,
        kernelHostCommentQuoted,
        kernelEscapedCommentQuoted: true,
        dockerIdentityAdapter: 'real-process-netns-inode-and-start-time',
        realIptablesCommands: true,
        jarvisStarted: false,
      })}\n`,
    );
  } finally {
    sleeper.kill('SIGTERM');
  }
}

if (process.argv[2] === 'fixture') {
  await fixture();
} else {
  assert.equal(process.argv.length, 2);
  const created = [];
  try {
    for (const namespace of [ROUTER, BOT]) {
      execute('/usr/sbin/ip', ['netns', 'add', namespace]);
      created.push(namespace);
    }
    process.stdout.write(
      `${execute('/usr/sbin/ip', ['netns', 'exec', ROUTER, '/usr/bin/node', '/lab/rule-regression.mjs', 'fixture'], undefined, 40_000)}\n`,
    );
  } finally {
    for (const namespace of created.reverse())
      execute('/usr/sbin/ip', ['netns', 'delete', namespace]);
  }
}
