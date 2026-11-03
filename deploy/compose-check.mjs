import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit Docker integration suite, separate from the ordinary Docker-free CI.
// Each run gets its own project and volumes. Containers/networks are stopped at
// the end; durable volumes remain for inspection. Nothing from an operator run
// is removed or reused. Docker errors fail this command; they are never PASS.
const project = `jarvis-recovery-check-${randomBytes(6).toString('hex')}`;
const privateDirectory = process.argv[2];
const started = performance.now();
let stage = 'arguments';
let ready = false;

function docker(args, timeout = 120_000) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, JARVIS_PRIVATE_DIR: privateDirectory },
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result;
}

function compose(args, timeout) {
  return docker(['compose', '-p', project, ...args], timeout);
}

function succeeds(result) {
  assert.equal(result.status, 0, `Docker command failed at ${stage}.`);
  return result.stdout;
}

function smoke() {
  const output = succeeds(
    compose(['--profile', 'test', 'run', '--rm', 'smoke']),
  );
  const lines = output.split('\n');
  return JSON.parse(
    lines.find((line) => line.startsWith('{"scenario":')) ?? '{}',
  );
}

async function healthy(service) {
  const deadline = Date.now() + 20_000;
  do {
    const result = compose([
      'exec',
      '-T',
      service,
      'node',
      service === 'echo' ? '/echo/healthcheck.mjs' : '/app/healthcheck.mjs',
    ]);
    if (result.status === 0) return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('Container failed its local health probe.');
}

function inspect(service) {
  const container = succeeds(compose(['ps', '-aq', service])).trim();
  return JSON.parse(succeeds(docker(['inspect', container])))[0];
}

function maintenance(args) {
  const output = succeeds(
    compose([
      '--profile',
      'recovery-test',
      'run',
      '--rm',
      'smoke-maintenance',
      ...args,
    ]),
  );
  return JSON.parse(output.trim());
}

try {
  assert.equal(process.argv.length, 3);
  assert.ok(privateDirectory && isAbsolute(privateDirectory));
  stage = 'docker-availability';
  succeeds(docker(['info', '--format', '{{.ServerVersion}}'], 10_000));
  ready = true;
  stage = 'build';
  succeeds(compose(['--profile', 'test', 'build'], 120_000));
  stage = 'fresh-end-to-end';
  const fresh = smoke();
  assert.equal(fresh.recovered, false);
  assert.equal(fresh.commands, 1);
  assert.equal(fresh.deliveries, 1);
  stage = 'restart-deduplication';
  const reopened = smoke();
  assert.equal(reopened.recovered, true);
  assert.equal(reopened.commands, 0);
  assert.equal(reopened.deliveries, 0);
  stage = 'echo-sigterm';
  succeeds(compose(['stop', '-t', '10', 'echo']));
  assert.equal(inspect('echo').State.ExitCode, 0);
  succeeds(compose(['start', 'echo']));
  await healthy('echo');
  stage = 'echo-sigkill';
  succeeds(compose(['kill', '-s', 'SIGKILL', 'echo']));
  succeeds(compose(['start', 'echo']));
  await healthy('echo');
  const afterEchoCrash = smoke();
  assert.equal(afterEchoCrash.commands, 0);
  assert.equal(afterEchoCrash.deliveries, 0);
  stage = 'normal-entrypoint-simulated-telegram';
  succeeds(
    compose(['--profile', 'recovery-test', 'up', '-d', 'simulated-telegram']),
  );
  await healthy('simulated-telegram');
  const running = inspect('simulated-telegram');
  assert.equal(running.Config.User, '1000:1000');
  assert.equal(running.HostConfig.ReadonlyRootfs, true);
  assert.ok(running.HostConfig.CapDrop.includes('ALL'));
  stage = 'duplicate-telegram-consumer';
  const duplicate = compose(
    [
      '--profile',
      'recovery-test',
      'run',
      '--rm',
      '--no-deps',
      'simulated-telegram',
    ],
    15_000,
  );
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.error, undefined); // A timeout is not evidence of a lock.
  assert.ok(!duplicate.stdout.includes('simulated-telegram-api-used'));
  stage = 'backup-while-normal-bot-running';
  const backup = maintenance([
    'backup',
    '/data/state/smoke.sqlite',
    '/backups',
    '/run/secrets/backup_key',
  ]);
  const backupPath = `/backups/${backup.file}`;
  const verified = maintenance([
    'verify',
    backupPath,
    '/run/secrets/backup_key',
  ]);
  assert.equal(verified.metadata.sha256, backup.metadata.sha256);
  assert.equal(verified.metadata.schemaVersion, 1);
  stage = 'operation-after-backup';
  const newerAction = succeeds(
    compose([
      '--profile',
      'test',
      'run',
      '--rm',
      'smoke',
      'node',
      '/smoke/smoke.mjs',
      'new-action',
    ]),
  );
  assert.equal(JSON.parse(newerAction.trim()).commands, 1);
  stage = 'telegram-sigterm';
  succeeds(compose(['stop', '-t', '15', 'simulated-telegram']));
  assert.equal(inspect('simulated-telegram').State.ExitCode, 0);
  succeeds(compose(['start', 'simulated-telegram']));
  await healthy('simulated-telegram');
  stage = 'telegram-sigkill';
  succeeds(compose(['kill', '-s', 'SIGKILL', 'simulated-telegram']));
  assert.equal(inspect('simulated-telegram').State.ExitCode, 137);
  succeeds(compose(['start', 'simulated-telegram']));
  await healthy('simulated-telegram');
  const afterCrash = smoke();
  assert.equal(afterCrash.commands, 0);
  assert.equal(afterCrash.deliveries, 0);
  stage = 'isolated-old-backup-restore';
  const restored = maintenance([
    'restore',
    backupPath,
    '/recovery/restore-01',
    '/run/secrets/backup_key',
  ]);
  assert.equal(restored.state.recovery.status, 'blocked');
  assert.equal(restored.state.actions.delivered, 1);
  const original = maintenance(['inspect', '/data/state/smoke.sqlite']);
  assert.equal(original.actions.delivered, 2);
  stage = 'restored-rollback-blocks-normal-entrypoint';
  // Stop the original consumer so a consumer lease cannot mask the recovery gate.
  succeeds(compose(['stop', '-t', '15', 'simulated-telegram']));
  const blocked = compose(
    [
      '--profile',
      'recovery-test',
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'JARVIS_STATE_FILE=/recovery/restore-01/state.sqlite',
      '-v',
      `${project}_jarvis_recovery:/recovery`,
      'simulated-telegram',
    ],
    15_000,
  );
  assert.equal(blocked.status, 1);
  assert.equal(blocked.error, undefined);
  assert.ok(!blocked.stdout.includes('simulated-telegram-api-used'));
  const stillBlocked = maintenance([
    'inspect',
    '/recovery/restore-01/state.sqlite',
  ]);
  assert.equal(stillBlocked.recovery.status, 'blocked');
  assert.equal(stillBlocked.actions.delivered, 1);
  succeeds(compose(['start', 'simulated-telegram']));
  await healthy('simulated-telegram');
  stage = 'resource-measurements';
  const containers = [inspect('simulated-telegram'), inspect('echo')];
  const ids = containers.map((container) => container.Id);
  const stats = succeeds(
    docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]),
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      project,
      fresh,
      reopened,
      afterCrash,
      backup: {
        bytes: backup.bytes,
        durationMs: backup.durationMs,
        schemaVersion: verified.metadata.schemaVersion,
        snapshotStartedAt: verified.metadata.snapshotStartedAt,
        snapshotFinishedAt: verified.metadata.snapshotFinishedAt,
      },
      restore: {
        durationMs: restored.durationMs,
        recovery: restored.state.recovery.status,
        retainedActions: restored.state.actions.delivered,
        originalActions: original.actions.delivered,
        lostKnownActions:
          original.actions.delivered - restored.state.actions.delivered,
        externalApiCallsWhileBlocked: 0,
      },
      scenarios: [
        'independent-echo-https-with-real-tls',
        'eight-concurrent-duplicates',
        'container-reopen',
        'echo-sigterm',
        'echo-sigkill',
        'normal-telegram-entrypoint-with-simulated-api',
        'duplicate-consumer-rejected',
        'telegram-sigterm',
        'telegram-sigkill-and-restart',
        'online-encrypted-backup-verify',
        'restore-before-a-known-operation',
        'rollback-blocks-api-until-operator-reconciliation',
      ],
      resources: stats.map((stat) => ({
        container: stat.Name,
        cpu: stat.CPUPerc,
        memory: stat.MemUsage,
        pids: stat.PIDs,
      })),
      restartCounters: containers.map((container) => ({
        container: container.Name,
        automaticRestarts: container.RestartCount,
      })),
      durationMs: Math.round(performance.now() - started),
      volumesRetained: true,
    })}\n`,
  );
} catch {
  process.stderr.write(`Compose checks failed or unavailable at ${stage}.\n`);
  process.exitCode = 1;
} finally {
  if (ready) {
    const stopped = compose([
      '--profile',
      'test',
      '--profile',
      'recovery-test',
      'down',
      '--remove-orphans',
    ]);
    if (stopped.status !== 0) {
      process.stderr.write(
        'Compose cleanup needs manual inspection; volumes retained.\n',
      );
      process.exitCode = 1;
    }
  }
}
