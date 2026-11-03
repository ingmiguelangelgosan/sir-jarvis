import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { inspectPilot } from './pilot-inspect.mjs';
import { preflightPilot } from './pilot-preflight.mjs';

// Explicit LOCAL ONLY test. Generated fictitious credentials, isolated project,
// internal Docker network, fake Telegram HTTP client. Never invokes AWS clients.
const parent = process.argv[2];
const project = `jarvis-pilot-check-${randomBytes(6).toString('hex')}`;
const started = performance.now();
let ready = false;
let stage = 'arguments';
let privateDirectory;
let environment;
let override;

function docker(args, timeout = 120_000) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: environment ?? process.env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Local pilot test failed at ${stage}.`);
  assert.equal(result.error, undefined);
  return result.stdout;
}
function compose(args, timeout) {
  return docker(
    [
      'compose',
      '-p',
      project,
      '-f',
      'deploy/compose.pilot.yaml',
      '-f',
      override,
      ...args,
    ],
    timeout,
  );
}
function maintenance(args) {
  return JSON.parse(
    compose([
      '--profile',
      'tools',
      'run',
      '--rm',
      'maintenance',
      ...args,
    ]).trim(),
  );
}
function stateOf() {
  return compose(['ps', '-q', 'jarvis']).trim();
}
async function healthy() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const id = stateOf();
    const health = docker([
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      id,
    ]).trim();
    if (health === 'healthy') return;
    // Execute the same health probe without waiting for Docker's full interval.
    const result = spawnSync(
      'docker',
      ['exec', id, 'node', '/app/healthcheck.mjs'],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (result.status === 0) return;
    await delay(500);
  }
  throw new Error();
}

try {
  assert.equal(process.argv.length, 3);
  assert.ok(parent && isAbsolute(parent) && existsSync(parent));
  privateDirectory = mkdtempSync(join(parent, 'pilot-check-'));
  const secrets = join(privateDirectory, 'secrets');
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(
    join(secrets, 'telegram-token'),
    `87654321:${randomBytes(32).toString('base64url')}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(join(secrets, 'allowed-users'), '42\n', {
    mode: 0o600,
    flag: 'wx',
  });
  writeFileSync(
    join(secrets, 'backup.key'),
    `${randomBytes(32).toString('base64url')}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const simulation = join(privateDirectory, 'telegram-fake.mjs');
  writeFileSync(
    simulation,
    `
import assert from 'node:assert/strict';
let seen=false;
globalThis.fetch=async(input,options)=>{
 const url=new URL(input); if(url.hostname!=='api.telegram.org')throw new Error('Unexpected network');
 const method=url.pathname.split('/').at(-1), body=JSON.parse(options.body);
 const reply=result=>new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});
 if(method==='getMe'){process.stdout.write('pilot-simulated-api-used\\n');return reply({id:87654321,is_bot:true,username:'JarvisBot'})}
 if(method==='getUpdates'){
  if(seen)return reply([]); seen=true;
  return reply([{update_id:1,message:{message_id:1,text:'/status',from:{id:42,is_bot:false},chat:{id:42,type:'private'}}},{update_id:2,message:{message_id:2,text:'/status',from:{id:77,is_bot:false},chat:{id:77,type:'private'}}},{update_id:3,message:{message_id:3,text:'/status',from:{id:42,is_bot:false},chat:{id:42,type:'group'}}}]);
 }
 if(method==='sendMessage'){assert.equal(body.chat_id,42);assert.ok(!body.text.includes('token'));process.stdout.write('pilot-authorized-response\\n');return reply({message_id:1})}
 throw new Error('Unsupported simulated API');
};
`,
    { mode: 0o600, flag: 'wx' },
  );
  override = join(privateDirectory, 'test-compose.json');
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        jarvis: {
          restart: 'no',
          command: [
            'node',
            '--import',
            '/test/telegram-fake.mjs',
            'dist/app/telegram-main.js',
          ],
          volumes: [
            {
              type: 'bind',
              source: simulation,
              target: '/test/telegram-fake.mjs',
              read_only: true,
            },
          ],
        },
      },
      networks: { pilot_egress: { internal: true } },
    }),
    { mode: 0o600, flag: 'wx' },
  );
  stage = 'docker-availability';
  docker(['info', '--format', '{{.ServerVersion}}'], 10_000);
  ready = true;
  stage = 'build-pinned-image';
  const tag = `sir-jarvis-pilot-check:${project}`;
  docker(['build', '--pull', '-t', tag, '.'], 120_000);
  const image = docker(['image', 'inspect', '--format', '{{.Id}}', tag]).trim();
  const layers = docker([
    'image',
    'inspect',
    '--format',
    '{{json .RootFS.Layers}}',
    image,
  ]).trim();
  environment = {
    ...process.env,
    JARVIS_PILOT_PRIVATE_DIR: secrets,
    JARVIS_PILOT_IMAGE: image,
  };
  stage = 'preflight-production-manifest';
  const preflight = preflightPilot(project, environment, (args) =>
    docker(args),
  );
  assert.equal(preflight.publicPorts, 0);
  stage = 'exclusive-initialization';
  compose([
    '--profile',
    'tools',
    'run',
    '--rm',
    '--entrypoint',
    'node',
    'maintenance',
    'dist/app/state-main.js',
    'init',
    '/data/state/jarvis.sqlite',
  ]);
  stage = 'minimal-pilot-start-health-allowlist';
  compose(['up', '-d', 'jarvis']);
  await healthy();
  await delay(200);
  let id = stateOf();
  const logs = docker(['logs', id]);
  assert.equal(
    logs.split('\n').filter((line) => line === 'pilot-authorized-response')
      .length,
    1,
  );
  assert.ok(logs.includes('pilot-simulated-api-used'));
  assert.equal(
    docker([
      'inspect',
      '--format',
      '{{len .HostConfig.PortBindings}}',
      id,
    ]).trim(),
    '0',
  );
  stage = 'safe-local-metrics';
  const metrics = inspectPilot(project, (args) => docker(args));
  assert.equal(metrics.status, 'running');
  assert.equal(metrics.storage.recovery, 'normal');
  assert.equal(metrics.storage.actions.delivered, 0); // Agent journal is deliberately absent in this pilot.
  stage = 'online-backup-verify';
  const backup = maintenance([
    'backup',
    '/data/state/jarvis.sqlite',
    '/backups',
    '/run/secrets/backup_key',
  ]);
  const backupPath = `/backups/${backup.file}`;
  assert.equal(
    maintenance(['verify', backupPath, '/run/secrets/backup_key']).metadata
      .sha256,
    backup.metadata.sha256,
  );
  stage = 'sigterm-and-restart';
  compose(['stop', '-t', '15', 'jarvis']);
  assert.equal(
    docker(['inspect', '--format', '{{.State.ExitCode}}', id]).trim(),
    '0',
  );
  compose(['start', 'jarvis']);
  await healthy();
  stage = 'sigkill-and-restart';
  compose(['kill', '-s', 'SIGKILL', 'jarvis']);
  assert.equal(
    docker(['inspect', '--format', '{{.State.ExitCode}}', id]).trim(),
    '137',
  );
  compose(['start', 'jarvis']);
  await healthy();
  stage = 'isolated-restore-blocks-all-api';
  compose(['stop', '-t', '15', 'jarvis']);
  const restored = maintenance([
    'restore',
    backupPath,
    '/recovery/pilot-restore',
    '/run/secrets/backup_key',
  ]);
  assert.equal(restored.state.recovery.status, 'blocked');
  const blocked = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'deploy/compose.pilot.yaml',
      '-f',
      override,
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'JARVIS_STATE_FILE=/recovery/pilot-restore/state.sqlite',
      '-v',
      `${project}_pilot_recovery:/recovery`,
      'jarvis',
    ],
    { encoding: 'utf8', env: environment, timeout: 15_000 },
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.error, undefined);
  assert.ok(!blocked.stdout.includes('pilot-simulated-api-used'));
  assert.equal(
    maintenance(['inspect', '/recovery/pilot-restore/state.sqlite']).recovery
      .status,
    'blocked',
  );
  stage = 'immutable-build-repeat';
  docker(['build', '--pull', '-t', tag, '.'], 120_000);
  const repeatedImage = docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    tag,
  ]).trim();
  assert.equal(
    docker([
      'image',
      'inspect',
      '--format',
      '{{json .RootFS.Layers}}',
      repeatedImage,
    ]).trim(),
    layers,
  );
  // BuildKit provenance can change the OCI index ID even when cached rootfs
  // layers are identical. Preserve attestations; record the actual deployed ID.
  process.stdout.write(
    `${JSON.stringify({ status: 'passed-local-only', project, image, repeatedBuild: { rootfsLayersMatch: true, imageIdMatches: repeatedImage === image, independentBitReproducibilityProven: false }, scenarios: ['minimal-compose-no-echo-no-public-ports', 'immutable-image-preflight', 'private-secret-mounts', 'normal-entrypoint-with-simulated-telegram', 'allowlist-and-private-chat', 'health-and-sanitized-inspection', 'online-encrypted-backup-verify', 'sigterm-and-restart', 'sigkill-and-restart', 'restore-blocked-before-api', 'repeated-build-rootfs-layers-match'], metrics, backup: { bytes: backup.bytes, durationMs: backup.durationMs }, restore: { durationMs: restored.durationMs, status: restored.state.recovery.status, externalApiCalls: 0 }, durationMs: Math.round(performance.now() - started), volumesRetained: true, awsValidated: false, ubuntuHostFirewallValidated: false })}\n`,
  );
} catch {
  process.stderr.write(
    `Local pilot checks failed or unavailable at ${stage}.\n`,
  );
  process.exitCode = 1;
} finally {
  if (ready && override) {
    try {
      compose(['--profile', 'tools', 'down', '--remove-orphans']);
    } catch {
      process.stderr.write(
        'Local test cleanup requires inspection; durable volumes retained.\n',
      );
      process.exitCode = 1;
    }
  }
}
