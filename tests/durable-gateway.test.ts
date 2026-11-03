import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { DurableAgentGateway } from '../src/agents/durable-gateway.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import { executionKey } from '../src/agents/json.ts';
import type {
  AgentExecutionRequest,
  AgentOperationQuery,
} from '../src/agents/protocol.ts';
import type { DurableStateStore } from '../src/agents/state-store.ts';
import type { AgentTransport } from '../src/agents/transport.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import { completed, registry, request } from './agent-runtime.fixtures.ts';
import { temporaryState } from './durable-test.fixtures.ts';

const signal = () => new AbortController().signal;
const keyFor = (value: AgentExecutionRequest) =>
  createHash('sha256').update(executionKey(value)).digest('hex');
const errorCode = (code: string, outcome?: string) => (error: unknown) => {
  assert.ok(error instanceof AgentGatewayError);
  assert.equal(error.code, code);
  if (outcome) assert.equal(error.outcome, outcome);
  return true;
};
function gateway(
  store: DurableStateStore,
  transport: Partial<AgentTransport>,
  secret: string,
) {
  const fixtures = registry();
  return new DurableAgentGateway(
    fixtures.registry,
    fixtures.catalog,
    {
      execute: async (value) => completed(value),
      getOperation: async () => assert.fail('No unexpected remote polling'),
      ...transport,
    },
    store,
    secret,
    { resultCacheMs: 1000 },
  );
}

test('cierre y reapertura conservan completed sin output privado ni nueva ejecución', async (t) => {
  const file = temporaryState(t);
  const secret = randomBytes(32).toString('base64url');
  const value = request({ input: { text: 'private-input-canary' } });
  let calls = 0;
  let store = new SqliteStateStore({ path: file.path, create: true });
  let engine = gateway(
    store,
    {
      execute: async (input) => {
        calls += 1;
        return {
          ...completed(input),
          output: { text: 'private-output-canary' },
        };
      },
    },
    secret,
  );
  assert.equal((await engine.execute(value, signal())).status, 'completed');
  assert.equal(store.getExecution(keyFor(value))?.phase, 'completed');
  engine.close();
  store.close();
  const bytes = readFileSync(file.path).toString('utf8');
  assert.ok(
    !bytes.includes('private-input-canary') &&
      !bytes.includes('private-output-canary'),
  );
  store = new SqliteStateStore({ path: file.path });
  engine = gateway(
    store,
    { execute: async () => assert.fail('Never execute after restart') },
    secret,
  );
  try {
    await assert.rejects(
      engine.execute(value, signal()),
      errorCode('RESULT_EXPIRED', 'completed'),
    );
    await assert.rejects(
      engine.execute(
        { ...value, input: { text: 'different-command' } },
        signal(),
      ),
      errorCode('IDEMPOTENCY_CONFLICT'),
    );
    assert.equal(calls, 1);
  } finally {
    engine.close();
    store.close();
  }
});

test('duplicados concurrentes comparten flight; abortar un follower no cierra al líder', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const secret = randomBytes(32).toString('base64url');
  const value = request();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const engine = gateway(
    store,
    {
      execute: async (input) => {
        calls += 1;
        await wait;
        return completed(input);
      },
    },
    secret,
  );
  file.cleanup(() => {
    engine.close();
    store.close();
  });
  const leader = engine.execute(value, signal());
  const controller = new AbortController();
  const follower = engine.execute(value, controller.signal);
  controller.abort();
  await assert.rejects(follower, errorCode('CANCELLED'));
  const duplicates = Array.from({ length: 20 }, () =>
    engine.execute(value, signal()),
  );
  release();
  const results = await Promise.all([leader, ...duplicates]);
  assert.equal(calls, 1);
  assert.equal(results[0]?.status, 'completed');
  assert.equal(store.getExecution(keyFor(value))?.phase, 'completed');
});

test('dos conexiones y coordinadores no despachan la misma operación lógica', async (t) => {
  const file = temporaryState(t);
  const firstStore = new SqliteStateStore({ path: file.path, create: true });
  const secondStore = new SqliteStateStore({ path: file.path });
  const secret = randomBytes(32).toString('base64url');
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const first = gateway(
    firstStore,
    {
      execute: async (value) => {
        calls += 1;
        await wait;
        return completed(value);
      },
    },
    secret,
  );
  const second = gateway(
    secondStore,
    { execute: async () => assert.fail('No second dispatch') },
    secret,
  );
  file.cleanup(() => {
    first.close();
    second.close();
    firstStore.close();
    secondStore.close();
  });
  const value = request();
  const running = first.execute(value, signal());
  await assert.rejects(
    second.execute(value, signal()),
    errorCode('UNAVAILABLE', 'uncertain'),
  );
  release();
  await running;
  await assert.rejects(
    second.execute(value, signal()),
    errorCode('RESULT_EXPIRED', 'completed'),
  );
  assert.equal(calls, 1);
});

test('una reserva previa, sin evidencia de dispatch, se bloquea al abrir otro coordinador', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const secret = randomBytes(32).toString('base64url');
  const value = request();
  const controller = new AbortController();
  const first = gateway(store, {}, secret);
  const work = first.execute(value, controller.signal);
  controller.abort();
  await assert.rejects(work);
  first.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = gateway(
    reopened,
    { execute: async () => assert.fail('No recovered execution') },
    secret,
  );
  try {
    await assert.rejects(
      recovered.execute(value, signal()),
      (error: unknown) => error instanceof AgentGatewayError,
    );
  } finally {
    recovered.close();
    reopened.close();
  }
});

