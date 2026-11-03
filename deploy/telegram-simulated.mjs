// Explicit test-profile preload. Every fetch is simulated; no Telegram token,
// public network or Jarvis module is used. HTTPS Agent Transport is unaffected.
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import process from 'node:process';

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (
    url.origin !== 'https://api.telegram.org' ||
    !url.pathname.startsWith(
      '/bot87654321:compose_fictitious_token_not_for_real_use/',
    )
  )
    throw new Error('Simulated Telegram rejected a destination.');
  const method = url.pathname.split('/').at(-1);
  let result;
  if (method === 'getMe') {
    process.stdout.write('simulated-telegram-api-used\n');
    result = {
      id: 87654321,
      is_bot: true,
      first_name: 'Fictitious local probe',
      username: 'jarvis_compose_demo_bot',
    };
  } else if (method === 'getUpdates') {
    await delay(1000, undefined, { signal: options?.signal });
    result = [];
  } else if (method === 'sendMessage') result = { message_id: 1 };
  else throw new Error('Simulated Telegram rejected a method.');
  return new globalThis.Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
