import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigurationError, parseConfig } from '../src/app/config.ts';

test('arranca sin credenciales con IA deshabilitada', () => {
  assert.deepEqual(parseConfig({}), {
    environment: 'development',
    timeZone: 'America/Bogota',
    aiMode: 'disabled',
  });
});

test('admite configuración explícita sin copiar variables desconocidas', () => {
  const environment = {
    NODE_ENV: 'production',
    JARVIS_TIMEZONE: 'UTC',
    JARVIS_AI_MODE: 'disabled',
    TELEGRAM_BOT_TOKEN: 'canario-secreto-no-real',
    DATABASE_URL: 'canario-privado-no-real',
  };
  const config = parseConfig(environment);
  assert.deepEqual(config, {
    environment: 'production',
    timeZone: 'UTC',
    aiMode: 'disabled',
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(environment.TELEGRAM_BOT_TOKEN, 'canario-secreto-no-real');
});

for (const [field, values] of Object.entries({
  NODE_ENV: ['', 'staging', 'canario-secreto-no-real'],
  JARVIS_TIMEZONE: ['', 'Invalid/Timezone', 'canario-secreto-no-real'],
  JARVIS_AI_MODE: ['', 'enabled', 'false', 'paid', 'canario-secreto-no-real'],
})) {
  for (const value of values) {
    test(`rechaza ${field} inválido (${JSON.stringify(value)}) sin revelar valores`, () => {
      assert.throws(
        () => parseConfig({ [field]: value }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.equal(
            error.message,
            `Configuración inválida: ${field}. Revisa .env.example.`,
          );
          return true;
        },
      );
    });
  }
}
