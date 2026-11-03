import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { AgentRegistration } from '../src/agents/protocol.ts';
import { respondToMessage } from '../src/app/assistant.ts';
import {
  createTelegramAgentIntegration,
  parseTelegramAgentsConfig,
} from '../src/app/telegram-agents.ts';
import {
  TelegramApiError,
  type TelegramApi,
  type TelegramUpdate,
} from '../src/channels/telegram/api.ts';
import { createTelegramHandler } from '../src/channels/telegram/handler.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import { registration } from './agent-runtime.fixtures.ts';
import {
  startEchoAgent,
  type EchoProcess,
  type EchoProcessOptions,
} from './https-process.ts';

const echoCommand = '/agent demo.echo echo.reply Hola Jarvis';
const freshSignal = () => new AbortController().signal;

function update(id = 1, text = echoCommand, userId = 42): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: 'private' },
    },
  };
}

function clock() {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    wait: async (milliseconds: number) => {
      waits.push(milliseconds);
      time += milliseconds;
    },
    waits,
  };
}

function configuration(
  server: EchoProcess,
  entry?: AgentRegistration,
  empty = false,
) {
  return parseTelegramAgentsConfig(
    {
      instance_id: 'jarvis-demo',
      subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
      agents: empty
        ? []
        : [
            entry ??
              registration({
                connection: {
                  ...registration().connection,
                  base_url: server.origin,
                },
              }),
          ],
      allowed_endpoints: empty ? [] : [{ origin: server.origin }],
      credential_variables: empty
        ? {}
        : { 'unused-request-reference': 'JARVIS_TEST_BEARER' },
      result_cache_ms: 1000,
    },
    [42, 43],
  );
}

interface Scenario {
  readonly server?: EchoProcessOptions;
  readonly entry?: (entry: AgentRegistration) => AgentRegistration;
  readonly empty?: boolean;
  readonly timeoutMs?: number;
  readonly wrongToken?: boolean;
}

