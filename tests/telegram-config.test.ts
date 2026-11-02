import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigurationError, parseConfig } from '../src/app/config.ts';
import { parseTelegramConfig } from '../src/app/telegram-config.ts';

const token = `12345:${'x'.repeat(35)}`;

test('valida token y allowlist explícita de IDs numéricos, sin valores por defecto', () => {
  const config = parseTelegramConfig({
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USER_IDS: '42, 43,42,4503599627370495',
  });
  assert.equal(config.token, token);
  assert.deepEqual(config.allowedUserIds, [42, 43, 4503599627370495]);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.allowedUserIds));
});

for (const value of [
  undefined,
  '',
  '0',
  '-42',
  '1.2',
  '1e3',
  'user',
  '42,',
  ',42',
  '42,,43',
  '9007199254740992',
]) {
  test(`rechaza allowlist inválida ${JSON.stringify(value)}`, () => {
    assert.throws(
      () =>
        parseTelegramConfig({
          TELEGRAM_BOT_TOKEN: token,
          TELEGRAM_ALLOWED_USER_IDS: value,
        }),
      new ConfigurationError(
        'Configuración inválida: TELEGRAM_ALLOWED_USER_IDS. Revisa .env.example.',
      ),
    );
  });
}

for (const value of [
  undefined,
  '',
  'canario-secreto-no-real',
  `${token}\n`,
  ` ${token}`,
  `${token}/getMe`,
  `${token}?query=secret`,
]) {
  test(`rechaza token inválido sin mostrarlo (${value === undefined ? 'ausente' : 'presente'})`, () => {
    assert.throws(
      () =>
        parseTelegramConfig({
          TELEGRAM_BOT_TOKEN: value,
          TELEGRAM_ALLOWED_USER_IDS: '42',
        }),
      new ConfigurationError(
        'Configuración inválida: TELEGRAM_BOT_TOKEN. Revisa .env.example.',
      ),
    );
  });
}

test('la configuración del diagnóstico no arrastra credenciales de Telegram', () => {
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_ALLOWED_USER_IDS: '42',
  });
  assert.equal(JSON.stringify(config).includes(token), false);
  assert.equal('token' in config, false);
});

test('entrada real de Telegram sin configuración falla antes de hacer solicitudes', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-telegram-config-'));
  context.after(() => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('jarvis-telegram-config-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const entry = fileURLToPath(
    new URL('../src/app/telegram-main.ts', import.meta.url),
  );
  const result = spawnSync(process.execPath, [entry], {
    cwd: directory,
    env: { NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Configuración inválida: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS. Revisa .env.example.',
  );
});

test('entrada real de Telegram no inicia ante argumentos desconocidos', () => {
  const entry = fileURLToPath(
    new URL('../src/app/telegram-main.ts', import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [entry, 'canario-secreto-no-real'],
    {
      env: { NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Uso: npm run telegram');
});
