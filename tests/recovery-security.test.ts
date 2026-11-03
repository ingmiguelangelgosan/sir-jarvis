import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DurableAgentGateway } from '../src/agents/durable-gateway.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import { acquireRuntimeLock } from '../src/infrastructure/runtime-lock.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import {
  createStateBackup,
  restoreStateBackup,
  StateBackupError,
  verifyStateBackup,
} from '../src/infrastructure/state-backup.ts';
import { completed, registry, request } from './agent-runtime.fixtures.ts';
import { temporaryState } from './durable-test.fixtures.ts';

function setup(t: TestContext) {
  const temporary = temporaryState(t);
  const active = join(temporary.directory, 'active');
  const backups = join(temporary.directory, 'backups');
  const keys = join(temporary.directory, 'keys');
  const restores = join(temporary.directory, 'restores');
  for (const directory of [active, backups, keys, restores])
    mkdirSync(directory, { mode: 0o700 });
  const key = randomBytes(32);
  const keyFile = join(keys, 'backup.key');
  writeFileSync(keyFile, key.toString('base64url'), { mode: 0o600 });
  const statePath = join(active, 'state.sqlite');
  const store = new SqliteStateStore({ path: statePath, create: true });
  temporary.cleanup(() => store.close());
  return {
    ...temporary,
    store,
    statePath,
    backups,
    keys,
    key,
    keyFile,
    restores,
  };
}

function safeBackupError(error: unknown) {
  assert.ok(error instanceof StateBackupError);
  assert.equal(error.message, new StateBackupError().message);
  return true;
}

const restoredPath = (directory: string) => join(directory, 'state.sqlite');
const signal = () => new AbortController().signal;