async function setup(t: TestContext, scenario: Scenario = {}) {
  const server = await startEchoAgent(scenario.server);
  t.after(() => server.close());
  const entry = registration({
    connection: { ...registration().connection, base_url: server.origin },
  });
  const config = configuration(
    server,
    scenario.entry?.(entry) ?? entry,
    scenario.empty,
  );
  const actionKey = randomBytes(32).toString('base64url');
  const integration = createTelegramAgentIntegration(
    config,
    actionKey,
    (name) =>
      name === 'JARVIS_TEST_BEARER'
        ? scenario.wrongToken
          ? randomBytes(32).toString('base64url')
          : server.token
        : undefined,
    {
      network: loopbackPolicy(server.origin),
      ca: server.ca,
      ...(scenario.timeoutMs === undefined
        ? {}
        : { timeoutMs: scenario.timeoutMs }),
    },
  );
  t.after(() => integration.close());
  const replies: { chatId: number; text: string }[] = [];
  const timeline = clock();
  const api: TelegramApi = {
    getMe: async () => ({ id: 12345, username: 'JarvisBot' }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => {
      replies.push({ chatId, text });
    },
  };
  const hooks = { ...timeline, agentCommands: integration.commands };
  const handle = createTelegramHandler([42, 43], 'JarvisBot', api, hooks);
  return {
    server,
    config,
    actionKey,
    integration,
    api,
    hooks,
    replies,
    timeline,
    handle,
  };
}

test('E2E polling Telegram simulado → Core → Gateway HTTPS → Echo independiente → Telegram', async (t) => {
  const { server, api, hooks, replies } = await setup(t);
  const controller = new AbortController();
  const offsets: (number | undefined)[] = [];
  api.getUpdates = async (offset) => {
    offsets.push(offset);
    if (offsets.length === 1) return [update(1, '/agents'), update(2)];
    controller.abort();
    return [];
  };
  await runTelegramPolling(api, [42], controller.signal, hooks);
  assert.deepEqual(offsets, [undefined, 3]);
  assert.equal(replies.length, 2);
  assert.match(replies[0]!.text, /demo\.echo · echo\.reply \(1\.0\)/);
  assert.deepEqual(replies[1], {
    chatId: 42,
    text: 'Respuesta del agente: Hola Jarvis',
  });
  assert.deepEqual(await server.stats(), {
    requests: 1,
    executions: 1,
    polls: 0,
    unauthorized: 0,
    duplicates: 0,
  });
  assert.equal(server.diagnosticsBytes(), 0);
});

test('E2E allowlist, chat privado y remitente coherente se comprueban antes de HTTPS', async (t) => {
  const { server, handle, replies } = await setup(t);
  const message = (update().message ?? {}) as Record<string, unknown>;
  for (const candidate of [
    update(1, echoCommand, 99),
    {
      update_id: 2,
      message: { ...message, message_id: 2, chat: { id: -42, type: 'group' } },
    },
    {
      update_id: 3,
      message: { ...message, message_id: 3, chat: { id: 43, type: 'private' } },
    },
    {
      update_id: 4,
      message: { ...message, message_id: 4, from: { id: 42, is_bot: true } },
    },
    {
      update_id: 5,
      message: { ...message, message_id: 5, sender_chat: { id: 42 } },
    },
    update(6, '/agent@OtherBot demo.echo echo.reply Hola'),
  ])
    await handle(candidate, freshSignal());
  assert.equal(replies.length, 0);
  assert.equal((await server.stats()).requests, 0);
});

test('E2E usuario permitido sin binding no obtiene identidad del texto', async (t) => {
  const { server, handle, replies } = await setup(t);
  await handle(
    update(1, `${echoCommand} subject_ref=owner-demo`, 43),
    freshSignal(),
  );
  assert.deepEqual(
    replies.map((reply) => reply.text),
    ['No tienes un perfil de agentes habilitado.'],
  );
  assert.equal((await server.stats()).requests, 0);
});

test('E2E /agents expone solo IDs/capacidades autorizadas, sin conexión o credenciales', async (t) => {
  const { server, handle, replies } = await setup(t, {
    entry: (entry) => ({
      ...entry,
      descriptor: {
        ...entry.descriptor,
        name: 'private-label',
        capabilities: [
          ...entry.descriptor.capabilities,
          {
            ...entry.descriptor.capabilities[0]!,
            name: 'echo.hidden',
            description: 'private-description',
          },
        ],
      },
    }),
  });
  await handle(update(1, '/agents@JarvisBot'), freshSignal());
  const text = replies[0]!.text;
  assert.match(text, /demo\.echo/);
  for (const privateValue of [
    server.origin,
    server.token,
    'unused-request-reference',
    'unused-event-reference',
    'private-label',
    'private-description',
    'echo.hidden',
    'owner-demo',
    'jarvis-demo',
  ])
    assert.ok(!text.includes(privateValue));
  assert.ok(text.length <= 4096);
  assert.equal((await server.stats()).requests, 0);
});

test('E2E formato y tamaño inválidos no producen efectos', async (t) => {
  const { server, handle, replies } = await setup(t);
  const malformed = [
    '/agent',
    '/agent demo.echo',
    '/agent demo.echo echo.reply',
    '/agents extra',
    '/agent https://unapproved.example echo.reply Hola',
    `/agent demo.echo echo.reply ${'x'.repeat(129)}`,
    '/agent demo.echo echo.reply Hola\nsegunda línea',
    '/agent demo.echo echo.reply Hola\u202eoculto',
  ];
  for (const [index, text] of malformed.entries())
    await handle(update(index + 1, text), freshSignal());
  assert.equal(replies.length, malformed.length);
  assert.ok(
    replies.every(
      (reply) =>
        !reply.text.includes('unapproved.example') &&
        !reply.text.includes('\u202e'),
    ),
  );
  assert.equal((await server.stats()).requests, 0);
});

test('E2E agente desconocido y capacidad no autorizada se explican sin conectar', async (t) => {
  const { server, handle, replies } = await setup(t, {
    entry: (entry) => ({
      ...entry,
      descriptor: {
        ...entry.descriptor,
        capabilities: [
          ...entry.descriptor.capabilities,
          { ...entry.descriptor.capabilities[0]!, name: 'echo.hidden' },
        ],
      },
    }),
  });
  await handle(update(1, '/agent unknown echo.reply Hola'), freshSignal());
  await handle(update(2, '/agent demo.echo echo.hidden Hola'), freshSignal());
  assert.match(replies[0]!.text, /agente no está disponible/);
  assert.match(replies[1]!.text, /No tienes acceso/);
  assert.equal((await server.stats()).requests, 0);
});

for (const scenario of [
  {
    label: 'deshabilitado',
    entry: (entry: AgentRegistration) => ({ ...entry, enabled: false }),
  },
  {
    label: 'sin permiso',
    entry: (entry: AgentRegistration) => ({ ...entry, permissions: [] }),
  },
  {
    label: 'de escritura',
    entry: (entry: AgentRegistration) => ({
      ...entry,
      descriptor: {
        ...entry.descriptor,
        capabilities: entry.descriptor.capabilities.map((capability) => ({
          ...capability,
          effect: 'write' as const,
        })),
      },
    }),
  },
])
  test(`E2E agente ${scenario.label} no aparece en /agents ni se ejecuta`, async (t) => {
    const { server, handle, replies } = await setup(t, scenario);
    await handle(update(1, '/agents'), freshSignal());
    await handle(update(2), freshSignal());
    assert.equal(replies[0]!.text, 'No tienes agentes de lectura disponibles.');
    assert.ok(!replies[1]!.text.startsWith('Respuesta del agente:'));
    assert.equal((await server.stats()).requests, 0);
  });

test('E2E cincuenta updates duplicados concurrentes causan un efecto y una respuesta', async (t) => {
  const { server, handle, replies } = await setup(t, {
    server: { mode: 'slow', delayMs: 60 },
  });
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      handle({ ...update(), update_id: index + 1 }, freshSignal()),
    ),
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.text, 'Respuesta del agente: Hola Jarvis');
  assert.equal((await server.stats()).executions, 1);
  assert.equal((await server.stats()).requests, 1);
});

