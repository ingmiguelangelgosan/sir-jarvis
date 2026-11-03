import { randomBytes } from 'node:crypto';

import {
  createTelegramAgentIntegration,
  parseTelegramAgentsConfig,
} from '../src/app/telegram-agents.ts';
import type { TelegramApi } from '../src/channels/telegram/api.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import { registration } from './agent-runtime.fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const server = await startEchoAgent();
const config = parseTelegramAgentsConfig(
  {
    instance_id: 'jarvis-demo',
    subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
    agents: [
      registration({
        connection: { ...registration().connection, base_url: server.origin },
      }),
    ],
    allowed_endpoints: [{ origin: server.origin }],
    credential_variables: { 'unused-request-reference': 'JARVIS_TEST_BEARER' },
    result_cache_ms: 1000,
  },
  [42],
);
const integration = createTelegramAgentIntegration(
  config,
  randomBytes(32).toString('base64url'),
  (name) => (name === 'JARVIS_TEST_BEARER' ? server.token : undefined),
  { network: loopbackPolicy(server.origin), ca: server.ca },
);
const controller = new AbortController();
let replies = 0;
let polls = 0;
const api: TelegramApi = {
  getMe: async () => ({ id: 12345, username: 'JarvisBot' }),
  getUpdates: async () => {
    polls += 1;
    if (polls === 1)
      return [
        {
          update_id: 1,
          message: {
            message_id: 1,
            text: '/agent demo.echo echo.reply Hola Jarvis',
            from: { id: 42, is_bot: false },
            chat: { id: 42, type: 'private' },
          },
        },
      ];
    controller.abort();
    return [];
  },
  sendMessage: async (_chatId, text) => {
    if (text !== 'Respuesta del agente: Hola Jarvis')
      throw new Error('Unexpected simulated reply.');
    replies += 1;
  },
};
try {
  await runTelegramPolling(api, [42], controller.signal, {
    agentCommands: integration.commands,
  });
  const counts = await server.stats();
  if (
    counts.executions !== 1 ||
    replies !== 1 ||
    server.diagnosticsBytes() !== 0
  )
    throw new Error('Telegram HTTPS demo failed.');
  process.stdout.write(
    `${JSON.stringify({ mode: 'telegram-simulated-https-local', status: 'completed', executions: counts.executions, replies })}\n`,
  );
} finally {
  integration.close();
  await server.close();
}
