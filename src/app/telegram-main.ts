import {
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { TelegramApiError } from '../channels/telegram/api.ts';
import { createTelegramApi } from '../channels/telegram/http-api.ts';
import { runTelegramPolling } from '../channels/telegram/polling.ts';
import { loadEnvironment } from '../infrastructure/environment.ts';
import { resolveFileSecrets } from '../infrastructure/file-secrets.ts';
import {
  acquireRuntimeLock,
  acquireTelegramConsumerLock,
  type RuntimeLock,
} from '../infrastructure/runtime-lock.ts';
import { SqliteStateStore } from '../infrastructure/sqlite-state-store.ts';
import { ConfigurationError, parseConfig } from './config.ts';
import { parseTelegramConfig } from './telegram-config.ts';
import {
  loadTelegramAgentIntegration,
  telegramAgentsEnabled,
} from './telegram-agents.ts';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let agents: ReturnType<typeof loadTelegramAgentIntegration>;
let stateLock: RuntimeLock | undefined;
let consumerLock: RuntimeLock | undefined;
let standaloneState: SqliteStateStore | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let healthFile: string | undefined;
let healthFd: number | undefined;

try {
  if (process.argv.length > 2) {
    process.stderr.write('Uso: npm run telegram\n');
    process.exitCode = 1;
  } else {
    const environment = resolveFileSecrets(
      loadEnvironment(process.env, resolve(process.cwd(), '.env')),
    );
    parseConfig(environment); // También rechaza cualquier intento de activar IA.
    const config = parseTelegramConfig(environment);
    if (
      telegramAgentsEnabled(environment) &&
      !environment.JARVIS_STATE_FILE?.trim()
    )
      throw new ConfigurationError(
        'Configuración inválida de agentes Telegram. Revisa docs/TELEGRAM.md.',
      );
    agents = loadTelegramAgentIntegration(environment, config.allowedUserIds);
    const statePath = environment.JARVIS_STATE_FILE
      ? resolve(environment.JARVIS_STATE_FILE)
      : undefined;
    if (statePath) {
      stateLock = acquireRuntimeLock(statePath);
      if (!agents) {
        standaloneState = new SqliteStateStore({ path: statePath });
        standaloneState.assertExternalEffectsAllowed();
      }
    }
    const runtime = environment.JARVIS_RUNTIME_DIRECTORY
      ? resolve(environment.JARVIS_RUNTIME_DIRECTORY)
      : statePath
        ? dirname(statePath)
        : resolve('.local/runtime');
    if (!environment.JARVIS_RUNTIME_DIRECTORY && !statePath)
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
    consumerLock = acquireTelegramConsumerLock(
      runtime,
      config.token.split(':')[0]!,
    );
    const assertRunning = () => {
      if (controller.signal.aborted) throw new Error();
      stateLock?.assertHeld();
      consumerLock!.assertHeld();
      standaloneState?.assertExternalEffectsAllowed();
    };
    const api = createTelegramApi(config.token);
    const guardedApi = {
      getMe: (signal: AbortSignal) => {
        assertRunning();
        return api.getMe(signal);
      },
      getUpdates: (offset: number | undefined, signal: AbortSignal) => {
        assertRunning();
        return api.getUpdates(offset, signal);
      },
      sendMessage: (chatId: number, text: string, signal: AbortSignal) => {
        assertRunning();
        return api.sendMessage(chatId, text, signal);
      },
    };
    const refreshHealth = () => {
      try {
        assertRunning();
        if (healthFile && healthFd !== undefined) {
          const info = lstatSync(healthFile);
          const owned = fstatSync(healthFd);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1 ||
            owned.ino !== info.ino ||
            owned.dev !== info.dev
          )
            throw new Error();
          const data = JSON.stringify({ pid: process.pid, at: Date.now() });
          writeSync(healthFd, data, 0, 'utf8');
          ftruncateSync(healthFd, Buffer.byteLength(data));
        }
      } catch {
        process.exitCode = 1;
        controller.abort();
      }
    };
    await runTelegramPolling(
      guardedApi,
      config.allowedUserIds,
      controller.signal,
      {
        log: (event) => {
          if (event === 'telegram-started' && environment.JARVIS_HEALTH_FILE) {
            healthFile = resolve(environment.JARVIS_HEALTH_FILE);
            healthFd = openSync(healthFile, 'wx', 0o600);
            refreshHealth();
            heartbeat = setInterval(refreshHealth, 10_000);
            heartbeat.unref();
          }
          process.stdout.write(`${event}\n`);
        },
        ...(agents
          ? {
              agentCommands: agents.commands,
              ...(agents.journal ? { agentJournal: agents.journal } : {}),
            }
          : {}),
      },
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
  if (heartbeat) clearInterval(heartbeat);
  if (healthFile && healthFd !== undefined) {
    try {
      const info = lstatSync(healthFile);
      const owned = fstatSync(healthFd);
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        info.ino === owned.ino &&
        info.dev === owned.dev
      )
        unlinkSync(healthFile);
    } catch {
      /* Health failure never exposes paths or secrets. */
    } finally {
      closeSync(healthFd);
    }
  }
  try {
    agents?.close();
  } finally {
    try {
      standaloneState?.close();
    } finally {
      try {
        consumerLock?.close();
      } finally {
        stateLock?.close();
      }
    }
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
