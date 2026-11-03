import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';

import { ConfigurationError } from '../src/app/config.ts';
import {
  createTelegramAgentIntegration,
  loadTelegramAgentIntegration,
  parseTelegramAgentsConfig,
  telegramAgentsEnabled,
} from '../src/app/telegram-agents.ts';
import { registration } from './agent-runtime.fixtures.ts';
import { loopbackPolicy } from './agent-https-fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const key = () => randomBytes(32).toString('base64url');
function removeFixture(directory: string): void {
  const target = realpathSync(directory);
  const fromTemporaryRoot = relative(realpathSync(tmpdir()), target);
  assert.ok(
    !isAbsolute(fromTemporaryRoot) &&
      !fromTemporaryRoot.startsWith('..') &&
      basename(target).startsWith('jarvis-agents-'),
  );
  rmSync(target, { recursive: true, force: true });
}
function config() {
  return {
    instance_id: 'jarvis-demo',
    subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
    agents: [registration()],
    allowed_endpoints: [{ origin: 'https://echo.example.invalid' }],
    credential_variables: { 'unused-request-reference': 'JARVIS_ECHO_BEARER' },
    result_cache_ms: 60_000,
  };
}
const invalid = (error: unknown) =>
  error instanceof ConfigurationError &&
  error.message ===
    'Configuración inválida de agentes Telegram. Revisa docs/TELEGRAM.md.';

test('integración false por defecto no lee archivos, claves ni credenciales', () => {
  for (const env of [
    {},
    {
      JARVIS_TELEGRAM_AGENTS_ENABLED: 'false',
      JARVIS_AGENTS_CONFIG_FILE: 'nonexistent-private-path',
      JARVIS_TELEGRAM_AGENT_KEY: 'private-canary',
    },
  ])
    assert.equal(loadTelegramAgentIntegration(env, [42]), undefined);
  assert.equal(telegramAgentsEnabled({}), false);
  for (const value of ['TRUE', '1', '', 'false ', 'yes'])
    assert.throws(
      () => telegramAgentsEnabled({ JARVIS_TELEGRAM_AGENTS_ENABLED: value }),
      invalid,
    );
});

test('configuración explícita se congela y separa sujetos de los mensajes', () => {
  const raw = config();
  const parsed = parseTelegramAgentsConfig(raw, [42]);
  raw.subjects[0]!.subject_ref = 'changed';
  assert.equal(parsed.subjects[0]?.subject_ref, 'owner-demo');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.agents[0]));
});

test('bindings rechazan usuarios fuera allowlist, duplicados y sujetos numéricos o compartidos', () => {
  for (const subjects of [
    [{ telegram_user_id: 43, subject_ref: 'owner-demo' }],
    [{ telegram_user_id: 42, subject_ref: '42' }],
    [
      { telegram_user_id: 42, subject_ref: 'owner-demo' },
      { telegram_user_id: 42, subject_ref: 'other' },
    ],
    [
      { telegram_user_id: 42, subject_ref: 'owner-demo' },
      { telegram_user_id: 43, subject_ref: 'owner-demo' },
    ],
    [{ telegram_user_id: '42', subject_ref: 'owner-demo' }],
  ])
    assert.throws(
      () =>
        parseTelegramAgentsConfig(
          { ...config(), subjects },
          [42, 43].filter((id) => subjects.length > 1 || id === 42),
        ),
      invalid,
    );
});

test('configuración rechaza campos extra, instancia cruzada, grants sin binding y referencias sin variable', () => {
  const raw = config();
  for (const value of [
    { ...raw, extra: 'private-canary' },
    { ...raw, instance_id: '42' },
    { ...raw, agents: [registration({ instance_id: 'other' })] },
    {
      ...raw,
      agents: [
        registration({
          permissions: [
            {
              subject_ref: 'other',
              capabilities: [{ name: 'echo.reply', version: '1.0' }],
            },
          ],
        }),
      ],
    },
    { ...raw, credential_variables: {} },
    { ...raw, result_cache_ms: 0 },
  ])
    assert.throws(() => parseTelegramAgentsConfig(value, [42]), invalid);
});

test('HMAC y token de Telegram nunca se usan como referencia Bearer de agente', () => {
  for (const variable of [
    'JARVIS_TELEGRAM_AGENT_KEY',
    'TELEGRAM_BOT_TOKEN',
    'invalid-name',
  ])
    assert.throws(
      () =>
        parseTelegramAgentsConfig(
          {
            ...config(),
            credential_variables: { 'unused-request-reference': variable },
          },
          [42],
        ),
      invalid,
    );
});