test('pending conserva request/correlation/operation y no hace polling remoto tras reapertura', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const value = request();
  const secret = randomBytes(32).toString('base64url');
  const pending = {
    protocol_version: '1.0',
    kind: 'execution-result',
    instance_id: value.instance_id,
    agent_id: value.agent_id,
    subject_ref: value.subject_ref,
    request_id: value.request_id,
    correlation_id: value.correlation_id,
    status: 'pending',
    operation_id: 'operation-original',
    poll_after_ms: 1,
  } as const;
  const engine = gateway(
    store,
    { execute: async () => pending, getOperation: async () => pending },
    secret,
  );
  assert.equal((await engine.execute(value, signal())).status, 'pending');
  const query: AgentOperationQuery = {
    protocol_version: '1.0',
    instance_id: value.instance_id,
    agent_id: value.agent_id,
    subject_ref: value.subject_ref,
    request_id: value.request_id,
    correlation_id: value.correlation_id,
    operation_id: pending.operation_id,
  };
  assert.equal((await engine.getOperation(query, signal())).status, 'pending');
  const expiry = store.getExecution(keyFor(value))?.pendingExpiresAt;
  engine.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = gateway(
    reopened,
    {
      execute: async () => assert.fail('No repeat'),
      getOperation: async () => assert.fail('No remote recovery polling'),
    },
    secret,
  );
  try {
    assert.deepEqual(await recovered.execute(value, signal()), pending);
    assert.deepEqual(await recovered.getOperation(query, signal()), pending);
    assert.equal(
      reopened.getExecution(keyFor(value))?.pendingExpiresAt,
      expiry,
    );
    await assert.rejects(
      recovered.getOperation({ ...query, correlation_id: 'other' }, signal()),
      errorCode('UNKNOWN_OPERATION'),
    );
  } finally {
    recovered.close();
    reopened.close();
  }
});

test('fallo confirmado conserva su código seguro al reiniciar', async (t) => {
  const file = temporaryState(t);
  const secret = randomBytes(32).toString('base64url');
  const value = request();
  const store = new SqliteStateStore({ path: file.path, create: true });
  const engine = gateway(
    store,
    {
      execute: async (input) => {
        const base = {
          protocol_version: input.protocol_version,
          kind: 'execution-result' as const,
          instance_id: input.instance_id,
          agent_id: input.agent_id,
          subject_ref: input.subject_ref,
          request_id: input.request_id,
          correlation_id: input.correlation_id,
        };
        return {
          ...base,
          status: 'failed',
          error: {
            code: 'VALIDATION_FAILED',
            message: 'private-error-canary',
            retryable: false,
          },
        };
      },
    },
    secret,
  );
  await engine.execute(value, signal());
  engine.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = gateway(reopened, {}, secret);
  try {
    const result = await recovered.execute(value, signal());
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.equal(result.error.code, 'VALIDATION_FAILED');
      assert.ok(!result.error.message.includes('canary'));
    }
  } finally {
    recovered.close();
    reopened.close();
  }
});

test('fallo de persistencia anterior a dispatch impide efectos y no degrada a memoria', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const broken = new Proxy(store, {
    get(target, property) {
      if (property === 'transitionExecution')
        return () => {
          throw new Error('private database path');
        };
      const result: unknown = Reflect.get(target, property);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  const engine = gateway(
    broken,
    { execute: async () => assert.fail('Must not dispatch') },
    randomBytes(32).toString('base64url'),
  );
  try {
    await assert.rejects(
      engine.execute(request(), signal()),
      errorCode('UNAVAILABLE', 'uncertain'),
    );
    await assert.rejects(
      engine.execute(request({ idempotency_key: 'new-key' }), signal()),
      errorCode('UNAVAILABLE', 'uncertain'),
    );
  } finally {
    engine.close();
    store.close();
  }
});

test('fallo al confirmar respuesta no expone éxito cacheado ni permite repetir tras reinicio', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  const secret = randomBytes(32).toString('base64url');
  const value = request();
  let calls = 0;
  const broken = new Proxy(store, {
    get(target, property) {
      if (property === 'transitionExecution')
        return (
          key: string,
          owner: string,
          change: { phase: string },
          now: number,
        ) => {
          if (change.phase === 'completed' || change.phase === 'uncertain')
            throw new Error('storage failure');
          target.transitionExecution(
            key,
            owner,
            change as { phase: 'started' },
            now,
          );
        };
      const result: unknown = Reflect.get(target, property);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  const engine = gateway(
    broken,
    {
      execute: async (input) => {
        calls += 1;
        return completed(input);
      },
    },
    secret,
  );
  await assert.rejects(
    engine.execute(value, signal()),
    errorCode('UNAVAILABLE', 'uncertain'),
  );
  await assert.rejects(
    engine.execute(value, signal()),
    errorCode('UNAVAILABLE', 'uncertain'),
  );
  engine.close();
  store.close();
  const reopened = new SqliteStateStore({ path: file.path });
  const recovered = gateway(
    reopened,
    { execute: async () => assert.fail('Never repeat') },
    secret,
  );
  try {
    await assert.rejects(
      recovered.execute(value, signal()),
      errorCode('UNAVAILABLE', 'uncertain'),
    );
    assert.equal(calls, 1);
  } finally {
    recovered.close();
    reopened.close();
  }
});

test('last abort persiste incertidumbre y descarta el resultado tardío', async (t) => {
  const file = temporaryState(t);
  const store = new SqliteStateStore({ path: file.path, create: true });
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const value = request();
  const engine = gateway(
    store,
    {
      execute: async (input) => {
        began();
        await sleep(30);
        return completed(input);
      },
    },
    randomBytes(32).toString('base64url'),
  );
  const controller = new AbortController();
  const work = engine.execute(value, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(work, errorCode('CANCELLED', 'uncertain'));
  await sleep(40);
  assert.equal(store.getExecution(keyFor(value))?.phase, 'uncertain');
  engine.close();
  store.close();
});
