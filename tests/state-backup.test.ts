import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { DurableAgentGateway } from '../src/agents/durable-gateway.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import {
  createTelegramAgentIntegration,
  parseTelegramAgentsConfig,
} from '../src/app/telegram-agents.ts';
import { createTelegramHandler } from '../src/channels/telegram/handler.ts';

import { createDurableTelegramJournal } from '../src/channels/telegram/durable-actions.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import {
  createStateBackup,
  pruneStateBackups,
  restoreStateBackup,
  StateBackupError,
  verifyStateBackup,
} from '../src/infrastructure/state-backup.ts';
import { temporaryState } from './durable-test.fixtures.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import {
  completed,
  registry,
  registration,
  request,
} from './agent-runtime.fixtures.ts';
import { startEchoAgent } from './https-process.ts';

function fixture(t: TestContext) {
  const file = temporaryState(t);
  const active = join(file.directory, 'active');
  const backups = join(file.directory, 'backups');
  mkdirSync(active, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  const keyFile = join(file.directory, 'backup.key');
  writeFileSync(keyFile, `${randomBytes(32).toString('base64url')}\n`, {
    mode: 0o600,
  });
  const statePath = join(active, 'state.sqlite');
  const store = new SqliteStateStore({ path: statePath, create: true });
  file.cleanup(() => store.close());
  return {
    ...file,
    active,
    backups,
    statePath,
    keyFile,
    store,
    backup: () =>
      createStateBackup({ statePath, backupDirectory: backups, keyFile }),
    restore: (backupFile: string, name = 'restored') =>
      restoreStateBackup({
        backupFile,
        keyFile,
        destinationDirectory: join(file.directory, name),
      }),
  };
}
test('heartbeat mal configurado nunca trunca un archivo privado existente', async (t) => {
  const f = fixture(t);
  const token = `12345:${randomBytes(32).toString('base64url')}`;
  const keyBytes = readFileSync(f.keyFile);
  const bot = resolve('src/app/telegram-main.ts');
  const preloader = `globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{id:12345,is_bot:true,username:'JarvisBot'}}),{headers:{'content-type':'application/json'}});`;
  const worker = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--import',
      `data:text/javascript,${encodeURIComponent(preloader)}`,
      bot,
    ],
    {
      cwd: f.directory,
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_IDS: '42',
        JARVIS_STATE_FILE: f.statePath,
        JARVIS_RUNTIME_DIRECTORY: f.active,
        JARVIS_HEALTH_FILE: f.keyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  worker.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  worker.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const [code] = await once(worker, 'exit');
  assert.equal(code, 1);
  assert.deepEqual(readFileSync(f.keyFile), keyBytes);
  assert.ok(!output.includes(f.keyFile) && !output.includes(token));
});

const action = (key: string) => ({
  key,
  commandHash: 'a'.repeat(64),
  owner: 'test-owner',
  phase: 'reserved' as const,
  createdAt: 1,
  updatedAt: 1,
});

test('backup online preserva reservas WAL sin checkpoint del escritor y queda cifrado', async (t) => {
  const f = fixture(t);
  f.store.reserveAction(action('action-one'));
  f.store.advanceOffset('bot-namespace', 44, 1);
  const original = readFileSync(f.statePath);
  const result = await f.backup();
  const path = join(f.backups, result.file);
  const encrypted = readFileSync(path);
  assert.ok(!encrypted.includes(Buffer.from('SQLite format 3')));
  assert.ok(!encrypted.includes(Buffer.from('action-one')));
  assert.ok(
    !encrypted.includes(Buffer.from(readFileSync(f.keyFile, 'utf8').trim())),
  );
  const verified = await verifyStateBackup({
    backupFile: path,
    keyFile: f.keyFile,
  });
  assert.equal(verified.state.actions.reserved, 1);
  assert.equal(verified.metadata.schemaVersion, 1);
  assert.ok(result.durationMs >= 0 && result.bytes > 0);
  assert.equal(readdirSync(f.backups).length, 1);
  // The source remains live and writable; snapshots do not change its logical history.
  f.store.reserveAction(action('action-two'));
  assert.ok(f.store.getAction('action-two'));
  assert.ok(original.length > 0);
});

test('restore siempre es aislado, bloqueado, íntegro y no reemplaza originales', async (t) => {
  const f = fixture(t);
  f.store.reserveAction(action('old-action'));
  const backup = await f.backup();
  const backupPath = join(f.backups, backup.file);
  const bytes = readFileSync(backupPath);
  const restored = await f.restore(backupPath);
  assert.equal(restored.state.recovery.status, 'blocked');
  const path = join(f.directory, 'restored', 'state.sqlite');
  const store = new SqliteStateStore({ path });
  try {
    assert.throws(() => store.reserveAction(action('new-action')));
    assert.ok(store.getAction('old-action'));
    store.checkIntegrity();
  } finally {
    store.close();
  }
  assert.deepEqual(readFileSync(backupPath), bytes);
  assert.ok(f.store.getAction('old-action'));
  await assert.rejects(f.restore(backupPath), StateBackupError);
  assert.ok(existsSync(path));
});

test('retención explícita conserva N copias verificadas, nunca borra artefactos ajenos', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    f.store.reserveAction(action(`entry-${i}`));
    await f.backup();
  }
  writeFileSync(join(f.backups, 'operator-notes.txt'), 'private notes', {
    mode: 0o600,
  });
  assert.equal(await pruneStateBackups(f.backups, f.keyFile, 2), 1);
  assert.equal(
    readdirSync(f.backups).filter((name) => name.endsWith('.jvb')).length,
    2,
  );
  assert.ok(existsSync(join(f.backups, 'operator-notes.txt')));
  await assert.rejects(pruneStateBackups(f.backups, f.keyFile, 0));
});

