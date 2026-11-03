import { createHash, createHmac } from 'node:crypto';
import { writeSync } from 'node:fs';

import { DurableAgentGateway } from '../../src/agents/durable-gateway.ts';
import { commandFingerprint, executionKey } from '../../src/agents/json.ts';
import type {
  DurableStateStore,
  ExecutionTransition,
} from '../../src/agents/state-store.ts';
import type { AgentExecutionRequest } from '../../src/agents/protocol.ts';
import { SqliteStateStore } from '../../src/infrastructure/sqlite-state-store.ts';
import { completed, registry } from '../agent-runtime.fixtures.ts';

function stopAtBoundary(): never {
  writeSync(1, 'durable-boundary\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.exit(2);
}
process.once(
  'message',
  (message: {
    path: string;
    secret: string;
    request: AgentExecutionRequest;
    stage: string;
  }) => {
    const store = new SqliteStateStore({ path: message.path });
    const value = message.request;
    if (message.stage === 'reserved') {
      const now = Date.now();
      store.reserveExecution({
        key: createHash('sha256').update(executionKey(value)).digest('hex'),
        commandHash: createHmac(
          'sha256',
          Buffer.from(message.secret, 'base64url'),
        )
          .update(commandFingerprint(value))
          .digest('hex'),
        owner: 'crashed-owner',
        phase: 'reserved',
        context: {
          protocol_version: '1.0',
          instance_id: value.instance_id,
          subject_ref: value.subject_ref,
          agent_id: value.agent_id,
          request_id: value.request_id,
          correlation_id: value.correlation_id,
          capability: value.capability,
        },
        createdAt: now,
        updatedAt: now,
      });
      stopAtBoundary();
    }
    const observed: DurableStateStore = new Proxy(store, {
      get(target, property) {
        if (property === 'transitionExecution')
          return (
            key: string,
            owner: string,
            change: ExecutionTransition,
            now: number,
          ) => {
            if (change.phase === 'completed' && message.stage === 'received')
              stopAtBoundary();
            target.transitionExecution(key, owner, change, now);
            if (change.phase === 'completed' && message.stage === 'confirmed')
              stopAtBoundary();
          };
        const result: unknown = Reflect.get(target, property);
        return typeof result === 'function' ? result.bind(target) : result;
      },
    });
    const fixture = registry();
    const engine = new DurableAgentGateway(
      fixture.registry,
      fixture.catalog,
      {
        execute: async (input) => {
          if (message.stage === 'started') stopAtBoundary();
          return completed(input);
        },
        getOperation: async () => {
          throw new Error('Unexpected polling');
        },
      },
      observed,
      message.secret,
      { resultCacheMs: 1000 },
    );
    void engine
      .execute(value, new AbortController().signal)
      .catch(() => process.exit(3));
  },
);