test('solo una clave HMAC canónica suficientemente fuerte permite componer integración', () => {
  const parsed = parseTelegramAgentsConfig(config(), [42]);
  for (const secret of [
    '',
    'x',
    'a'.repeat(42),
    `${key()}=`,
    ' '.repeat(43),
    'a'.repeat(90),
  ])
    assert.throws(
      () => createTelegramAgentIntegration(parsed, secret, () => undefined),
      invalid,
    );
  for (const length of [32, 64]) {
    const integration = createTelegramAgentIntegration(
      parsed,
      randomBytes(length).toString('base64url'),
      () => undefined,
    );
    assert.equal(JSON.stringify(integration), '{}');
    integration.close();
  }
});

test('Registry y política de red validan configuración antes de iniciar Telegram', () => {
  const raw = config();
  const cases = [
    { ...raw, agents: [registration(), registration()] },
    { ...raw, allowed_endpoints: [{ origin: 'https://other.invalid' }] },
    { ...raw, allowed_endpoints: [{ origin: 'http://echo.example.invalid' }] },
    {
      ...raw,
      allowed_endpoints: [
        {
          origin: 'https://echo.example.invalid',
          private_addresses: ['127.0.0.1'],
        },
      ],
    },
  ];
  for (const value of cases)
    assert.throws(
      () =>
        createTelegramAgentIntegration(
          parseTelegramAgentsConfig(value, [42]),
          key(),
          () => undefined,
        ),
      invalid,
    );
});

test('sin agentes ni variables Bearer la integración inicia y responde sin red', async () => {
  const parsed = parseTelegramAgentsConfig(
    {
      ...config(),
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
    },
    [42],
  );
  const integration = createTelegramAgentIntegration(parsed, key(), () =>
    assert.fail('No credentials lookup'),
  );
  try {
    assert.equal(
      await integration.commands(
        {
          userId: 42,
          chatId: 42,
          messageId: 1,
          botUsername: 'JarvisBot',
          text: '/agents',
        },
        new AbortController().signal,
      ),
      'No tienes agentes de lectura disponibles.',
    );
  } finally {
    integration.close();
  }
});

test('carga de archivo privado está acotada y errores no exponen ruta ni contenido', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-agents-config-'));
  t.after(() => removeFixture(directory));
  const path = join(directory, 'agents.json');
  const env = {
    JARVIS_TELEGRAM_AGENTS_ENABLED: 'true',
    JARVIS_AGENTS_CONFIG_FILE: path,
    JARVIS_TELEGRAM_AGENT_KEY: key(),
  };
  assert.throws(
    () =>
      loadTelegramAgentIntegration(
        { JARVIS_TELEGRAM_AGENTS_ENABLED: 'true' },
        [42],
      ),
    invalid,
  );
  assert.throws(() => loadTelegramAgentIntegration(env, [42]), invalid);
  for (const value of ['private-canary-invalid-json', ' '.repeat(65_537)]) {
    writeFileSync(path, value);
    assert.throws(() => loadTelegramAgentIntegration(env, [42]), invalid);
  }
  writeFileSync(path, Buffer.from([0xc3, 0x28]));
  assert.throws(() => loadTelegramAgentIntegration(env, [42]), invalid);
  writeFileSync(path, JSON.stringify(config()));
  const integration = loadTelegramAgentIntegration(env, [42]);
  integration?.close();
});

test('CA privada opcional se lee relativa al archivo configurado y falla de forma segura', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-agents-ca-'));
  t.after(() => removeFixture(directory));
  const path = join(directory, 'agents.json');
  writeFileSync(
    path,
    JSON.stringify({ ...config(), ca_file: 'missing-ca.pem' }),
  );
  assert.throws(
    () =>
      loadTelegramAgentIntegration(
        {
          JARVIS_TELEGRAM_AGENTS_ENABLED: 'true',
          JARVIS_AGENTS_CONFIG_FILE: path,
          JARVIS_TELEGRAM_AGENT_KEY: key(),
        },
        [42],
      ),
    invalid,
  );
});

test('Bearer mal configurado con el valor HMAC nunca se envía al agente', async (t) => {
  const server = await startEchoAgent();
  t.after(() => server.close());
  const raw = config();
  raw.agents = [
    {
      ...registration(),
      connection: { ...registration().connection, base_url: server.origin },
    },
  ];
  raw.allowed_endpoints = [{ origin: server.origin }];
  const secret = key();
  const integration = createTelegramAgentIntegration(
    parseTelegramAgentsConfig(raw, [42]),
    secret,
    () => secret,
    { network: loopbackPolicy(server.origin), ca: server.ca },
  );
  t.after(() => integration.close());
  const reply = await integration.commands(
    {
      userId: 42,
      chatId: 42,
      messageId: 1,
      botUsername: 'JarvisBot',
      text: '/agent demo.echo echo.reply Hola Jarvis',
    },
    new AbortController().signal,
  );
  assert.ok(!reply?.includes(secret));
  assert.equal((await server.stats()).requests, 0);
  assert.equal(server.diagnosticsBytes(), 0);
});