test('publicación restaurada contiene gate durable en main sin depender del WAL del staging', async (t) => {
  const value = setup(t);
  value.store.advanceOffset('opaque-bot', 123, Date.now());
  const backup = await createStateBackup({
    statePath: value.statePath,
    backupDirectory: value.backups,
    keyFile: value.keyFile,
  });
  const destinationDirectory = join(value.restores, 'one');
  const restored = await restoreStateBackup({
    backupFile: join(value.backups, backup.file),
    keyFile: value.keyFile,
    destinationDirectory,
  });
  assert.equal(restored.state.recovery.status, 'blocked');
  assert.deepEqual(readdirSync(destinationDirectory), ['state.sqlite']);
  const raw = new DatabaseSync(restoredPath(destinationDirectory), {
    readOnly: true,
  });
  try {
    assert.equal(
      raw.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'delete',
    );
    assert.equal(
      raw
        .prepare(
          "SELECT fingerprint FROM bindings WHERE namespace='recovery.v1.gate'",
        )
        .get()?.fingerprint,
      restored.state.recovery.restoreId,
    );
    assert.equal(
      raw
        .prepare("SELECT offset FROM offsets WHERE namespace='opaque-bot'")
        .get()?.offset,
      123,
    );
    assert.equal(
      raw.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
  } finally {
    raw.close();
  }
  assert.equal(existsSync(`${restoredPath(destinationDirectory)}-wal`), false);
});

test('backup anterior omite una operación ya enviada: restore bloquea su replay directo por Gateway', async (t) => {
  const value = setup(t);
  const secret = randomBytes(32).toString('base64url');
  const backup = await createStateBackup({
    statePath: value.statePath,
    backupDirectory: value.backups,
    keyFile: value.keyFile,
  });
  const fixture = registry();
  let calls = 0;
  const transport = {
    execute: async (input: Parameters<typeof completed>[0]) => {
      calls += 1;
      return completed(input);
    },
    getOperation: async () => assert.fail('No remote polling'),
  };
  const live = new DurableAgentGateway(
    fixture.registry,
    fixture.catalog,
    transport,
    value.store,
    secret,
    { resultCacheMs: 1000 },
  );
  const command = request();
  try {
    assert.equal((await live.execute(command, signal())).status, 'completed');
  } finally {
    live.close();
  }
  assert.equal(calls, 1);
  const destinationDirectory = join(value.restores, 'old');
  await restoreStateBackup({
    backupFile: join(value.backups, backup.file),
    keyFile: value.keyFile,
    destinationDirectory,
  });
  const recoveredStore = new SqliteStateStore({
    path: restoredPath(destinationDirectory),
  });
  const recovered = new DurableAgentGateway(
    fixture.registry,
    fixture.catalog,
    transport,
    recoveredStore,
    secret,
    { resultCacheMs: 1000 },
  );
  try {
    assert.deepEqual(recoveredStore.inspect().executions, {});
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        await assert.rejects(
          recovered.execute(command, signal()),
          (error: unknown) => {
            assert.ok(error instanceof AgentGatewayError);
            assert.equal(error.code, 'UNAVAILABLE');
            assert.equal(error.outcome, 'uncertain');
            return true;
          },
        );
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(recoveredStore.inspect().executions, {});
  } finally {
    recovered.close();
    recoveredStore.close();
  }
});

test('backup de recuperación autorizada se restaura bloqueado con otro identificador', async (t) => {
  const value = setup(t);
  const backup = await createStateBackup({
    statePath: value.statePath,
    backupDirectory: value.backups,
    keyFile: value.keyFile,
  });
  const firstDirectory = join(value.restores, 'first');
  const first = await restoreStateBackup({
    backupFile: join(value.backups, backup.file),
    keyFile: value.keyFile,
    destinationDirectory: firstDirectory,
  });
  const firstStore = new SqliteStateStore({
    path: restoredPath(firstDirectory),
  });
  try {
    firstStore.authorizeRecovery(
      first.state.recovery.restoreId!,
      'a'.repeat(64),
      888,
      Date.now(),
    );
    assert.equal(firstStore.recoveryStatus().status, 'authorized');
    firstStore.assertExternalEffectsAllowed();
    const secondBackup = await createStateBackup({
      statePath: restoredPath(firstDirectory),
      backupDirectory: value.backups,
      keyFile: value.keyFile,
    });
    const secondDirectory = join(value.restores, 'second');
    const second = await restoreStateBackup({
      backupFile: join(value.backups, secondBackup.file),
      keyFile: value.keyFile,
      destinationDirectory: secondDirectory,
    });
    assert.equal(second.state.recovery.status, 'blocked');
    assert.notEqual(
      second.state.recovery.restoreId,
      first.state.recovery.restoreId,
    );
    const secondStore = new SqliteStateStore({
      path: restoredPath(secondDirectory),
    });
    try {
      assert.throws(
        () => secondStore.assertExternalEffectsAllowed(),
        AgentGatewayError,
      );
      assert.throws(
        () =>
          secondStore.authorizeRecovery(
            first.state.recovery.restoreId!,
            'b'.repeat(64),
            999,
            Date.now(),
          ),
        AgentGatewayError,
      );
      assert.equal(secondStore.recoveryStatus().status, 'blocked');
    } finally {
      secondStore.close();
    }
  } finally {
    firstStore.close();
  }
});

test('CLI de autorización rechaza runtime activo y no cambia el gate', async (t) => {
  const value = setup(t);
  const backup = await createStateBackup({
    statePath: value.statePath,
    backupDirectory: value.backups,
    keyFile: value.keyFile,
  });
  const destinationDirectory = join(value.restores, 'locked');
  const restored = await restoreStateBackup({
    backupFile: join(value.backups, backup.file),
    keyFile: value.keyFile,
    destinationDirectory,
  });
  const path = restoredPath(destinationDirectory);
  const reviewFile = join(value.keys, 'review.json');
  writeFileSync(
    reviewFile,
    JSON.stringify({
      restore_id: restored.state.recovery.restoreId,
      external_evidence_sha256: 'a'.repeat(64),
      telegram_next_offset: 500,
      decision: 'allow-read-only',
      pending_and_uncertain: 'reviewed',
      backup_rollback: 'reviewed',
    }),
    { mode: 0o600 },
  );
  const lock = acquireRuntimeLock(path);
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../src/app/backup-main.ts', import.meta.url)),
          'authorize',
          path,
          restored.state.recovery.restoreId!,
          reviewFile,
          '--acknowledge-backup-rollback',
        ],
        {
          cwd: value.directory,
          env:
            process.platform === 'win32' && process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {},
          timeout: 10_000,
        },
      ),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && 'stdout' in error && 'stderr' in error,
        );
        assert.equal(error.stdout, '');
        assert.equal(error.stderr, `${new StateBackupError().message}\n`);
        return true;
      },
    );
    lock.assertHeld();
    const store = new SqliteStateStore({ path });
    try {
      assert.equal(store.recoveryStatus().status, 'blocked');
    } finally {
      store.close();
    }
  } finally {
    lock.close();
  }
});

