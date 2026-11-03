import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ConfigurationError } from '../src/app/config.ts';
import {
  acquireRuntimeLock,
  acquireTelegramConsumerLock,
} from '../src/infrastructure/runtime-lock.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import { temporaryState } from './durable-test.fixtures.ts';

function safeFailure(error: unknown) {
  assert.ok(error instanceof ConfigurationError);
  assert.equal(
    error.message,
    'No se pudo reservar el runtime local. Revisa otras instancias y permisos.',
  );
  return true;
}

function worker(path: string, mode: 'state' | 'telegram' = 'state') {
  const moduleUrl = new URL(
    '../src/infrastructure/runtime-lock.ts',
    import.meta.url,
  ).href;
  const source = `
    import { acquireRuntimeLock, acquireTelegramConsumerLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lock = ${mode === 'state' ? 'acquireRuntimeLock(process.argv[1])' : "acquireTelegramConsumerLock(process.argv[1], '123456789')"};
      process.once('SIGTERM', () => { lock.close(); process.send?.('released'); process.exit(0); });
      process.send?.('held');
      setInterval(() => lock.assertHeld(), 1000);
    } catch { process.send?.('blocked'); process.exitCode=2; }
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source, path],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env:
        process.platform === 'win32' && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
    },
  );
  let stderr = '';
  child.stderr?.on('data', (value: Buffer) => {
    stderr += value.toString('utf8');
  });
  return { child, diagnostic: () => stderr };
}

function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Runtime lock worker timed out')),
      10_000,
    );
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Runtime lock worker failed'));
    });
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

test('lock de runtime es exclusivo y close idempotente permite un nuevo propietario', (t) => {
  const file = temporaryState(t);
  const first = acquireRuntimeLock(file.path);
  file.cleanup(() => first.close());
  first.assertHeld();
  assert.throws(() => acquireRuntimeLock(file.path), safeFailure);
  first.close();
  first.close();
  assert.throws(() => first.assertHeld(), safeFailure);
  const second = acquireRuntimeLock(file.path);
  file.cleanup(() => second.close());
  second.assertHeld();
});

for (const signal of ['SIGKILL', 'SIGTERM'] as const)
  test(`${signal} de proceso libera lock SQLite del runtime sin borrar archivos`, async (t) => {
    const file = temporaryState(t);
    const owner = worker(file.path);
    try {
      assert.equal(await message(owner.child), 'held');
      assert.throws(() => acquireRuntimeLock(file.path), safeFailure);
      const contender = worker(file.path);
      try {
        assert.equal(await message(contender.child), 'blocked');
      } finally {
        await terminate(contender.child, 'SIGKILL');
      }
      assert.equal(contender.diagnostic(), '');
      await terminate(owner.child, signal);
      const recovered = acquireRuntimeLock(file.path);
      try {
        recovered.assertHeld();
      } finally {
        recovered.close();
      }
      assert.equal(owner.diagnostic(), '');
    } finally {
      await terminate(owner.child, 'SIGKILL');
    }
  });

test('lock por bot impide otro consumidor incluso con otro archivo de estado', async (t) => {
  const file = temporaryState(t);
  const owner = worker(file.directory, 'telegram');
  try {
    assert.equal(await message(owner.child), 'held');
    assert.throws(
      () => acquireTelegramConsumerLock(file.directory, '123456789'),
      safeFailure,
    );
    const otherBot = acquireTelegramConsumerLock(file.directory, '987654321');
    try {
      otherBot.assertHeld();
    } finally {
      otherBot.close();
    }
    await terminate(owner.child, 'SIGKILL');
    const recovered = acquireTelegramConsumerLock(file.directory, '123456789');
    recovered.close();
    assert.equal(owner.diagnostic(), '');
  } finally {
    await terminate(owner.child, 'SIGKILL');
  }
});

test('lock separado no bloquea commits WAL ni backup coherente del estado principal', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const lock = acquireRuntimeLock(file.path);
  try {
    store.bind('installation', 'a'.repeat(64));
    store.advanceOffset('opaque-bot', 42, 100);
    const connection = new DatabaseSync(file.path);
    try {
      const destination = join(file.directory, 'snapshot.sqlite');
      await backup(connection, destination);
      const snapshot = new DatabaseSync(destination, { readOnly: true });
      try {
        assert.equal(
          snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check,
          'ok',
        );
        assert.equal(
          snapshot
            .prepare('SELECT offset FROM offsets WHERE namespace=?')
            .get('opaque-bot')?.offset,
          42,
        );
      } finally {
        snapshot.close();
      }
    } finally {
      connection.close();
    }
    store.advanceOffset('opaque-bot', 43, 101);
    assert.equal(store.getOffset('opaque-bot'), 43);
    lock.assertHeld();
  } finally {
    lock.close();
    store.close();
  }
});

test('lock rechaza rutas, identidades y archivos privados inseguros sin detalles internos', (t) => {
  const file = temporaryState(t);
  assert.throws(() => acquireRuntimeLock('relative.sqlite'), safeFailure);
  assert.throws(
    () => acquireRuntimeLock('\\\\server\\share\\state.sqlite'),
    safeFailure,
  );
  assert.throws(
    () => acquireTelegramConsumerLock(file.directory, 'token:secret'),
    safeFailure,
  );
  const lockPath = `${file.path}.runtime-lock`;
  writeFileSync(lockPath, 'not a SQLite database', { mode: 0o600 });
  assert.throws(() => acquireRuntimeLock(file.path), safeFailure);
  assert.equal(readFileSync(lockPath, 'utf8'), 'not a SQLite database');
});

test('lock rechaza hardlinks, sustitución y permisos POSIX incorrectos', (t) => {
  const file = temporaryState(t);
  const first = acquireRuntimeLock(file.path);
  try {
    const lockPath = `${file.path}.runtime-lock`;
    linkSync(lockPath, join(file.directory, 'alias'));
    assert.throws(() => first.assertHeld(), safeFailure);
  } finally {
    first.close();
  }
  const other = join(file.directory, 'other.sqlite');
  const second = acquireRuntimeLock(other);
  try {
    if (process.platform === 'win32') {
      // Windows denies replacing an actively locked SQLite file at the OS boundary.
      assert.throws(
        () => renameSync(`${other}.runtime-lock`, `${other}.runtime-lock.old`),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)),
      );
      second.assertHeld();
    } else {
      renameSync(`${other}.runtime-lock`, `${other}.runtime-lock.old`);
      writeFileSync(`${other}.runtime-lock`, '', { mode: 0o600 });
      assert.throws(() => second.assertHeld(), safeFailure);
    }
  } finally {
    second.close();
  }
  if (process.platform !== 'win32') {
    chmodSync(file.directory, 0o755);
    assert.throws(
      () => acquireRuntimeLock(join(file.directory, 'bad.sqlite')),
      safeFailure,
    );
    chmodSync(file.directory, 0o700);
    const insecure = join(file.directory, 'public.sqlite');
    const initialized = acquireRuntimeLock(insecure);
    initialized.close();
    chmodSync(`${insecure}.runtime-lock`, 0o644);
    assert.throws(() => acquireRuntimeLock(insecure), safeFailure);
  }
});
