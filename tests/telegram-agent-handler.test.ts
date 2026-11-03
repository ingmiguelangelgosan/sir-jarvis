import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TelegramApiError,
  type TelegramUpdate,
} from '../src/channels/telegram/api.ts';
import { createTelegramHandler } from '../src/channels/telegram/handler.ts';

function message(id: number, text = '/agents'): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: 'private' },
    },
  };
}
const signal = () => new AbortController().signal;
function clock() {
  let value = 0;
  return {
    now: () => value,
    wait: async (ms: number) => {
      value += ms;
    },
  };
}

test('acciones de agentes no se expulsan por tráfico legacy ni por saturación', async () => {
  let commands = 0;
  const logs: string[] = [];
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    { sendMessage: async () => undefined },
    {
      ...clock(),
      agentCommands: async () => {
        commands += 1;
        return 'Lista segura';
      },
      log: (event) => logs.push(event),
    },
  );
  for (let i = 1; i <= 1024; i += 1) await handle(message(i), signal());
  for (let i = 2000; i <= 3024; i += 1)
    await handle(message(i, '/status'), signal());
  await handle(message(1), signal());
  await handle(message(4000, '/agent demo.echo echo.reply Hola'), signal());
  assert.equal(commands, 1024);
  assert.deepEqual(logs, ['telegram-agent-capacity']);
});

test('reserva sigue vigente mientras el callback espera y el tráfico legacy rota', async () => {
  let calls = 0;
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    { sendMessage: async () => undefined },
    {
      ...clock(),
      agentCommands: async () => {
        calls += 1;
        await deferred;
        return 'Respuesta segura';
      },
    },
  );
  const first = handle(
    message(1, '/agent demo.echo echo.reply Hola'),
    signal(),
  );
  for (let i = 2; i <= 1028; i += 1)
    await handle(message(i, '/status'), signal());
  await handle(message(1, '/agent demo.echo echo.reply Otro'), signal());
  assert.equal(calls, 1);
  release();
  await first;
});

test('entregas concurrentes se serializan y comparten cooldown429 sin repetir consultas', async () => {
  const time = clock();
  const attempts: number[] = [];
  let commands = 0;
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    {
      sendMessage: async () => {
        attempts.push(time.now());
        if (attempts.length === 1)
          throw new TelegramApiError('rate-limit', 2000);
      },
    },
    {
      ...time,
      agentCommands: async () => {
        commands += 1;
        return 'Respuesta segura';
      },
    },
  );
  await Promise.all([
    handle(message(1), signal()),
    handle(message(2), signal()),
  ]);
  assert.equal(commands, 2);
  assert.deepEqual(attempts, [0, 2000, 3000]);
});

test('cancelar una entrega en cola impide el envío posterior sin ejecutar otro callback', async () => {
  const abort = new AbortController();
  let calls = 0;
  let sends = 0;
  let started!: () => void;
  let finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    {
      sendMessage: async () => {
        sends += 1;
        started();
        await deferred;
      },
    },
    {
      ...clock(),
      agentCommands: async () => {
        calls += 1;
        return 'Respuesta segura';
      },
    },
  );
  const first = handle(message(1), signal());
  await begun;
  const second = handle(message(2), abort.signal);
  await Promise.resolve();
  abort.abort();
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(sends, 1);
});

test('error inesperado y respuesta demasiado grande usan mensajes fijos', async () => {
  const replies: string[] = [];
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    {
      sendMessage: async (_chat, text) => {
        replies.push(text);
      },
    },
    {
      ...clock(),
      agentCommands: async (context) => {
        if (context.messageId === 1)
          throw new Error('https://internal.invalid/Bearer-secret');
        return 'private-canary'.repeat(1000);
      },
    },
  );
  await handle(message(1), signal());
  await handle(message(2), signal());
  assert.deepEqual(replies, [
    'No pude obtener una respuesta del agente.',
    'No puedo mostrar esa respuesta con seguridad.',
  ]);
});

test('cancelación durante backoff de entrega termina sin respuesta alternativa ni error crudo', async () => {
  const controller = new AbortController();
  let sends = 0;
  const handle = createTelegramHandler(
    [42],
    'JarvisBot',
    {
      sendMessage: async () => {
        sends += 1;
        throw new TelegramApiError('rate-limit', 2000);
      },
    },
    {
      agentCommands: async () => 'Respuesta segura',
      wait: async () => {
        controller.abort();
        throw new Error('private-canary');
      },
    },
  );
  await handle(message(1), controller.signal);
  assert.equal(sends, 1);
});
