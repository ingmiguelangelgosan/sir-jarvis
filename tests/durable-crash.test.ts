import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DurableAgentGateway } from '../src/agents/durable-gateway.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import { SqliteStateStore } from '../src/infrastructure/sqlite-state-store.ts';
import { registry, request } from './agent-runtime.fixtures.ts';
import { temporaryState } from './durable-test.fixtures.ts';

for (const stage of ['reserved', 'started', 'received', 'confirmed'])
  test(`caída real de proceso en frontera ${stage}: WAL conserva reserva sin nueva ejecución`, async (t) => {
    const file = temporaryState(t);
    const bootstrap = new SqliteStateStore({ path: file.path, create: true });
    bootstrap.close();
    const value = request({
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const secret = randomBytes(32).toString('base64url');
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/durable-crash-worker.ts', import.meta.url),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [],
        env:
          process.platform === 'win32' && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {},
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 200);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Crash fixture did not reach boundary'));
        }, 10_000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Crash fixture failed'));
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Crash fixture exited before boundary'));
        });
        child.stdout?.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          if (chunk.toString('utf8').includes('durable-boundary')) resolve();
          else reject(new Error('Invalid fixture output'));
        });
        child.send({ path: file.path, secret, request: value, stage });
      });
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      });
      assert.equal(stderr, '');
      const store = new SqliteStateStore({ path: file.path });
      const fixture = registry();
      const recovered = new DurableAgentGateway(
        fixture.registry,
        fixture.catalog,
        {
          execute: async () =>
            assert.fail('A crash never creates a new executable operation'),
          getOperation: async () => assert.fail('No remote reconstruction'),
        },
        store,
        secret,
        { resultCacheMs: 1000 },
      );
      try {
        await Promise.all(
          Array.from({ length: 12 }, async () => {
            await assert.rejects(
              recovered.execute(value, new AbortController().signal),
              (error: unknown) => {
                assert.ok(error instanceof AgentGatewayError);
                assert.equal(
                  error.code,
                  stage === 'confirmed' ? 'RESULT_EXPIRED' : 'UNAVAILABLE',
                );
                assert.equal(
                  error.outcome,
                  stage === 'confirmed' ? 'completed' : 'uncertain',
                );
                return true;
              },
            );
          }),
        );
      } finally {
        recovered.close();
        store.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGKILL');
        });
    }
  });
