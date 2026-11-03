import assert from 'node:assert/strict';
import {
  setImmediate as nextTurn,
  setTimeout as pause,
} from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { inspect } from 'node:util';
import { z } from 'zod';

import {
  AgentGatewayError,
  AgentTransportError,
  type ExecutionOutcome,
  type GatewayErrorCode,
} from '../src/agents/errors.ts';
import {
  InMemoryAgentGateway,
  type GatewayOptions,
} from '../src/agents/gateway.ts';
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentOperationQuery,
} from '../src/agents/protocol.ts';
import { InMemoryAgentRegistry } from '../src/agents/registry.ts';
import type { AgentTransport } from '../src/agents/transport.ts';
import { CapabilitySchemaCatalog } from '../src/agents/validation.ts';

type ResultContext = Pick<
  AgentExecutionRequest,
  'instance_id' | 'agent_id' | 'subject_ref' | 'request_id' | 'correlation_id'
>;

function request(
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    protocol_version: '1.0',
    kind: 'execute',
    instance_id: 'jarvis-demo',
    agent_id: 'demo.echo',
    subject_ref: 'owner-demo',
    correlation_id: 'flow-demo-001',
    request_id: 'request-demo-001',
    idempotency_key: 'effect-demo-001',
    capability: { name: 'echo.reply', version: '1.0' },
    deadline_at: new Date(Date.now() + 10_000).toISOString(),
    cost_policy: 'no-paid-services',
    input: { text: 'Texto ficticio.' },
    ...overrides,
  };
}

function resultEnvelope(context: ResultContext) {
  return {
    protocol_version: '1.0',
    kind: 'execution-result',
    instance_id: context.instance_id,
    agent_id: context.agent_id,
    subject_ref: context.subject_ref,
    correlation_id: context.correlation_id,
    request_id: context.request_id,
  } as const;
}

function completed(context: ResultContext, text = 'Respuesta ficticia.') {
  return {
    ...resultEnvelope(context),
    status: 'completed',
    output: { text },
  } satisfies AgentExecutionResult;
}

function pending(context: ResultContext, operationId = 'operation-demo-001') {
  return {
    ...resultEnvelope(context),
    status: 'pending',
    operation_id: operationId,
    poll_after_ms: 1,
  } satisfies AgentExecutionResult;
}

function operationQuery(context: ResultContext): AgentOperationQuery {
  return {
    protocol_version: '1.0',
    instance_id: context.instance_id,
    agent_id: context.agent_id,
    subject_ref: context.subject_ref,
    correlation_id: context.correlation_id,
    request_id: context.request_id,
    operation_id: 'operation-demo-001',
  };
}

interface FixtureOptions {
  readonly execute?: AgentTransport['execute'];
  readonly getOperation?: AgentTransport['getOperation'];
  readonly gateway?: Partial<GatewayOptions>;
  readonly capability?: Partial<AgentCapability>;
  readonly outputSchema?: { parse(value: unknown): unknown };
}

function fixture(context: TestContext, options: FixtureOptions = {}) {
  const schemas = new CapabilitySchemaCatalog([
    {
      id: 'demo.echo.input.v1',
      schema: z.strictObject({
        text: z.string().max(512),
        count: z.number().int().optional(),
      }),
    },
    {
      id: 'demo.echo.output.v1',
      schema:
        options.outputSchema ?? z.strictObject({ text: z.string().max(512) }),
    },
  ]);
  const capability = {
    name: 'echo.reply',
    version: '1.0',
    description: 'Capacidad ficticia local de pruebas.',
    effect: 'read',
    supports_idempotency: true,
    input_schema_id: 'demo.echo.input.v1',
    output_schema_id: 'demo.echo.output.v1',
    ...options.capability,
  } satisfies AgentCapability;
  const registry = new InMemoryAgentRegistry(
    [
      {
        instance_id: 'jarvis-demo',
        descriptor: {
          protocol_version: '1.0',
          agent_id: 'demo.echo',
          agent_version: '0.1.0',
          name: 'Agente ficticio',
          capabilities: [capability],
        },
        enabled: true,
        availability: 'available',
        connection: {
          base_url: 'https://echo.example.invalid',
          request_credential_ref: 'demo-request-reference',
          event_key_ref: 'demo-event-reference',
        },
        permissions: ['owner-demo', 'second-demo'].map((subject_ref) => ({
          subject_ref,
          capabilities: [
            { name: capability.name, version: capability.version },
          ],
        })),
      },
    ],
    schemas,
    ['https://echo.example.invalid'],
  );
  const transport: AgentTransport = {
    execute: options.execute ?? (async (value) => completed(value)),
    getOperation: options.getOperation ?? (async (value) => completed(value)),
  };
  const gateway = new InMemoryAgentGateway(registry, schemas, transport, {
    resultCacheMs: 5_000,
    jitter: () => 0,
    ...options.gateway,
  });
  context.after(() => gateway.close());
  return gateway;
}

