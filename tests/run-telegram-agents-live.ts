// Explicit manual testing supervisor. Excluded from production build and CI tests.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { ConfigurationError, parseConfig } from '../src/app/config.ts';
import {
  createTelegramAgentIntegration,
  parseTelegramAgentsConfig,
  telegramAgentsEnabled,
} from '../src/app/telegram-agents.ts';
import { parseTelegramConfig } from '../src/app/telegram-config.ts';
import { createTelegramApi } from '../src/channels/telegram/http-api.ts';
import { runTelegramPolling } from '../src/channels/telegram/polling.ts';
import { loadEnvironment } from '../src/infrastructure/environment.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import { registration } from './agent-runtime.fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let server: Awaited<ReturnType<typeof startEchoAgent>> | undefined;
let integration: ReturnType<typeof createTelegramAgentIntegration> | undefined;
try {
  if (process.argv.length > 2)
    throw new ConfigurationError('La demo no admite parámetros.');
  const environment = loadEnvironment(process.env, resolve('.env'));
  if (
    parseConfig(environment).environment === 'production' ||
    !telegramAgentsEnabled(environment)
  )
    throw new ConfigurationError(
      'La demo requiere entorno development/test y JARVIS_TELEGRAM_AGENTS_ENABLED=true.',
    );
  const telegram = parseTelegramConfig(environment);
  if (telegram.allowedUserIds.length !== 1)
    throw new ConfigurationError(
      'La demo requiere exactamente un propietario autorizado.',
    );
  server = await startEchoAgent();
  const entry = registration();
  const config = parseTelegramAgentsConfig(
    {
      instance_id: 'jarvis-demo',
      subjects: [
        {
          telegram_user_id: telegram.allowedUserIds[0],
          subject_ref: 'owner-demo',
        },
      ],
      agents: [
        {
          ...entry,
          connection: { ...entry.connection, base_url: server.origin },
        },
      ],
      allowed_endpoints: [{ origin: server.origin }],
      credential_variables: {
        'unused-request-reference': 'JARVIS_TEST_BEARER',
      },
      result_cache_ms: 60_000,
    },
    telegram.allowedUserIds,
  );
  const token = server.token;
  integration = createTelegramAgentIntegration(
    config,
    randomBytes(32).toString('base64url'),
    () => token,
    { network: loopbackPolicy(server.origin), ca: server.ca },
  );
  process.stdout.write(
    'Demo manual: Telegram real y Echo HTTPS temporal. Usa /agents y /agent demo.echo echo.reply Hola Jarvis. Ctrl+C para cerrar.\n',
  );
  await runTelegramPolling(
    createTelegramApi(telegram.token),
    telegram.allowedUserIds,
    controller.signal,
    {
      agentCommands: integration.commands,
      log: (event) => process.stdout.write(`${event}\n`),
    },
  );
} catch {
  if (!controller.signal.aborted) {
    process.stderr.write(
      'No se pudo iniciar la demo manual. Revisa docs/TELEGRAM.md, la configuración y que no haya otro poller.\n',
    );
    process.exitCode = 1;
  }
} finally {
  integration?.close();
  await server?.close();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
