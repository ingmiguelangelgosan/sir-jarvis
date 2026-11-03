import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { AgentGatewayError } from '../src/agents/errors.ts';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentGateway,
  AgentRegistration,
} from '../src/agents/protocol.ts';
import { InMemoryAgentRegistry } from '../src/agents/registry.ts';
import { AgentExecutionService } from '../src/app/agent-execution.ts';
import { AgentReadService, agentReadError } from '../src/app/agent-read.ts';
import { createTelegramAgentCommands } from '../src/channels/telegram/agent-commands.ts';
import {
  actor,
  completed,
  registration,
  schemas,
} from './agent-runtime.fixtures.ts';

const ids = {
  request_id: 'request',
  correlation_id: 'flow',
  idempotency_key: 'action',
};
const invocation = {
  agentId: 'demo.echo',
  capability: 'echo.reply',
  text: 'Hola Jarvis',
  ids,
};
const signal = () => new AbortController().signal;

function readsFixture(
  options: {
    readonly entries?: readonly AgentRegistration[];
    readonly execute?: (
      value: AgentExecutionRequest,
      signal: AbortSignal,
    ) => Promise<AgentExecutionResult>;
  } = {},
) {
  const registry = new InMemoryAgentRegistry(
    options.entries ?? [registration()],
    schemas(),
    ['https://echo.example.invalid'],
  );
  const calls: AgentExecutionRequest[] = [];
  const gateway: AgentGateway = {
    async execute(value, inputSignal) {
      calls.push(value);
      return options.execute
        ? options.execute(value, inputSignal)
        : { ...completed(value), output: value.input };
    },
    getOperation: async () => assert.fail('No automatic polling'),
  };
  return {
    reads: new AgentReadService(
      registry,
      new AgentExecutionService(registry, gateway),
    ),
    calls,
  };
}

test('caso de lectura valida actor, capacidad, coste e IDs antes del Gateway', async () => {
  const { reads, calls } = readsFixture();
  assert.equal(
    await reads.invoke(actor, invocation, signal()),
    'Respuesta del agente: Hola Jarvis',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.subject_ref, actor.subject_ref);
  assert.equal(calls[0]?.cost_policy, 'no-paid-services');
  assert.deepEqual(calls[0]?.input, { text: 'Hola Jarvis' });
  assert.equal(calls[0]?.idempotency_key, ids.idempotency_key);
  assert.ok(!JSON.stringify(calls).includes('credential'));
});

test('lectura rechaza inputs malformados, controles y campos de autoridad sin llamar Gateway', async () => {
  const { reads, calls } = readsFixture();
  for (const patch of [
    { text: '' },
    { text: ' '.repeat(3) },
    { text: 'x'.repeat(129) },
    { text: 'line\nbreak' },
    { text: 'hidden\u202eoverride' },
    { text: '\ud800' },
    { text: 'tab\there' },
    { subject_ref: 'chosen-by-message' },
    { input: { text: 'another' } },
    { cost_policy: 'paid' },
    { agentId: 'https://url.invalid' },
    { capability: '../write' },
    { ids: { ...ids, request_id: 'bad/id' } },
  ])
    assert.match(
      await reads.invoke(actor, { ...invocation, ...patch }, signal()),
      /consulta no es válida/,
    );
  assert.equal(calls.length, 0);
});

test('actor de otra instancia o sujeto no ejecuta la capacidad', async () => {
  const { reads, calls } = readsFixture();
  await reads.invoke({ ...actor, instance_id: 'other' }, invocation, signal());
  await reads.invoke({ ...actor, subject_ref: 'other' }, invocation, signal());
  assert.equal(calls.length, 0);
});