function safeError(code?: GatewayErrorCode, outcome?: ExecutionOutcome) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AgentGatewayError);
    if (code !== undefined) assert.equal(error.code, code);
    if (outcome !== undefined) assert.equal(error.outcome, outcome);
    assert.equal(
      inspect(error, { depth: 10 }).includes('canario-privado'),
      false,
    );
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('ejecuciones idénticas concurrentes comparten un único dispatch y resultado', async (context) => {
  const dispatched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<unknown>();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      dispatched.resolve();
      return remote.promise;
    },
  });
  const command = request();
  const first = gateway.execute(command, new AbortController().signal);
  const second = gateway.execute({ ...command }, new AbortController().signal);
  await dispatched.promise;
  assert.equal(calls, 1);
  remote.resolve(completed(command));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, completed(command));
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls, 1);
});

test('el fingerprint ignora orden de propiedades y deadline sin crear otro efecto', async (context) => {
  const remote = Promise.withResolvers<unknown>();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      return remote.promise;
    },
  });
  const command = request({ input: { text: 'Texto ficticio.', count: 2 } });
  const first = gateway.execute(command, new AbortController().signal);
  const second = gateway.execute(
    {
      ...command,
      input: { count: 2, text: 'Texto ficticio.' },
      deadline_at: new Date(Date.now() + 20_000).toISOString(),
    },
    new AbortController().signal,
  );
  remote.resolve(completed(command));
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

for (const changed of [
  { input: { text: 'Otro contenido ficticio.' } },
  { request_id: 'request-demo-distinto' },
  { correlation_id: 'flow-demo-distinto' },
]) {
  test(`misma clave con ${Object.keys(changed)[0]} distinto devuelve 409 sin otro dispatch`, async (context) => {
    const remote = Promise.withResolvers<unknown>();
    let calls = 0;
    const gateway = fixture(context, {
      execute: async () => {
        calls += 1;
        return remote.promise;
      },
    });
    const command = request();
    const first = gateway.execute(command, new AbortController().signal);
    await assert.rejects(
      gateway.execute({ ...command, ...changed }, new AbortController().signal),
      (error: unknown) => {
        safeError('IDEMPOTENCY_CONFLICT')(error);
        assert.ok(error instanceof AgentGatewayError);
        assert.equal(error.httpStatus, 409);
        return true;
      },
    );
    assert.equal(calls, 1);
    remote.resolve(completed(command));
    await first;
  });
}

test('la misma clave de sujetos autorizados distintos no mezcla sus resultados', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed(value, value.subject_ref);
    },
  });
  const first = request();
  const second = { ...first, subject_ref: 'second-demo' };
  assert.deepEqual(
    await gateway.execute(first, new AbortController().signal),
    completed(first, 'owner-demo'),
  );
  assert.deepEqual(
    await gateway.execute(second, new AbortController().signal),
    completed(second, 'second-demo'),
  );
  assert.equal(calls, 2);
});

test('cancelación anterior al dispatch no inicia el transporte ni reserva un efecto incierto', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed(value);
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('canario-privado'));
  const command = request();
  await assert.rejects(
    gateway.execute(command, controller.signal),
    safeError('CANCELLED', 'not-started'),
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    completed(command),
  );
  assert.equal(calls, 1);
});

test('cancelar un waiter no cancela la operación que otro todavía espera', async (context) => {
  const dispatched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<unknown>();
  let transportSignal: AbortSignal | undefined;
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      transportSignal = signal;
      dispatched.resolve();
      return remote.promise;
    },
  });
  const controller = new AbortController();
  const command = request();
  const first = gateway.execute(command, controller.signal);
  const firstRejected = assert.rejects(
    first,
    safeError('CANCELLED', 'uncertain'),
  );
  const second = gateway.execute(command, new AbortController().signal);
  await dispatched.promise;
  controller.abort();
  await firstRejected;
  assert.equal(transportSignal?.aborted, false);
  remote.resolve(completed(command));
  assert.deepEqual(await second, completed(command));
});

