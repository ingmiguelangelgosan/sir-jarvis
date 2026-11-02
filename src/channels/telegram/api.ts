export interface TelegramIdentity {
  readonly id: number;
  readonly username: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: unknown;
}

// Compartido por polling y un futuro transporte webhook; sin HTTP en el handler.
export interface TelegramApi {
  getMe(signal: AbortSignal): Promise<TelegramIdentity>;
  getUpdates(
    offset: number | undefined,
    signal: AbortSignal,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, signal: AbortSignal): Promise<void>;
}

export type TelegramErrorKind =
  | 'rate-limit'
  | 'transient'
  | 'unauthorized'
  | 'conflict'
  | 'rejected'
  | 'invalid-response'
  | 'aborted';

export class TelegramApiError extends Error {
  readonly kind: TelegramErrorKind;
  readonly retryAfterMs: number | undefined;

  constructor(kind: TelegramErrorKind, retryAfterMs?: number) {
    // Nunca conservar el error de fetch, URL, token ni description de Telegram.
    super(`Error de comunicación con Telegram (${kind}).`);
    this.name = 'TelegramApiError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
