// Standalone protocol fixture: no Jarvis imports, dependencies, keys or domain data.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:https';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const ids = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const contextKeys = [
  'protocol_version',
  'instance_id',
  'agent_id',
  'subject_ref',
  'request_id',
  'correlation_id',
];
const executionKeys = [
  ...contextKeys,
  'kind',
  'idempotency_key',
  'capability',
  'deadline_at',
  'cost_policy',
  'input',
];
const counts = {
  requests: 0,
  executions: 0,
  polls: 0,
  unauthorized: 0,
  duplicates: 0,
};
const reservations = new Map();
const operations = new Map();
let server;
let configuration;
let configured = false;
let remainingFailures = 0;

function exactObject(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validContext(value) {
  return (
    value.protocol_version === '1.0' &&
    contextKeys
      .slice(1)
      .every((key) => typeof value[key] === 'string' && ids.test(value[key])) &&
    value.instance_id === 'jarvis-demo' &&
    value.agent_id === 'demo.echo' &&
    value.subject_ref === 'owner-demo'
  );
}

function validExecution(value) {
  return (
    exactObject(value, executionKeys) &&
    validContext(value) &&
    value.kind === 'execute' &&
    typeof value.idempotency_key === 'string' &&
    ids.test(value.idempotency_key) &&
    exactObject(value.capability, ['name', 'version']) &&
    value.capability.name === 'echo.reply' &&
    value.capability.version === '1.0' &&
    value.cost_policy === 'no-paid-services' &&
    typeof value.deadline_at === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.deadline_at) &&
    Number.isFinite(Date.parse(value.deadline_at)) &&
    Date.parse(value.deadline_at) > Date.now() &&
    exactObject(value.input, ['text']) &&
    typeof value.input.text === 'string' &&
    value.input.text.length > 0 &&
    value.input.text.length <= 128
  );
}

function context(value) {
  return Object.fromEntries(contextKeys.map((key) => [key, value[key]]));
}

function completed(value) {
  return {
    ...context(value),
    kind: 'execution-result',
    status: 'completed',
    output: { text: value.input.text },
  };
}

function failed(value, code, retryable = false, extra = {}) {
  return {
    ...context(value),
    kind: 'execution-result',
    status: 'failed',
    error: { code, message: 'Fixture rejection.', retryable, ...extra },
  };
}

function send(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const data = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    connection: 'close',
    ...headers,
  });
  response.end(data);
}