test('cancelar el último waiter aborta transporte y conserva inmediatamente el tombstone', async (context) => {
  const dispatched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<unknown>();
  let transportSignal: AbortSignal | undefined;
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      calls += 1;
      transportSignal = signal;
      dispatched.resolve();
      return remote.promise;
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const command = request();
  const firstRejected = assert.rejects(
    gateway.execute(command, firstController.signal),
    safeError('CANCELLED', 'uncertain'),
  );
  const secondRejected = assert.rejects(
    gateway.execute(command, secondController.signal),
    safeError('CANCELLED', 'uncertain'),
  );
  await dispatched.promise;
  firstController.abort();
  secondController.abort();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(transportSignal?.aborted, true);
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CANCELLED', 'uncertain'),
  );
  remote.resolve(completed(command));
  await nextTurn();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CANCELLED', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('un transporte reentrante no consigue un segundo dispatch de la misma clave', async (context) => {
  let inner: Promise<AgentExecutionResult> | undefined;
  let calls = 0;
  const gateway: InMemoryAgentGateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      assert.equal(calls, 1);
      inner = gateway.execute(value, new AbortController().signal);
      return completed(value);
    },
  });
  const command = request();
  const outer = await gateway.execute(command, new AbortController().signal);
  assert.ok(inner);
  assert.deepEqual(await inner, outer);
  assert.equal(calls, 1);
});

test('un abort reentrante durante dispatch no deja un waiter colgado ni permite repetir', async (context) => {
  const controller = new AbortController();
  const remote = Promise.withResolvers<unknown>();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      controller.abort();
      return remote.promise;
    },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, controller.signal),
    safeError('CANCELLED', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CANCELLED', 'uncertain'),
  );
  assert.equal(calls, 1);
  remote.resolve(completed(command));
});

test('timeout local limita un transporte que ignora la señal y descarta la respuesta tardía', async (context) => {
  const remote = Promise.withResolvers<unknown>();
  let calls = 0;
  let transportSignal: AbortSignal | undefined;
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      calls += 1;
      transportSignal = signal;
      return remote.promise;
    },
    gateway: { attemptTimeoutMs: 20, totalTimeoutMs: 100 },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.equal(transportSignal?.aborted, true);
  remote.resolve(completed(command));
  await nextTurn();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('el deadline de un follower no extiende el trabajo reservado por el primero', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    gateway: { attemptTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
  });
  const command = request({
    deadline_at: new Date(Date.now() + 40).toISOString(),
  });
  const first = assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  const second = assert.rejects(
    gateway.execute(
      { ...command, deadline_at: new Date(Date.now() + 10_000).toISOString() },
      new AbortController().signal,
    ),
    safeError('TIMEOUT', 'uncertain'),
  );
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('el caché completed caduca y conserva la clave sin reejecutar ni liberar capacidad', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed(value);
    },
    gateway: { resultCacheMs: 20, maxRecords: 1 },
  });
  const command = request();
  const original = await gateway.execute(command, new AbortController().signal);
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    original,
  );
  await pause(50);
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  await assert.rejects(
    gateway.execute(
      request({
        request_id: 'request-demo-002',
        idempotency_key: 'effect-demo-002',
      }),
      new AbortController().signal,
    ),
    safeError('CAPACITY_EXCEEDED', 'not-started'),
  );
  assert.equal(calls, 1);
});

test('el máximo de waiters incluye al inicial y no cancela al que conserva el cupo', async (context) => {
  const remote = Promise.withResolvers<unknown>();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      return remote.promise;
    },
    gateway: { maxWaiters: 1 },
  });
  const command = request();
  const first = gateway.execute(command, new AbortController().signal);
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CAPACITY_EXCEEDED'),
  );
  remote.resolve(completed(command));
  assert.deepEqual(await first, completed(command));
  assert.equal(calls, 1);
});

