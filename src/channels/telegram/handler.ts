import { z } from 'zod';

import {
  respondToMessage,
  type AssistantRequest,
} from '../../app/assistant.ts';
import {
  TelegramApiError,
  type TelegramApi,
  type TelegramUpdate,
} from './api.ts';
import { wait, type RuntimeHooks } from './runtime.ts';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const messageSchema = z.object({
  message_id: positiveId,
  from: z.object({ id: positiveId, is_bot: z.literal(false) }),
  chat: z.object({ id: positiveId, type: z.literal('private') }),
  text: z.string().min(1).max(4096),
  sender_chat: z.unknown().optional(),
});

function command(
  text: string,
  botUsername: string,
): AssistantRequest | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/.exec(text);
  if (match?.[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) {
    return undefined;
  }
  if (match?.[1] === 'start') return 'start';
  if (match?.[1] === 'status') return 'status';
  return 'unsupported';
}

export function createTelegramHandler(
  allowedUserIds: readonly number[],
  botUsername: string,
  api: Pick<TelegramApi, 'sendMessage'>,
  hooks: RuntimeHooks & {
    readonly respond?: (request: AssistantRequest) => string;
  } = {},
): (update: TelegramUpdate, signal: AbortSignal) => Promise<void> {
  const allowed = new Set(allowedUserIds);
  const processed = new Set<string>();
  const pause = hooks.wait ?? wait;
  const now = hooks.now ?? (() => performance.now());
  const respond = hooks.respond ?? respondToMessage;
  let nextSendAt = 0;

  return async (update, signal) => {
    if (signal.aborted) return;
    const parsed = messageSchema.safeParse(update.message);
    if (!parsed.success) return;
    const message = parsed.data;
    if (
      !allowed.has(message.from.id) ||
      message.chat.id !== message.from.id ||
      message.sender_chat !== undefined
    )
      return;

    const key = `${message.chat.id}:${message.message_id}`;
    if (processed.has(key)) return;
    const intent = command(message.text, botUsername);
    if (intent === undefined) return;

    // Reserva antes de efectos externos: un envío incierto no se reintenta a ciegas.
    processed.add(key);
    if (processed.size > 1024) {
      const oldest = processed.values().next().value;
      if (oldest !== undefined) processed.delete(oldest);
    }
    const reply = respond(intent);
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
      try {
        const remaining = nextSendAt - now();
        if (remaining > 0) await pause(remaining, signal);
        if (signal.aborted) return;
        nextSendAt = now() + 1000;
        await api.sendMessage(message.chat.id, reply, signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof TelegramApiError && error.kind === 'rate-limit') {
          nextSendAt = Math.max(
            nextSendAt,
            now() + (error.retryAfterMs ?? 1000),
          );
          if (attempt < 2) {
            await pause(error.retryAfterMs ?? 1000, signal);
            continue;
          }
          hooks.log?.('telegram-send-rejected');
        } else if (
          error instanceof TelegramApiError &&
          (error.kind === 'rejected' || error.kind === 'unauthorized')
        ) {
          hooks.log?.('telegram-send-rejected');
        } else {
          hooks.log?.('telegram-delivery-unconfirmed');
        }
        return;
      }
    }
  };
}
