import { createHash, createHmac, randomUUID } from 'node:crypto';

import { AgentGatewayError, safeAgentMessage } from './errors.ts';
import { InMemoryAgentGateway, type GatewayOptions } from './gateway.ts';
import { commandFingerprint, executionKey } from './json.ts';
import type {
  AgentErrorCode,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentGateway,
  AgentOperationQuery,
  AgentRegistry,
} from './protocol.ts';
import { authorizeExecution, authorizeSubject } from './registry.ts';
import type { DurableExecution, DurableStateStore } from './state-store.ts';
import type { AgentTransport } from './transport.ts';
import {
  type CapabilitySchemaCatalog,
  parseExecutionRequest,
  parseExecutionResult,
  parseOperationQuery,
} from './validation.ts';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Adds transactional safety to the existing in-memory execution engine. */
export class DurableAgentGateway implements AgentGateway {
  readonly #store: DurableStateStore;
  readonly #registry: AgentRegistry;
  readonly #schemas: CapabilitySchemaCatalog;
  readonly #inner: InMemoryAgentGateway;
  readonly #key: Buffer;
  readonly #owner = randomUUID();
  readonly #owned = new Set<string>();
  readonly #capacity: number;
  #poisoned = false;
  #closed = false;

  constructor(
    registry: AgentRegistry,
    schemas: CapabilitySchemaCatalog,
    transport: AgentTransport,
    store: DurableStateStore,
    fingerprintKey: string,
    options: Omit<GatewayOptions, 'observer'>,
  ) {
    this.#registry = registry;
    this.#schemas = schemas;
    this.#store = store;
    this.#key = Buffer.from(fingerprintKey, 'base64url');
    this.#capacity = options.maxRecords ?? 256;
    if (this.#key.length < 32 || this.#key.length > 64)
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    this.#inner = new InMemoryAgentGateway(
      registry,
      schemas,
      {
        execute: async (request, signal) => {
          this.#ready(signal);
          const key = digest(executionKey(request));
          this.#storage(() =>
            store.transitionExecution(
              key,
              this.#owner,
              { phase: 'started' },
              Date.now(),
            ),
          );
          this.#ready(signal);
          if (Date.parse(request.deadline_at) <= Date.now())
            throw new AgentGatewayError('TIMEOUT', 'uncertain');
          authorizeExecution(registry, request);
          return transport.execute(request, signal);
        },
        getOperation: (query, signal) => {
          this.#ready(signal);
          return transport.getOperation(query, signal);
        },
      },
      {
        ...options,
        observer: {
          result: (key, result) => this.#recordResult(digest(key), result),
          error: (key, error, mode) => {
            if (mode !== 'execute') return; // Poll failure never proves the pending operation failed.
            this.#storage(() =>
              store.transitionExecution(
                digest(key),
                this.#owner,
                {
                  phase:
                    error.outcome === 'not-started'
                      ? 'not-started'
                      : 'uncertain',
                  errorCode: error.code,
                  outcome: error.outcome,
                },
                Date.now(),
              ),
            );
          },
        },
      },
    );
  }

  async execute(
    value: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.#ready(signal);
    const request = parseExecutionRequest(value);
    const capability = authorizeExecution(this.#registry, request);
    this.#schemas.validate(capability.input_schema_id, request.input);
    const key = digest(executionKey(request));
    const commandHash = createHmac('sha256', this.#key)
      .update(commandFingerprint(request))
      .digest('hex');
    if (this.#owned.has(key)) {
      const live = this.#storage(() => this.#store.getExecution(key));
      if (!live) {
        this.#poisoned = true;
        throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
      }
      if (live.commandHash !== commandHash)
        throw new AgentGatewayError('IDEMPOTENCY_CONFLICT');
    }
    if (!this.#owned.has(key)) {
      if (this.#owned.size >= this.#capacity)
        throw new AgentGatewayError('CAPACITY_EXCEEDED');
      if (Date.parse(request.deadline_at) <= Date.now())
        throw new AgentGatewayError('TIMEOUT');
      const now = Date.now();
      const reserved = this.#storage(() =>
        this.#store.reserveExecution({
          key,
          commandHash,
          owner: this.#owner,
          phase: 'reserved',
          createdAt: now,
          updatedAt: now,
          context: {
            protocol_version: '1.0',
            instance_id: request.instance_id,
            subject_ref: request.subject_ref,
            agent_id: request.agent_id,
            request_id: request.request_id,
            correlation_id: request.correlation_id,
            capability: request.capability,
          },
        }),
      );
      if (!reserved.created) return this.#recover(reserved.record);
      this.#owned.add(key);
    }
    try {
      const result = await this.#inner.execute(request, signal);
      this.#ready(signal); // A failed ledger write can never leak cached success.
      return result;
    } catch (error) {
      if (this.#poisoned)
        throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
      throw error instanceof AgentGatewayError
        ? error
        : new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }

  async getOperation(
    value: AgentOperationQuery,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.#ready(signal);
    const query = parseOperationQuery(value);
    authorizeSubject(this.#registry, query);
    const record = this.#storage(() =>
      this.#store.findOperation(
        {
          instance_id: query.instance_id,
          agent_id: query.agent_id,
          subject_ref: query.subject_ref,
        },
        query.operation_id,
      ),
    );
    if (
      !record ||
      record.context.request_id !== query.request_id ||
      record.context.correlation_id !== query.correlation_id
    )
      throw new AgentGatewayError('UNKNOWN_OPERATION');
    authorizeExecution(this.#registry, record.context);
    if (!this.#owned.has(record.key)) return this.#recover(record);
    const result = await this.#inner.getOperation(query, signal);
    this.#ready(signal);
    return result;
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#inner.close();
    }
  }

  #recover(record: DurableExecution): AgentExecutionResult {
    if (record.phase === 'completed')
      throw new AgentGatewayError('RESULT_EXPIRED', 'completed');
    if (
      record.phase === 'pending' &&
      record.operationId &&
      record.pollAfterMs &&
      record.pendingExpiresAt
    ) {
      if (record.pendingExpiresAt <= Date.now())
        throw new AgentGatewayError('TIMEOUT', 'uncertain');
      const context = {
        protocol_version: record.context.protocol_version,
        instance_id: record.context.instance_id,
        agent_id: record.context.agent_id,
        subject_ref: record.context.subject_ref,
        request_id: record.context.request_id,
        correlation_id: record.context.correlation_id,
      };
      return {
        ...context,
        kind: 'execution-result',
        status: 'pending',
        operation_id: record.operationId,
        poll_after_ms: record.pollAfterMs,
      } as AgentExecutionResult;
    }
    if (record.phase === 'failed')
      return parseExecutionResult(
        {
          protocol_version: '1.0',
          kind: 'execution-result',
          instance_id: record.context.instance_id,
          agent_id: record.context.agent_id,
          subject_ref: record.context.subject_ref,
          request_id: record.context.request_id,
          correlation_id: record.context.correlation_id,
          status: 'failed',
          error: {
            code: (record.errorCode ?? 'INTERNAL_ERROR') as AgentErrorCode,
            message: safeAgentMessage(
              (record.errorCode ?? 'INTERNAL_ERROR') as AgentErrorCode,
            ),
            retryable: false,
          },
        },
        record.context,
        authorizeExecution(this.#registry, record.context),
        this.#schemas,
      );
    if (record.phase === 'not-started')
      throw new AgentGatewayError(
        record.errorCode ?? 'UNAVAILABLE',
        'not-started',
      );
    throw new AgentGatewayError(record.errorCode ?? 'UNAVAILABLE', 'uncertain');
  }

  #recordResult(key: string, result: AgentExecutionResult): void {
    const record = this.#storage(() => this.#store.getExecution(key));
    if (!record) throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
    const capability = authorizeExecution(this.#registry, record.context);
    parseExecutionResult(result, record.context, capability, this.#schemas);
    this.#storage(() =>
      this.#store.transitionExecution(
        key,
        this.#owner,
        {
          phase: result.status,
          outcome: result.status,
          ...(result.status === 'pending'
            ? {
                operationId: result.operation_id,
                pollAfterMs: result.poll_after_ms,
                pendingExpiresAt:
                  record.pendingExpiresAt ?? Date.now() + 86_400_000,
              }
            : {}),
          ...(result.status === 'failed'
            ? { errorCode: result.error.code }
            : {}),
        },
        Date.now(),
      ),
    );
  }

  #ready(signal: AbortSignal): void {
    if (this.#poisoned || this.#closed)
      throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
    if (signal.aborted) throw new AgentGatewayError('CANCELLED');
  }
  #storage<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (
        error instanceof AgentGatewayError &&
        [
          'IDEMPOTENCY_CONFLICT',
          'RESULT_EXPIRED',
          'CAPACITY_EXCEEDED',
        ].includes(error.code)
      )
        throw error;
      this.#poisoned = true;
      throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }
}
