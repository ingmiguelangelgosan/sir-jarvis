import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';

import {
  TelegramApiError,
  type TelegramErrorKind,
} from '../src/channels/telegram/api.ts';
import { createTelegramApi } from '../src/channels/telegram/http-api.ts';

const token = '123456789:token-canario-ficticio-sin-valor-real';
const signal = new AbortController().signal;

interface RecordedRequest {
  readonly url: string;
  readonly options: RequestInit | undefined;
}

function stubFetch(response: Response | Error): {
  readonly request: typeof fetch;
  readonly calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const request: typeof fetch = async (input, options) => {
    calls.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      options,
    });
    if (response instanceof Error) throw response;
    return response;
  };
  return { request, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function safeError(kind: TelegramErrorKind, retryAfterMs?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.kind, kind);
    assert.equal(error.retryAfterMs, retryAfterMs);
    const serialized = inspect(error, { depth: 10 });
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('api.telegram.org'), false);
    assert.equal(serialized.includes('contenido-privado-canario'), false);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('getMe usa POST al endpoint fijo y retorna solo la identidad necesaria', async () => {
  const stub = stubFetch(
    jsonResponse({
      ok: true,
      result: {
        id: 123456789,
        is_bot: true,
        username: 'JarvisPruebasBot',
        first_name: 'contenido-privado-canario',
      },
    }),
  );
  const api = createTelegramApi(token, stub.request);
  assert.deepEqual(await api.getMe(signal), {
    id: 123456789,
    username: 'JarvisPruebasBot',
  });
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.ok(call);
  assert.equal(call.url, `https://api.telegram.org/bot${token}/getMe`);
  assert.equal(call.options?.method, 'POST');
  assert.equal(call.options?.redirect, 'error');
  assert.equal(
    new Headers(call.options?.headers).get('content-type'),
    'application/json',
  );
  assert.ok(call.options?.signal instanceof AbortSignal);
  assert.equal(call.options.signal.aborted, false);
});

test('getUpdates pide solo mensajes y long polling sin offset inicial', async () => {
  const updates = [{ update_id: 10, message: { text: '/start' } }];
  const stub = stubFetch(jsonResponse({ ok: true, result: updates }));
  const api = createTelegramApi(token, stub.request);
  assert.deepEqual(await api.getUpdates(undefined, signal), updates);
  const call = stub.calls[0];
  assert.ok(call);
  assert.equal(call.url, `https://api.telegram.org/bot${token}/getUpdates`);
  assert.deepEqual(JSON.parse(String(call.options?.body)), {
    timeout: 25,
    limit: 100,
    allowed_updates: ['message'],
  });
});

test('getUpdates envía el offset exacto y admite updates sin texto', async () => {
  const updates = [
    { update_id: 11 },
    { update_id: 12, message: { photo: [{ file_id: 'ficticio' }] } },
  ];
  const stub = stubFetch(jsonResponse({ ok: true, result: updates }));
  const api = createTelegramApi(token, stub.request);
  assert.deepEqual(await api.getUpdates(11, signal), updates);
  assert.equal(JSON.parse(String(stub.calls[0]?.options?.body)).offset, 11);
});

test('sendMessage deshabilita envíos pagos y previews sin interpretar markup', async () => {
  const stub = stubFetch(jsonResponse({ ok: true, result: { message_id: 9 } }));
  const api = createTelegramApi(token, stub.request);
  assert.equal(
    await api.sendMessage(42, 'Mensaje simple <sin formato>', signal),
    undefined,
  );
  const call = stub.calls[0];
  assert.ok(call);
  assert.equal(call.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(call.options?.method, 'POST');
  assert.equal(call.options?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(call.options?.body)), {
    chat_id: 42,
    text: 'Mensaje simple <sin formato>',
    allow_paid_broadcast: false,
    link_preview_options: { is_disabled: true },
  });
});

for (const [status, kind] of [
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [409, 'conflict'],
  [400, 'rejected'],
  [404, 'rejected'],
  [500, 'transient'],
  [502, 'transient'],
  [503, 'transient'],
] as const) {
  test(`HTTP ${status} se clasifica como ${kind} sin datos privados ni reintentos`, async () => {
    const stub = stubFetch(
      jsonResponse(
        {
          ok: false,
          error_code: status,
          description: `contenido-privado-canario ${token}`,
        },
        status,
      ),
    );
    const api = createTelegramApi(token, stub.request);
    await assert.rejects(api.getUpdates(undefined, signal), safeError(kind));
    assert.equal(stub.calls.length, 1);
  });
}

test('429 respeta retry_after en milisegundos sin reintentar dentro del cliente HTTP', async () => {
  const stub = stubFetch(
    jsonResponse(
      {
        ok: false,
        error_code: 429,
        parameters: { retry_after: 7 },
        description: `contenido-privado-canario ${token}`,
      },
      429,
    ),
  );
  const api = createTelegramApi(token, stub.request);
  await assert.rejects(
    api.sendMessage(42, 'Hola', signal),
    safeError('rate-limit', 7_000),
  );
  assert.equal(stub.calls.length, 1);
});

test('429 sin retry_after usa una espera segura predeterminada', async () => {
  const stub = stubFetch(jsonResponse({ ok: false, error_code: 429 }, 429));
  await assert.rejects(
    createTelegramApi(token, stub.request).getUpdates(undefined, signal),
    safeError('rate-limit', 1_000),
  );
});

for (const retryAfter of [0, -1, 1.5, 86_401, '7', null]) {
  test(`429 con retry_after inválido ${JSON.stringify(retryAfter)} falla sin acortar la espera`, async () => {
    const stub = stubFetch(
      jsonResponse(
        {
          ok: false,
          error_code: 429,
          parameters: { retry_after: retryAfter },
        },
        429,
      ),
    );
    await assert.rejects(
      createTelegramApi(token, stub.request).getUpdates(undefined, signal),
      safeError('invalid-response'),
    );
    assert.equal(stub.calls.length, 1);
  });
}