test('retención con clave incorrecta no elimina ninguna copia', async (t) => {
  const f = fixture(t);
  await f.backup();
  await f.backup();
  const wrong = join(f.directory, 'wrong.key');
  writeFileSync(wrong, randomBytes(32).toString('base64url'), { mode: 0o600 });
  await assert.rejects(pruneStateBackups(f.backups, wrong, 1));
  assert.equal(
    readdirSync(f.backups).filter((name) => name.endsWith('.jvb')).length,
    2,
  );
});

test('backup falla cerrado si directorio activo se usa como destino o se pierde DB', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    createStateBackup({
      statePath: f.statePath,
      backupDirectory: f.active,
      keyFile: f.keyFile,
    }),
  );
  await assert.rejects(
    createStateBackup({
      statePath: join(f.active, 'missing.sqlite'),
      backupDirectory: f.backups,
      keyFile: f.keyFile,
    }),
  );
  assert.equal(existsSync(join(f.active, 'missing.sqlite')), false);
  assert.deepEqual(readdirSync(f.backups), []);
});

test('permisos inseguros o clave no canónica impiden backup sin artefactos parciales', async (t) => {
  const f = fixture(t);
  writeFileSync(f.keyFile, 'invalid-private-key', { mode: 0o600 });
  await assert.rejects(f.backup(), StateBackupError);
  assert.deepEqual(readdirSync(f.backups), []);
  if (process.platform !== 'win32') {
    writeFileSync(f.keyFile, randomBytes(32).toString('base64url'));
    chmodSync(f.backups, 0o755);
    await assert.rejects(f.backup(), StateBackupError);
    chmodSync(f.backups, 0o700);
  }
});

test('schema futuro en backup cifrado es rechazado antes de publicar restauración', async (t) => {
  const f = fixture(t);
  f.store.close();
  const db = new DatabaseSync(f.statePath);
  db.exec('PRAGMA user_version=99');
  db.close();
  await assert.rejects(f.backup(), StateBackupError);
  assert.deepEqual(readdirSync(f.backups), []);
});

test(
  'escrituras concurrentes de otro proceso conservan atomicidad del snapshot',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    // Seed enough pages to exercise incremental backup while an independent writer commits.
    const seed = new DatabaseSync(f.statePath);
    seed.exec('BEGIN IMMEDIATE');
    const insert = seed.prepare(
      "INSERT INTO actions(key,command_hash,owner,phase,created_at,updated_at) VALUES(?,?,?,'reserved',1,1)",
    );
    for (let i = 0; i < 4000; i++)
      insert.run(`seed-${i}`, 'a'.repeat(64), 'seed-owner');
    seed.exec('COMMIT');
    seed.close();
    const worker = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.env.STATE); db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL');
    let n=0; const timer=setInterval(()=>{ n++; db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO actions(key,command_hash,owner,phase,created_at,updated_at) VALUES(?,?,?,'reserved',1,1)").run('worker-'+n,'a'.repeat(64),'worker');
      db.prepare("INSERT INTO offsets(namespace,offset,updated_at) VALUES('writer-counter',?,1) ON CONFLICT(namespace) DO UPDATE SET offset=excluded.offset").run(n);
      db.exec('COMMIT'); if(n===1) process.send('ready');
    },2);
    process.on('message',()=>{clearInterval(timer);db.close();process.exit(0)});
  `,
      ],
      {
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          STATE: f.statePath,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    t.after(() => worker.kill());
    await once(worker, 'message');
    const backup = await f.backup();
    worker.send('stop');
    await once(worker, 'exit');
    const restored = await f.restore(join(f.backups, backup.file));
    assert.ok(restored.state.actions.reserved! > 4000);
    const db = new DatabaseSync(join(f.directory, 'restored', 'state.sqlite'), {
      readOnly: true,
    });
    try {
      const n = Number(
        db
          .prepare(
            "SELECT offset FROM offsets WHERE namespace='writer-counter'",
          )
          .get()?.offset,
      );
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) AS total FROM actions WHERE key LIKE 'worker-%'",
            )
            .get()?.total,
        ),
        n,
      );
    } finally {
      db.close();
    }
    t.diagnostic(
      `online snapshot ${backup.bytes} bytes / ${backup.durationMs} ms; restore ${restored.durationMs} ms`,
    );
  },
);

test(
  'terminación forzada a mitad de transacción no publica una reserva parcial',
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    const worker = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.env.STATE); db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO actions(key,command_hash,owner,phase,created_at,updated_at) VALUES(?,?,?,'reserved',1,1)").run('uncommitted','b'.repeat(64),'worker');
    process.send('ready'); setInterval(()=>{},1000);
  `,
      ],
      {
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          STATE: f.statePath,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    t.after(() => worker.kill());
    await once(worker, 'message');
    const exit = once(worker, 'exit');
    worker.kill('SIGKILL');
    await exit;
    assert.equal(f.store.getAction('uncommitted'), undefined);
    const backup = await f.backup();
    const result = await verifyStateBackup({
      backupFile: join(f.backups, backup.file),
      keyFile: f.keyFile,
    });
    assert.equal(result.state.actions.reserved, undefined);
  },
);

