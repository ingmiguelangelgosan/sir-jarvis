import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { AgentGatewayError } from '../src/agents/errors.ts';
import { InMemoryAgentGateway } from '../src/agents/gateway.ts';
import type {
  AgentExecutionResult,
  AgentGateway,
  AgentRegistration,
} from '../src/agents/protocol.ts';
import { AgentExecutionService } from '../src/app/agent-execution.ts';
import {
  actor,
  completed,
  registration,
  registry,
  request,
} from './agent-runtime.fixtures.ts';

test('caso de uso integra Registry/Gateway falso sin pasar referencias de conexión al transporte', async (context) => {
  const setup = registry();
  let sent = 0;
  const gateway = new InMemoryAgentGateway(
    setup.registry,
    setup.catalog,
    {
      execute: async (value) => {
        sent += 1;
        assert.equal(value.cost_policy, 'no-paid-services');
        assert.equal(
          JSON.stringify(value).includes('unused-request-reference'),
          false,
        );
        assert.equal('connection' in value, false);
        return completed(value);
      },
      getOperation: async () => assert.fail('No hay operación pendiente'),
    },
    { resultCacheMs: 60_000 },
  );
  context.after(() => gateway.close());
  const service = new AgentExecutionService(setup.registry, gateway);
  const result = await service.execute(
    actor,
    request(),
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
  assert.equal(sent, 1);
});

test('Core no invoca Gateway si actor, instancia, sujeto, agente o capacidad no están autorizados', async () => {
  const setup = registry();
  let called = 0;
  const gateway: AgentGateway = {
    execute: async () => {
      called += 1;
      assert.fail('No debe invocarse');
    },
    getOperation: async () => {
      called += 1;
      assert.fail('No debe consultarse');
    },
  };
  const service = new AgentExecutionService(setup.registry, gateway);
  for (const [subject, value] of [
    [{ ...actor, subject_ref: 'otro' }, request()],
    [{ ...actor, instance_id: 'otra' }, request()],
    [actor, request({ subject_ref: 'otro' })],
    [actor, request({ instance_id: 'otra' })],
    [actor, request({ agent_id: 'unknown' })],
    [actor, request({ capability: { name: 'unknown', version: '1.0' } })],
    [actor, { ...request(), cost_policy: 'paid' }],
    [{ ...actor, token: 'canario' }, request()],
  ] as const)
    await assert.rejects(
      service.execute(subject, value, new AbortController().signal),
      AgentGatewayError,
    );
  await assert.rejects(
    service.getOperation(
      { ...actor, subject_ref: 'otro' },
      {
        protocol_version: '1.0',
        ...actor,
        agent_id: 'demo.echo',
        correlation_id: 'flow-demo',
        request_id: 'request-demo',
        operation_id: 'operation-demo',
      },
      new AbortController().signal,
    ),
    AgentGatewayError,
  );
  assert.equal(called, 0);
});

for (const changes of [
  { enabled: false },
  { availability: 'unknown' },
  { availability: 'unavailable' },
  { permissions: [] },
] as const satisfies readonly Partial<AgentRegistration>[]) {
  test('Core falla cerrado ante configuración deshabilitada, no disponible o sin permisos', async () => {
    const setup = registry(registration(changes));
    const gateway: AgentGateway = {
      execute: async () => assert.fail('No debe ejecutar'),
      getOperation: async () => assert.fail('No debe consultar'),
    };
    await assert.rejects(
      new AgentExecutionService(setup.registry, gateway).execute(
        actor,
        request(),
        new AbortController().signal,
      ),
      AgentGatewayError,
    );
  });
}

test('schema de capacidad rechaza payload con campos ocultos antes del transporte', async (context) => {
  const setup = registry();
  const gateway = new InMemoryAgentGateway(
    setup.registry,
    setup.catalog,
    {
      execute: async () => assert.fail('No enviar payload inválido'),
      getOperation: async () => assert.fail('No consultar'),
    },
    { resultCacheMs: 60_000 },
  );
  context.after(() => gateway.close());
  const service = new AgentExecutionService(setup.registry, gateway);
  await assert.rejects(
    service.execute(
      actor,
      request({ input: { text: 'hola', password: 'canario' } }),
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof AgentGatewayError && error.code === 'VALIDATION_FAILED',
  );
});

test('Core clona actor/request antes del await y no expone errores de un puerto defectuoso', async (context) => {
  const setup = registry();
  const subject = { ...actor };
  const input = { ...request(), input: { text: 'original' } };
  const gateway = new InMemoryAgentGateway(
    setup.registry,
    setup.catalog,
    {
      execute: async (value) => {
        assert.equal(value.subject_ref, 'owner-demo');
        assert.equal(value.input.text, 'original');
        return completed(value);
      },
      getOperation: async () => assert.fail('No consultar'),
    },
    { resultCacheMs: 60_000 },
  );
  context.after(() => gateway.close());
  const promise = new AgentExecutionService(setup.registry, gateway).execute(
    subject,
    input,
    new AbortController().signal,
  );
  subject.subject_ref = 'otro';
  input.input.text = 'mutado';
  assert.equal((await promise).status, 'completed');

  const broken: AgentGateway = {
    execute: async () => {
      throw new Error('canario-privado-no-real');
    },
    getOperation: async () => {
      throw new Error('canario-privado-no-real');
    },
  };
  await assert.rejects(
    new AgentExecutionService(setup.registry, broken).execute(
      actor,
      request(),
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentGatewayError);
      assert.equal(error.outcome, 'uncertain');
      assert.equal(inspect(error).includes('canario-privado'), false);
      return true;
    },
  );
});

test('errores de respuesta válidos se presentan con mensajes locales, no con datos del agente', async (context) => {
  const setup = registry();
  const gateway = new InMemoryAgentGateway(
    setup.registry,
    setup.catalog,
    {
      execute: async (value) => {
        const base = completed(value);
        return {
          protocol_version: base.protocol_version,
          kind: base.kind,
          instance_id: base.instance_id,
          subject_ref: base.subject_ref,
          agent_id: base.agent_id,
          request_id: base.request_id,
          correlation_id: base.correlation_id,
          status: 'failed',
          error: {
            code: 'VALIDATION_FAILED',
            message: 'canario-privado-no-real',
            retryable: false,
          },
        };
      },
      getOperation: async () => assert.fail('No consultar'),
    },
    { resultCacheMs: 60_000 },
  );
  context.after(() => gateway.close());
  const result: AgentExecutionResult = await gateway.execute(
    request(),
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(result).includes('canario-privado'), false);
});

test('demo de proceso termina sin credenciales y se etiqueta como simulada', () => {
  const file = fileURLToPath(
    new URL('../src/app/agent-demo.ts', import.meta.url),
  );
  const result = spawnSync(process.execPath, [file], {
    cwd: tmpdir(),
    env: { NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'canario-no-real' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: 'simulated',
    status: 'completed',
  });
});