for (const capability of [
  { effect: 'read', supports_idempotency: false },
  { effect: 'write', supports_idempotency: true },
] as const) {
  test(`unavailable se reintenta con seguridad para ${capability.effect}/idempotente=${capability.supports_idempotency}`, async (context) => {
    let now = Date.now();
    const waits: number[] = [];
    let calls = 0;
    const gateway = fixture(context, {
      capability,
      execute: async (value) => {
        calls += 1;
        if (calls < 3) throw new AgentTransportError('unavailable');
        return completed(value);
      },
      gateway: {
        now: () => now,
        wait: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    });
    const command = request({
      deadline_at: new Date(now + 10_000).toISOString(),
    });
    assert.deepEqual(
      await gateway.execute(command, new AbortController().signal),
      completed(command),
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1_000, 2_000]);
  });
}

test('una escritura sin garantía de idempotencia no se repite ante unavailable', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    capability: { effect: 'write', supports_idempotency: false },
    execute: async () => {
      calls += 1;
      throw new AgentTransportError('unavailable');
    },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('UNAVAILABLE', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('UNAVAILABLE', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('429 respeta cada espera del proveedor y permite reintento de una escritura rechazada', async (context) => {
  let now = Date.now();
  const dispatchTimes: number[] = [];
  const waits: number[] = [];
  const gateway = fixture(context, {
    capability: { effect: 'write', supports_idempotency: false },
    execute: async (value) => {
      dispatchTimes.push(now);
      if (dispatchTimes.length === 1)
        throw new AgentTransportError('rate-limit', 2_500);
      if (dispatchTimes.length === 2)
        throw new AgentTransportError('rate-limit', 3_500);
      return completed(value);
    },
    gateway: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  });
  const command = request({
    deadline_at: new Date(now + 10_000).toISOString(),
  });
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    completed(command),
  );
  assert.equal(dispatchTimes.length, 3);
  assert.ok((dispatchTimes[1] ?? 0) - (dispatchTimes[0] ?? 0) >= 2_500);
  assert.ok((dispatchTimes[2] ?? 0) - (dispatchTimes[1] ?? 0) >= 3_500);
  assert.ok(waits.every((value) => value > 0));
});

test('un error desconocido no se reintenta ni conserva mensajes privados del transporte', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      throw new Error('canario-privado: URL y detalles internos ficticios');
    },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError(undefined, 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError(undefined, 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('pending se consulta con IDs originales y completar actualiza execute y caché de consulta', async (context) => {
  let now = Date.now();
  let executes = 0;
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      executes += 1;
      return pending(value);
    },
    getOperation: async (value) => {
      polls += 1;
      return completed(value);
    },
    gateway: { now: () => now },
  });
  const command = request();
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    pending(command),
  );
  now += 1;
  const query = operationQuery(command);
  const terminal = await gateway.getOperation(
    query,
    new AbortController().signal,
  );
  assert.deepEqual(terminal, completed(command));
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    terminal,
  );
  assert.deepEqual(
    await gateway.getOperation(query, new AbortController().signal),
    terminal,
  );
  assert.equal(executes, 1);
  assert.equal(polls, 1);
});

test('consultas pending concurrentes comparten un único getOperation', async (context) => {
  let now = Date.now();
  const remote = Promise.withResolvers<unknown>();
  const dispatched = Promise.withResolvers<void>();
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => pending(value),
    getOperation: async () => {
      polls += 1;
      dispatched.resolve();
      return remote.promise;
    },
    gateway: { now: () => now },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  const query = operationQuery(command);
  const first = gateway.getOperation(query, new AbortController().signal);
  const second = gateway.getOperation(query, new AbortController().signal);
  await dispatched.promise;
  assert.equal(polls, 1);
  remote.resolve(completed(command));
  assert.deepEqual(await first, await second);
  assert.equal(polls, 1);
});

test('IDs cruzados de una query se rechazan sin invocar el transporte', async (context) => {
  let now = Date.now();
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => pending(value),
    getOperation: async (value) => {
      polls += 1;
      return completed(value);
    },
    gateway: { now: () => now },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  for (const changed of [
    { subject_ref: 'second-demo' },
    { request_id: 'other-request' },
    { correlation_id: 'other-correlation' },
    { operation_id: 'other-operation' },
  ]) {
    await assert.rejects(
      gateway.getOperation(
        { ...operationQuery(command), ...changed },
        new AbortController().signal,
      ),
      safeError(),
    );
  }
  assert.equal(polls, 0);
});

