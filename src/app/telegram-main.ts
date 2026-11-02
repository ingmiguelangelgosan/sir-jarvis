import { resolve } from 'node:path';

import { TelegramApiError } from '../channels/telegram/api.ts';
import { createTelegramApi } from '../channels/telegram/http-api.ts';
import { runTelegramPolling } from '../channels/telegram/polling.ts';
import { loadEnvironment } from '../infrastructure/environment.ts';
import { ConfigurationError, parseConfig } from './config.ts';
import { parseTelegramConfig } from './telegram-config.ts';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  if (process.argv.length > 2) {
    process.stderr.write('Uso: npm run telegram\n');
    process.exitCode = 1;
  } else {
    const environment = loadEnvironment(
      process.env,
      resolve(process.cwd(), '.env'),
    );
    parseConfig(environment); // También rechaza cualquier intento de activar IA.
    const config = parseTelegramConfig(environment);
    await runTelegramPolling(
      createTelegramApi(config.token),
      config.allowedUserIds,
      controller.signal,
      { log: (event) => process.stdout.write(`${event}\n`) },
    );
  }
} catch (error) {
  if (!controller.signal.aborted) {
    let message = 'No se pudo iniciar Telegram.';
    if (error instanceof ConfigurationError) message = error.message;
    if (error instanceof TelegramApiError) {
      message =
        error.kind === 'conflict'
          ? 'Telegram rechazó el polling. Revisa otras instancias o un webhook activo.'
          : error.message;
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
