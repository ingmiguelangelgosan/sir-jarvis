import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { AgentGatewayError } from '../src/agents/errors.ts';
import type {
  DurableAction,
  DurableExecution,
} from '../src/agents/state-store.ts';
import {
  SqliteStateStore,
  type SqliteStateStoreOptions,
} from '../src/infrastructure/sqlite-state-store.ts';

const stores = new Set<SqliteStateStore>();
const execute = promisify(execFile);
function openStore(options: SqliteStateStoreOptions): SqliteStateStore {
  const store = new SqliteStateStore(options);
  stores.add(store);
  return store;
}

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
function execution(
  overrides: Partial<DurableExecution> = {},
): DurableExecution {
  return {
    key: 'execution-key',
    commandHash: hash,
    owner: 'owner-one',
    phase: 'reserved',
    createdAt: 100,
    updatedAt: 100,
    context: {
      protocol_version: '1.0',
      instance_id: 'instance',
      agent_id: 'demo.echo',
      subject_ref: 'owner',
      request_id: 'request',
      correlation_id: 'correlation',
      capability: { name: 'echo.reply', version: '1.0' },
    },
    ...overrides,
  };
}
function action(overrides: Partial<DurableAction> = {}): DurableAction {
  return {
    key: 'action-key',
    commandHash: hash,
    owner: 'owner-one',
    phase: 'reserved',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof AgentGatewayError && error.code === expected;
}
function directory(t: TestContext): string {
  const root = realpathSync(tmpdir());
  const path = mkdtempSync(join(root, 'jarvis-sqlite-state-'));
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  t.after(() => {
    // Test hooks execute in registration order: release handles before cleanup.
    for (const store of stores) store.close();
    stores.clear();
    const actual = realpathSync(path);
    const fromRoot = relative(root, actual);
    assert.ok(
      !isAbsolute(fromRoot) &&
        fromRoot !== '..' &&
        !fromRoot.startsWith('../') &&
        !fromRoot.startsWith('..\\') &&
        basename(actual).startsWith('jarvis-sqlite-state-') &&
        !fromRoot.includes('/') &&
        !fromRoot.includes('\\'),
    );
    // Windows scanners can hold a just-closed WAL file briefly. Retry only the
    // verified temporary target after releasing every known database handle.
    rmSync(actual, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  });
  return path;
}
function storeFixture(t: TestContext, maxRecords?: number) {
  const path = join(directory(t), 'state.sqlite');
  const store = openStore({
    path,
    create: true,
    ...(maxRecords === undefined ? {} : { maxRecords }),
  });
  t.after(() => store.close());
  return { path, store };
}

test('SQLite bootstrap exclusivo, WAL/FULL y reapertura real conservan la reserva', (t) => {
  const { path, store } = storeFixture(t);
  assert.equal(store.reserveExecution(execution()).created, true);
  store.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  db.close();
  assert.throws(
    () => new SqliteStateStore({ path, create: true }),
    code('INVALID_CONFIGURATION'),
  );
  const reopened = openStore({ path });
  t.after(() => reopened.close());
  const duplicate = reopened.reserveExecution(
    execution({ owner: 'after-restart' }),
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.owner, 'owner-one');
  assert.equal(duplicate.record.phase, 'reserved');
  assert.equal(Object.isFrozen(duplicate.record.context), true);
});

test('SQLite unicidad transaccional entre conexiones comparte reserva y rechaza comando distinto', (t) => {
  const { path, store } = storeFixture(t);
  const second = openStore({ path });
  t.after(() => second.close());
  assert.equal(store.reserveExecution(execution()).created, true);
  assert.equal(
    second.reserveExecution(execution({ owner: 'other-process' })).created,
    false,
  );
  assert.throws(
    () => second.reserveExecution(execution({ commandHash: otherHash })),
    code('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(store.getExecution('execution-key')?.owner, 'owner-one');
});

test('SQLite reservas realmente simultáneas desde procesos separados producen un único propietario', async (t) => {
  const { path, store } = storeFixture(t);
  store.close();
  const adapter = new URL(
    '../src/infrastructure/sqlite-state-store.ts',
    import.meta.url,
  ).href;
  const source = `
    import { SqliteStateStore } from ${JSON.stringify(adapter)};
    const value = JSON.parse(process.argv[2]);
    const store = new SqliteStateStore({ path: process.argv[1], busyTimeoutMs: 1000 });
    try { const result = store.reserveExecution(value); process.stdout.write(JSON.stringify({ created: result.created, owner: result.record.owner })); }
    finally { store.close(); }
  `;
  const results = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const child = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          source,
          path,
          JSON.stringify(execution({ owner: `process-${index}` })),
        ],
        {
          env: {
            ...(process.platform === 'win32' && process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          timeout: 10_000,
          maxBuffer: 4096,
          encoding: 'utf8',
        },
      );
      assert.equal(child.stderr, '');
      return JSON.parse(child.stdout) as {
        readonly created: boolean;
        readonly owner: string;
      };
    }),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.owner)).size, 1);
});