test('un pending con operation_id cambiado no sustituye la referencia válida original', async (context) => {
  let now = Date.now();
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => pending(value),
    getOperation: async (value) => {
      polls += 1;
      return polls === 1
        ? pending(value, 'operation-cruzada')
        : completed(value);
    },
    gateway: { now: () => now },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  await assert.rejects(
    gateway.getOperation(operationQuery(command), new AbortController().signal),
    safeError('INVALID_RESPONSE', 'uncertain'),
  );
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    pending(command),
  );
  now += 1;
  assert.deepEqual(
    await gateway.getOperation(
      operationQuery(command),
      new AbortController().signal,
    ),
    completed(command),
  );
  assert.equal(polls, 2);
});

test('una respuesta de correlación distinta se rechaza y no autoriza reejecutar la clave', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed({ ...value, correlation_id: 'flow-cruzado' });
    },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('INVALID_RESPONSE', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('INVALID_RESPONSE', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('unavailable persistente se limita a tres intentos y conserva el resultado incierto', async (context) => {
  let now = Date.now();
  let calls = 0;
  const waits: number[] = [];
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      throw new AgentTransportError('unavailable');
    },
    gateway: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  });
  const command = request({
    deadline_at: new Date(now + 10_000).toISOString(),
  });
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('UNAVAILABLE', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('UNAVAILABLE', 'uncertain'),
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test('un Retry-After que excede el deadline no se acorta ni inicia otro intento', async (context) => {
  let calls = 0;
  let waits = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      throw new AgentTransportError('rate-limit', 5_000);
    },
    gateway: {
      wait: async () => {
        waits += 1;
      },
    },
  });
  const command = request({
    deadline_at: new Date(Date.now() + 1_000).toISOString(),
  });
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RATE_LIMITED', 'not-started'),
  );
  assert.equal(calls, 1);
  assert.equal(waits, 0);
});

for (const retryAfterMs of [0, Number.NaN, 86_400_001]) {
  test(`Retry-After inválido ${String(retryAfterMs)} falla cerrado sin reintento`, async (context) => {
    let calls = 0;
    const gateway = fixture(context, {
      execute: async () => {
        calls += 1;
        throw new AgentTransportError('rate-limit', retryAfterMs);
      },
    });
    await assert.rejects(
      gateway.execute(request(), new AbortController().signal),
      safeError('INVALID_RESPONSE', 'not-started'),
    );
    assert.equal(calls, 1);
  });
}

test('cancelar durante backoff termina aunque el hook wait ignore la señal', async (context) => {
  const waiting = Promise.withResolvers<void>();
  const ignoredWait = Promise.withResolvers<void>();
  const controller = new AbortController();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      throw new AgentTransportError('unavailable');
    },
    gateway: {
      wait: async () => {
        waiting.resolve();
        return ignoredWait.promise;
      },
    },
  });
  const command = request();
  const rejected = assert.rejects(
    gateway.execute(command, controller.signal),
    safeError('CANCELLED', 'uncertain'),
  );
  await waiting.promise;
  controller.abort();
  await rejected;
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CANCELLED', 'uncertain'),
  );
  ignoredWait.resolve();
  await nextTurn();
  assert.equal(calls, 1);
});

test('un cooldown del agente retrasa también otra clave mientras siga vigente', async (context) => {
  let now = Date.now();
  const waiting = Promise.withResolvers<void>();
  const cooldown = Promise.withResolvers<void>();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      if (calls === 1) throw new AgentTransportError('rate-limit', 1_000);
      return completed(value);
    },
    gateway: {
      now: () => now,
      wait: async () => {
        waiting.resolve();
        return cooldown.promise;
      },
    },
  });
  const command = request();
  const first = gateway.execute(command, new AbortController().signal);
  void first.catch(() => undefined);
  await waiting.promise;
  const second = gateway.execute(
    request({
      request_id: 'request-demo-002',
      idempotency_key: 'effect-demo-002',
    }),
    new AbortController().signal,
  );
  const both = Promise.all([first, second]);
  void both.catch(() => undefined);
  await nextTurn();
  assert.equal(calls, 1);
  now += 1_000;
  cooldown.resolve();
  const results = await both;
  assert.ok(results.every((result) => result.status === 'completed'));
  assert.equal(calls, 3);
});