test('errores indicados en un envelope HTTP 200 también se clasifican', async () => {
  const stub = stubFetch(
    jsonResponse({
      ok: false,
      error_code: 429,
      parameters: { retry_after: 3 },
    }),
  );
  await assert.rejects(
    createTelegramApi(token, stub.request).getMe(signal),
    safeError('rate-limit', 3_000),
  );
});

test('un rechazo de fetch no conserva el error original que contiene el token', async () => {
  const stub = stubFetch(
    new TypeError(
      `fetch https://api.telegram.org/bot${token}/getUpdates contenido-privado-canario`,
    ),
  );
  await assert.rejects(
    createTelegramApi(token, stub.request).getUpdates(undefined, signal),
    safeError('transient'),
  );
  assert.equal(stub.calls.length, 1);
});

test('una señal abortada produce un error controlado sin conservar su motivo', async () => {
  const controller = new AbortController();
  const privateError = new Error(`contenido-privado-canario ${token}`);
  controller.abort(privateError);
  const stub = stubFetch(privateError);
  await assert.rejects(
    createTelegramApi(token, stub.request).getMe(controller.signal),
    safeError('aborted'),
  );
});

test('el aborto del proceso cancela una solicitud HTTP en curso', async () => {
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | null | undefined;
  const request: typeof fetch = async (_input, options) => {
    forwardedSignal = options?.signal;
    return new Promise<Response>((_resolve, reject) => {
      forwardedSignal?.addEventListener(
        'abort',
        () => reject(forwardedSignal?.reason),
        { once: true },
      );
    });
  };
  const pending = createTelegramApi(token, request).getMe(controller.signal);
  assert.ok(forwardedSignal instanceof AbortSignal);
  controller.abort(new Error(`contenido-privado-canario ${token}`));
  await assert.rejects(pending, safeError('aborted'));
  assert.equal(forwardedSignal.aborted, true);
});

for (const [status, kind, retryAfterMs] of [
  [500, 'transient', undefined],
  [429, 'rate-limit', 1_000],
] as const) {
  test(`HTTP ${status} con cuerpo ilegible conserva su clasificación segura`, async () => {
    const stub = stubFetch(
      new Response(`contenido-privado-canario ${token}`, { status }),
    );
    await assert.rejects(
      createTelegramApi(token, stub.request).getUpdates(undefined, signal),
      safeError(kind, retryAfterMs),
    );
  });
}

for (const result of [
  null,
  { id: 123, is_bot: false, username: 'JarvisPruebasBot' },
  { id: -1, is_bot: true, username: 'JarvisPruebasBot' },
  {
    id: Number.MAX_SAFE_INTEGER + 1,
    is_bot: true,
    username: 'JarvisPruebasBot',
  },
  { id: 123, is_bot: true },
  { id: 123, is_bot: true, username: '' },
]) {
  test(`getMe rechaza identidad inválida ${JSON.stringify(result)}`, async () => {
    const stub = stubFetch(jsonResponse({ ok: true, result }));
    await assert.rejects(
      createTelegramApi(token, stub.request).getMe(signal),
      safeError('invalid-response'),
    );
  });
}

for (const result of [
  null,
  {},
  [{ update_id: -1 }],
  [{ update_id: 1.5 }],
  [{ update_id: Number.MAX_SAFE_INTEGER + 1 }],
  [{ message: { text: '/start' } }],
]) {
  test(`getUpdates rechaza resultado inválido ${JSON.stringify(result)}`, async () => {
    const stub = stubFetch(jsonResponse({ ok: true, result }));
    await assert.rejects(
      createTelegramApi(token, stub.request).getUpdates(undefined, signal),
      safeError('invalid-response'),
    );
  });
}

test('sendMessage rechaza una respuesta sin message_id válido', async () => {
  const stub = stubFetch(
    jsonResponse({ ok: true, result: { message_id: -1 } }),
  );
  await assert.rejects(
    createTelegramApi(token, stub.request).sendMessage(42, 'Hola', signal),
    safeError('invalid-response'),
  );
});

test('una respuesta 200 sin envelope válido no se considera exitosa', async () => {
  const stub = stubFetch(
    jsonResponse({ result: { id: 123, is_bot: true, username: 'Jarvis' } }),
  );
  await assert.rejects(
    createTelegramApi(token, stub.request).getMe(signal),
    safeError('invalid-response'),
  );
});

test('JSON ilegible se sanea sin conservar su contenido ni errores de parseo', async () => {
  const stub = stubFetch(
    new Response(`contenido-privado-canario ${token}`, { status: 200 }),
  );
  await assert.rejects(
    createTelegramApi(token, stub.request).getMe(signal),
    safeError('invalid-response'),
  );
});

for (const [readError, kind] of [
  [new TypeError(`contenido-privado-canario ${token}`), 'transient'],
  [new SyntaxError(`contenido-privado-canario ${token}`), 'invalid-response'],
] as const) {
  test(`lectura de cuerpo HTTP 200 con ${readError.name} se clasifica como ${kind} sin revelar el error`, async () => {
    const response = jsonResponse({ ok: true, result: [] });
    Object.defineProperty(response, 'json', {
      value: async () => {
        throw readError;
      },
    });
    const stub = stubFetch(response);
    await assert.rejects(
      createTelegramApi(token, stub.request).getUpdates(undefined, signal),
      safeError(kind),
    );
    assert.equal(stub.calls.length, 1);
  });
}
