import { z } from 'zod';

export type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const configurationSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  JARVIS_TIMEZONE: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('es-CO', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    })
    .default('America/Bogota'),
  JARVIS_AI_MODE: z.literal('disabled').default('disabled'),
});

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly timeZone: string;
  readonly aiMode: 'disabled';
}

export function parseConfig(environment: Environment): AppConfig {
  // Selección explícita: ni credenciales ni otras variables llegan al resultado.
  const result = configurationSchema.safeParse({
    NODE_ENV: environment.NODE_ENV,
    JARVIS_TIMEZONE: environment.JARVIS_TIMEZONE,
    JARVIS_AI_MODE: environment.JARVIS_AI_MODE,
  });

  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    // No incluir valores, mensajes originales de Zod ni el entorno completo.
    throw new ConfigurationError(
      `Configuración inválida: ${fields.join(', ')}. Revisa .env.example.`,
    );
  }

  return Object.freeze({
    environment: result.data.NODE_ENV,
    timeZone: result.data.JARVIS_TIMEZONE,
    aiMode: result.data.JARVIS_AI_MODE,
  });
}