test('E2E HMAC estable reutiliza la reserva y un cambio de texto no genera otra clave', async (t) => {
  const { server, api, hooks, handle, replies } = await setup(t);
  await handle(update(), freshSignal());
  const anotherHandler = createTelegramHandler([42], 'JarvisBot', api, hooks);
  await anotherHandler(update(), freshSignal());
  assert.equal((await server.stats()).requests, 1);
  assert.equal(replies.length, 2);
  const changedHandler = createTelegramHandler([42], 'JarvisBot', api, hooks);
  await changedHandler(
    update(1, '/agent demo.echo echo.reply Otro texto'),
    freshSignal(),
  );
  assert.match(replies.at(-1)!.text, /otra consulta/);
  assert.equal((await server.stats()).requests, 1);
});

test('E2E HMAC conserva identidad lógica al recomponer el Gateway con la misma clave', async (t) => {
  const { server, config, actionKey, handle, api, timeline, replies } =
    await setup(t);
  await handle(update(), freshSignal());
  const replacement = createTelegramAgentIntegration(
    config,
    actionKey,
    () => server.token,
    { network: loopbackPolicy(server.origin), ca: server.ca },
  );
  t.after(() => replacement.close());
  await createTelegramHandler([42], 'JarvisBot', api, {
    ...timeline,
    agentCommands: replacement.commands,
  })(update(), freshSignal());
  assert.equal(replies.length, 2);
  assert.equal((await server.stats()).requests, 2);
  assert.equal((await server.stats()).executions, 1);
  assert.equal((await server.stats()).duplicates, 1);
});

test('E2E429 al responder Telegram reintenta solo la entrega, nunca la consulta HTTPS', async (t) => {
  const { server, api, hooks, replies, timeline } = await setup(t);
  let attempts = 0;
  const send = api.sendMessage;
  api.sendMessage = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new TelegramApiError('rate-limit', 2000);
    await send(...args);
  };
  await createTelegramHandler(
    [42],
    'JarvisBot',
    api,
    hooks,
  )(update(), freshSignal());
  assert.equal(attempts, 2);
  assert.equal(replies.length, 1);
  assert.deepEqual(timeline.waits, [2000]);
  assert.equal((await server.stats()).requests, 1);
});

test('E2E pending se presenta sin inventar éxito, mostrar IDs o iniciar polling', async (t) => {
  const { server, handle, replies } = await setup(t, {
    server: { mode: 'pending' },
  });
  await handle(update(), freshSignal());
  assert.match(replies[0]!.text, /sigue pendiente/);
  assert.ok(!replies[0]!.text.includes('operation-'));
  assert.ok(!replies[0]!.text.includes('Respuesta del agente:'));
  assert.equal((await server.stats()).polls, 0);
});

