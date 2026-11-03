import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createTelegramAgentIntegration,
  parseTelegramAgentsConfig,
  loadTelegramAgentIntegration,
} from '../src/app/telegram-agents.ts';
import { TelegramApiError } from '../src/channels/telegram/api.ts';
import { createTelegramHandler } from '../src/channels/telegram/handler.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import { registration } from './agent-runtime.fixtures.ts';
import { temporaryState } from './durable-test.fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const signal = () => new AbortController().signal;
const update = {
  update_id: 600,
  message: {
    message_id: 987654321,
    text: '/agent demo.echo echo.reply Hola Jarvis',
    from: { id: 123456789, is_bot: false },
    chat: { id: 123456789, type: 'private' },
  },
};
const clock = () => {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  };
};

for (const delivery of ['delivered', 'uncertain', '429'])
  test(`Telegram durable ${delivery}: reapertura no consulta ni reenvía el mensaje`, async (t) => {
    const file = temporaryState(t);
    const server = await startEchoAgent();
    t.after(() => server.close());
    const entry = registration();
    const config = parseTelegramAgentsConfig(
      {
        instance_id: 'jarvis-demo',
        subjects: [{ telegram_user_id: 123456789, subject_ref: 'owner-demo' }],
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
      [123456789],
    );
    const key = randomBytes(32).toString('base64url');
    let store = new SqliteStateStore({ path: file.path, create: true });
    let runtime = createTelegramAgentIntegration(
      config,
      key,
      () => server.token,
      { store, network: loopbackPolicy(server.origin), ca: server.ca },
    );
    let sends = 0;
    const handle = createTelegramHandler(
      [123456789],
      'JarvisBot',
      {
        sendMessage: async () => {
          sends += 1;
          if (delivery === 'uncertain') throw new TelegramApiError('transient');
          if (delivery === '429' && sends === 1)
            throw new TelegramApiError('rate-limit', 2000);
        },
      },
      {
        ...clock(),
        agentCommands: runtime.commands,
        agentJournal: runtime.journal!,
      },
      777777777,
    );
    await handle(update, signal());
    runtime.close();
    store.close();
    store = new SqliteStateStore({ path: file.path });
    runtime = createTelegramAgentIntegration(config, key, () => server.token, {
      store,
      network: loopbackPolicy(server.origin),
      ca: server.ca,
    });
    try {
      const recovered = createTelegramHandler(
        [123456789],
        'JarvisBot',
        { sendMessage: async () => assert.fail('No automatic resend') },
        {
          ...clock(),
          agentCommands: runtime.commands,
          agentJournal: runtime.journal!,
        },
        777777777,
      );
      await Promise.all(
        Array.from({ length: 20 }, () => recovered(update, signal())),
      );
      assert.equal((await server.stats()).executions, 1);
      assert.equal((await server.stats()).requests, 1);
      assert.equal(sends, delivery === '429' ? 2 : 1);
    } finally {
      runtime.close();
      store.close();
    }
    const bytes = readFileSync(file.path).toString('utf8');
    for (const privateValue of [
      '123456789',
      '987654321',
      '777777777',
      'Hola Jarvis',
      server.token,
      key,
    ])
      assert.ok(!bytes.includes(privateValue));
  });

test('journal conserva offset monotónico y el polling lo carga antes de getUpdates', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const config = parseTelegramAgentsConfig(
    {
      instance_id: 'jarvis-demo',
      subjects: [{ telegram_user_id: 123456789, subject_ref: 'owner-demo' }],
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
      result_cache_ms: 1000,
    },
    [123456789],
  );
  const key = randomBytes(32).toString('base64url');
  let runtime = createTelegramAgentIntegration(config, key, () => undefined, {
    store,
  });
  const controller = new AbortController();
  let polls = 0;
  await runTelegramPolling(
    {
      getMe: async () => ({ id: 777777777, username: 'JarvisBot' }),
      getUpdates: async () => {
        polls += 1;
        if (polls === 1)
          return [
            { ...update, message: { ...update.message, text: '/agents' } },
          ];
        controller.abort();
        return [];
      },
      sendMessage: async () => undefined,
    },
    [123456789],
    controller.signal,
    {
      ...clock(),
      agentCommands: runtime.commands,
      agentJournal: runtime.journal!,
    },
  );
  runtime.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  runtime = createTelegramAgentIntegration(config, key, () => undefined, {
    store: reopened,
  });
  try {
    const after = new AbortController();
    await runTelegramPolling(
      {
        getMe: async () => ({ id: 777777777, username: 'JarvisBot' }),
        getUpdates: async (offset) => {
          assert.equal(offset, 601);
          after.abort();
          return [];
        },
        sendMessage: async () => assert.fail('No response'),
      },
      [123456789],
      after.signal,
      {
        ...clock(),
        agentCommands: runtime.commands,
        agentJournal: runtime.journal!,
      },
    );
  } finally {
    runtime.close();
    reopened.close();
  }
});

