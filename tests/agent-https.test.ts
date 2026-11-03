import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { AgentGatewayError } from '../src/agents/errors.ts';
import type { AgentOperationQuery } from '../src/agents/protocol.ts';
import { actor, request } from './agent-runtime.fixtures.ts';
import { httpsRuntime, loopbackPolicy } from './agent-https-fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const signal = () => new AbortController().signal;
const errorCode = (code: string, outcome?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentGatewayError);
  assert.equal(error.code, code);
  if (outcome) assert.equal(error.outcome, outcome);
  return true;
};

async function setup(
  t: TestContext,
  options: Parameters<typeof startEchoAgent>[0] = {},
  runtimeOptions: Parameters<typeof httpsRuntime>[1] = {},
) {
  const server = await startEchoAgent(options);
  t.after(() => server.close());
  const runtime = httpsRuntime(server, runtimeOptions);
  t.after(() => runtime.close());
  return { server, ...runtime };
}

test('HTTPS real entre procesos: Core autoriza, TLS autentica y echo conserva el texto', async (t) => {
  const { server, core } = await setup(t);
  const value = request();
  const result = await core.execute(actor, value, signal());
  assert.equal(result.status, 'completed');
  if (result.status === 'completed')
    assert.deepEqual(result.output, value.input);
  for (const key of [
    'instance_id',
    'agent_id',
    'subject_ref',
    'request_id',
    'correlation_id',
  ] as const)
    assert.equal(result[key], value[key]);
  assert.equal((await server.stats()).executions, 1);
  assert.equal(server.diagnosticsBytes(), 0);
});

