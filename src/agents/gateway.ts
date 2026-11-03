import { setTimeout as sleep } from 'node:timers/promises';

import {
  AgentGatewayError,
  AgentTransportError,
  type ExecutionOutcome,
} from './errors.ts';
import { commandFingerprint, executionKey } from './json.ts';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentGateway,
  AgentOperationQuery,
  AgentRegistry,
} from './protocol.ts';
import { authorizeExecution, authorizeSubject } from './registry.ts';
import type { AgentTransport } from './transport.ts';
import {
  type CapabilitySchemaCatalog,
  parseExecutionRequest,
  parseExecutionResult,
  parseOperationQuery,
} from './validation.ts';

type Context = Pick<
  AgentExecutionRequest,
  | 'protocol_version'
  | 'instance_id'
  | 'agent_id'
  | 'subject_ref'
  | 'request_id'
  | 'correlation_id'
  | 'capability'
>;
interface Flight {
  readonly mode: 'execute' | 'poll';
  readonly controller: AbortController;
  readonly deadlineAt: number;
  readonly waiters: Set<symbol>;
  readonly promise: Promise<AgentExecutionResult>;
  readonly resolve: (value: AgentExecutionResult) => void;
  readonly reject: (error: AgentGatewayError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  joins: number;
  attemptDeadlineAt: number | undefined;
}
interface Entry {
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly context: Context;
  state: ExecutionOutcome | 'in-flight';
  possibleEffect: boolean;
  active: Flight | undefined;
  result: AgentExecutionResult | undefined;
  error: AgentGatewayError | undefined;
  cacheTimer: ReturnType<typeof setTimeout> | undefined;
  resultExpiresAt: number | undefined;
  operationId: string | undefined;
  nextPollAt: number;
  pendingExpiresAt: number | undefined;
}

export interface GatewayOptions {
  /** Internal atomic state observer, never a public agent wire contract. */
  readonly observer?: {
    result(key: string, result: AgentExecutionResult): void;
    error(
      key: string,
      error: AgentGatewayError,
      mode: 'execute' | 'poll',
    ): void;
  };
  /** Retención transitoria explícita de outputs; las claves no se expulsan. */
  readonly resultCacheMs: number;
  readonly maxRecords?: number;
  readonly maxWaiters?: number;
  readonly attemptTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Jitter en milisegundos, 0..250. */
  readonly jitter?: () => number;
}

function integer(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new AgentGatewayError('INVALID_CONFIGURATION');
  return value;
}

function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () =>
      finish(
        false,
        new AgentGatewayError(
          signal.reason === 'deadline' ? 'TIMEOUT' : 'CANCELLED',
        ),
      );
    function finish(success: boolean, value: unknown): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      if (success) resolve(value as T);
      else reject(value);
    }
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) {
      stop();
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new AgentGatewayError('CANCELLED');
        return work();
      })
      .then(
        (value) => finish(true, value),
        (error: unknown) => finish(false, error),
      );
  });
}

export class InMemoryAgentGateway implements AgentGateway {
  readonly #registry: AgentRegistry;
  readonly #schemas: CapabilitySchemaCatalog;
  readonly #transport: AgentTransport;
  readonly #options: Required<Omit<GatewayOptions, 'observer'>>;
  readonly #observer: GatewayOptions['observer'];
  readonly #entries = new Map<string, Entry>();
  readonly #operations = new Map<string, Entry>();
  readonly #cooldowns = new Map<string, number>();
  #closed = false;

