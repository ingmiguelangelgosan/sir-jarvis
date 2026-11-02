import assert from 'node:assert/strict';
import { test } from 'node:test';

import { respondToMessage } from '../src/app/assistant.ts';
import {
  TelegramApiError,
  type TelegramApi,
  type TelegramUpdate,
} from '../src/channels/telegram/api.ts';
import { createTelegramHandler } from '../src/channels/telegram/handler.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { wait } from '../src/channels/telegram/runtime.ts';

function update(id = 1, text = '/start', userId = 42): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      from: { id: userId, is_bot: false },
      chat: { id: userId, type: 'private' },
    },
  };
}

function fakeApi(overrides: Partial<TelegramApi> = {}): TelegramApi {
  return {
    getMe: async () => ({ id: 12345, username: 'JarvisBot' }),
    getUpdates: async () => [],
    sendMessage: async () => {},
    ...overrides,
  };
}

function immediateClock() {
  let time = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => time,
    wait: async (milliseconds: number) => {
      delays.push(milliseconds);
      time += milliseconds;
    },
  };
}

test('núcleo responde sin afirmar que IA o finanzas están implementadas', () => {
  assert.match(respondToMessage('start'), /Hola, soy Jarvis/);
  assert.match(respondToMessage('status'), /IA: deshabilitada/);
  assert.match(
    respondToMessage('status'),
    /Finanzas y persistencia: pendientes/,
  );
  assert.match(
    respondToMessage('unsupported'),
    /No he registrado ninguna operación/,
  );
});

test('integra /start, /status, texto y comando desconocido sin reflejar datos privados', async () => {
  const replies: string[] = [];
  const clock = immediateClock();
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async (chatId, text) => {
        assert.equal(chatId, 42);
        replies.push(text);
      },
    }),
    clock,
  );
  const signal = new AbortController().signal;
  await handle(update(1, '/start datos-privados'), signal);
  await handle(update(2, '/status@JarvisBot'), signal);
  await handle(update(3, 'pagué dinero-canario-no-real'), signal);
  await handle(update(4, '/desconocido'), signal);
  await handle(update(5, '/start@OtroBot'), signal);
  assert.equal(replies.length, 4);
  assert.match(replies[0]!, /Hola/);
  assert.match(replies[1]!, /Jarvis activo/);
  assert.equal(replies[2], replies[3]);
  assert.equal(replies.join('').includes('datos-privados'), false);
  assert.equal(replies.join('').includes('dinero-canario'), false);
  assert.deepEqual(clock.delays, [1000, 1000, 1000]);
});

test('rechaza usuario ajeno, grupos, bots, ID inconsistente y mensajes no textuales antes del núcleo', async () => {
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async () =>
        assert.fail('No debe responder a un origen no autorizado'),
    }),
    { respond: () => assert.fail('No debe ejecutar operaciones del núcleo') },
  );
  const signal = new AbortController().signal;
  const message = {
    message_id: 1,
    text: '/status',
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: 'private' },
  };
  for (const candidate of [
    update(1, '/status', 43),
    { update_id: 2, message: { ...message, chat: { id: -42, type: 'group' } } },
    {
      update_id: 3,
      message: { ...message, chat: { id: 43, type: 'private' } },
    },
    { update_id: 4, message: { ...message, from: { id: 42, is_bot: true } } },
    {
      update_id: 5,
      message: { ...message, text: undefined, photo: ['ficticia'] },
    },
    { update_id: 6 },
    { update_id: 7, message: { ...message, sender_chat: { id: 42 } } },
    {
      update_id: 8,
      message: { ...message, from: { id: '42', is_bot: false } },
    },
  ])
    await handle(candidate, signal);
});

test('deduplica el mismo mensaje incluso con update_id distinto', async () => {
  let sends = 0;
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async () => {
        sends += 1;
      },
    }),
  );
  const signal = new AbortController().signal;
  await handle(update(), signal);
  await handle(update(), signal);
  await handle({ ...update(), update_id: 2 }, signal);
  assert.equal(sends, 1);
});

test('429 espera retry_after y reintenta hasta entregar sin repetir la operación del núcleo', async () => {
  let sends = 0;
  let operations = 0;
  const clock = immediateClock();
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async () => {
        sends += 1;
        if (sends < 3) throw new TelegramApiError('rate-limit', sends * 2000);
      },
    }),
    {
      ...clock,
      respond: (request) => {
        operations += 1;
        return respondToMessage(request);
      },
    },
  );
  const signal = new AbortController().signal;
  await handle(update(), signal);
  await handle(update(), signal);
  assert.equal(sends, 3);
  assert.equal(operations, 1);
  assert.deepEqual(clock.delays, [2000, 4000]);
});