test('SQLite marca inicio y mantiene incertidumbre tras cierre sin permitir reejecución', (t) => {
  const { path, store } = storeFixture(t);
  store.reserveExecution(execution());
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'started' },
    101,
  );
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'uncertain', errorCode: 'TIMEOUT', outcome: 'uncertain' },
    102,
  );
  store.close();
  const next = openStore({ path });
  t.after(() => next.close());
  const result = next.reserveExecution(execution({ owner: 'new-owner' }));
  assert.equal(result.created, false);
  assert.equal(result.record.phase, 'uncertain');
  assert.equal(result.record.errorCode, 'TIMEOUT');
  assert.throws(
    () =>
      next.transitionExecution(
        'execution-key',
        'owner-one',
        { phase: 'started' },
        103,
      ),
    code('UNAVAILABLE'),
  );
});

test('SQLite reserva e inicio sobreviven sin normalizar una historia en curso de otro proceso', (t) => {
  const { path, store } = storeFixture(t);
  store.reserveExecution(execution());
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'started' },
    101,
  );
  const second = openStore({ path });
  t.after(() => second.close());
  assert.equal(second.getExecution('execution-key')?.phase, 'started');
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'completed', outcome: 'completed' },
    102,
  );
  assert.equal(second.getExecution('execution-key')?.phase, 'completed');
});

test('SQLite pending conserva scope, correlación, ID y plazo original sin renovación', (t) => {
  const { path, store } = storeFixture(t);
  const value = execution();
  store.reserveExecution(value);
  store.transitionExecution(value.key, value.owner, { phase: 'started' }, 101);
  store.transitionExecution(
    value.key,
    value.owner,
    {
      phase: 'pending',
      operationId: 'operation-one',
      pollAfterMs: 1000,
      pendingExpiresAt: 86_400_100,
    },
    102,
  );
  assert.throws(
    () =>
      store.transitionExecution(
        value.key,
        value.owner,
        { phase: 'pending', pendingExpiresAt: 86_400_101 },
        103,
      ),
    code('UNAVAILABLE'),
  );
  assert.throws(
    () =>
      store.transitionExecution(
        value.key,
        value.owner,
        { phase: 'pending', operationId: 'other' },
        103,
      ),
    code('UNAVAILABLE'),
  );
  store.close();
  const reopened = openStore({ path });
  t.after(() => reopened.close());
  const scope = {
    instance_id: 'instance',
    agent_id: 'demo.echo',
    subject_ref: 'owner',
  };
  assert.equal(
    reopened.findOperation(scope, 'operation-one')?.context.correlation_id,
    'correlation',
  );
  assert.equal(
    reopened.findOperation({ ...scope, subject_ref: 'other' }, 'operation-one'),
    undefined,
  );
  assert.equal(
    reopened.findOperation(scope, 'operation-one')?.pendingExpiresAt,
    86_400_100,
  );
});

