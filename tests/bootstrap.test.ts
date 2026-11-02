import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigurationError, parseConfig } from '../src/app/config.ts';
import { runCli } from '../src/channels/cli/run.ts';
import { loadEnvironment } from '../src/infrastructure/environment.ts';

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-phase0-'));
  context.after(() => {
    // Validar el destino antes del borrado recursivo del fixture.
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('jarvis-phase0-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

const entrypoint = fileURLToPath(
  new URL('../src/app/main.ts', import.meta.url),
);

test('ausencia de .env permite el diagnóstico local', (context) => {
  const directory = temporaryDirectory(context);
  assert.deepEqual(loadEnvironment({}, join(directory, '.env')), {});
});

test('carga .env y el entorno del proceso tiene prioridad sin mutarlo', (context) => {
  const directory = temporaryDirectory(context);
  const envFilePath = join(directory, '.env');
  writeFileSync(
    envFilePath,
    'NODE_ENV=production\nJARVIS_TIMEZONE=UTC\nJARVIS_AI_MODE=enabled\n',
  );
  const environment = Object.freeze({ JARVIS_AI_MODE: 'disabled' });
  assert.deepEqual(parseConfig(loadEnvironment(environment, envFilePath)), {
    environment: 'production',
    timeZone: 'UTC',
    aiMode: 'disabled',
  });
  assert.deepEqual(environment, { JARVIS_AI_MODE: 'disabled' });
});

test('un error de lectura distinto de ENOENT impide el arranque sin revelar rutas', (context) => {
  const directory = temporaryDirectory(context);
  assert.throws(
    () => loadEnvironment({}, directory),
    new ConfigurationError('No se pudo cargar el archivo .env.'),
  );
});

test('CLI real responde sin credenciales y no expone variables privadas', (context) => {
  const result = spawnSync(process.execPath, [entrypoint, 'diagnose'], {
    cwd: temporaryDirectory(context),
    env: {
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: 'canario-secreto-no-real',
      DATABASE_URL: 'canario-privado-no-real',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    application: 'jarvis',
    phase: '1A',
    status: 'bootstrap-ready',
    checks: { configuration: 'valid' },
    capabilities: {
      telegram: 'available-not-connected',
      persistence: 'not-implemented',
      finance: 'not-implemented',
      ai: 'disabled',
    },
  });
  assert.equal(result.stdout.includes('canario'), false);
});

test('CLI real rechaza habilitar IA desde .env sin revelar el valor', (context) => {
  const directory = temporaryDirectory(context);
  writeFileSync(
    join(directory, '.env'),
    'JARVIS_AI_MODE=canario-secreto-no-real',
  );
  const result = spawnSync(process.execPath, [entrypoint], {
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
    'Configuración inválida: JARVIS_AI_MODE. Revisa .env.example.',
  );
});

test('errores inesperados producen un mensaje fijo sin trazas ni secretos', () => {
  const messages: string[] = [];
  const code = runCli(
    [],
    () => {
      throw new Error('canario-secreto-no-real');
    },
    {
      write: () => assert.fail('No debe escribir un diagnóstico exitoso'),
      error: (message) => messages.push(message),
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(messages, ['No se pudo iniciar Jarvis.']);
});

test('argumentos desconocidos no arrancan ni se reflejan en la salida', () => {
  const messages: string[] = [];
  const code = runCli(
    ['canario-secreto-no-real'],
    () => assert.fail('No debe iniciar con argumentos inválidos'),
    {
      write: () => assert.fail('No debe escribir un diagnóstico exitoso'),
      error: (message) => messages.push(message),
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(messages, ['Uso: jarvis [diagnose]']);
});
