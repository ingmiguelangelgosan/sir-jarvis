import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { z } from 'zod';

import { AgentGatewayError } from '../src/agents/errors.ts';
import {
  canonicalJson,
  commandFingerprint,
  jsonSnapshot,
} from '../src/agents/json.ts';
import { InMemoryAgentRegistry } from '../src/agents/registry.ts';
import {
  CapabilitySchemaCatalog,
  parseExecutionRequest,
  parseExecutionResult,
} from '../src/agents/validation.ts';
import {
  completed,
  origin,
  registration,
  request,
  schemas,
} from './agent-runtime.fixtures.ts';

test('Registry separa instancias, copia configuración y devuelve estructuras inmutables', () => {
  const raw = registration();
  const registry = new InMemoryAgentRegistry(
    [raw, registration({ instance_id: 'otra-instancia' })],
    schemas(),
    [origin],
  );
  Object.defineProperty(raw, 'enabled', { value: false });
  Object.defineProperty(raw.descriptor, 'name', { value: 'cambio-local' });
  const entry = registry.get('jarvis-demo', 'demo.echo');
  assert.equal(entry?.enabled, true);
  assert.equal(entry?.descriptor.name, 'Fixture local');
  assert.equal(registry.list('jarvis-demo').length, 1);
  assert.equal(registry.list('otra-instancia').length, 1);
  assert.equal(registry.get('otra', 'demo.echo'), undefined);
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry?.descriptor.capabilities));
  assert.ok(Object.isFrozen(entry?.permissions[0]?.capabilities[0]));
  assert.ok(Object.isFrozen(registry.list('jarvis-demo')));
});

test('Registry rechaza IDs duplicados, grants/capacidades duplicados o schemas desconocidos', () => {
  const value = registration();
  const capability = value.descriptor.capabilities[0]!;
  for (const values of [
    [value, value],
    [
      registration({
        descriptor: {
          ...value.descriptor,
          capabilities: [capability, capability],
        },
      }),
    ],
    [
      registration({
        descriptor: {
          ...value.descriptor,
          capabilities: [{ ...capability, output_schema_id: 'unknown.schema' }],
        },
      }),
    ],
    [
      registration({
        permissions: [...value.permissions, ...value.permissions],
      }),
    ],
    [
      registration({
        permissions: [
          {
            subject_ref: 'owner-demo',
            capabilities: [{ name: 'unknown', version: '1.0' }],
          },
        ],
      }),
    ],
    [
      registration({
        permissions: [
          {
            subject_ref: 'owner-demo',
            capabilities: [capability, capability].map(({ name, version }) => ({
              name,
              version,
            })),
          },
        ],
      }),
    ],
    [{ ...value, unexpected: true }],
    [
      {
        ...value,
        descriptor: { ...value.descriptor, protocol_version: '2.0' },
      },
    ],
  ])
    assert.throws(
      () => new InMemoryAgentRegistry(values, schemas(), [origin]),
      (error: unknown) =>
        error instanceof AgentGatewayError &&
        error.code === 'INVALID_CONFIGURATION',
    );
});

for (const url of [
  'http://echo.example.invalid',
  `${origin}/v1`,
  `${origin}?`,
  `${origin}#`,
  'https://usuario:canario-privado@echo.example.invalid',
  'https://otro.example.invalid',
  'https://169.254.169.254',
  'https://metadata.google.internal',
]) {
  test(`Registry rechaza origen no permitido sin divulgar URL (${url.includes('@') ? 'credenciales ficticias' : 'caso de formato'})`, () => {
    assert.throws(
      () =>
        new InMemoryAgentRegistry(
          [
            registration({
              connection: { ...registration().connection, base_url: url },
            }),
          ],
          schemas(),
          [origin],
        ),
      (error: unknown) => {
        assert.ok(error instanceof AgentGatewayError);
        assert.equal(error.code, 'INVALID_CONFIGURATION');
        assert.equal(inspect(error).includes('canario-privado'), false);
        assert.equal(inspect(error).includes(url), false);
        return true;
      },
    );
  });
}

test('no hay origen habilitado implícito ni auto-discovery', () => {
  assert.throws(
    () => new InMemoryAgentRegistry([registration()], schemas(), []),
    AgentGatewayError,
  );
  assert.throws(
    () =>
      new CapabilitySchemaCatalog([
        { id: 'same', schema: z.strictObject({}) },
        { id: 'same', schema: z.strictObject({}) },
      ]),
    AgentGatewayError,
  );
});