function authenticated(request) {
  const raw = request.headers.authorization;
  const received = typeof raw === 'string' ? Buffer.from(raw) : Buffer.alloc(0);
  const expected = Buffer.from(`Bearer ${configuration.token}`);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error('Body limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fingerprint(value) {
  const command = {
    ...context(value),
    kind: value.kind,
    idempotency_key: value.idempotency_key,
    capability: {
      name: value.capability.name,
      version: value.capability.version,
    },
    cost_policy: value.cost_policy,
    input: { text: value.input.text },
  };
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

async function execution(request, response) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers['content-type'] ?? '',
    )
  ) {
    send(response, 415, {});
    return;
  }
  let value;
  try {
    value = await body(request);
  } catch {
    send(response, 400, {});
    return;
  }
  if (!validExecution(value)) {
    send(response, 422, {});
    return;
  }
  if (
    configuration.mode === 'raw-rate-limit' ||
    configuration.mode === 'raw-unavailable'
  ) {
    send(
      response,
      configuration.mode === 'raw-rate-limit' ? 429 : 503,
      'Fixture rejection.',
      {
        'content-type': 'text/plain',
        'retry-after': '1',
      },
    );
    return;
  }
  if (
    remainingFailures > 0 &&
    ['rate-limit', 'unavailable'].includes(configuration.mode)
  ) {
    remainingFailures -= 1;
    const rateLimit = configuration.mode === 'rate-limit';
    send(
      response,
      rateLimit ? 429 : 503,
      failed(value, rateLimit ? 'RATE_LIMITED' : 'UNAVAILABLE', true),
      rateLimit ? { 'retry-after': configuration.retryAfter ?? '1' } : {},
    );
    return;
  }
  const key = JSON.stringify([
    value.instance_id,
    value.subject_ref,
    value.agent_id,
    value.capability.name,
    value.capability.version,
    value.idempotency_key,
  ]);
  const hash = fingerprint(value);
  const previous = reservations.get(key);
  if (previous) {
    if (previous.hash !== hash) {
      send(response, 409, failed(value, 'IDEMPOTENCY_CONFLICT'));
      return;
    }
    counts.duplicates += 1;
    const result = await previous.result;
    send(response, result.status === 'pending' ? 202 : 200, result);
    return;
  }
  if (reservations.size >= 256) {
    send(response, 429, failed(value, 'RATE_LIMITED', false), {
      'retry-after': '1',
    });
    return;
  }
  counts.executions += 1;
  // Reserve synchronously before an asynchronous delay; the fixture is read-only.
  const work = Promise.resolve().then(async () => {
    if (configuration.mode === 'slow')
      await delay(configuration.delayMs ?? 200);
    if (configuration.mode === 'pending') {
      const operation_id = `operation-${counts.executions}`;
      operations.set(operation_id, value);
      return {
        ...context(value),
        kind: 'execution-result',
        status: 'pending',
        operation_id,
        poll_after_ms: configuration.pollAfterMs ?? 1,
      };
    }
    return completed(value);
  });
  reservations.set(key, { hash, result: work });
  const result = await work;
  switch (configuration.mode) {
    case 'malformed':
      send(response, 200, '{invalid-json');
      break;
    case 'version':
      send(response, 200, { ...result, protocol_version: '2.0' });
      break;
    case 'cross-subject':
      send(response, 200, { ...result, subject_ref: 'someone-else' });
      break;
    case 'cross-agent':
      send(response, 200, { ...result, agent_id: 'another-agent' });
      break;
    case 'redirect':
      send(
        response,
        302,
        {},
        { location: 'https://example.invalid/v1/execute' },
      );
      break;
    case 'oversize':
      send(response, 200, { ...result, output: { text: 'x'.repeat(70_000) } });
      break;
    case 'chunked-oversize':
      response.writeHead(200, {
        'content-type': 'application/json',
        connection: 'close',
      });
      response.write('{"text":"');
      response.end(`${'x'.repeat(70_000)}"}`);
      break;
    case 'invalid-schema':
      send(response, 200, { ...result, output: { text: 42 } });
      break;
    case 'invalid-content-type':
      send(response, 200, result, { 'content-type': 'text/plain' });
      break;
    case 'invalid-encoding':
      send(response, 200, result, { 'content-encoding': 'gzip' });
      break;
    case 'invalid-utf8':
      send(response, 200, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
      break;
    case 'duplicate-fields':
      send(
        response,
        200,
        JSON.stringify(result).replace(
          '"status":"completed"',
          '"status":"completed","status":"completed"',
        ),
      );
      break;
    case 'bad-status':
      send(response, 202, result);
      break;
    case 'failed':
      send(response, 422, failed(value, 'VALIDATION_FAILED'));
      break;
    default:
      send(response, result.status === 'pending' ? 202 : 200, result);
  }
}

function operation(url, response) {
  const operation_id = url.pathname.slice('/v1/operations/'.length);
  const query = Object.fromEntries(url.searchParams);
  if (
    !ids.test(operation_id) ||
    !exactObject(query, contextKeys) ||
    [...url.searchParams].length !== contextKeys.length ||
    !validContext(query)
  ) {
    send(response, 422, {});
    return;
  }
  const original = operations.get(operation_id);
  if (!original || contextKeys.some((key) => original[key] !== query[key])) {
    send(response, 404, {});
    return;
  }
  counts.polls += 1;
  send(response, 200, completed(original));
}

async function route(request, response) {
  counts.requests += 1;
  if (!authenticated(request)) {
    counts.unauthorized += 1;
    request.resume();
    send(response, 401, {});
    return;
  }
  const url = new URL(request.url ?? '/', 'https://echo.test');
  if (
    request.method === 'POST' &&
    url.pathname === '/v1/execute' &&
    !url.search
  ) {
    await execution(request, response);
  } else if (
    request.method === 'GET' &&
    url.pathname.startsWith('/v1/operations/')
  ) {
    operation(url, response);
  } else {
    request.resume();
    send(response, 404, {});
  }
}

function shutdown() {
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.on('message', (message) => {
  if (message?.type === 'stats') {
    process.send?.({ type: 'stats', id: message.id, counts: { ...counts } });
    return;
  }
  if (message?.type === 'shutdown') {
    shutdown();
    return;
  }
  if (message?.type !== 'configure' || configured) return;
  configured = true;
  configuration = message.options;
  remainingFailures = configuration.failures ?? 1;
  try {
    server = createServer(
      {
        key: configuration.key,
        cert: configuration.cert,
        minVersion: 'TLSv1.2',
      },
      (request, response) => {
        void route(request, response).catch(() => send(response, 500, {}));
      },
    );
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.on('tlsClientError', () => undefined);
    server.on('error', () => {
      process.send?.({ type: 'failure' });
      shutdown();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      process.send?.({
        type: 'ready',
        port: typeof address === 'object' ? address?.port : undefined,
      });
    });
  } catch {
    process.send?.({ type: 'failure' });
    shutdown();
  }
});
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Direct starts require an IPC launcher so no credential can be passed in argv.
if (!process.send) process.exitCode = 1;
