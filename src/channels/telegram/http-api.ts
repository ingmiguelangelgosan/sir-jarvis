import { z } from 'zod';

import { TelegramApiError, type TelegramApi } from './api.ts';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({
  id: positiveId,
  is_bot: z.literal(true),
  username: z.string().regex(/^[A-Za-z0-9_]+$/),
});
const updatesSchema = z.array(
  z.object({
    update_id: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    message: z.unknown().optional(),
  }),
);
const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.unknown().optional() }).optional(),
});

function apiError(code: number, retryAfter: unknown): TelegramApiError {
  if (code === 429) {
    if (
      retryAfter !== undefined &&
      (typeof retryAfter !== 'number' ||
        !Number.isSafeInteger(retryAfter) ||
        retryAfter <= 0 ||
        retryAfter > 86_400)
    ) {
      // No acortar una espera del proveedor desconocida ni desbordar timers.
      return new TelegramApiError('invalid-response');
    }
    return new TelegramApiError('rate-limit', (Number(retryAfter) || 1) * 1000);
  }
  if (code === 401 || code === 403) return new TelegramApiError('unauthorized');
  if (code === 409) return new TelegramApiError('conflict');
  if (code >= 500) return new TelegramApiError('transient');
  return new TelegramApiError('rejected');
}

export function createTelegramApi(
  token: string,
  request: typeof fetch = fetch,
): TelegramApi {
  async function call(
    method: string,
    payload: object,
    signal: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (signal.aborted) throw new TelegramApiError('aborted');
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    let response: Response;
    try {
      response = await request(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: requestSignal,
        },
      );
    } catch {
      throw new TelegramApiError(signal.aborted ? 'aborted' : 'transient');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted) throw new TelegramApiError('aborted');
      if (!response.ok) throw apiError(response.status, undefined);
      if (requestSignal.aborted || !(error instanceof SyntaxError)) {
        throw new TelegramApiError('transient');
      }
      throw new TelegramApiError('invalid-response');
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!response.ok) {
      throw apiError(
        response.status,
        envelope.success ? envelope.data.parameters?.retry_after : undefined,
      );
    }
    if (!envelope.success) throw new TelegramApiError('invalid-response');
    if (!envelope.data.ok) {
      throw apiError(
        envelope.data.error_code ?? 400,
        envelope.data.parameters?.retry_after,
      );
    }
    return envelope.data.result;
  }

  return {
    async getMe(signal) {
      const result = identitySchema.safeParse(await call('getMe', {}, signal));
      if (!result.success) throw new TelegramApiError('invalid-response');
      return { id: result.data.id, username: result.data.username };
    },
    async getUpdates(offset, signal) {
      const result = updatesSchema.safeParse(
        await call(
          'getUpdates',
          { offset, timeout: 25, limit: 100, allowed_updates: ['message'] },
          signal,
          35_000,
        ),
      );
      if (!result.success) throw new TelegramApiError('invalid-response');
      return result.data;
    },
    async sendMessage(chatId, text, signal) {
      const result = z.object({ message_id: positiveId }).safeParse(
        await call(
          'sendMessage',
          {
            chat_id: chatId,
            text,
            link_preview_options: { is_disabled: true },
            allow_paid_broadcast: false,
          },
          signal,
        ),
      );
      if (!result.success) throw new TelegramApiError('invalid-response');
    },
  };
}