test('tras conciliación el floor durable descarta updates ausentes de una copia antigua', async (t) => {
  const f = fixture(t);
  const key = randomBytes(32).toString('base64url');
  const journal = createDurableTelegramJournal(f.store, key, 'jarvis-test');
  journal.advance(12345, 100);
  const backup = await f.backup();
  journal.advance(12345, 201); // Active history after snapshot, absent from restored DB.
  const restored = await f.restore(join(f.backups, backup.file));
  const store = new SqliteStateStore({
    path: join(f.directory, 'restored', 'state.sqlite'),
  });
  try {
    assert.throws(() => store.assertExternalEffectsAllowed());
    store.authorizeRecovery(
      restored.state.recovery.restoreId!,
      'c'.repeat(64),
      201,
      Date.now(),
    );
    const recovered = createDurableTelegramJournal(store, key, 'jarvis-test');
    assert.equal(recovered.offset(12345), 201);
    const abort = new AbortController();
    let polls = 0;
    let sends = 0;
    await runTelegramPolling(
      {
        getMe: async () => ({ id: 12345, username: 'JarvisBot' }),
        getUpdates: async (offset) => {
          assert.equal(offset, 201);
          polls++;
          if (polls > 1) abort.abort();
          return [
            {
              update_id: 200,
              message: {
                message_id: 9,
                text: '/status',
                from: { id: 42, is_bot: false },
                chat: { id: 42, type: 'private' },
              },
            },
          ];
        },
        sendMessage: async () => {
          sends++;
        },
      },
      [42],
      abort.signal,
      { agentJournal: recovered },
    );
    assert.equal(sends, 0);
  } finally {
    store.close();
  }
});

test('ENOSPC durante cifrado se informa de forma segura y limpia temporales', async (t) => {
  const f = fixture(t);
  const moduleUrl = pathToFileURL(
    resolve('src/infrastructure/state-backup.ts'),
  ).href;
  // Inject a real filesystem write failure in an isolated process, not a full operator disk.
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--input-type=module',
      '--eval',
      `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.createWriteStream;
    fs.createWriteStream=(path,opts)=>{ if(String(path).endsWith('encrypted.part')) { const e=new Error('PRIVATE_PATH_CANARY');e.code='ENOSPC';throw e; } return original(path,opts); };
    syncBuiltinESMExports();
    const {createStateBackup}=await import(${JSON.stringify(moduleUrl)});
    try {await createStateBackup({statePath:process.env.STATE,backupDirectory:process.env.BACKUPS,keyFile:process.env.KEY});process.exitCode=2}
    catch(e){process.stdout.write(e.message)}
  `,
    ],
    {
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        STATE: f.statePath,
        BACKUPS: f.backups,
        KEY: f.keyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.match(output, /No se pudo completar/);
  assert.ok(!output.includes('PRIVATE_PATH_CANARY'));
  assert.deepEqual(readdirSync(f.backups), []);
  f.store.assertExternalEffectsAllowed();
});