test('un 429 concurrente que amplía cooldown impide despachar al terminar la espera anterior', async (context) => {
  let now = Date.now();
  const secondRejection = Promise.withResolvers<unknown>();
  const firstWait = Promise.withResolvers<void>();
  const bothWaiting = Promise.withResolvers<void>();
  const waits: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const calls: { key: string; at: number }[] = [];
  const attempts = new Map<string, number>();
  const gateway = fixture(context, {
    execute: async (value) => {
      calls.push({ key: value.idempotency_key, at: now });
      const count = (attempts.get(value.idempotency_key) ?? 0) + 1;
      attempts.set(value.idempotency_key, count);
      if (count === 1 && value.idempotency_key === 'effect-demo-001')
        throw new AgentTransportError('rate-limit', 1_000);
      if (count === 1) return secondRejection.promise;
      return completed(value);
    },
    gateway: {
      now: () => now,
      wait: async () => {
        const deferred = Promise.withResolvers<void>();
        waits.push(deferred);
        if (waits.length === 1) firstWait.resolve();
        if (waits.length === 2) bothWaiting.resolve();
        return deferred.promise;
      },
    },
  });
  const command = request();
  const first = gateway.execute(command, new AbortController().signal);
  const second = gateway.execute(
    request({
      request_id: 'request-demo-002',
      idempotency_key: 'effect-demo-002',
    }),
    new AbortController().signal,
  );
  const both = Promise.all([first, second]);
  void both.catch(() => undefined);
  await firstWait.promise;
  assert.equal(calls.length, 2);
  secondRejection.reject(new AgentTransportError('rate-limit', 2_000));
  await bothWaiting.promise;
  now += 1_000;
  waits[0]?.resolve();
  await nextTurn();
  assert.equal(
    attempts.get('effect-demo-001'),
    1,
    'La ampliación del cooldown debe revalidarse después de cada espera.',
  );
  now += 1_000;
  for (const wait of waits) wait.resolve();
  assert.ok((await both).every((result) => result.status === 'completed'));
  assert.equal(calls.length, 4);
});

test('un timeout de consulta conserva pending y descarta su finalización tardía', async (context) => {
  let now = Date.now();
  let polls = 0;
  const lateReply = Promise.withResolvers<unknown>();
  const gateway = fixture(context, {
    execute: async (value) => pending(value),
    getOperation: async (value) => {
      polls += 1;
      return polls === 1 ? lateReply.promise : completed(value);
    },
    gateway: { now: () => now, attemptTimeoutMs: 20, totalTimeoutMs: 100 },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  await assert.rejects(
    gateway.getOperation(operationQuery(command), new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  lateReply.resolve(completed(command, 'Respuesta tardía que debe ignorarse.'));
  await nextTurn();
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    pending(command),
  );
  now += 1;
  assert.deepEqual(
    await gateway.getOperation(
      operationQuery(command),
      new AbortController().signal,
    ),
    completed(command),
  );
  assert.equal(polls, 2);
});

test('una respuesta failed de negocio se devuelve saneada y no se reintenta', async (context) => {
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return {
        ...resultEnvelope(value),
        status: 'failed',
        error: {
          code: 'VALIDATION_FAILED',
          message: 'canario-privado',
          retryable: false,
        },
      };
    },
  });
  const command = request();
  const failed = await gateway.execute(command, new AbortController().signal);
  assert.equal(failed.status, 'failed');
  assert.equal(
    inspect(failed, { depth: 10 }).includes('canario-privado'),
    false,
  );
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    failed,
  );
  assert.equal(calls, 1);
});

test('429 persistente se limita a tres rechazos y no vuelve a enviar la misma clave', async (context) => {
  let now = Date.now();
  let calls = 0;
  const waits: number[] = [];
  const gateway = fixture(context, {
    execute: async () => {
      calls += 1;
      throw new AgentTransportError('rate-limit', 300);
    },
    gateway: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  });
  const command = request();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RATE_LIMITED', 'not-started'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RATE_LIMITED', 'not-started'),
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [300, 300]);
});