test('clave o bindings cambiados no crean una historia silenciosamente nueva', (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const config = parseTelegramAgentsConfig(
    {
      instance_id: 'jarvis-demo',
      subjects: [{ telegram_user_id: 123456789, subject_ref: 'owner-demo' }],
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
      result_cache_ms: 1000,
    },
    [123456789],
  );
  const key = randomBytes(32).toString('base64url');
  const runtime = createTelegramAgentIntegration(config, key, () => undefined, {
    store,
  });
  runtime.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  try {
    assert.throws(() =>
      createTelegramAgentIntegration(
        config,
        randomBytes(32).toString('base64url'),
        () => undefined,
        { store: reopened },
      ),
    );
    assert.throws(() =>
      createTelegramAgentIntegration(
        { ...config, instance_id: 'other' },
        key,
        () => undefined,
        { store: reopened },
      ),
    );
  } finally {
    reopened.close();
  }
});

test('DB configurada ausente falla cerrado y no se crea implícitamente', (t) => {
  const file = temporaryState(t);
  const configPath = join(file.directory, 'agents.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      instance_id: 'jarvis-demo',
      subjects: [],
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
      result_cache_ms: 1000,
    }),
  );
  assert.throws(() =>
    loadTelegramAgentIntegration(
      {
        JARVIS_TELEGRAM_AGENTS_ENABLED: 'true',
        JARVIS_STATE_FILE: file.path,
        JARVIS_AGENTS_CONFIG_FILE: configPath,
        JARVIS_TELEGRAM_AGENT_KEY: randomBytes(32).toString('base64url'),
      },
      [123456789],
    ),
  );
  assert.equal(existsSync(file.path), false);
});

test('entrega iniciada antes de caída se conserva sin autoreenvío', (t) => {
  const file = temporaryState(t);
  const key = randomBytes(32).toString('base64url');
  const config = parseTelegramAgentsConfig(
    {
      instance_id: 'jarvis-demo',
      subjects: [{ telegram_user_id: 123456789, subject_ref: 'owner-demo' }],
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
      result_cache_ms: 1000,
    },
    [123456789],
  );
  const store = new SqliteStateStore({ path: file.path, create: true });
  const runtime = createTelegramAgentIntegration(config, key, () => undefined, {
    store,
  });
  const message = {
    userId: 123456789,
    chatId: 123456789,
    messageId: 987654321,
    botUsername: 'JarvisBot',
    botId: 777777777,
    text: update.message.text,
  };
  const action = runtime.journal!.reserve(message)!;
  runtime.journal!.result(action);
  runtime.journal!.deliveryPending(action);
  runtime.journal!.deliveryStarted(action);
  assert.equal(store.getAction(action)?.phase, 'delivery-started');
  runtime.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = createTelegramAgentIntegration(
    config,
    key,
    () => undefined,
    { store: reopened },
  );
  try {
    assert.equal(recovered.journal!.reserve(message), undefined);
    assert.equal(reopened.getAction(action)?.phase, 'delivery-started');
  } finally {
    recovered.close();
    reopened.close();
  }
});

