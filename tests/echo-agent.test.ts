import assert from 'node:assert/strict';
import { request } from 'node:https';
import { test } from 'node:test';

import { startEchoAgent, type EchoProcess } from './https-process.ts';

// This client deliberately has no imports from src/: the service is autonomous.
function command() {
  return {
    protocol_version: '1.0',
    kind: 'execute',
    instance_id: 'jarvis-demo',
    agent_id: 'demo.echo',
    subject_ref: 'owner-demo',
    request_id: 'independent-request',
    correlation_id: 'independent-flow',
    idempotency_key: 'independent-key',
    capability: { name: 'echo.reply', version: '1.0' },
    deadline_at: new Date(Date.now() + 10_000).toISOString(),
    cost_policy: 'no-paid-services',
    input: { text: 'Independiente de Jarvis' },
  };
}

function call(
  server: EchoProcess,
  value: unknown,
  authenticated = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'echo.test',
        port: Number(new URL(server.origin).port),
        path: '/v1/execute',
        method: 'POST',
        agent: false,
        family: 4,
        ca: server.ca,
        rejectUnauthorized: true,
        lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4),
        headers: {
          Authorization: `Bearer ${authenticated ? server.token : 'incorrect-test-credential'}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              ) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

test('echo.reply se inicia y prueba con cliente independiente sin Core/Registry/Gateway', async (t) => {
  const server = await startEchoAgent();
  t.after(() => server.close());
  const value = command();
  const result = await call(server, value);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'completed');
  assert.deepEqual(result.body.output, value.input);
  assert.equal(server.diagnosticsBytes(), 0);
});

test('el proceso independiente rechaza credenciales y capacidad antes de efectos', async (t) => {
  const server = await startEchoAgent();
  t.after(() => server.close());
  assert.equal((await call(server, command(), false)).status, 401);
  assert.equal(
    (
      await call(server, {
        ...command(),
        capability: { name: 'unapproved', version: '1.0' },
      })
    ).status,
    422,
  );
  assert.equal((await server.stats()).executions, 0);
});

test('el proceso independiente reserva duplicados simultáneos y rechaza cambio de comando', async (t) => {
  const server = await startEchoAgent({ mode: 'slow', delayMs: 30 });
  t.after(() => server.close());
  const value = command();
  const results = await Promise.all([call(server, value), call(server, value)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await server.stats()).executions, 1);
  assert.equal((await server.stats()).duplicates, 1);
  assert.equal(
    (await call(server, { ...value, input: { text: 'different' } })).status,
    409,
  );
});
