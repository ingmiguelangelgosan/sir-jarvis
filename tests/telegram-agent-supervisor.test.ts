import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const manualScript = fileURLToPath(
  new URL('./run-telegram-agents-live.ts', import.meta.url),
);
const normalScript = fileURLToPath(
  new URL('../src/app/telegram-main.ts', import.meta.url),
);

// Preloading replaces only Telegram's fetch boundary. HTTPS to the isolated Echo
// process still uses the production node:https transport, TLS and authentication.
const simulatedTelegram = `
let polls = 0;
let sends = 0;
globalThis.fetch = async (value, options) => {
  const url = new URL(String(value));
  if (url.origin !== 'https://api.telegram.org' || options?.method !== 'POST')
    throw new Error('Unexpected simulated Telegram call.');
  const method = url.pathname.split('/').at(-1);
  const envelope = (result) => new Response(JSON.stringify({ ok: true, result }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  if (method === 'getMe') return envelope({ id: 12345, is_bot: true, username: 'JarvisBot' });
  if (method === 'getUpdates') {
    polls += 1;
    if (polls === 1) return envelope([
      { update_id: 1, message: { message_id: 1, text: '/agents',
        from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' } } },
      { update_id: 2, message: { message_id: 2, text: '/agent demo.echo echo.reply Hola Jarvis',
        from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' } } },
    ]);
    // Emit the same shutdown event on both Windows and Linux without relying on
    // Windows' different process.kill(SIGTERM) termination semantics.
    process.emit('SIGTERM');
    return envelope([]);
  }
  if (method === 'sendMessage') {
    const body = JSON.parse(options.body);
    if (body.chat_id !== 42 || body.allow_paid_broadcast !== false || body.parse_mode !== undefined)
      throw new Error('Unexpected simulated Telegram delivery.');
    sends += 1;
    if (sends === 1 && typeof body.text === 'string' && body.text.includes('demo.echo · echo.reply'))
      process.stdout.write('manual-list-confirmed\\n');
    else if (sends === 2 && body.text === 'Respuesta del agente: Hola Jarvis')
      process.stdout.write('manual-demo-confirmed\\n');
    else throw new Error('Unexpected simulated Telegram reply.');
    return envelope({ message_id: sends });
  }
  throw new Error('Unexpected simulated Telegram method.');
};
`;

const forbidNetworkAndFixture = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.fork = () => {
  process.stdout.write('unexpected-fixture-start\\n');
  throw new Error('Fixture startup forbidden by this test.');
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  process.stdout.write('unexpected-telegram-fetch\\n');
  throw new Error('Telegram fetch forbidden by this test.');
};
`;

function isolatedDirectory(t: TestContext): string {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'jarvis-telegram-supervisor-'));
  t.after(() => {
    const target = realpathSync(directory);
    const fromRoot = relative(root, target);
    if (
      isAbsolute(fromRoot) ||
      fromRoot === '..' ||
      fromRoot.startsWith('../') ||
      fromRoot.startsWith('..\\') ||
      !basename(target).startsWith('jarvis-telegram-supervisor-') ||
      fromRoot.includes('/') ||
      fromRoot.includes('\\')
    )
      throw new Error('Refusing cleanup outside the isolated test directory.');
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

function environment(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    NODE_ENV: 'development',
    JARVIS_AI_MODE: 'disabled',
    JARVIS_TELEGRAM_AGENTS_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: `123456789:${randomBytes(32).toString('base64url')}`,
    TELEGRAM_ALLOWED_USER_IDS: '42',
    ...overrides,
  };
}

function execute(
  t: TestContext,
  preload: string,
  env: NodeJS.ProcessEnv,
  script = manualScript,
) {
  const cwd = isolatedDirectory(t);
  const url = `data:text/javascript,${encodeURIComponent(preload)}`;
  return new Promise<{
    readonly code: string | number;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      ['--import', url, script],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 65_536,
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

test('supervisor manual: Telegram simulado recorre HTTPS real y cierra limpiamente por SIGTERM', async (t) => {
  const env = environment();
  const result = await execute(t, simulatedTelegram, env);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /manual-list-confirmed/);
  assert.match(result.stdout, /manual-demo-confirmed/);
  assert.match(result.stdout, /telegram-started/);
  assert.match(result.stdout, /telegram-stopped/);
  assert.ok(!result.stdout.includes(env.TELEGRAM_BOT_TOKEN!));
  assert.ok(!result.stdout.includes('https://echo.test'));
});

for (const scenario of [
  {
    label: 'integración deshabilitada',
    overrides: { JARVIS_TELEGRAM_AGENTS_ENABLED: 'false' },
  },
  { label: 'entorno production', overrides: { NODE_ENV: 'production' } },
  {
    label: 'más de un propietario',
    overrides: { TELEGRAM_ALLOWED_USER_IDS: '42,43' },
  },
])
  test(`supervisor manual rechaza ${scenario.label} antes de fixture y Telegram`, async (t) => {
    const env = environment(scenario.overrides);
    const result = await execute(t, forbidNetworkAndFixture, env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'No se pudo iniciar la demo manual. Revisa docs/TELEGRAM.md, la configuración y que no haya otro poller.\n',
    );
    assert.ok(!result.stderr.includes(env.TELEGRAM_BOT_TOKEN!));
  });

test('entrada Telegram normal rechaza configuración local inválida antes de cualquier llamada', async (t) => {
  const env = environment({
    JARVIS_AGENTS_CONFIG_FILE: 'private-path-canary/agents.json',
    JARVIS_TELEGRAM_AGENT_KEY: randomBytes(32).toString('base64url'),
  });
  const result = await execute(t, forbidNetworkAndFixture, env, normalScript);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Configuración inválida de agentes Telegram. Revisa docs/TELEGRAM.md.\n',
  );
  for (const privateValue of [
    env.TELEGRAM_BOT_TOKEN!,
    env.JARVIS_TELEGRAM_AGENT_KEY!,
    'private-path-canary',
  ])
    assert.ok(!result.stderr.includes(privateValue));
});