test('fallo de reserva de canal bloquea callback y envío', async () => {
  let callbacks = 0;
  let sends = 0;
  const handle = createTelegramHandler(
    [123456789],
    'JarvisBot',
    {
      sendMessage: async () => {
        sends += 1;
      },
    },
    {
      agentCommands: async () => {
        callbacks += 1;
        return 'safe';
      },
      agentJournal: {
        reserve() {
          throw new Error('storage-private-canary');
        },
        result() {},
        deliveryPending() {},
        deliveryStarted() {},
        deliveryFinished() {},
        offset: () => undefined,
        advance() {},
      },
    },
    777777777,
  );
  await assert.rejects(handle(update, signal()));
  assert.equal(callbacks, 0);
  assert.equal(sends, 0);
});

test('fallo al persistir delivery-started impide Telegram y conserva evidencia incierta', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const { createDurableTelegramJournal } =
    await import('../src/channels/telegram/durable-actions.ts');
  const raw = createDurableTelegramJournal(
    store,
    randomBytes(32).toString('base64url'),
    'jarvis-demo',
  );
  let action: string | undefined;
  let sends = 0;
  const journal = {
    ...raw,
    reserve: (message: Parameters<typeof raw.reserve>[0]) => {
      action = raw.reserve(message);
      return action;
    },
    deliveryStarted() {
      throw new Error('private-path-error');
    },
  };
  const handle = createTelegramHandler(
    [123456789],
    'JarvisBot',
    {
      sendMessage: async () => {
        sends += 1;
      },
    },
    { agentCommands: async () => 'safe', agentJournal: journal },
    777777777,
  );
  try {
    await handle(update, signal());
    assert.equal(sends, 0);
    assert.equal(store.getAction(action!)?.phase, 'delivery-uncertain');
  } finally {
    store.close();
  }
});

test('fallo después del envío nunca se convierte en una segunda entrega', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const { createDurableTelegramJournal } =
    await import('../src/channels/telegram/durable-actions.ts');
  const key = randomBytes(32).toString('base64url');
  const raw = createDurableTelegramJournal(store, key, 'jarvis-demo');
  let action: string | undefined;
  let sends = 0;
  const journal = {
    ...raw,
    reserve: (message: Parameters<typeof raw.reserve>[0]) => {
      action = raw.reserve(message);
      return action;
    },
    deliveryFinished(
      value: string,
      phase: Parameters<typeof raw.deliveryFinished>[1],
    ) {
      if (phase === 'delivered') throw new Error('commit failure');
      raw.deliveryFinished(value, phase);
    },
  };
  const handle = createTelegramHandler(
    [123456789],
    'JarvisBot',
    {
      sendMessage: async () => {
        sends += 1;
      },
    },
    { agentCommands: async () => 'safe', agentJournal: journal },
    777777777,
  );
  await handle(update, signal());
  assert.equal(store.getAction(action!)?.phase, 'delivery-uncertain');
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = createDurableTelegramJournal(reopened, key, 'jarvis-demo');
  try {
    const after = createTelegramHandler(
      [123456789],
      'JarvisBot',
      {
        sendMessage: async () => {
          sends += 1;
        },
      },
      {
        agentCommands: async () => assert.fail('No callback'),
        agentJournal: recovered,
      },
      777777777,
    );
    await after(update, signal());
    assert.equal(sends, 1);
  } finally {
    reopened.close();
  }
});

test('fallo de offset detiene polling antes de reconocer o procesar otra actualización', async () => {
  let polls = 0;
  await assert.rejects(
    runTelegramPolling(
      {
        getMe: async () => ({ id: 777777777, username: 'JarvisBot' }),
        getUpdates: async () => {
          polls += 1;
          return [{ update_id: 600 }];
        },
        sendMessage: async () => assert.fail('No response'),
      },
      [123456789],
      signal(),
      {
        agentJournal: {
          reserve: () => undefined,
          result() {},
          deliveryPending() {},
          deliveryStarted() {},
          deliveryFinished() {},
          offset: () => undefined,
          advance() {
            throw new Error('storage unavailable');
          },
        },
      },
    ),
  );
  assert.equal(polls, 1);
});