test('HTTPS: cincuenta duplicados concurrentes invocan una vez y otro comando da409', async (t) => {
  const { server, core } = await setup(t, { mode: 'slow', delayMs: 50 });
  const value = request();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => core.execute(actor, value, signal())),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(await server.stats(), {
    requests: 1,
    executions: 1,
    polls: 0,
    unauthorized: 0,
    duplicates: 0,
  });
  await assert.rejects(
    core.execute(
      actor,
      { ...value, input: { text: 'Otro comando' } },
      signal(),
    ),
    errorCode('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal((await server.stats()).requests, 1);
});

test('HTTPS: el agente independiente también deduplica retries directos', async (t) => {
  const { server, transport } = await setup(t, { mode: 'slow', delayMs: 30 });
  const value = request();
  const results = await Promise.all([
    transport.execute(value, signal()),
    transport.execute(value, signal()),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await server.stats()).executions, 1);
  assert.equal((await server.stats()).duplicates, 1);
  const failed = await transport.execute(
    { ...value, input: { text: 'Otro' } },
    signal(),
  );
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed')
    assert.equal(failed.error.code, 'IDEMPOTENCY_CONFLICT');
});

for (const scenario of [
  {
    name: 'agente desconocido',
    patch: { agent_id: 'unknown' },
    code: 'UNKNOWN_AGENT',
  },
  {
    name: 'sujeto cruzado',
    patch: { subject_ref: 'other' },
    code: 'FORBIDDEN',
  },
  {
    name: 'capacidad desconocida',
    patch: { capability: { name: 'other', version: '1.0' } },
    code: 'UNKNOWN_CAPABILITY',
  },
  {
    name: 'versión incompatible',
    patch: { protocol_version: '2.0' },
    code: 'UNSUPPORTED_PROTOCOL',
  },
  {
    name: 'schema incorrecto',
    patch: { input: { text: 42 } },
    code: 'VALIDATION_FAILED',
  },
  {
    name: 'campo extra',
    patch: { secret: 'not-allowed' },
    code: 'VALIDATION_FAILED',
  },
])
  test(`HTTPS: ${scenario.name} no llega a la red`, async (t) => {
    const { server, core } = await setup(t);
    await assert.rejects(
      core.execute(actor, { ...request(), ...scenario.patch }, signal()),
      errorCode(scenario.code),
    );
    assert.equal((await server.stats()).requests, 0);
  });

for (const scenario of [
  { name: 'deshabilitado', patch: { enabled: false }, code: 'AGENT_DISABLED' },
  { name: 'sin permiso', patch: { permissions: [] }, code: 'FORBIDDEN' },
  {
    name: 'no disponible',
    patch: { availability: 'unknown' as const },
    code: 'AGENT_UNAVAILABLE',
  },
])
  test(`HTTPS: agente ${scenario.name} no resuelve secretos ni conecta`, async (t) => {
    const { server, core, transport } = await setup(
      t,
      {},
      {
        registration: scenario.patch,
        credentials: {
          async resolve() {
            throw new Error('Resolver must not run');
          },
        },
      },
    );
    await assert.rejects(
      core.execute(actor, request(), signal()),
      errorCode(scenario.code),
    );
    await assert.rejects(
      transport.execute(request(), signal()),
      errorCode(scenario.code),
    );
    assert.equal((await server.stats()).requests, 0);
  });

test('HTTPS: credencial incorrecta no ejecuta y no se reintenta', async (t) => {
  const { server, core } = await setup(
    t,
    {},
    { token: randomBytes(32).toString('base64url') },
  );
  await assert.rejects(
    core.execute(actor, request(), signal()),
    errorCode('INVALID_RESPONSE', 'uncertain'),
  );
  const counts = await server.stats();
  assert.equal(counts.requests, 1);
  assert.equal(counts.unauthorized, 1);
  assert.equal(counts.executions, 0);
});

for (const mode of [
  'malformed',
  'version',
  'cross-subject',
  'cross-agent',
  'invalid-schema',
  'invalid-content-type',
  'invalid-encoding',
  'invalid-utf8',
  'duplicate-fields',
  'oversize',
  'chunked-oversize',
  'bad-status',
  'redirect',
  'raw-rate-limit',
  'raw-unavailable',
] as const)
  test(`HTTPS: rechaza ${mode} sin aceptar resultado ni reintentar`, async (t) => {
    const { server, core } = await setup(t, { mode });
    const value = request();
    await assert.rejects(
      core.execute(actor, value, signal()),
      errorCode('INVALID_RESPONSE', 'uncertain'),
    );
    await assert.rejects(
      core.execute(actor, value, signal()),
      errorCode('INVALID_RESPONSE', 'uncertain'),
    );
    assert.equal((await server.stats()).requests, 1);
    assert.equal(server.diagnosticsBytes(), 0);
  });

for (const certificate of ['untrusted', 'expired', 'wrong-host'] as const)
  test(`HTTPS: certificado ${certificate} impide enviar bearer y cuerpo`, async (t) => {
    const { server, transport } = await setup(t, { certificate });
    await assert.rejects(
      transport.execute(request(), signal()),
      errorCode('UNAVAILABLE', 'not-started'),
    );
    assert.equal((await server.stats()).requests, 0);
    assert.equal(server.diagnosticsBytes(), 0);
  });

test('HTTPS: un fallo estructurado se sanea y no se reintenta', async (t) => {
  const { server, core } = await setup(t, { mode: 'failed' });
  const result = await core.execute(actor, request(), signal());
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.error.code, 'VALIDATION_FAILED');
    assert.equal(result.error.message, 'Datos de operación inválidos.');
  }
  assert.equal((await server.stats()).requests, 1);
});

test('HTTPS:429 válido respeta Retry-After y comparte el retry con duplicados', async (t) => {
  const { server, core } = await setup(t, {
    mode: 'rate-limit',
    retryAfter: '1',
    failures: 1,
  });
  const value = request();
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => core.execute(actor, value, signal())),
  );
  assert.equal(results[0]?.status, 'completed');
  assert.ok(Date.now() - started >= 1000);
  assert.equal((await server.stats()).requests, 2);
  assert.equal((await server.stats()).executions, 1);
});

for (const header of ['garbage', '0', '-1', '999999999999999'])
  test(`HTTPS: Retry-After inválido (${header}) detiene sin retry`, async (t) => {
    const { server, core } = await setup(t, {
      mode: 'rate-limit',
      retryAfter: header,
      failures: 1,
    });
    await assert.rejects(
      core.execute(actor, request(), signal()),
      errorCode('INVALID_RESPONSE'),
    );
    assert.equal((await server.stats()).requests, 1);
  });

test('HTTPS: Retry-After mayor al deadline no se acorta', async (t) => {
  const { server, core } = await setup(t, {
    mode: 'rate-limit',
    retryAfter: '20',
    failures: 1,
  });
  await assert.rejects(
    core.execute(
      actor,
      request({ deadline_at: new Date(Date.now() + 2000).toISOString() }),
      signal(),
    ),
    errorCode('RATE_LIMITED', 'not-started'),
  );
  assert.equal((await server.stats()).requests, 1);
});