test(
  'conexión HTTPS perdida después de envío queda incierta y no se reintenta tras restore',
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    const server = await startEchoAgent({ mode: 'slow', delayMs: 2000 });
    t.after(() => server.close());
    const entry = registration();
    const config = parseTelegramAgentsConfig(
      {
        instance_id: 'jarvis-demo',
        subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
        agents: [
          {
            ...entry,
            connection: { ...entry.connection, base_url: server.origin },
          },
        ],
        allowed_endpoints: [{ origin: server.origin }],
        credential_variables: {
          'unused-request-reference': 'JARVIS_TEST_BEARER',
        },
        result_cache_ms: 1000,
      },
      [42],
    );
    const integration = createTelegramAgentIntegration(
      config,
      randomBytes(32).toString('base64url'),
      () => server.token,
      { store: f.store, network: loopbackPolicy(server.origin), ca: server.ca },
    );
    let commands = 0;
    let reply = '';
    const handle = createTelegramHandler(
      [42],
      'JarvisBot',
      {
        sendMessage: async (_chat, text) => {
          reply = text;
        },
      },
      {
        agentCommands: async (value, signal) => {
          commands++;
          return integration.commands(value, signal);
        },
        agentJournal: integration.journal!,
      },
      12345,
    );
    const update = {
      update_id: 90,
      message: {
        message_id: 90,
        text: '/agent demo.echo echo.reply Test',
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: 'private' },
      },
    };
    const execution = handle(update, new AbortController().signal);
    try {
      const deadline = Date.now() + 5000;
      while ((await server.stats()).executions === 0) {
        if (Date.now() > deadline)
          assert.fail('Request never reached HTTPS agent');
        await sleep(5);
      }
      await server.close(); // Real established socket disappears after the independent process accepted the POST.
      await execution;
      assert.equal(commands, 1);
      assert.ok(reply && !reply.includes(server.token));
      assert.equal(f.store.inspect().executions.uncertain, 1);
      const backup = await f.backup();
      const restored = await f.restore(join(f.backups, backup.file));
      assert.equal(restored.state.executions.uncertain, 1);
      assert.equal(restored.state.review.executions[0]?.phase, 'uncertain');
      const store = new SqliteStateStore({
        path: join(f.directory, 'restored', 'state.sqlite'),
      });
      try {
        assert.throws(() => store.reserveAction(action('unknown-after-loss')));
      } finally {
        store.close();
      }
      await handle(update, new AbortController().signal);
      assert.equal(commands, 1);
    } finally {
      integration.close();
    }
  },
);

test('ensayo local mide ventana RPO y RTO técnico hasta consulta ficticia tras revisión explícita', async (t) => {
  const f = fixture(t);
  const fx = registry();
  const secret = randomBytes(32).toString('base64url');
  const engine = new DurableAgentGateway(
    fx.registry,
    fx.catalog,
    {
      execute: async (value) => completed(value),
      getOperation: async () => assert.fail('No polling'),
    },
    f.store,
    secret,
    { resultCacheMs: 1000 },
  );
  const backup = await f.backup();
  await engine.execute(request(), new AbortController().signal);
  engine.close();
  const incidentAt = Date.now();
  const recoveryStart = performance.now();
  const restored = await f.restore(join(f.backups, backup.file));
  const store = new SqliteStateStore({
    path: join(f.directory, 'restored', 'state.sqlite'),
  });
  let calls = 0;
  const recovered = new DurableAgentGateway(
    fx.registry,
    fx.catalog,
    {
      execute: async (value) => {
        calls++;
        return completed(value);
      },
      getOperation: async () => assert.fail('No polling'),
    },
    store,
    secret,
    { resultCacheMs: 1000 },
  );
  try {
    await assert.rejects(
      recovered.execute(request(), new AbortController().signal),
      AgentGatewayError,
    );
    assert.equal(calls, 0);
    recovered.close();
    // Controlled test review: known lost operation counted from the independent live store.
    assert.equal(f.store.inspect().executions.completed, 1);
    assert.deepEqual(restored.state.executions, {});
    store.authorizeRecovery(
      restored.state.recovery.restoreId!,
      'e'.repeat(64),
      201,
      Date.now(),
    );
    const authorized = new DurableAgentGateway(
      fx.registry,
      fx.catalog,
      {
        execute: async (value) => {
          calls++;
          return completed(value);
        },
        getOperation: async () => assert.fail('No polling'),
      },
      store,
      secret,
      { resultCacheMs: 1000 },
    );
    try {
      assert.equal(
        (
          await authorized.execute(
            request({
              request_id: 'new-after-review',
              idempotency_key: 'new-after-review',
            }),
            new AbortController().signal,
          )
        ).status,
        'completed',
      );
    } finally {
      authorized.close();
    }
    assert.equal(calls, 1);
    t.diagnostic(
      JSON.stringify({
        scenario: 'controlled-local-recovery',
        knownOperationsMissingFromBackup: 1,
        rpoWindowMs: incidentAt - backup.metadata.snapshotStartedAt,
        restoreMs: restored.durationMs,
        technicalRtoIncludingSyntheticReviewMs: Math.round(
          performance.now() - recoveryStart,
        ),
        rssBytes: process.memoryUsage().rss,
        operatorReviewSimulated: true,
      }),
    );
  } finally {
    recovered.close();
    store.close();
  }
});
