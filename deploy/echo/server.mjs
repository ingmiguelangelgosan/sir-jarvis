// Independent, read-only HTTPS protocol demo. No Jarvis imports or dependencies.
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import process from 'node:process';
import { TextDecoder } from 'node:util';

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
const ids = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const reservations = new Map();
let server;

function reply(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  response.end(body);
}

function validate(value) {
  return (
    exact(value, executionKeys) &&
    value.protocol_version === '1.0' &&
    contextKeys
      .slice(1)
      .every((key) => typeof value[key] === 'string' && ids.test(value[key])) &&
    value.instance_id === 'jarvis-demo' &&
    value.agent_id === 'demo.echo' &&
    value.subject_ref === 'owner-demo' &&
    value.kind === 'execute' &&
    typeof value.idempotency_key === 'string' &&
    ids.test(value.idempotency_key) &&
    exact(value.capability, ['name', 'version']) &&
    value.capability.name === 'echo.reply' &&
    value.capability.version === '1.0' &&
    value.cost_policy === 'no-paid-services' &&
    typeof value.deadline_at === 'string' &&
    Number.isFinite(Date.parse(value.deadline_at)) &&
    Date.parse(value.deadline_at) > Date.now() &&
    exact(value.input, ['text']) &&
    typeof value.input.text === 'string' &&
    value.input.text.trim().length > 0 &&
    value.input.text.length <= 128 &&
    [...value.input.text].every((character) => {
      const point = character.codePointAt(0);
      return (
        point >= 32 &&
        !(point >= 127 && point <= 159) &&
        !(point >= 0x202a && point <= 0x202e) &&
        !(point >= 0x2066 && point <= 0x2069) &&
        !(point >= 0xd800 && point <= 0xdfff)
      );
    })
  );
}

function shutdown() {
  if (!server) return;
  server.close();
  server.closeAllConnections();
}

try {
  const expected = Buffer.from(
    `Bearer ${readFileSync('/run/secrets/echo_bearer', 'utf8').trim()}`,
  );
  if (expected.length < 39 || expected.length > 4096) throw new Error();
  server = createServer(
    {
      key: readFileSync('/run/secrets/echo_key'),
      cert: readFileSync('/run/secrets/echo_certificate'),
      minVersion: 'TLSv1.2',
      maxHeaderSize: 16_384,
    },
    (request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/healthz') {
          request.resume();
          reply(response, 200, { status: 'ok' });
          return;
        }
        const received = Buffer.from(request.headers.authorization ?? '');
        if (
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        ) {
          request.resume();
          reply(response, 401, {});
          return;
        }
        if (
          request.method !== 'POST' ||
          request.url !== '/v1/execute' ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
            request.headers['content-type'] ?? '',
          )
        ) {
          request.resume();
          reply(response, 404, {});
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65_536) throw new Error();
          chunks.push(chunk);
        }
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        if (!validate(value)) {
          reply(response, 422, {});
          return;
        }
        const context = Object.fromEntries(
          contextKeys.map((key) => [key, value[key]]),
        );
        const key = JSON.stringify([
          value.instance_id,
          value.agent_id,
          value.subject_ref,
          value.idempotency_key,
        ]);
        const hash = createHash('sha256')
          .update(
            JSON.stringify({
              ...context,
              capability: value.capability,
              input: value.input,
              cost_policy: value.cost_policy,
            }),
          )
          .digest('hex');
        const prior = reservations.get(key);
        if (prior && prior.hash !== hash) {
          reply(response, 409, {
            ...context,
            kind: 'execution-result',
            status: 'failed',
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'Request conflict.',
              retryable: false,
            },
          });
          return;
        }
        if (!prior && reservations.size >= 256) {
          reply(response, 429, {
            ...context,
            kind: 'execution-result',
            status: 'failed',
            error: {
              code: 'RATE_LIMITED',
              message: 'Demo capacity reached.',
              retryable: false,
            },
          });
          return;
        }
        const result = prior?.result ?? {
          ...context,
          kind: 'execution-result',
          status: 'completed',
          output: { text: value.input.text },
        };
        if (!prior) reservations.set(key, { hash, result });
        reply(response, 200, result);
      })().catch(() => {
        if (!response.headersSent) reply(response, 400, {});
        else response.destroy();
      });
    },
  );
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('tlsClientError', () => undefined);
  server.on('error', () => {
    process.exitCode = 1;
    shutdown();
  });
  server.listen(8443, '0.0.0.0');
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch {
  process.stderr.write('Echo demo could not start.\n');
  process.exitCode = 1;
}