test('SQLite una operation no puede vincularse a solicitudes distintas del mismo scope', (t) => {
  const { store } = storeFixture(t);
  for (const key of ['first', 'second']) {
    store.reserveExecution(
      execution({ key, context: { ...execution().context, request_id: key } }),
    );
    store.transitionExecution(key, 'owner-one', { phase: 'started' }, 101);
  }
  store.transitionExecution(
    'first',
    'owner-one',
    {
      phase: 'pending',
      operationId: 'same-operation',
      pollAfterMs: 100,
      pendingExpiresAt: 9000,
    },
    102,
  );
  assert.throws(
    () =>
      store.transitionExecution(
        'second',
        'owner-one',
        {
          phase: 'pending',
          operationId: 'same-operation',
          pollAfterMs: 100,
          pendingExpiresAt: 9000,
        },
        102,
      ),
    code('UNAVAILABLE'),
  );
  assert.equal(store.getExecution('second')?.phase, 'started');
});

test('SQLite reserva y entrega Telegram distinguen pendiente, envío incierto y confirmado sin mensajes', (t) => {
  const { path, store } = storeFixture(t);
  store.reserveAction(action());
  store.transitionAction('action-key', 'owner-one', 'result-confirmed', 101);
  store.transitionAction('action-key', 'owner-one', 'delivery-pending', 102);
  store.transitionAction('action-key', 'owner-one', 'delivery-started', 103);
  // An explicit 429 is the only caller-authorized transition back to pending.
  store.transitionAction('action-key', 'owner-one', 'delivery-pending', 104);
  store.transitionAction('action-key', 'owner-one', 'delivery-started', 105);
  store.transitionAction('action-key', 'owner-one', 'delivery-uncertain', 106);
  store.close();
  const reopened = openStore({ path });
  t.after(() => reopened.close());
  assert.equal(
    reopened.reserveAction(action({ owner: 'new-process' })).created,
    false,
  );
  assert.equal(reopened.getAction('action-key')?.phase, 'delivery-uncertain');
  assert.throws(
    () =>
      reopened.transitionAction(
        'action-key',
        'owner-one',
        'delivery-started',
        107,
      ),
    code('UNAVAILABLE'),
  );
  assert.throws(
    () => reopened.reserveAction(action({ commandHash: otherHash })),
    code('IDEMPOTENCY_CONFLICT'),
  );
});

test('SQLite no permite propietarios cruzados, retrocesos o transiciones terminales', (t) => {
  const { store } = storeFixture(t);
  store.reserveExecution(execution());
  store.reserveAction(action());
  assert.throws(
    () =>
      store.transitionExecution(
        'execution-key',
        'other-owner',
        { phase: 'started' },
        101,
      ),
    code('UNAVAILABLE'),
  );
  assert.throws(
    () =>
      store.transitionExecution(
        'execution-key',
        'owner-one',
        { phase: 'completed' },
        101,
      ),
    code('UNAVAILABLE'),
  );
  assert.throws(
    () =>
      store.transitionAction(
        'action-key',
        'other-owner',
        'result-confirmed',
        101,
      ),
    code('UNAVAILABLE'),
  );
  assert.throws(
    () => store.transitionAction('action-key', 'owner-one', 'delivered', 101),
    code('UNAVAILABLE'),
  );
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'started' },
    101,
  );
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'failed', errorCode: 'FORBIDDEN', outcome: 'failed' },
    102,
  );
  assert.throws(
    () =>
      store.transitionExecution(
        'execution-key',
        'owner-one',
        { phase: 'started' },
        103,
      ),
    code('UNAVAILABLE'),
  );
});