test('ni una capacidad write llamada echo.reply ni schema o versión distintos se pueden invocar', async () => {
  for (const patch of [
    { effect: 'write' as const },
    { input_schema_id: 'demo.output.v1' },
    { version: '2.0' },
  ]) {
    const entry = registration();
    const { reads, calls } = readsFixture({
      entries: [
        {
          ...entry,
          descriptor: {
            ...entry.descriptor,
            capabilities: entry.descriptor.capabilities.map((cap) => ({
              ...cap,
              ...patch,
            })),
          },
          permissions: entry.permissions.map((grant) => ({
            ...grant,
            capabilities: grant.capabilities.map((cap) => ({
              ...cap,
              version: 'version' in patch ? patch.version! : cap.version,
            })),
          })),
        },
      ],
    });
    assert.doesNotMatch(reads.list(actor), /demo.echo/);
    assert.match(
      await reads.invoke(actor, invocation, signal()),
      /No tienes acceso/,
    );
    assert.equal(calls.length, 0);
  }
});

test('listado no expone descripción, conexión, secretos, perfiles ajenos o agentes deshabilitados', () => {
  const base = registration();
  const entries = [
    {
      ...base,
      descriptor: {
        ...base.descriptor,
        name: 'private-name',
        capabilities: base.descriptor.capabilities.map((cap) => ({
          ...cap,
          description: 'private-description',
        })),
      },
    },
    registration({
      enabled: false,
      descriptor: { ...base.descriptor, agent_id: 'disabled' },
    }),
    registration({
      availability: 'unavailable',
      descriptor: { ...base.descriptor, agent_id: 'unavailable' },
    }),
    registration({
      permissions: [
        {
          subject_ref: 'other',
          capabilities: [{ name: 'echo.reply', version: '1.0' }],
        },
      ],
      descriptor: { ...base.descriptor, agent_id: 'other-subject' },
    }),
  ];
  const { reads, calls } = readsFixture({ entries });
  const list = reads.list(actor);
  assert.match(list, /demo.echo · echo.reply \(1.0\)/);
  assert.doesNotMatch(
    list,
    /private-|https|credential|unused-|disabled|unavailable|other-subject|owner-demo/,
  );
  assert.equal(
    reads.list({ ...actor, subject_ref: 'absent' }),
    'No tienes agentes de lectura disponibles.',
  );
  assert.equal(calls.length, 0);
});

test('listado amplio se limita a una respuesta Telegram y no ejecuta agentes', () => {
  const base = registration();
  const entries = Array.from({ length: 120 }, (_, i) =>
    registration({
      descriptor: {
        ...base.descriptor,
        agent_id: `agent${i}.${'a'.repeat(100)}`,
      },
    }),
  );
  const { reads, calls } = readsFixture({ entries });
  const list = reads.list(actor);
  assert.ok(list.length <= 3500);
  assert.match(list, /Lista limitada/);
  assert.equal(calls.length, 0);
});

test('salida del agente se muestra solo si es el echo exacto aprobado', async () => {
  for (const text of [
    'https://internal.invalid',
    'Bearer private-canary',
    'Otra respuesta',
    'bidi\u202e',
  ]) {
    const { reads } = readsFixture({
      execute: async (value) => ({ ...completed(value), output: { text } }),
    });
    const reply = await reads.invoke(actor, invocation, signal());
    assert.equal(
      reply,
      'El agente devolvió una respuesta que no puedo mostrar con seguridad.',
    );
    assert.ok(!reply.includes(text));
  }
});

test('pending no muestra operation_id, output ni promete finalización y no hace polling', async () => {
  const { reads } = readsFixture({
    execute: async (value) =>
      ({
        ...completed(value),
        status: 'pending',
        output: undefined,
        operation_id: 'private-operation',
        poll_after_ms: 1,
      }) as unknown as AgentExecutionResult,
  });
  const reply = await reads.invoke(actor, invocation, signal());
  assert.match(reply, /sigue pendiente/);
  assert.doesNotMatch(reply, /private-operation|completad/);
});

