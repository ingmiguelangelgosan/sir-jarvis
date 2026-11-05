import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { temporaryState } from './durable-test.fixtures.ts';

interface HostReport {
  readonly calls: readonly { program: string; args: readonly string[] }[];
  readonly events: readonly string[];
  readonly files: readonly string[];
}

/** Isolated process injection: production CLI, fake root/Linux, no real commands or host writes. */
function execute(t: TestContext, scenario: string, args: readonly string[]) {
  const file = temporaryState(t);
  const report = join(file.directory, 'report.json');
  const preload = join(file.directory, 'fake-host.mjs');
  writeFileSync(
    preload,
    `
import fs from 'node:fs';
import cp from 'node:child_process';
import {Resolver} from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
const original={...fs};
const scenario=process.env.TEST_SCENARIO;
const calls=[],events=[];
const ROOT='/etc/jarvis-egress', RUN='/run/jarvis-egress', PUBLIC=RUN+'/public';
const dirs=new Map([[ROOT,0o700],['/opt/jarvis-release',0o755],['/srv/jarvis-private',0o700]]);
const files=new Map([[PUBLIC+'/permit.json','PRIVATE_PERMIT_CANARY']]);
const config={version:1,project:'sir-jarvis-pilot',image:'sha256:'+ 'a'.repeat(64),releaseDirectory:'/opt/jarvis-release',privateDirectory:'/srv/jarvis-private'};
if(scenario==='bad-config')config.version=2;
if(scenario!=='no-config')files.set(ROOT+'/config.json',JSON.stringify(config));
if(scenario==='dns-failure')files.set(ROOT+'/approved.json','OLD_REVIEW_CANARY');
if(scenario==='runtime-permission'){dirs.set(RUN,0o755);dirs.set(PUBLIC,0o755)}
for(const name of ['gate.mjs','policy.mjs','host.mjs'])files.set('/opt/jarvis-release/deploy/egress/'+name,'reviewed-script');
const privatePath=p=>typeof p==='string'&&(p.startsWith(ROOT)||p.startsWith(RUN)||p.startsWith('/opt/jarvis-release')||p.startsWith('/srv/jarvis-private'));
const missing=()=>Object.assign(new Error('PRIVATE_FS_CANARY'),{code:'ENOENT'});
let nextFd=50000;const fds=new Map();
fs.existsSync=p=>privatePath(p)?dirs.has(p)||files.has(p):original.existsSync(p);
fs.realpathSync=p=>privatePath(p)?p:original.realpathSync(p);
fs.lstatSync=p=>{
 if(!privatePath(p))return original.lstatSync(p);
 if(!dirs.has(p)&&!files.has(p))throw missing();
 return {uid:0,mode:dirs.has(p)?dirs.get(p):0o600,nlink:1,size:files.get(p)?.length??0,ino:1,isDirectory:()=>dirs.has(p),isFile:()=>files.has(p),isSymbolicLink:()=>false};
};
fs.mkdirSync=(p,opts)=>{if(!privatePath(p))throw Error('REAL_FS_WRITE_FORBIDDEN');events.push('mkdir:'+p);dirs.set(p,opts.mode)};
fs.readFileSync=(p,encoding)=>{
 if(!privatePath(p))return original.readFileSync(p,encoding);
 events.push('read:'+p);if(!files.has(p))throw missing();
 return encoding?files.get(p):Buffer.from(files.get(p));
};
fs.openSync=(p,flags,...rest)=>{if(!privatePath(p)){if(flags==='r'||flags===0||p===process.env.TEST_REPORT)return original.openSync(p,flags,...rest);throw Error('REAL_FS_WRITE_FORBIDDEN')};events.push('open:'+p);const fd=nextFd++;fds.set(fd,p);files.set(p,'');return fd};
fs.writeFileSync=(p,data)=>{if(!fds.has(p))throw Error('REAL_FS_WRITE_FORBIDDEN');files.set(fds.get(p),String(data))};
fs.fsyncSync=fd=>{if(!fds.has(fd))throw Error('REAL_FSYNC_FORBIDDEN')};
fs.closeSync=fd=>{if(!fds.delete(fd))return original.closeSync(fd)};
fs.chmodSync=(p,mode)=>{if(!dirs.has(p))throw Error('REAL_CHMOD_FORBIDDEN');dirs.set(p,mode)};
fs.fchmodSync=fd=>{if(!fds.has(fd))throw Error('REAL_FCHMOD_FORBIDDEN')};
fs.renameSync=(from,to)=>{if(!privatePath(from)||!privatePath(to))throw Error('REAL_FS_WRITE_FORBIDDEN');events.push('rename:'+to);if(!files.has(from))throw missing();files.set(to,files.get(from));files.delete(from)};
fs.unlinkSync=p=>{if(!privatePath(p))throw Error('REAL_FS_WRITE_FORBIDDEN');events.push('unlink:'+p);if(!files.delete(p))throw missing()};
Object.defineProperty(process,'platform',{value:'linux'});process.getuid=()=>0;
let userRules=scenario==='already-denied'?['-A DOCKER-USER -s 172.30.78.0/28 -m comment --comment jarvis-1g-safety -j DROP']:[];
let inputRules=scenario==='already-denied'?['-A INPUT -s 172.30.78.0/28 -m comment --comment jarvis-1g-host-deny -j DROP']:[];
cp.spawnSync=(program,args,opts)=>{
 calls.push({program,args:[...args]});events.push('command:'+program+':'+args.join(' '));
 if(!['/usr/sbin/iptables','/usr/sbin/iptables-restore','/usr/sbin/ipset','/usr/bin/docker','/usr/bin/systemctl','/usr/sbin/ufw'].includes(program))throw Error('REAL_COMMAND_FORBIDDEN');
 if(program.endsWith('/iptables')){
  if(scenario==='firewall-error')return {status:1,stdout:'',stderr:'PRIVATE_FIREWALL_CANARY'};
  if(args.includes('-S'))return {status:0,stdout:args.at(-1)==='INPUT'?inputRules.join('\\n'):userRules.join('\\n')};
  const insert=args.indexOf('-I');if(insert>=0){const chain=args[insert+1];const rule='-A '+chain+' '+args.slice(insert+3).join(' ');if(chain==='INPUT')inputRules.unshift(rule);else userRules.unshift(rule)}
 }
 if(program.endsWith('/iptables-restore')){
  const text=String(opts.input??'');events.push('restore:'+text);
  if(text.includes('-F INPUT')||text.includes('-F FORWARD')||text.includes('-F DOCKER-USER')||text.includes('-P '))throw Error('GLOBAL_RULE_MUTATION_FORBIDDEN');
 }
 return {status:0,stdout:'',stderr:''};
};
Resolver.prototype.setServers=function(servers){events.push('dns-servers:'+servers.join(','))};
Resolver.prototype.resolve4=async function(){events.push('dns-resolution-rejected');throw Error('PRIVATE_DNS_CANARY')};
syncBuiltinESMExports();
process.once('exit',()=>original.writeFileSync(process.env.TEST_REPORT,JSON.stringify({calls,events,files:[...files.keys()]}),{mode:0o600}));
`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--import',
      pathToFileURL(preload).href,
      resolve('deploy/egress/host.mjs'),
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        TEST_REPORT: report,
        TEST_SCENARIO: scenario,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.ok(existsSync(report), `Isolated mock failed: ${result.stderr}`);
  const recorded = JSON.parse(readFileSync(report, 'utf8')) as HostReport;
  return { ...result, recorded };
}

function assertNoAppOrGlobalChanges(report: HostReport) {
  assert.ok(report.calls.every((call) => !call.program.endsWith('/docker')));
  for (const call of report.calls) {
    assert.ok(!call.args.includes('-P') && !call.args.includes('--flush'));
    if (call.args.includes('-I')) {
      const index = call.args.indexOf('-I');
      assert.ok(['INPUT', 'DOCKER-USER'].includes(call.args[index + 1]!));
      assert.ok(call.args.includes('172.30.78.0/28'));
      assert.equal(call.args.at(-1), 'DROP');
    }
  }
  assert.equal(
    report.files.includes('/run/jarvis-egress/public/permit.json'),
    false,
  );
}

test('deny uses only subnet-scoped firewall commands and revokes grants without config, DNS or Docker', (t) => {
  const result = execute(t, 'no-config', ['deny']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /denied; grants revoked/);
  assertNoAppOrGlobalChanges(result.recorded);
  assert.ok(
    result.recorded.calls.some(
      (call) =>
        call.program.endsWith('/ipset') &&
        call.args.join(' ') === 'flush JRV1G_TG4',
    ),
  );
  assert.ok(
    !result.recorded.events.some(
      (event) =>
        event.includes('/etc/jarvis-egress/config.json') ||
        event.startsWith('dns-'),
    ),
  );
});

test('reapplying deny preserves existing matching hooks without inserting duplicates', (t) => {
  const result = execute(t, 'already-denied', ['deny']);
  assert.equal(result.status, 0, result.stderr);
  assertNoAppOrGlobalChanges(result.recorded);
  assert.ok(!result.recorded.calls.some((call) => call.args.includes('-I')));
  assert.ok(
    result.recorded.events.some(
      (event) =>
        event.startsWith('restore:') &&
        event.includes('-A JRV1G_EGRESS -j DROP'),
    ),
  );
});

test('unsafe runtime directory fails after installing emergency DROP rather than keeping the subnet allowed', (t) => {
  const result = execute(t, 'runtime-permission', ['deny']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keep Jarvis stopped/);
  const inserted = result.recorded.events.findIndex(
    (event) =>
      event.includes('-I DOCKER-USER 1 -s 172.30.78.0/28') &&
      event.endsWith('-j DROP'),
  );
  const restore = result.recorded.events.findIndex(
    (event) =>
      event.startsWith('restore:') && event.includes('-A JRV1G_EGRESS -j DROP'),
  );
  assert.ok(
    inserted >= 0,
    'An emergency DROP must precede fallible runtime-file handling',
  );
  assert.ok(restore > inserted);
  assert.ok(
    result.recorded.calls.every((call) => !call.program.endsWith('/docker')),
  );
  assert.ok(!result.stderr.includes('PRIVATE_FS_CANARY'));
});

test('candidate DNS failure leaves firewall denied, removes the prior grant and never publishes approval', (t) => {
  const result = execute(t, 'dns-failure', ['candidate']);
  assert.equal(result.status, 1);
  assertNoAppOrGlobalChanges(result.recorded);
  assert.ok(result.recorded.events.includes('dns-servers:172.26.0.2'));
  assert.ok(result.recorded.events.includes('dns-resolution-rejected'));
  assert.ok(
    !result.recorded.files.includes('/etc/jarvis-egress/candidate.json'),
  );
  assert.ok(
    !result.recorded.files.includes('/etc/jarvis-egress/approved.json'),
  );
  assert.ok(!result.stderr.includes('PRIVATE_DNS_CANARY'));
});

test('invalid config cannot trigger DNS, run the app, or preserve an old permission', (t) => {
  const result = execute(t, 'bad-config', ['candidate']);
  assert.equal(result.status, 1);
  assertNoAppOrGlobalChanges(result.recorded);
  assert.ok(!result.recorded.events.some((event) => event.startsWith('dns-')));
  assert.ok(
    !result.recorded.files.includes('/etc/jarvis-egress/candidate.json'),
  );
});

test('malformed explicit approval rejects before DNS or publishing a new allowlist', (t) => {
  const result = execute(t, 'valid', [
    'approve',
    '--sha256',
    'not-a-reviewed-fingerprint',
  ]);
  assert.equal(result.status, 1);
  assertNoAppOrGlobalChanges(result.recorded);
  assert.ok(!result.recorded.events.some((event) => event.startsWith('dns-')));
  assert.ok(
    !result.recorded.files.includes('/etc/jarvis-egress/approved.json'),
  );
});

test('firewall-command failure is never reported as successful denial and leaks no raw diagnostics', (t) => {
  const result = execute(t, 'firewall-error', ['deny']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Egress operation failed/);
  assert.ok(!result.stderr.includes('PRIVATE_FIREWALL_CANARY'));
  assert.ok(result.recorded.calls.length > 0);
  assert.ok(
    result.recorded.calls.every((call) => !call.program.endsWith('/docker')),
  );
});
