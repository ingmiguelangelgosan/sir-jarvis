import { z } from 'zod';

import { ConfigurationError, type Environment } from './config.ts';

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(/^[1-9]\d{4,19}:[A-Za-z0-9_-]{30,128}$/)
    .refine((value) => value === value.trim()),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .min(1)
    .refine((value) =>
      value.split(',').every((part) => {
        const id = part.trim();
        return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
      }),
    ),
});

export interface TelegramConfig {
  readonly token: string;
  readonly allowedUserIds: readonly number[];
}

export function parseTelegramConfig(environment: Environment): TelegramConfig {
  const result = telegramSchema.safeParse({
    TELEGRAM_BOT_TOKEN: environment.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ALLOWED_USER_IDS: environment.TELEGRAM_ALLOWED_USER_IDS,
  });
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    throw new ConfigurationError(
      `Configuración inválida: ${fields.join(', ')}. Revisa .env.example.`,
    );
  }
  return Object.freeze({
    token: result.data.TELEGRAM_BOT_TOKEN,
    allowedUserIds: Object.freeze([
      ...new Set(result.data.TELEGRAM_ALLOWED_USER_IDS.split(',').map(Number)),
    ]),
  });
}
