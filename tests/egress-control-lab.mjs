import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// Local Docker only. No privileges, host network/PID, Docker socket or real bot.
const image = process.argv[2];
const names = [];
let stage = 'arguments';
const started = performance.now();
function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `Local control lab failed at ${stage}.`);
  assert.equal(result.error, undefined);
  return result.stdout.trim();
}
async function waitFor(fn) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(100);
  }
  throw new Error();
}
try {
  assert.equal(process.argv.length, 3);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  if (process.env.DOCKER_HOST)
    assert.match(process.env.DOCKER_HOST, /^(?:npipe|unix):\/\//);
  assert.match(
    docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']),
    /^(?:npipe|unix):\/\//,
  );
  stage = 'systemd-unit-syntax-and-order';
  const units = resolve('deploy/egress/systemd');
  const unitScript = `set -eu
mkdir -p /run/systemd/system/docker.service.d
cp /units/jarvis-egress-policy.service /units/jarvis-pilot.service /run/systemd/system/
cp /units/docker-egress.conf /run/systemd/system/docker.service.d/50-jarvis-egress.conf
chmod 0644 /run/systemd/system/*.service /run/systemd/system/docker.service.d/*.conf
printf '[Unit]\\nDescription=Isolated Docker dependency stub\\n[Service]\\nType=oneshot\\nRemainAfterExit=yes\\nExecStart=/usr/bin/true\\n' > /run/systemd/system/docker.service
printf '[Unit]\\nDescription=Isolated legacy dependency stub\\nAfter=docker.service\\n[Service]\\nType=oneshot\\nRemainAfterExit=yes\\nExecStart=/usr/bin/true\\n' > /run/systemd/system/jarvis-egress-deny.service
systemd-analyze verify /run/systemd/system/docker.service /run/systemd/system/jarvis-egress-policy.service /run/systemd/system/jarvis-pilot.service
`;
  docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--tmpfs',
    '/run:rw,nosuid,nodev,size=8m',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=8m',
    '--mount',
    `type=bind,source=${units},target=/units,readonly`,
    '--entrypoint',
    'bash',
    image,
    '-c',
    unitScript,
  ]);
  for (const end of ['expiry', 'revocation']) {
    stage = `gate-${end}`;
    const name = `jarvis-gate-check-${randomBytes(6).toString('hex')}`;
    names.push(name);
    const fixture = `mkdir -p /tmp/gate-app/dist/app; printf '%s' 'process.stdout.write("fake-app-started\\n");process.once("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);' > /tmp/gate-app/dist/app/telegram-main.js; cd /tmp/gate-app; exec node /gate.mjs`;
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '32',
      '--memory',
      '128m',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=4m,mode=1777',
      '--tmpfs',
      '/run/jarvis-egress:rw,nosuid,nodev,size=1m,mode=0755',
      '--mount',
      `type=bind,source=${resolve('deploy/egress/gate.mjs')},target=/gate.mjs,readonly`,
      '--entrypoint',
      'bash',
      image,
      '-c',
      fixture,
    ]);
    await waitFor(
      () =>
        docker([
          'exec',
          name,
          'node',
          '-e',
          "process.stdout.write(require('node:fs').existsSync('/tmp/jarvis-egress-challenge')?'yes':'no')",
        ]) === 'yes',
    );
    const challenge = docker([
      'exec',
      name,
      'node',
      '-e',
      "process.stdout.write(require('node:fs').readFileSync('/tmp/jarvis-egress-challenge','utf8'))",
    ]);
    const writePermit = (value) =>
      docker([
        'exec',
        '--user',
        '0',
        name,
        'node',
        '-e',
        "const fs=require('node:fs'),p='/run/jarvis-egress/permit.json';fs.writeFileSync(p+'.tmp',process.argv[1],{mode:0o444});fs.renameSync(p+'.tmp',p)",
        JSON.stringify(value),
      ]);
    writePermit({
      challenge: '0'.repeat(64),
      policyHash: 'a'.repeat(64),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10000,
    });
    await delay(250);
    assert.ok(!docker(['logs', name]).includes('fake-app-started'));
    writePermit({
      challenge,
      policyHash: 'a'.repeat(64),
      issuedAt: Date.now(),
      expiresAt: Date.now() + (end === 'expiry' ? 1500 : 10000),
    });
    await waitFor(() => docker(['logs', name]).includes('fake-app-started'));
    if (end === 'revocation')
      docker([
        'exec',
        '--user',
        '0',
        name,
        'node',
        '-e',
        "require('node:fs').unlinkSync('/run/jarvis-egress/permit.json')",
      ]);
    await waitFor(
      () =>
        docker(['inspect', '--format', '{{.State.Running}}', name]) === 'false',
    );
    assert.equal(
      docker(['inspect', '--format', '{{.State.ExitCode}}', name]),
      '0',
    );
    assert.equal(
      docker(['logs', name]).split('fake-app-started').length - 1,
      1,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'passed-isolated-controls', scenarios: ['systemd-255-unit-verify-with-stub-dependencies', 'stale-challenge-does-not-release-app', 'lease-expiry-stops-fake-child', 'permit-revocation-stops-fake-child'], durationMs: Math.round(performance.now() - started), realBotStarted: false, hostSystemdChanged: false, awsCalls: 0, actualHostBootOrderValidated: false })}\n`,
  );
} catch {
  process.stderr.write(`Local control lab failed at ${stage}.\n`);
  process.exitCode = 1;
} finally {
  for (const name of names) {
    try {
      docker(['rm', '-f', name]);
    } catch {
      process.exitCode = 1;
    }
  }
}
