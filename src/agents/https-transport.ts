import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { debuglog } from 'node:util';

import {
  type AgentCredentialResolver,
  validBearerToken,
} from './credentials.ts';
import { AgentGatewayError } from './errors.ts';
import {
  type AgentNetworkPolicy,
  parseHttpsOrigin,
  sameIpAddress,
} from './network-policy.ts';
import type {
  AgentCapability,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentOperationQuery,
  AgentRegistry,
} from './protocol.ts';
import { authorizeExecution } from './registry.ts';
import type { AgentTransport } from './transport.ts';
import {
  type CapabilitySchemaCatalog,
  parseExecutionRequest,
  parseExecutionResult,
  parseOperationQuery,
} from './validation.ts';

interface PendingContext {
  readonly query: AgentOperationQuery;
  readonly capability: AgentExecutionRequest['capability'];
  readonly expiresAt: number;
}

export interface HttpsAgentTransportOptions {
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  readonly maxInflight?: number;
  /** Private trust roots, if required. Verification and hostname checks stay on. */
  readonly ca?: string;
}

function operationKey(query: AgentOperationQuery): string {
  return JSON.stringify([
    query.instance_id,
    query.agent_id,
    query.subject_ref,
    query.operation_id,
  ]);
}

function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new AgentGatewayError('CANCELLED'));
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new AgentGatewayError('CANCELLED');
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

function wireJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse accepts duplicate keys. Reject ambiguity before trusting any field.
  const objects: (Set<string> | undefined)[] = [];
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text[offset];
    if (char === '{') objects.push(new Set());
    else if (char === '[') objects.push(undefined);
    else if (char === '}' || char === ']') objects.pop();
    else if (char === '"') {
      const start = offset;
      for (offset += 1; offset < text.length; offset += 1) {
        if (text[offset] === '\\') offset += 1;
        else if (text[offset] === '"') break;
      }
      let after = offset + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after += 1;
      if (text[after] === ':') {
        const key: string = JSON.parse(text.slice(start, offset + 1));
        const keys = objects.at(-1);
        if (!keys || keys.has(key)) throw new Error();
        keys.add(key);
      }
    }
  }
  return value;
}

function statusMatches(status: number, result: AgentExecutionResult): boolean {
  if (result.status === 'completed') return status === 200;
  if (result.status === 'pending') return status === 202;
  const statuses = {
    UNSUPPORTED_PROTOCOL: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    UNKNOWN_CAPABILITY: 404,
    VALIDATION_FAILED: 422,
    IDEMPOTENCY_CONFLICT: 409,
    RATE_LIMITED: 429,
    TIMEOUT: 504,
    UNAVAILABLE: 503,
    INTERNAL_ERROR: 500,
  };
  return status === statuses[result.error.code];
}

function retryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
          value,
        )
      ? Date.parse(value) - Date.now()
      : NaN;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 86_400_000
  )
    throw new AgentGatewayError('INVALID_RESPONSE', 'uncertain');
  return milliseconds;
}

/** Real HTTPS adapter. Retry/deduplication remain exclusively in the Gateway. */
export class HttpsAgentTransport implements AgentTransport {
  readonly #registry: AgentRegistry;
  readonly #schemas: CapabilitySchemaCatalog;
  readonly #network: AgentNetworkPolicy;
  readonly #credentials: AgentCredentialResolver;
  readonly #timeoutMs: number;
  readonly #maxPending: number;
  readonly #maxInflight: number;
  readonly #ca: string | undefined;
  readonly #pending = new Map<string, PendingContext>();
  readonly #active = new Set<AbortController>();
  #resolving = 0;
  #closed = false;