  constructor(
    registry: AgentRegistry,
    schemas: CapabilitySchemaCatalog,
    transport: AgentTransport,
    options: GatewayOptions,
  ) {
    this.#registry = registry;
    this.#schemas = schemas;
    this.#transport = transport;
    this.#observer = options.observer;
    this.#options = {
      resultCacheMs: integer(options.resultCacheMs, 900_000),
      maxRecords: integer(options.maxRecords ?? 256, 4096),
      maxWaiters: integer(options.maxWaiters ?? 64, 256),
      attemptTimeoutMs: integer(options.attemptTimeoutMs ?? 10_000, 10_000),
      totalTimeoutMs: integer(options.totalTimeoutMs ?? 30_000, 30_000),
      now: options.now ?? Date.now,
      wait:
        options.wait ??
        (async (milliseconds, signal) => {
          await sleep(milliseconds, undefined, { signal });
        }),
      jitter: options.jitter ?? (() => Math.floor(Math.random() * 250)),
    };
    this.#now();
  }

  async execute(
    value: unknown,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.#ready(signal);
    const request = parseExecutionRequest(value);
    const capability = authorizeExecution(this.#registry, request);
    this.#schemas.validate(capability.input_schema_id, request.input);
    const key = executionKey(request);
    const fingerprint = commandFingerprint(request);
    const existing = this.#entries.get(key);
    if (signal.aborted)
      throw new AgentGatewayError(
        'CANCELLED',
        existing?.possibleEffect ? 'uncertain' : 'not-started',
      );
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new AgentGatewayError('IDEMPOTENCY_CONFLICT');
      this.#expirePending(existing);
      this.#expireResult(existing);
      if (existing.error) throw existing.error;
      if (existing.result) return existing.result;
      if (existing.active)
        return this.#join(
          existing,
          existing.active,
          signal,
          Date.parse(request.deadline_at),
        );
      throw new AgentGatewayError(
        'RESULT_EXPIRED',
        existing.state === 'completed' ? 'completed' : 'uncertain',
      );
    }
    const deadline = Math.min(
      Date.parse(request.deadline_at),
      this.#now() + this.#options.totalTimeoutMs,
    );
    if (deadline <= this.#now()) throw new AgentGatewayError('TIMEOUT');
    if (this.#entries.size >= this.#options.maxRecords)
      throw new AgentGatewayError('CAPACITY_EXCEEDED');
    const context: Context = Object.freeze({
      protocol_version: request.protocol_version,
      instance_id: request.instance_id,
      agent_id: request.agent_id,
      subject_ref: request.subject_ref,
      request_id: request.request_id,
      correlation_id: request.correlation_id,
      capability: request.capability,
    });
    const entry: Entry = {
      requestKey: key,
      fingerprint,
      context,
      state: 'in-flight',
      possibleEffect: false,
      active: undefined,
      result: undefined,
      error: undefined,
      cacheTimer: undefined,
      resultExpiresAt: undefined,
      operationId: undefined,
      nextPollAt: 0,
      pendingExpiresAt: undefined,
    };
    // Reserva atómica en este proceso, antes de programar trabajo o esperar.
    this.#entries.set(key, entry);
    const flight = this.#start(entry, 'execute', deadline, (active) =>
      this.#run(entry, active, (activeSignal) =>
        this.#transport.execute(request, activeSignal),
      ),
    );
    return this.#join(entry, flight, signal, deadline);
  }

  async getOperation(
    value: unknown,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.#ready(signal);
    const query = parseOperationQuery(value);
    authorizeSubject(this.#registry, query);
    const entry = this.#operations.get(this.#operationKey(query));
    if (
      !entry ||
      entry.context.request_id !== query.request_id ||
      entry.context.correlation_id !== query.correlation_id
    ) {
      throw new AgentGatewayError('UNKNOWN_OPERATION');
    }
    authorizeExecution(this.#registry, entry.context);
    if (signal.aborted) throw new AgentGatewayError('CANCELLED', 'uncertain');
    this.#expirePending(entry);
    this.#expireResult(entry);
    if (entry.state !== 'pending') {
      if (entry.error) throw entry.error;
      if (entry.result) return entry.result;
      throw new AgentGatewayError(
        'RESULT_EXPIRED',
        entry.state === 'completed' ? 'completed' : 'uncertain',
      );
    }
    const deadline = Math.min(
      this.#now() + this.#options.totalTimeoutMs,
      entry.pendingExpiresAt ?? Infinity,
    );
    if (entry.active) return this.#join(entry, entry.active, signal, deadline);
    const flight = this.#start(entry, 'poll', deadline, (active) =>
      this.#run(entry, active, (activeSignal) =>
        this.#transport.getOperation(query, activeSignal),
      ),
    );
    return this.#join(entry, flight, signal, deadline);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      if (entry.active)
        this.#terminate(
          entry,
          entry.active,
          new AgentGatewayError('CANCELLED', this.#outcome(entry)),
        );
      if (entry.cacheTimer) clearTimeout(entry.cacheTimer);
      entry.result = undefined;
    }
    this.#entries.clear();
    this.#operations.clear();
    this.#cooldowns.clear();
  }

  #ready(signal: AbortSignal): void {
    if (this.#closed) throw new AgentGatewayError('UNAVAILABLE');
    if (!(signal instanceof AbortSignal))
      throw new AgentGatewayError('VALIDATION_FAILED');
  }

  #now(): number {
    const value = this.#options.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    return value;
  }

  #outcome(entry: Entry): ExecutionOutcome {
    return entry.possibleEffect ? 'uncertain' : 'not-started';
  }

  #operationKey(
    query: Pick<
      AgentOperationQuery,
      'instance_id' | 'subject_ref' | 'agent_id' | 'operation_id'
    >,
  ): string {
    return JSON.stringify([
      query.instance_id,
      query.subject_ref,
      query.agent_id,
      query.operation_id,
    ]);
  }

  #start(
    entry: Entry,
    mode: Flight['mode'],
    deadlineAt: number,
    run: (flight: Flight) => Promise<AgentExecutionResult>,
  ): Flight {
    const deferred = Promise.withResolvers<AgentExecutionResult>();
    const flight: Flight = {
      ...deferred,
      mode,
      deadlineAt,
      controller: new AbortController(),
      waiters: new Set(),
      timer: undefined,
      closed: false,
      joins: 0,
      attemptDeadlineAt: undefined,
    };
    // La promesa compartida puede quedarse sin consumidores al cancelar todos.
    void flight.promise.catch(() => undefined);
    entry.active = flight;
    flight.timer = setTimeout(
      () =>
        this.#terminate(
          entry,
          flight,
          new AgentGatewayError('TIMEOUT', this.#outcome(entry)),
        ),
      Math.max(1, deadlineAt - this.#now()),
    );
    queueMicrotask(() => {
      if (flight.closed) return;
      void run(flight).then(
        (result) => {
          if (flight.closed) return;
          try {
            authorizeExecution(this.#registry, entry.context);
            this.#checkDeadline(entry, flight);
            this.#store(entry, result);
            this.#finish(entry, flight);
            flight.resolve(result);
          } catch (error) {
            this.#fail(entry, flight, error);
          }
        },
        (error: unknown) => this.#fail(entry, flight, error),
      );
    });
    return flight;
  }

  #finish(entry: Entry, flight: Flight): void {
    flight.closed = true;
    if (flight.timer) clearTimeout(flight.timer);
    if (entry.active === flight) entry.active = undefined;
  }

  #fail(entry: Entry, flight: Flight, error: unknown): void {
    if (flight.closed) return;
    let safe = new AgentGatewayError(
      error instanceof AgentGatewayError ? error.code : 'UNAVAILABLE',
      this.#outcome(entry),
    );
    try {
      this.#observer?.error(entry.requestKey, safe, flight.mode);
    } catch {
      safe = new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
    if (flight.mode === 'execute') {
      this.#clearResult(entry);
      entry.error = safe;
      entry.state = safe.outcome;
    }
    this.#finish(entry, flight);
    flight.reject(safe);
  }

  #terminate(entry: Entry, flight: Flight, error: AgentGatewayError): void {
    if (flight.closed) return;
    try {
      this.#observer?.error(entry.requestKey, error, flight.mode);
    } catch {
      error = new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
    // Tombstone y cierre antes de abortar: incluso callbacks reentrantes lo ven.
    if (flight.mode === 'execute') {
      this.#clearResult(entry);
      entry.error = error;
      entry.state = error.outcome;
    }
    this.#finish(entry, flight);
    flight.reject(error);
    flight.controller.abort(
      error.code === 'TIMEOUT' ? 'deadline' : 'cancelled',
    );
  }

  #join(
    entry: Entry,
    flight: Flight,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<AgentExecutionResult> {
    // Acumulativo, no solo activos: las reacciones de Promise no se desregistran
    // al abortar y tampoco pueden crecer sin límite mediante abort/rejoin.
    if (flight.joins >= this.#options.maxWaiters)
      return Promise.reject(
        new AgentGatewayError('CAPACITY_EXCEEDED', this.#outcome(entry)),
      );
    flight.joins += 1;
    return new Promise((resolve, reject) => {
      const token = Symbol();
      flight.waiters.add(token);
      let done = false;
      const timer: { handle: ReturnType<typeof setTimeout> | undefined } = {
        handle: undefined,
      };
      const cleanup = () => {
        signal.removeEventListener('abort', stop);
        if (timer.handle) clearTimeout(timer.handle);
        flight.waiters.delete(token);
      };
      const leave = (code: 'CANCELLED' | 'TIMEOUT') => {
        if (done) return;
        done = true;
        cleanup();
        const error = new AgentGatewayError(code, this.#outcome(entry));
        if (flight.waiters.size === 0) this.#terminate(entry, flight, error);
        reject(error);
      };
      const stop = () => leave('CANCELLED');
      signal.addEventListener('abort', stop, { once: true });
      const remaining = Math.min(deadlineAt, flight.deadlineAt) - this.#now();
      if (signal.aborted) {
        stop();
        return;
      }
      if (remaining <= 0) {
        leave('TIMEOUT');
        return;
      }
      timer.handle = setTimeout(() => leave('TIMEOUT'), remaining);
      void flight.promise.then(
        (result) => {
          if (done) return;
          try {
            if (Math.min(deadlineAt, flight.deadlineAt) <= this.#now()) {
              leave('TIMEOUT');
              return;
            }
            done = true;
            cleanup();
            resolve(result);
          } catch {
            done = true;
            cleanup();
            reject(
              new AgentGatewayError('INTERNAL_ERROR', this.#outcome(entry)),
            );
          }
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  #store(entry: Entry, result: AgentExecutionResult): void {
    if (result.status === 'pending') {
      if (
        entry.operationId !== undefined &&
        entry.operationId !== result.operation_id
      )
        throw new AgentGatewayError('INVALID_RESPONSE', 'uncertain');
      const key = this.#operationKey({
        ...entry.context,
        operation_id: result.operation_id,
      });
      const existing = this.#operations.get(key);
      if (existing && existing !== entry)
        throw new AgentGatewayError('INVALID_RESPONSE', 'uncertain');
      entry.operationId = result.operation_id;
      entry.nextPollAt = this.#now() + result.poll_after_ms;
      entry.pendingExpiresAt ??= this.#now() + 86_400_000;
      this.#operations.set(key, entry);
    }
    this.#observer?.result(entry.requestKey, result);
    entry.state = result.status;
    entry.result = result;
    if (entry.cacheTimer) clearTimeout(entry.cacheTimer);
    if (result.status === 'completed') {
      entry.resultExpiresAt = this.#now() + this.#options.resultCacheMs;
      entry.cacheTimer = setTimeout(
        () => this.#clearResult(entry),
        this.#options.resultCacheMs,
      );
      entry.cacheTimer.unref();
    }
  }

  #clearResult(entry: Entry): void {
    if (entry.cacheTimer) clearTimeout(entry.cacheTimer);
    entry.cacheTimer = undefined;
    entry.result = undefined;
    entry.resultExpiresAt = undefined;
  }

  #expireResult(entry: Entry): void {
    if (
      entry.resultExpiresAt !== undefined &&
      entry.resultExpiresAt <= this.#now()
    )
      this.#clearResult(entry);
  }

  #expirePending(entry: Entry): void {
    if (
      entry.state !== 'pending' ||
      entry.pendingExpiresAt === undefined ||
      entry.pendingExpiresAt > this.#now()
    )
      return;
    const error = new AgentGatewayError('TIMEOUT', 'uncertain');
    this.#clearResult(entry);
    entry.state = 'uncertain';
    entry.error = error;
    if (entry.active) this.#terminate(entry, entry.active, error);
  }

  #checkDeadline(entry: Entry, flight: Flight): void {
    if (flight.closed || flight.controller.signal.aborted)
      throw new AgentGatewayError('CANCELLED', this.#outcome(entry));
    if (
      Math.min(flight.deadlineAt, flight.attemptDeadlineAt ?? Infinity) <=
      this.#now()
    ) {
      const error = new AgentGatewayError('TIMEOUT', this.#outcome(entry));
      this.#terminate(entry, flight, error);
      throw error;
    }
  }

  async #pause(
    entry: Entry,
    flight: Flight,
    milliseconds: number,
    limitCode: 'TIMEOUT' | 'RATE_LIMITED' = 'TIMEOUT',
  ): Promise<void> {
    if (flight.deadlineAt <= this.#now())
      throw new AgentGatewayError('TIMEOUT');
    if (milliseconds >= flight.deadlineAt - this.#now())
      throw new AgentGatewayError(limitCode);
    await abortable(
      () => this.#options.wait(milliseconds, flight.controller.signal),
      flight.controller.signal,
    );
    if (flight.deadlineAt <= this.#now())
      throw new AgentGatewayError('TIMEOUT');
    // Revalidar permisos después de cualquier espera y antes de efectos.
    authorizeExecution(this.#registry, entry.context);
  }

  async #run(
    entry: Entry,
    flight: Flight,
    send: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<AgentExecutionResult> {
    const target = JSON.stringify([
      entry.context.instance_id,
      entry.context.agent_id,
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (flight.closed || flight.controller.signal.aborted)
        throw new AgentGatewayError('CANCELLED');
      let capability = authorizeExecution(this.#registry, entry.context);
      const previousEffect = entry.possibleEffect;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let retry: 'rate-limit' | 'unavailable' | undefined;
      let retryAfter: number | undefined;
      let retryAllowed = true;
      try {
        const raw = await abortable(async () => {
          // Otro flight puede ampliar el cooldown durante una espera. Releerlo
          // hasta el dispatch, sin consumir intentos ni acortar Retry-After.
          for (;;) {
            const waitUntil = Math.max(
              this.#cooldowns.get(target) ?? 0,
              flight.mode === 'poll' ? entry.nextPollAt : 0,
            );
            if (waitUntil <= this.#now()) break;
            await this.#pause(
              entry,
              flight,
              waitUntil - this.#now(),
              'RATE_LIMITED',
            );
          }
          if (flight.closed || flight.controller.signal.aborted)
            throw new AgentGatewayError('CANCELLED');
          if (flight.deadlineAt <= this.#now())
            throw new AgentGatewayError('TIMEOUT');
          capability = authorizeExecution(this.#registry, entry.context);
          flight.attemptDeadlineAt = Math.min(
            flight.deadlineAt,
            this.#now() + this.#options.attemptTimeoutMs,
          );
          timer = setTimeout(
            () =>
              this.#terminate(
                entry,
                flight,
                new AgentGatewayError('TIMEOUT', this.#outcome(entry)),
              ),
            Math.max(1, flight.attemptDeadlineAt - this.#now()),
          );
          entry.possibleEffect = true;
          return send(flight.controller.signal);
        }, flight.controller.signal);
        this.#checkDeadline(entry, flight);
        const result = parseExecutionResult(
          raw,
          entry.context,
          capability,
          this.#schemas,
        );
        this.#checkDeadline(entry, flight);
        if (result.status !== 'failed') return result;
        retryAllowed = result.error.retryable;
        if (result.error.code === 'TIMEOUT')
          throw new AgentGatewayError('TIMEOUT', 'uncertain');
        if (result.error.code === 'RATE_LIMITED') {
          if (flight.mode === 'execute') entry.possibleEffect = previousEffect;
          retry = 'rate-limit';
          retryAfter = result.error.retry_after_ms;
        } else if (
          result.error.code === 'UNAVAILABLE' ||
          result.error.code === 'INTERNAL_ERROR'
        ) {
          retry = 'unavailable';
        } else {
          if (flight.mode === 'execute') entry.possibleEffect = previousEffect;
          return result;
        }
      } catch (error) {
        if (!flight.closed) this.#checkDeadline(entry, flight);
        if (!(error instanceof AgentTransportError)) throw error;
        retry = error.kind;
        retryAfter = error.retryAfterMs;
        if (retry === 'rate-limit' && flight.mode === 'execute')
          entry.possibleEffect = previousEffect;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (flight.closed) throw new AgentGatewayError('CANCELLED');
      if (retry === 'rate-limit') {
        const delay = retryAfter ?? 1000;
        if (!Number.isSafeInteger(delay) || delay <= 0 || delay > 86_400_000)
          throw new AgentGatewayError('INVALID_RESPONSE', this.#outcome(entry));
        this.#cooldowns.set(
          target,
          Math.max(this.#cooldowns.get(target) ?? 0, this.#now() + delay),
        );
        if (attempt === 2 || !retryAllowed)
          throw new AgentGatewayError('RATE_LIMITED');
      } else {
        if (
          attempt === 2 ||
          !retryAllowed ||
          (flight.mode === 'execute' &&
            capability.effect !== 'read' &&
            !capability.supports_idempotency)
        )
          throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
        const jitter = this.#options.jitter();
        if (!Number.isFinite(jitter) || jitter < 0 || jitter > 250)
          throw new AgentGatewayError('INVALID_CONFIGURATION');
        await this.#pause(entry, flight, 1000 * 2 ** attempt + jitter);
      }
    }
    throw new AgentGatewayError('INTERNAL_ERROR', 'uncertain');
  }
}