test('getOperation espera poll_after_ms antes de consultar el transporte', async (context) => {
  let now = Date.now();
  const beganAt = now;
  const waits: number[] = [];
  let polledAt: number | undefined;
  const gateway = fixture(context, {
    execute: async (value) => ({ ...pending(value), poll_after_ms: 2_000 }),
    getOperation: async (value) => {
      polledAt = now;
      return completed(value);
    },
    gateway: {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  assert.deepEqual(
    await gateway.getOperation(
      operationQuery(command),
      new AbortController().signal,
    ),
    completed(command),
  );
  assert.deepEqual(waits, [2_000]);
  assert.equal(polledAt, beganAt + 2_000);
});

test('una consulta terminal caducada no refresca ni vuelve a ejecutar la operación', async (context) => {
  let now = Date.now();
  let executes = 0;
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      executes += 1;
      return pending(value);
    },
    getOperation: async (value) => {
      polls += 1;
      return completed(value);
    },
    gateway: { now: () => now, resultCacheMs: 20 },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  await gateway.getOperation(
    operationQuery(command),
    new AbortController().signal,
  );
  await pause(50);
  await assert.rejects(
    gateway.getOperation(operationQuery(command), new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  assert.equal(executes, 1);
  assert.equal(polls, 1);
});

test('close aborta trabajo pendiente, es idempotente y no permite reutilizar el Gateway', async (context) => {
  const remote = Promise.withResolvers<unknown>();
  const dispatched = Promise.withResolvers<void>();
  let transportSignal: AbortSignal | undefined;
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      calls += 1;
      transportSignal = signal;
      dispatched.resolve();
      return remote.promise;
    },
  });
  const command = request();
  const rejected = assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CANCELLED', 'uncertain'),
  );
  await dispatched.promise;
  gateway.close();
  gateway.close();
  await rejected;
  assert.equal(transportSignal?.aborted, true);
  remote.resolve(completed(command));
  await nextTurn();
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('UNAVAILABLE', 'not-started'),
  );
  assert.equal(calls, 1);
});

test('un completed devuelto después del deadline lógico no se convierte en éxito antes del timer', async (context) => {
  let now = Date.now();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      now += 2_000;
      return completed(value);
    },
    gateway: { now: () => now },
  });
  const command = request({ deadline_at: new Date(now + 1_000).toISOString() });
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('una validación de output que supera el deadline tampoco guarda un éxito tardío', async (context) => {
  let now = Date.now();
  let calls = 0;
  let validations = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed(value);
    },
    outputSchema: z
      .strictObject({ text: z.string().max(512) })
      .superRefine(() => {
        validations += 1;
        now += 2_000;
      }),
    gateway: { now: () => now },
  });
  const command = request({ deadline_at: new Date(now + 1_000).toISOString() });
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.equal(validations, 1);
  assert.equal(calls, 1);
});

test('execute detecta TTL vencido por reloj aunque el timer todavía no haya recibido turno', async (context) => {
  let now = Date.now();
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      return completed(value);
    },
    gateway: { now: () => now, resultCacheMs: 10 },
  });
  const command = request();
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    completed(command),
  );
  now += 11;
  // Solo continuaciones de microtasks: no nextTurn/pause que dispare el timer.
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  assert.equal(calls, 1);
});

test('getOperation terminal detecta TTL por reloj sin refrescar antes del timer', async (context) => {
  let now = Date.now();
  let polls = 0;
  const gateway = fixture(context, {
    execute: async (value) => pending(value),
    getOperation: async (value) => {
      polls += 1;
      return completed(value);
    },
    gateway: { now: () => now, resultCacheMs: 10 },
  });
  const command = request();
  await gateway.execute(command, new AbortController().signal);
  now += 1;
  await gateway.getOperation(
    operationQuery(command),
    new AbortController().signal,
  );
  now += 11;
  await assert.rejects(
    gateway.getOperation(operationQuery(command), new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('RESULT_EXPIRED', 'completed'),
  );
  assert.equal(polls, 1);
});

test('los joins cancelados no recuperan el cupo acumulativo ni cancelan al waiter original', async (context) => {
  const dispatched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<unknown>();
  let transportSignal: AbortSignal | undefined;
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      calls += 1;
      transportSignal = signal;
      dispatched.resolve();
      return remote.promise;
    },
    gateway: { maxWaiters: 3 },
  });
  const command = request();
  const original = gateway.execute(command, new AbortController().signal);
  await dispatched.promise;
  for (let join = 0; join < 2; join += 1) {
    const controller = new AbortController();
    const rejected = assert.rejects(
      gateway.execute(command, controller.signal),
      safeError('CANCELLED', 'uncertain'),
    );
    controller.abort();
    await rejected;
    assert.equal(transportSignal?.aborted, false);
  }
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('CAPACITY_EXCEEDED', 'uncertain'),
  );
  assert.equal(transportSignal?.aborted, false);
  remote.resolve(completed(command));
  assert.deepEqual(await original, completed(command));
  assert.equal(calls, 1);
});