  constructor(
    registry: AgentRegistry,
    schemas: CapabilitySchemaCatalog,
    network: AgentNetworkPolicy,
    credentials: AgentCredentialResolver,
    options: HttpsAgentTransportOptions = {},
  ) {
    this.#registry = registry;
    this.#schemas = schemas;
    this.#network = network;
    this.#credentials = credentials;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxPending = options.maxPending ?? 256;
    this.#maxInflight = options.maxInflight ?? 32;
    this.#ca = options.ca;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 10_000 ||
      !Number.isSafeInteger(this.#maxPending) ||
      this.#maxPending < 1 ||
      this.#maxPending > 4096 ||
      !Number.isSafeInteger(this.#maxInflight) ||
      this.#maxInflight < 1 ||
      this.#maxInflight > 256 ||
      (this.#ca !== undefined &&
        (typeof this.#ca !== 'string' || this.#ca.length > 65_536)) ||
      (process.env.NODE_DEBUG ?? '').trim().length > 0 ||
      ['http', 'https', 'tls'].some((category) => debuglog(category).enabled)
    )
      throw new AgentGatewayError('INVALID_CONFIGURATION');
  }

  async execute(
    value: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const request = parseExecutionRequest(value);
    const capability = authorizeExecution(this.#registry, request);
    this.#schemas.validate(capability.input_schema_id, request.input);
    // Reserve space before a remote operation could become pending.
    if (this.#pending.size + this.#active.size >= this.#maxPending)
      throw new AgentGatewayError('CAPACITY_EXCEEDED');
    return this.#exchange(
      request,
      capability,
      '/v1/execute',
      JSON.stringify(request),
      Date.parse(request.deadline_at),
      signal,
    );
  }

  async getOperation(
    value: AgentOperationQuery,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const query = parseOperationQuery(value);
    const pending = this.#pending.get(operationKey(query));
    if (!pending) throw new AgentGatewayError('UNKNOWN_OPERATION');
    if (
      pending.query.request_id !== query.request_id ||
      pending.query.correlation_id !== query.correlation_id
    )
      throw new AgentGatewayError('UNKNOWN_OPERATION');
    if (pending.expiresAt <= Date.now())
      throw new AgentGatewayError('TIMEOUT', 'uncertain');
    const capability = authorizeExecution(this.#registry, {
      ...query,
      capability: pending.capability,
    });
    const parameters = new URLSearchParams();
    for (const field of [
      'protocol_version',
      'instance_id',
      'agent_id',
      'subject_ref',
      'request_id',
      'correlation_id',
    ] as const)
      parameters.set(field, query[field]);
    return this.#exchange(
      query,
      capability,
      `/v1/operations/${query.operation_id}?${parameters.toString()}`,
      undefined,
      Math.min(pending.expiresAt, Date.now() + this.#timeoutMs),
      signal,
      pending,
    );
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    this.#pending.clear();
  }

  #resolve<T>(run: () => Promise<T>): Promise<T> {
    // OS DNS and an injected resolver may not support abort. Keep their slots
    // until the underlying work settles, even after the caller has timed out.
    if (this.#resolving >= this.#maxInflight)
      return Promise.reject(new AgentGatewayError('CAPACITY_EXCEEDED'));
    this.#resolving += 1;
    return Promise.resolve()
      .then(run)
      .finally(() => {
        this.#resolving -= 1;
      });
  }

  async #exchange(
    context: AgentExecutionRequest | AgentOperationQuery,
    capability: AgentCapability,
    path: string,
    body: string | undefined,
    deadline: number,
    signal: AbortSignal,
    prior?: PendingContext,
  ): Promise<AgentExecutionResult> {
    if (this.#closed || signal.aborted)
      throw new AgentGatewayError('CANCELLED');
    if (this.#active.size >= this.#maxInflight)
      throw new AgentGatewayError('CAPACITY_EXCEEDED');
    const until = Math.min(deadline, Date.now() + this.#timeoutMs);
    if (until <= Date.now()) throw new AgentGatewayError('TIMEOUT');
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    let dispatched = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, until - Date.now()),
    );
    this.#active.add(controller);
    const check = () => {
      if (until <= Date.now() || timedOut)
        throw new AgentGatewayError('TIMEOUT');
      if (controller.signal.aborted) throw new AgentGatewayError('CANCELLED');
    };
    try {
      check();
      const registration = this.#registry.get(
        context.instance_id,
        context.agent_id,
      )!;
      const url = parseHttpsOrigin(registration.connection.base_url);
      const endpoint = await abortable(
        () =>
          this.#resolve(() =>
            this.#network.resolve(url.origin, controller.signal),
          ),
        controller.signal,
      );
      check();
      if (
        endpoint.origin !== url.origin ||
        endpoint.hostname !== url.hostname.replace(/^\[|\]$/g, '') ||
        endpoint.port !== Number(url.port || 443) ||
        isIP(endpoint.address) !== endpoint.family
      )
        throw new AgentGatewayError('INVALID_CONFIGURATION');
      const token = await abortable(
        () =>
          this.#resolve(() =>
            this.#credentials.resolve(
              registration.connection.request_credential_ref,
              controller.signal,
            ),
          ),
        controller.signal,
      );
      check();
      if (!validBearerToken(token))
        throw new AgentGatewayError('INVALID_CONFIGURATION');
      authorizeExecution(this.#registry, { ...context, capability });
      const response = await new Promise<{
        body: string;
        status: number;
        retry: string | undefined;
      }>((resolve, reject) => {
        let finished = false;
        const fail = (
          code: 'INVALID_RESPONSE' | 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED',
        ) => {
          if (finished) return;
          finished = true;
          reject(new AgentGatewayError(code));
          req.destroy();
        };
        const req = httpsRequest(
          {
            hostname: endpoint.hostname,
            port: endpoint.port,
            path,
            method: body === undefined ? 'GET' : 'POST',
            agent: false,
            family: endpoint.family,
            lookup: (_hostname, options, callback) => {
              if (options.all)
                callback(null, [
                  { address: endpoint.address, family: endpoint.family },
                ]);
              else callback(null, endpoint.address, endpoint.family);
            },
            servername: isIP(endpoint.hostname) ? '' : endpoint.hostname,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
            checkServerIdentity: (_host, certificate) =>
              checkServerIdentity(endpoint.hostname, certificate),
            ...(this.#ca === undefined ? {} : { ca: this.#ca }),
            maxHeaderSize: 16_384,
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
              Authorization: `Bearer ${token}`,
              Connection: 'close',
              ...(body === undefined
                ? {}
                : {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                  }),
            },
          },
          (res) => {
            res.on('error', () => fail('INVALID_RESPONSE'));
            const one = (name: string) => {
              const values = res.headersDistinct[name];
              if (values && values.length !== 1) throw new Error();
              return values?.[0];
            };
            let declared: number | undefined;
            let headerRetry: string | undefined;
            try {
              const type = one('content-type');
              const encoding = one('content-encoding');
              const length = one('content-length');
              if (
                !type ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type) ||
                (encoding !== undefined && encoding !== 'identity') ||
                ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) ||
                (length !== undefined &&
                  (!/^\d+$/.test(length) || Number(length) > 65_536))
              )
                throw new Error();
              declared = length === undefined ? undefined : Number(length);
              headerRetry = one('retry-after');
            } catch {
              res.destroy();
              fail('INVALID_RESPONSE');
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65_536) {
                res.destroy();
                fail('INVALID_RESPONSE');
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              if (finished) return;
              try {
                check();
                if (
                  !res.complete ||
                  (declared !== undefined && declared !== size)
                )
                  throw new Error();
                const text = new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks),
                );
                finished = true;
                resolve({
                  body: text,
                  status: res.statusCode ?? 0,
                  retry: headerRetry,
                });
              } catch {
                fail('INVALID_RESPONSE');
              }
            });
            res.on('close', () => {
              if (!res.complete) fail('INVALID_RESPONSE');
            });
          },
        );
        req.on('error', () =>
          fail(controller.signal.aborted ? 'CANCELLED' : 'UNAVAILABLE'),
        );
        req.on('socket', (socket) => {
          if (!(socket instanceof TLSSocket)) {
            fail('UNAVAILABLE');
            return;
          }
          socket.once('secureConnect', () => {
            try {
              check();
              const peer = socket.remoteAddress ?? '';
              const expected =
                endpoint.family === 4 && isIP(peer) === 6
                  ? `::ffff:${endpoint.address}`
                  : endpoint.address;
              if (
                !socket.authorized ||
                !sameIpAddress(peer, expected) ||
                socket.remotePort !== endpoint.port
              )
                throw new Error();
              dispatched = true;
              req.end(body);
            } catch {
              fail('UNAVAILABLE');
            }
          });
        });
      });
      check();
      let result = parseExecutionResult(
        wireJson(response.body),
        context,
        capability,
        this.#schemas,
      );
      if (!statusMatches(response.status, result))
        throw new AgentGatewayError('INVALID_RESPONSE');
      if (result.status === 'failed' && result.error.code === 'RATE_LIMITED') {
        const delay = retryAfter(response.retry);
        if (delay !== undefined)
          result = parseExecutionResult(
            {
              ...result,
              error: {
                ...result.error,
                retry_after_ms: Math.max(
                  delay,
                  result.error.retry_after_ms ?? 0,
                ),
              },
            },
            context,
            capability,
            this.#schemas,
          );
      }
      check();
      authorizeExecution(this.#registry, { ...context, capability });
      if (result.status === 'pending') {
        if (
          'operation_id' in context &&
          context.operation_id !== result.operation_id
        )
          throw new AgentGatewayError('INVALID_RESPONSE');
        const query: AgentOperationQuery = {
          protocol_version: '1.0',
          instance_id: result.instance_id,
          agent_id: result.agent_id,
          subject_ref: result.subject_ref,
          request_id: result.request_id,
          correlation_id: result.correlation_id,
          operation_id: result.operation_id,
        };
        const key = operationKey(query);
        const existing = this.#pending.get(key);
        if (
          existing &&
          (existing.query.request_id !== query.request_id ||
            existing.query.correlation_id !== query.correlation_id)
        )
          throw new AgentGatewayError('INVALID_RESPONSE');
        if (!this.#pending.has(key) && this.#pending.size >= this.#maxPending)
          throw new AgentGatewayError('CAPACITY_EXCEEDED');
        this.#pending.set(key, {
          query,
          capability: { name: capability.name, version: capability.version },
          expiresAt:
            prior?.expiresAt ??
            this.#pending.get(key)?.expiresAt ??
            Date.now() + 86_400_000,
        });
      } else if (prior) this.#pending.delete(operationKey(prior.query));
      return result;
    } catch (error) {
      throw new AgentGatewayError(
        timedOut || until <= Date.now()
          ? 'TIMEOUT'
          : controller.signal.aborted
            ? 'CANCELLED'
            : error instanceof AgentGatewayError
              ? error.code
              : 'INVALID_RESPONSE',
        dispatched ? 'uncertain' : 'not-started',
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', relay);
      this.#active.delete(controller);
      controller.abort();
    }
  }
}