test('errores y estados inciertos se muestran seguros y sin mensajes del peer', async () => {
  for (const error of [
    new Error('https://private.invalid/Bearer-secret'),
    new AgentGatewayError('TIMEOUT', 'uncertain'),
    new AgentGatewayError('UNAVAILABLE', 'uncertain'),
    new AgentGatewayError('RATE_LIMITED'),
    new AgentGatewayError('AGENT_DISABLED'),
    new AgentGatewayError('CANCELLED'),
  ]) {
    const { reads } = readsFixture({
      execute: async () => {
        throw error;
      },
    });
    const reply = await reads.invoke(actor, invocation, signal());
    assert.doesNotMatch(reply, /private|Bearer|stack|Error:/);
    if (error instanceof AgentGatewayError && error.outcome === 'uncertain')
      assert.match(reply, /no está confirmado|No pude confirmar/);
  }
  assert.equal(
    agentReadError(new AgentGatewayError('CAPACITY_EXCEEDED')),
    'Jarvis no puede admitir más consultas de agentes en este momento.',
  );
});

test('adaptador usa botId autenticado estable, namespaces distintos y HMAC no derivado del texto', async () => {
  const { reads, calls } = readsFixture();
  const commands = createTelegramAgentCommands({
    instanceId: actor.instance_id,
    bindings: [{ telegram_user_id: 987654321, subject_ref: actor.subject_ref }],
    actionKey: randomBytes(32).toString('base64url'),
    reads,
  });
  const message = {
    userId: 987654321,
    chatId: 987654321,
    messageId: 876543219,
    botUsername: 'OldName',
    botId: 765432198,
    text: '/agent demo.echo echo.reply Hola',
  };
  await commands(message, signal());
  await commands(
    {
      ...message,
      botUsername: 'NewName',
      text: '/agent demo.echo echo.reply Otro',
    },
    signal(),
  );
  assert.equal(calls[0]?.request_id, calls[1]?.request_id);
  assert.equal(calls[0]?.correlation_id, calls[1]?.correlation_id);
  assert.equal(calls[0]?.idempotency_key, calls[1]?.idempotency_key);
  assert.notEqual(calls[0]?.request_id, calls[0]?.idempotency_key);
  const wire = JSON.stringify(calls);
  for (const id of [message.userId, message.messageId, message.botId])
    assert.ok(!wire.includes(String(id)));
});

test('cancelación previa y perfiles no vinculados no invocan el Core', async () => {
  const { reads, calls } = readsFixture();
  const controller = new AbortController();
  controller.abort();
  await reads.invoke(actor, invocation, controller.signal);
  const commands = createTelegramAgentCommands({
    instanceId: actor.instance_id,
    bindings: [],
    actionKey: randomBytes(32).toString('base64url'),
    reads,
  });
  assert.match(
    (await commands(
      {
        userId: 42,
        chatId: 42,
        messageId: 1,
        botUsername: 'JarvisBot',
        text: '/agents',
      },
      signal(),
    ))!,
    /perfil/,
  );
  assert.equal(calls.length, 0);
});

test('adaptador acota trabajo concurrente sin duplicar ni dejar nuevas invocaciones en cola', async () => {
  const releases: (() => void)[] = [];
  const { reads, calls } = readsFixture({
    execute: async (value) => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { ...completed(value), output: value.input };
    },
  });
  const commands = createTelegramAgentCommands({
    instanceId: actor.instance_id,
    bindings: [{ telegram_user_id: 42, subject_ref: actor.subject_ref }],
    actionKey: randomBytes(32).toString('base64url'),
    reads,
  });
  const message = {
    userId: 42,
    chatId: 42,
    messageId: 1,
    botUsername: 'JarvisBot',
    text: '/agent demo.echo echo.reply Hola',
  };
  const work = Array.from({ length: 8 }, (_, i) =>
    commands({ ...message, messageId: i + 1 }, signal()),
  );
  const rejected = await commands({ ...message, messageId: 9 }, signal());
  assert.match(rejected!, /otras consultas/);
  assert.equal(calls.length, 8);
  for (const release of releases) release();
  await Promise.all(work);
  assert.equal(calls.length, 8);
});