for (const firstAccess of ['execute', 'getOperation'] as const) {
  test(`pending expira a las 24h originales en ${firstAccess} y otro pending no renueva el horizonte`, async (context) => {
    const beganAt = Date.now();
    let now = beganAt;
    let executes = 0;
    let polls = 0;
    const gateway = fixture(context, {
      execute: async (value) => {
        executes += 1;
        return pending(value);
      },
      getOperation: async (value) => {
        polls += 1;
        return pending(value);
      },
      gateway: { now: () => now },
    });
    const command = request();
    await gateway.execute(command, new AbortController().signal);
    now = beganAt + 23 * 60 * 60 * 1_000;
    assert.deepEqual(
      await gateway.getOperation(
        operationQuery(command),
        new AbortController().signal,
      ),
      pending(command),
    );
    now = beganAt + 24 * 60 * 60 * 1_000 + 1;
    const expired =
      firstAccess === 'execute'
        ? gateway.execute(command, new AbortController().signal)
        : gateway.getOperation(
            operationQuery(command),
            new AbortController().signal,
          );
    await assert.rejects(expired, safeError('TIMEOUT', 'uncertain'));
    await assert.rejects(
      gateway.execute(command, new AbortController().signal),
      safeError('TIMEOUT', 'uncertain'),
    );
    await assert.rejects(
      gateway.getOperation(
        operationQuery(command),
        new AbortController().signal,
      ),
      safeError('TIMEOUT', 'uncertain'),
    );
    now = beganAt + 1_000;
    await assert.rejects(
      gateway.execute(command, new AbortController().signal),
      safeError('TIMEOUT', 'uncertain'),
    );
    assert.equal(executes, 1);
    assert.equal(polls, 1);
  });
}

test('un completed que supera solo el plazo del intento queda incierto sin esperar su timer', async (context) => {
  const beganAt = Date.now();
  let now = beganAt;
  let calls = 0;
  const gateway = fixture(context, {
    execute: async (value) => {
      calls += 1;
      now += 150;
      return completed(value);
    },
    gateway: { now: () => now, attemptTimeoutMs: 100, totalTimeoutMs: 1_000 },
  });
  const command = request({
    deadline_at: new Date(beganAt + 1_000).toISOString(),
  });
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.ok(now < beganAt + 1_000);
  await assert.rejects(
    gateway.execute(command, new AbortController().signal),
    safeError('TIMEOUT', 'uncertain'),
  );
  assert.equal(calls, 1);
});

test('el resultado compartido respeta el deadline individual corto sin cancelar al waiter largo', async (context) => {
  const beganAt = Date.now();
  let now = beganAt;
  let calls = 0;
  let transportSignal: AbortSignal | undefined;
  const dispatched = Promise.withResolvers<void>();
  const remote = Promise.withResolvers<unknown>();
  const gateway = fixture(context, {
    execute: async (_value, signal) => {
      calls += 1;
      transportSignal = signal;
      dispatched.resolve();
      return remote.promise;
    },
    gateway: { now: () => now, attemptTimeoutMs: 1_000, totalTimeoutMs: 2_000 },
  });
  const command = request({
    deadline_at: new Date(beganAt + 2_000).toISOString(),
  });
  // El primer caller fija el plazo del trabajo; el follower tiene otro menor.
  const longWaiter = gateway.execute(command, new AbortController().signal);
  const shortRejected = assert.rejects(
    gateway.execute(
      { ...command, deadline_at: new Date(beganAt + 500).toISOString() },
      new AbortController().signal,
    ),
    safeError('TIMEOUT', 'uncertain'),
  );
  await dispatched.promise;
  now += 600;
  remote.resolve(completed(command));
  assert.deepEqual(await longWaiter, completed(command));
  await shortRejected;
  assert.equal(transportSignal?.aborted, false);
  assert.deepEqual(
    await gateway.execute(command, new AbortController().signal),
    completed(command),
  );
  assert.equal(calls, 1);
});
