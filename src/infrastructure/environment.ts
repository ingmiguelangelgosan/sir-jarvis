import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigurationError, type Environment } from '../app/config.ts';

export function loadEnvironment(
  environment: Environment,
  envFilePath: string,
): Environment {
  let fileEnvironment: Environment;

  try {
    fileEnvironment = parseEnv(readFileSync(envFilePath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return environment;
    }

    // El error de lectura puede incluir rutas o contenido privado.
    throw new ConfigurationError('No se pudo cargar el archivo .env.');
  }

  return { ...fileEnvironment, ...environment };
}