test('HTTPS:503 estructurado puede reintentarse para una lectura', async (t) => {
  const { server, core } = await setup(
    t,
    { mode: 'unavailable', failures: 1 },
    { gateway: { jitter: () => 0 } },
  );
  assert.equal(
    (await core.execute(actor, request(), signal())).status,
    'completed',
  );
  assert.equal((await server.stats()).requests, 2);
});

test('HTTPS:503 no reintenta escritura que no garantiza idempotencia', async (t) => {
  const { registration } = await import('./agent-runtime.fixtures.ts');
  const entry = registration();
  const { server, core } = await setup(
    t,
    { mode: 'unavailable', failures: 1 },
    {
      registration: {
        descriptor: {
          ...entry.descriptor,
          capabilities: entry.descriptor.capabilities.map((cap) => ({
            ...cap,
            effect: 'write',
            supports_idempotency: false,
          })),
        },
      },
    },
  );
  await assert.rejects(
    core.execute(actor, request(), signal()),
    errorCode('UNAVAILABLE', 'uncertain'),
  );
  assert.equal((await server.stats()).requests, 1);
});

test('HTTPS: pending se consulta con contexto exacto y polling concurrente único', async (t) => {
  const { server, core, transport } = await setup(t, {
    mode: 'pending',
    pollAfterMs: 20,
  });
  const value = request();
  const pending = await core.execute(actor, value, signal());
  assert.equal(pending.status, 'pending');
  if (pending.status !== 'pending') return;
  const query: AgentOperationQuery = {
    protocol_version: '1.0',
    instance_id: value.instance_id,
    agent_id: value.agent_id,
    subject_ref: value.subject_ref,
    request_id: value.request_id,
    correlation_id: value.correlation_id,
    operation_id: pending.operation_id,
  };
  await assert.rejects(
    transport.getOperation({ ...query, correlation_id: 'different' }, signal()),
    errorCode('UNKNOWN_OPERATION'),
  );
  await assert.rejects(
    transport.getOperation({ ...query, subject_ref: 'other' }, signal()),
    errorCode('UNKNOWN_OPERATION'),
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () => core.getOperation(actor, query, signal())),
  );
  assert.equal(results[0]?.status, 'completed');
  assert.deepEqual(await core.execute(actor, value, signal()), results[0]);
  assert.equal((await server.stats()).polls, 1);
});

test('HTTPS: cancelación previa y deadline vencido no envían', async (t) => {
  const { server, transport } = await setup(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    transport.execute(request(), aborted.signal),
    errorCode('CANCELLED', 'not-started'),
  );
  await assert.rejects(
    transport.execute(
      request({ deadline_at: new Date(Date.now() - 1).toISOString() }),
      signal(),
    ),
    errorCode('TIMEOUT', 'not-started'),
  );
  assert.equal((await server.stats()).requests, 0);
});

test('HTTPS: timeout de DNS previo al envío no produce efectos tardíos', async (t) => {
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { server, transport } = await setup(
    t,
    {},
    {
      network: {
        async resolve(origin, inputSignal) {
          await deferred;
          return loopbackPolicy(origin).resolve(origin, inputSignal);
        },
      },
      transport: { timeoutMs: 25, maxInflight: 1 },
    },
  );
  await assert.rejects(
    transport.execute(request(), signal()),
    errorCode('TIMEOUT', 'not-started'),
  );
  await assert.rejects(
    transport.execute(request(), signal()),
    errorCode('CAPACITY_EXCEEDED', 'not-started'),
  );
  release();
  await sleep(5);
  assert.equal((await server.stats()).requests, 0);
});

test('HTTPS: cancelación durante resolución de secreto no envía ni filtra rechazo tardío', async (t) => {
  let began!: () => void;
  let finish!: (value: string) => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const deferred = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const { server, transport } = await setup(
    t,
    {},
    {
      credentials: {
        async resolve() {
          began();
          return deferred;
        },
      },
    },
  );
  const controller = new AbortController();
  const work = transport.execute(request(), controller.signal);
  await started;
  controller.abort();
  await assert.rejects(work, errorCode('CANCELLED', 'not-started'));
  finish(server.token);
  await sleep(5);
  assert.equal((await server.stats()).requests, 0);
});