test('SQLite offset es monotónico y persiste; bind impide reinterpretar claves/instalación', (t) => {
  const { path, store } = storeFixture(t);
  store.bind('installation', hash);
  store.bind('installation', hash);
  assert.throws(
    () => store.bind('installation', otherHash),
    code('INVALID_CONFIGURATION'),
  );
  store.advanceOffset('telegram-namespace', 12, 100);
  store.advanceOffset('telegram-namespace', 9, 101);
  assert.equal(store.getOffset('telegram-namespace'), 12);
  store.close();
  const reopened = openStore({ path });
  t.after(() => reopened.close());
  assert.equal(reopened.getOffset('telegram-namespace'), 12);
  assert.throws(
    () => reopened.bind('installation', otherHash),
    code('INVALID_CONFIGURATION'),
  );
});

test('SQLite compacta tras siete días conservando tombstones, pending e inciertos', (t) => {
  const { path, store } = storeFixture(t);
  for (const phase of [
    'completed',
    'failed',
    'pending',
    'uncertain',
  ] as const) {
    store.reserveExecution(execution({ key: phase }));
    store.transitionExecution(phase, 'owner-one', { phase: 'started' }, 101);
    store.transitionExecution(
      phase,
      'owner-one',
      phase === 'pending'
        ? {
            phase,
            operationId: 'pending-op',
            pollAfterMs: 1000,
            pendingExpiresAt: 90_000,
          }
        : { phase, outcome: phase },
      102,
    );
  }
  assert.throws(() => store.compact(200, 1000), code('UNAVAILABLE'));
  assert.equal(store.compact(200, 8 * 86_400_000), 2);
  assert.throws(() => store.getExecution('completed'), code('RESULT_EXPIRED'));
  assert.throws(
    () => store.reserveExecution(execution({ key: 'completed' })),
    code('RESULT_EXPIRED'),
  );
  assert.throws(
    () =>
      store.reserveExecution(
        execution({ key: 'completed', commandHash: otherHash }),
      ),
    code('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(store.getExecution('pending')?.phase, 'pending');
  assert.equal(store.getExecution('uncertain')?.phase, 'uncertain');
  store.close();
  const db = new DatabaseSync(path);
  assert.equal(
    db.prepare("SELECT context FROM executions WHERE key='completed'").get()
      ?.context,
    null,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS total FROM executions').get()?.total,
    4,
  );
  db.close();
});

test('SQLite cupo conjunto lleno falla cerrado sin expulsar reservas existentes', (t) => {
  const { store } = storeFixture(t, 2);
  store.reserveExecution(execution());
  store.reserveAction(action());
  assert.equal(store.reserveExecution(execution()).created, false);
  assert.throws(
    () => store.reserveExecution(execution({ key: 'another-key' })),
    code('CAPACITY_EXCEEDED'),
  );
  assert.equal(store.getAction('action-key')?.phase, 'reserved');
});

test('SQLite locks transitorios fallan seguro y se recuperan sin crear reserva fantasma', (t) => {
  const { path, store } = storeFixture(t);
  const blocker = new DatabaseSync(path);
  blocker.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.reserveExecution(execution()), code('UNAVAILABLE'));
  blocker.exec('ROLLBACK');
  blocker.close();
  assert.equal(store.getExecution('execution-key'), undefined);
  assert.equal(store.reserveExecution(execution()).created, true);
});

test('SQLite entradas no JSON, campos extra y metadatos fuera de fase se rechazan antes del INSERT', (t) => {
  const { store } = storeFixture(t);
  for (const value of [
    { ...execution(), input: { text: 'private-payload' } },
    {
      ...execution(),
      context: { ...execution().context, token: 'private-token' },
    },
    { ...execution(), commandHash: 'not-a-hash' },
    { ...execution(), pollAfterMs: 100 },
    { ...execution(), pendingExpiresAt: 100 },
    { ...execution(), phase: 'started' },
  ])
    assert.throws(
      () => store.reserveExecution(value as DurableExecution),
      code('UNAVAILABLE'),
    );
  assert.equal(store.getExecution('execution-key'), undefined);
});

test('SQLite no recrea automáticamente DB ausente, corrupta o con esquema incompatible', (t) => {
  const root = directory(t);
  const path = join(root, 'state.sqlite');
  assert.throws(
    () => new SqliteStateStore({ path }),
    code('INVALID_CONFIGURATION'),
  );
  writeFileSync(path, 'private-corruption-canary', { mode: 0o600 });
  assert.throws(
    () => new SqliteStateStore({ path }),
    (error: unknown) => {
      assert.ok(error instanceof AgentGatewayError);
      assert.equal(error.code, 'INVALID_CONFIGURATION');
      assert.ok(!String(error.stack).includes('private-corruption-canary'));
      assert.ok(!String(error.stack).includes(root));
      return true;
    },
  );
});

test('SQLite rechaza user_version futuro, migración alterada y esquema modificado', (t) => {
  for (const sql of [
    'PRAGMA user_version=2',
    "UPDATE schema_migrations SET checksum='" + otherHash + "'",
    'ALTER TABLE actions ADD COLUMN unexpected TEXT',
  ]) {
    const path = join(directory(t), 'state.sqlite');
    const store = new SqliteStateStore({ path, create: true });
    store.close();
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    assert.throws(
      () => new SqliteStateStore({ path }),
      code('INVALID_CONFIGURATION'),
    );
  }
});

test('SQLite falla cerrado si el path fue reemplazado con otro archivo mientras estaba abierto', (t) => {
  const { path, store } = storeFixture(t);
  // POSIX permits replacement while open; Windows may refuse the rename, which
  // itself enforces this condition at the filesystem boundary.
  let renamed = false;
  try {
    renameSync(path, `${path}.old`);
    renamed = true;
  } catch {
    if (process.platform !== 'win32') assert.fail('Expected rename support');
  }
  if (renamed) {
    writeFileSync(path, '', { mode: 0o600 });
    assert.throws(
      () => store.reserveExecution(execution()),
      code('UNAVAILABLE'),
    );
    rmSync(path);
    renameSync(`${path}.old`, path);
  }
});

test('SQLite crea archivo privado y rechaza permisos POSIX amplios sin repararlos silenciosamente', (t) => {
  const { path, store } = storeFixture(t);
  if (process.platform === 'win32') {
    assert.ok(lstatSync(path).isFile());
    return;
  }
  assert.equal(lstatSync(path).mode & 0o077, 0);
  chmodSync(path, 0o644);
  assert.throws(() => store.getExecution('execution-key'), code('UNAVAILABLE'));
  assert.throws(
    () => new SqliteStateStore({ path }),
    code('INVALID_CONFIGURATION'),
  );
  chmodSync(path, 0o600);
});

test('SQLite no guarda outputs, mensajes, credenciales o IDs personales en claro', (t) => {
  const { path, store } = storeFixture(t);
  store.reserveExecution(execution());
  store.reserveAction(action());
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'started' },
    101,
  );
  store.transitionExecution(
    'execution-key',
    'owner-one',
    { phase: 'completed', outcome: 'completed' },
    102,
  );
  store.close();
  const bytes = readFileSync(path).toString('utf8');
  for (const canary of [
    'private-payload',
    'private-token',
    'TELEGRAM_BOT_TOKEN',
    'Hola Jarvis',
    '987654321',
  ])
    assert.ok(!bytes.includes(canary));
  const db = new DatabaseSync(path);
  assert.deepEqual(
    db
      .prepare('PRAGMA table_info(executions)')
      .all()
      .map((row) => row.name)
      .filter((name) =>
        [
          'payload',
          'output',
          'token',
          'telegram_user_id',
          'chat_id',
          'message',
        ].includes(String(name)),
      ),
    [],
  );
  db.close();
});

test('SQLite close es idempotente y un store cerrado no admite efectos', (t) => {
  const { store } = storeFixture(t);
  store.close();
  store.close();
  assert.throws(() => store.reserveExecution(execution()), code('UNAVAILABLE'));
});
