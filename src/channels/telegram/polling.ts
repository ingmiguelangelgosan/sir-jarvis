import { TelegramApiError, type TelegramApi } from './api.ts';
import { createTelegramHandler } from './handler.ts';
import { wait, type RuntimeHooks } from './runtime.ts';

export async function runTelegramPolling(
  api: TelegramApi,
  allowedUserIds: readonly number[],
  signal: AbortSignal,
  hooks: RuntimeHooks = {},
): Promise<void> {
  const pause = hooks.wait ?? wait;
  let failures = 0;

  async function recover(error: unknown): Promise<void> {
    if (
      !(error instanceof TelegramApiError) ||
      (error.kind !== 'transient' && error.kind !== 'rate-limit')
    ) {
      throw error instanceof TelegramApiError
        ? error
        : new TelegramApiError('invalid-response');
    }
    hooks.log?.('telegram-poll-retry');
    const delay =
      error.kind === 'rate-limit'
        ? (error.retryAfterMs ?? 1000)
        : Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    failures += 1;
    await pause(delay, signal);
  }

  try {
    let identity;
    while (!signal.aborted) {
      try {
        identity = await api.getMe(signal);
        break;
      } catch (error) {
        if (signal.aborted) return;
        await recover(error);
      }
    }
    if (!identity || signal.aborted) return;
    const handle = createTelegramHandler(
      allowedUserIds,
      identity.username,
      api,
      hooks,
      identity.id,
    );
    hooks.log?.('telegram-started');
    failures = 0;
    let offset: number | undefined;

    while (!signal.aborted) {
      let updates;
      try {
        updates = await api.getUpdates(offset, signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        await recover(error);
        continue;
      }
      for (const update of [...updates].sort(
        (a, b) => a.update_id - b.update_id,
      )) {
        if (signal.aborted) return;
        if (offset !== undefined && update.update_id < offset) continue;
        await handle(update, signal);
        offset = update.update_id + 1;
      }
      if (updates.length === 0) await pause(100, signal);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    hooks.log?.('telegram-stopped');
  }
}