test('HTTPS: timeout posterior al envío queda incierto y no se reejecuta', async (t) => {
  const { server, core } = await setup(
    t,
    { mode: 'slow', delayMs: 160 },
    { transport: { timeoutMs: 75 } },
  );
  const value = request();
  await assert.rejects(
    core.execute(actor, value, signal()),
    errorCode('TIMEOUT', 'uncertain'),
  );
  assert.equal((await server.stats()).executions, 1);
  await sleep(180);
  await assert.rejects(
    core.execute(actor, value, signal()),
    errorCode('TIMEOUT', 'uncertain'),
  );
  assert.equal((await server.stats()).executions, 1);
});

test('HTTPS: cancelar un duplicado mantiene al otro; cancelar el último conserva incertidumbre', async (t) => {
  const { server, core } = await setup(t, { mode: 'slow', delayMs: 150 });
  const value = request();
  const first = new AbortController();
  const work = core.execute(actor, value, first.signal);
  const surviving = core.execute(actor, value, signal());
  first.abort();
  await assert.rejects(work, errorCode('CANCELLED'));
  assert.equal((await surviving).status, 'completed');
  const second = request({
    idempotency_key: 'another-key',
    request_id: 'another-request',
  });
  const controller = new AbortController();
  const last = core.execute(actor, second, controller.signal);
  // Observe the independent process accepting it before cancellation.
  for (let i = 0; i < 100 && (await server.stats()).executions < 2; i += 1)
    await sleep(5);
  assert.equal((await server.stats()).executions, 2);
  controller.abort();
  await assert.rejects(last, errorCode('CANCELLED', 'uncertain'));
  await assert.rejects(
    core.execute(actor, second, signal()),
    errorCode('CANCELLED', 'uncertain'),
  );
  assert.equal((await server.stats()).executions, 2);
});

test('HTTPS: close aborta y cierra permanentemente el transporte', async (t) => {
  const { transport } = await setup(
    t,
    {},
    { network: { resolve: () => new Promise(() => undefined) } },
  );
  const work = transport.execute(request(), signal());
  transport.close();
  await assert.rejects(work, errorCode('CANCELLED'));
  await assert.rejects(
    transport.execute(request(), signal()),
    errorCode('CANCELLED'),
  );
});

test('HTTPS: errores de credenciales y bearer con CRLF no se registran ni se exponen', async (t) => {
  const canary = randomBytes(32).toString('hex');
  for (const mode of ['throws', 'invalid']) {
    const { server, transport } = await setup(
      t,
      {},
      {
        credentials: {
          async resolve() {
            if (mode === 'throws') throw new Error(canary);
            return `${canary}\r\nInjected: value`;
          },
        },
      },
    );
    try {
      await transport.execute(request(), signal());
      assert.fail('Expected rejection');
    } catch (error) {
      assert.ok(error instanceof AgentGatewayError);
      assert.ok(!JSON.stringify(error).includes(canary));
      assert.ok(!String(error.stack).includes(canary));
    }
    assert.equal((await server.stats()).requests, 0);
    assert.equal(server.diagnosticsBytes(), 0);
  }
});

test('HTTPS: tracing de Node bloqueado antes de crear conexiones', async (t) => {
  const server = await startEchoAgent();
  t.after(() => server.close());
  const original = process.env.NODE_DEBUG;
  try {
    for (const debug of ['http', 'https', 'tls', '*', 'h*']) {
      process.env.NODE_DEBUG = debug;
      assert.throws(
        () => httpsRuntime(server),
        errorCode('INVALID_CONFIGURATION'),
      );
    }
  } finally {
    if (original === undefined) delete process.env.NODE_DEBUG;
    else process.env.NODE_DEBUG = original;
  }
  assert.equal((await server.stats()).requests, 0);
  assert.equal(server.diagnosticsBytes(), 0);
});

test('HTTPS: política de producción bloquea DNS loopback antes de resolver bearer', async (t) => {
  const { HttpsEndpointPolicy } =
    await import('../src/agents/network-policy.ts');
  const server = await startEchoAgent();
  t.after(() => server.close());
  const runtime = httpsRuntime(server, {
    network: new HttpsEndpointPolicy([{ origin: server.origin }], async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    credentials: {
      async resolve() {
        assert.fail('No credentials before network policy');
      },
    },
  });
  t.after(() => runtime.close());
  await assert.rejects(
    runtime.transport.execute(request(), signal()),
    errorCode('FORBIDDEN', 'not-started'),
  );
  assert.equal((await server.stats()).requests, 0);
});