test('E2E timeout tras aceptar la consulta queda incierto sin reejecución', async (t) => {
  const { server, handle, replies, api, hooks } = await setup(t, {
    server: { mode: 'slow', delayMs: 1500 },
    timeoutMs: 600,
  });
  await handle(update(), freshSignal());
  assert.equal((await server.stats()).executions, 1);
  assert.match(replies[0]!.text, /resultado no está confirmado/);
  await createTelegramHandler(
    [42],
    'JarvisBot',
    api,
    hooks,
  )(update(), freshSignal());
  assert.match(replies[1]!.text, /resultado no está confirmado/);
  assert.equal((await server.stats()).requests, 1);
});

test('E2E abort después de dispatch no responde ni vuelve a ejecutar el mensaje', async (t) => {
  const { server, handle, replies, api, hooks } = await setup(t, {
    server: { mode: 'slow', delayMs: 1500 },
  });
  const controller = new AbortController();
  const operation = handle(update(), controller.signal);
  for (
    let attempt = 0;
    attempt < 200 && (await server.stats()).executions === 0;
    attempt += 1
  )
    await delay(5);
  assert.equal((await server.stats()).executions, 1);
  controller.abort();
  await operation;
  assert.equal(replies.length, 0);
  await handle(update(), freshSignal());
  assert.equal(replies.length, 0);
  await createTelegramHandler(
    [42],
    'JarvisBot',
    api,
    hooks,
  )(update(), freshSignal());
  assert.match(replies[0]!.text, /canceló la espera/);
  assert.equal((await server.stats()).requests, 1);
});

for (const mode of [
  'malformed',
  'cross-subject',
  'version',
  'failed',
  'raw-unavailable',
] as const)
  test(`E2E fallo ${mode} se convierte en una respuesta segura`, async (t) => {
    const { server, handle, replies } = await setup(t, { server: { mode } });
    await handle(update(), freshSignal());
    const text = replies[0]!.text;
    assert.ok(!text.startsWith('Respuesta del agente:'));
    for (const privateValue of [
      server.origin,
      server.token,
      'request_id',
      'protocol_version',
      'execution-result',
      'unused-request-reference',
    ])
      assert.ok(!text.includes(privateValue));
    assert.equal((await server.stats()).requests, 1);
    assert.equal(server.diagnosticsBytes(), 0);
  });

test('E2E unavailable estructurado se reintenta de forma segura para la lectura', async (t) => {
  const { server, handle, replies } = await setup(t, {
    server: { mode: 'unavailable', failures: 1 },
  });
  await handle(update(), freshSignal());
  assert.equal(replies[0]!.text, 'Respuesta del agente: Hola Jarvis');
  assert.equal((await server.stats()).requests, 2);
  assert.equal((await server.stats()).executions, 1);
});

test('E2E integración deshabilitada mantiene fallback y comandos históricos', async (t) => {
  const { server, api, timeline, replies } = await setup(t);
  const disabled = createTelegramHandler([42], 'JarvisBot', api, timeline);
  for (const [index, text] of [
    '/start',
    '/status',
    '/agents',
    echoCommand,
    '/unknown',
  ].entries())
    await disabled(update(index + 1, text), freshSignal());
  assert.equal(replies[0]!.text, respondToMessage('start'));
  assert.equal(replies[1]!.text, respondToMessage('status'));
  assert.ok(
    replies
      .slice(2)
      .every((reply) => reply.text === respondToMessage('unsupported')),
  );
  assert.equal((await server.stats()).requests, 0);
});

test('E2E integración habilitada sin agentes inicia y conserva /start y /status', async (t) => {
  const { server, handle, replies } = await setup(t, { empty: true });
  for (const [index, text] of [
    '/start',
    '/status',
    '/agents',
    echoCommand,
  ].entries())
    await handle(update(index + 1, text), freshSignal());
  assert.equal(replies[0]!.text, respondToMessage('start'));
  assert.equal(replies[1]!.text, respondToMessage('status'));
  assert.equal(replies[2]!.text, 'No tienes agentes de lectura disponibles.');
  assert.match(replies[3]!.text, /agente no está disponible/);
  assert.equal((await server.stats()).requests, 0);
});