for (const kind of [
  'transient',
  'invalid-response',
  'rejected',
  'unauthorized',
] as const) {
  test(`envío ${kind} no se reintenta ni expone contenido del error`, async () => {
    let sends = 0;
    const events: string[] = [];
    const handle = createTelegramHandler(
      [42],
      'JarvisBot',
      fakeApi({
        sendMessage: async () => {
          sends += 1;
          throw new TelegramApiError(kind);
        },
      }),
      { log: (event) => events.push(event) },
    );
    const signal = new AbortController().signal;
    await handle(update(), signal);
    await handle(update(), signal);
    assert.equal(sends, 1);
    assert.deepEqual(events, [
      kind === 'rejected' || kind === 'unauthorized'
        ? 'telegram-send-rejected'
        : 'telegram-delivery-unconfirmed',
    ]);
  });
}

test('limita a tres intentos ante 429 persistente', async () => {
  let sends = 0;
  const events: string[] = [];
  const clock = immediateClock();
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async () => {
        sends += 1;
        throw new TelegramApiError('rate-limit', 1000);
      },
    }),
    { ...clock, log: (event) => events.push(event) },
  );
  await handle(update(), new AbortController().signal);
  assert.equal(sends, 3);
  assert.deepEqual(events, ['telegram-send-rejected']);
});

test('conserva retry_after del último 429 para el siguiente mensaje', async () => {
  let time = 0;
  const attempts: number[] = [];
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    fakeApi({
      sendMessage: async () => {
        attempts.push(time);
        if (attempts.length <= 3)
          throw new TelegramApiError('rate-limit', 60_000);
      },
    }),
    {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    },
  );
  const signal = new AbortController().signal;
  await handle(update(1), signal);
  await handle(update(2), signal);
  assert.deepEqual(attempts, [0, 60_000, 120_000, 180_000]);
});

test('polling ordena eventos, avanza offset y descarta duplicados, no autorizados y medios', async () => {
  const controller = new AbortController();
  const offsets: (number | undefined)[] = [];
  let sends = 0;
  const api = fakeApi({
    getUpdates: async (offset) => {
      offsets.push(offset);
      if (offsets.length === 1)
        return [
          update(11, '/status'),
          update(10),
          update(10),
          update(12, '/status', 99),
        ];
      if (offsets.length === 2)
        return [
          update(10),
          { ...update(11), update_id: 13 },
          { update_id: 14 },
        ];
      controller.abort();
      return [];
    },
    sendMessage: async () => {
      sends += 1;
    },
  });
  await runTelegramPolling(api, [42], controller.signal, immediateClock());
  assert.equal(sends, 2);
  assert.deepEqual(offsets, [undefined, 13, 15]);
});

test('polling respeta 429, aplica backoff transitorio y se cancela', async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let identities = 0;
  let polls = 0;
  const api = fakeApi({
    getMe: async () => {
      identities += 1;
      if (identities === 1) throw new TelegramApiError('rate-limit', 2000);
      return { id: 12345, username: 'JarvisBot' };
    },
    getUpdates: async () => {
      polls += 1;
      if (polls < 3) throw new TelegramApiError('transient');
      return [];
    },
  });
  await runTelegramPolling(api, [42], controller.signal, {
    wait: async (milliseconds) => {
      delays.push(milliseconds);
      if (milliseconds === 100) controller.abort();
    },
  });
  assert.deepEqual(delays, [2000, 1000, 2000, 100]);
});

for (const kind of [
  'unauthorized',
  'conflict',
  'rejected',
  'invalid-response',
] as const) {
  test(`polling ${kind} se detiene sin bucle de reintentos`, async () => {
    const api = fakeApi({
      getUpdates: async () => {
        throw new TelegramApiError(kind);
      },
    });
    await assert.rejects(
      runTelegramPolling(api, [42], new AbortController().signal, {
        wait: async () => assert.fail('No debe reintentar un fallo permanente'),
      }),
      (error: unknown) =>
        error instanceof TelegramApiError && error.kind === kind,
    );
  });
}

test('cancelación durante una petición y una espera no deja reintentos pendientes', async () => {
  const controller = new AbortController();
  const api = fakeApi({
    getUpdates: async (_offset, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('canario-no-real')),
          { once: true },
        );
        queueMicrotask(() => controller.abort());
      }),
  });
  await runTelegramPolling(api, [42], controller.signal);
  await assert.rejects(wait(30_000, controller.signal), { name: 'AbortError' });
});

test('una señal ya cancelada impide llamadas de API y operaciones', async () => {
  const controller = new AbortController();
  controller.abort();
  const api = fakeApi({
    getMe: async () => assert.fail('No debe llamar Telegram'),
    sendMessage: async () => assert.fail('No debe enviar'),
  });
  await runTelegramPolling(api, [42], controller.signal);
  await createTelegramHandler(
    [42],
    'JarvisBot',
    api,
  )(update(), controller.signal);
});
