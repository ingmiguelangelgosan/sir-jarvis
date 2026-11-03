// Explicit integration probe, mounted only into the test profile. No Telegram API.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { loadTelegramAgentIntegration } from '/app/dist/app/telegram-agents.js';
import { createTelegramHandler } from '/app/dist/channels/telegram/handler.js';
import { resolveFileSecrets } from '/app/dist/infrastructure/file-secrets.js';
import { SqliteStateStore } from '/app/dist/infrastructure/sqlite-state-store.js';

const started = performance.now();
let integration;
let stage = 'configuration';
try {
  const environment = resolveFileSecrets(process.env);
  const path = environment.JARVIS_STATE_FILE;
  assert.ok(path);
  const recovering = existsSync(path);
  const newAction = process.argv[2] === 'new-action';
  if (!recovering) new SqliteStateStore({ path, create: true }).close();
  const allowed = environment.TELEGRAM_ALLOWED_USER_IDS?.split(',').map(Number);
  assert.deepEqual(allowed, [42]); // This probe uses a fictitious local subject only.
  stage = 'composition';
  integration = loadTelegramAgentIntegration(environment, allowed);
  assert.ok(integration?.journal);
  const replies = [];
  let commands = 0;
  const handler = createTelegramHandler(
    allowed,
    'jarvis_compose_demo_bot',
    {
      async sendMessage(_chat, text) {
        replies.push(text);
      },
    },
    {
      agentCommands: async (message, signal) => {
        commands += 1;
        return integration.commands(message, signal);
      },
      agentJournal: integration.journal,
    },
    87654321,
  );
  const update = {
    update_id: newAction ? 2 : 1,
    message: {
      message_id: newAction ? 2 : 1,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: 'private' },
      text: '/agent demo.echo echo.reply Hola Jarvis',
    },
  };
  const signal = new globalThis.AbortController().signal;
  stage = 'execution';
  await Promise.all(Array.from({ length: 8 }, () => handler(update, signal)));
  const expected = newAction || !recovering ? 1 : 0;
  assert.equal(commands, expected);
  assert.equal(replies.length, expected);
  if (expected) assert.ok(replies[0]?.includes('Hola Jarvis'));
  // Authentication remains effective before the command callback.
  await handler(
    {
      ...update,
      update_id: 2,
      message: {
        ...update.message,
        message_id: 2,
        from: { id: 77, is_bot: false },
        chat: { id: 77, type: 'private' },
      },
    },
    signal,
  );
  assert.equal(commands, expected);
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'telegram-simulated-core-gateway-independent-echo-https',
      recovered: recovering,
      commands,
      deliveries: replies.length,
      concurrentDuplicates: 8,
      databaseBytes: statSync(path).size,
      walBytes: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0,
      durationMs: Math.round(performance.now() - started),
      rssBytes: process.memoryUsage().rss,
    })}\n`,
  );
} catch {
  process.stderr.write(`Compose integration probe failed: ${stage}.\n`);
  process.exitCode = 1;
} finally {
  integration?.close();
}