test('schema local no puede ocultar campos extra, coaccionar, transformar ni añadir defaults', () => {
  for (const [schema, input] of [
    [z.object({ text: z.string() }), { text: 'válido', private: 'canario' }],
    [z.strictObject({ text: z.coerce.string() }), { text: 42 }],
    [
      z.strictObject({
        text: z.string().transform((value) => value.toUpperCase()),
      }),
      { text: 'minúscula' },
    ],
    [z.strictObject({ text: z.string().default('default') }), {}],
  ] as const) {
    const catalog = new CapabilitySchemaCatalog([{ id: 'schema', schema }]);
    assert.throws(
      () => catalog.validate('schema', input),
      (error: unknown) =>
        error instanceof AgentGatewayError &&
        error.code === 'VALIDATION_FAILED',
    );
  }
});

test('parsers asíncronos se rechazan sin dejar rechazos sin manejar o divulgar errores', async () => {
  for (const parse of [
    async () => ({ text: 'ficticio' }),
    async () => {
      throw new Error('canario-schema-no-real');
    },
  ]) {
    const catalog = new CapabilitySchemaCatalog([
      { id: 'async.invalid', schema: { parse } },
    ]);
    assert.throws(
      () => catalog.validate('async.invalid', { text: 'entrada' }),
      (error: unknown) => {
        assert.ok(error instanceof AgentGatewayError);
        assert.equal(error.code, 'VALIDATION_FAILED');
        assert.equal(inspect(error).includes('canario-schema'), false);
        return true;
      },
    );
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('snapshot JSON rechaza valores no JSON, ciclos, profundidad/tamaño excesivo y propiedades activas', () => {
  let accessed = false;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get: () => {
      accessed = true;
      throw new Error('canario');
    },
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  let deep: unknown = {};
  for (let i = 0; i < 40; i += 1) deep = { deep };
  const values = [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    { text: undefined },
    getter,
    cycle,
    deep,
    {
      toJSON: () => {
        accessed = true;
        return {};
      },
    },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { text: '\0'.repeat(20_000) },
    { text: 'á'.repeat(40_000) },
  ];
  for (const value of values)
    assert.throws(
      () => jsonSnapshot(value),
      (error: unknown) =>
        error instanceof AgentGatewayError &&
        error.code === 'VALIDATION_FAILED',
    );
  assert.equal(accessed, false);
});

test('canonicalización ignora orden de claves/deadline pero no cambios de comando', () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
  const first = request();
  assert.equal(
    commandFingerprint(first),
    commandFingerprint({
      ...first,
      deadline_at: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  assert.notEqual(
    commandFingerprint(first),
    commandFingerprint({ ...first, input: { text: 'otro' } }),
  );
  assert.notEqual(
    commandFingerprint(first),
    commandFingerprint({ ...first, correlation_id: 'otro-flujo' }),
  );
});

test('envelopes de ejecución rechazan versión, pago y campos extras antes de efectos', () => {
  for (const value of [
    { ...request(), protocol_version: '2.0' },
    { ...request(), cost_policy: 'paid' },
    { ...request(), connection: { base_url: origin } },
  ]) {
    assert.throws(() => parseExecutionRequest(value), AgentGatewayError);
  }
});

test('resultados se validan por todos los IDs, schema, estado y campos estrictos', () => {
  const original = request();
  const result = completed(original);
  const capability = registration().descriptor.capabilities[0]!;
  const catalog = schemas();
  for (const field of [
    'instance_id',
    'subject_ref',
    'agent_id',
    'request_id',
    'correlation_id',
  ] as const) {
    assert.throws(
      () =>
        parseExecutionResult(
          { ...result, [field]: 'otro' },
          original,
          capability,
          catalog,
        ),
      (error: unknown) =>
        error instanceof AgentGatewayError && error.code === 'INVALID_RESPONSE',
    );
  }
  for (const value of [
    { ...result, protocol_version: '2.0' },
    { ...result, output: { text: 'ok', token: 'canario' } },
    { ...result, extra: true },
    { ...result, error: { code: 'INTERNAL_ERROR' } },
    { ...result, output: { text: 42 } },
  ]) {
    assert.throws(
      () => parseExecutionResult(value, original, capability, catalog),
      AgentGatewayError,
    );
  }
});