for (const corruption of ['header', 'tag', 'wrong-key'] as const)
  test(`backup ${corruption}: autenticación falla antes de publicar plaintext o restauración`, async (t) => {
    const value = setup(t);
    const backup = await createStateBackup({
      statePath: value.statePath,
      backupDirectory: value.backups,
      keyFile: value.keyFile,
    });
    const original = join(value.backups, backup.file);
    const originalBytes = readFileSync(original);
    const mutated = Buffer.from(originalBytes);
    const path = join(value.backups, 'tampered.jvb');
    if (corruption === 'header') mutated[24] = mutated[24]! ^ 1;
    if (corruption === 'tag')
      mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 1;
    writeFileSync(path, mutated, { mode: 0o600 });
    const keyFile =
      corruption === 'wrong-key'
        ? join(value.keys, 'other.key')
        : value.keyFile;
    if (corruption === 'wrong-key')
      writeFileSync(keyFile, randomBytes(32).toString('base64url'), {
        mode: 0o600,
      });
    await assert.rejects(
      verifyStateBackup({ backupFile: path, keyFile }),
      safeBackupError,
    );
    const destinationDirectory = join(value.restores, 'rejected');
    await assert.rejects(
      restoreStateBackup({ backupFile: path, keyFile, destinationDirectory }),
      safeBackupError,
    );
    assert.equal(existsSync(destinationDirectory), false);
    assert.ok(readFileSync(original).equals(originalBytes));
    assert.equal(
      readdirSync(value.backups).some(
        (name) => name.startsWith('.verify-') || name.startsWith('.backup-'),
      ),
      false,
    );
  });

test('contenedor autenticado con SQLite de esquema futuro se rechaza en aislamiento', async (t) => {
  const value = setup(t);
  value.store.close();
  const future = new DatabaseSync(value.statePath);
  try {
    future.exec('PRAGMA user_version=2');
  } finally {
    future.close();
  }
  const plaintext = readFileSync(value.statePath);
  const magic = Buffer.from('JARVIS-BACKUP-1\n');
  const now = Date.now();
  const header = Buffer.from(
    JSON.stringify({
      format: 1,
      schemaVersion: 1,
      id: randomUUID(),
      snapshotStartedAt: now,
      snapshotFinishedAt: now,
      bytes: plaintext.length,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const nonce = randomBytes(12);
  const aad = Buffer.concat([magic, length, header, nonce]);
  const cipher = createCipheriv('aes-256-gcm', value.key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const backupFile = join(value.backups, 'future.jvb');
  writeFileSync(
    backupFile,
    Buffer.concat([aad, ciphertext, cipher.getAuthTag()]),
    { mode: 0o600 },
  );
  await assert.rejects(
    verifyStateBackup({ backupFile, keyFile: value.keyFile }),
    safeBackupError,
  );
  const destinationDirectory = join(value.restores, 'future');
  await assert.rejects(
    restoreStateBackup({
      backupFile,
      keyFile: value.keyFile,
      destinationDirectory,
    }),
    safeBackupError,
  );
  assert.equal(existsSync(destinationDirectory), false);
});
