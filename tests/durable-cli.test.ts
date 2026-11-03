import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { temporaryState } from './durable-test.fixtures.ts';

const stateScript = fileURLToPath(
  new URL('../src/app/state-main.ts', import.meta.url),
);
const botScript = fileURLToPath(
  new URL('../src/app/telegram-main.ts', import.meta.url),
);
function run(
  args: string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
) {
  return new Promise<{ code: string | number; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        args,
        {
          cwd,
          env: {
            ...(process.platform === 'win32' && process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            ...environment,
          },
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 65_536,
        },
        (error, stdout, stderr) =>
          resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    },
  );
}
const noFetch = `globalThis.fetch = async () => { process.stdout.write('UNEXPECTED_FETCH'); throw new Error('Forbidden external call'); };`;
const preload = (code: string) => [
  '--import',
  `data:text/javascript,${encodeURIComponent(code)}`,
];
const environment = () => ({
  NODE_ENV: 'development',
  JARVIS_AI_MODE: 'disabled',
  TELEGRAM_BOT_TOKEN: `123456789:${randomBytes(32).toString('base64url')}`,
  TELEGRAM_ALLOWED_USER_IDS: '42',
  JARVIS_TELEGRAM_AGENTS_ENABLED: 'true',
  JARVIS_TELEGRAM_AGENT_KEY: randomBytes(32).toString('base64url'),
});
function writeConfig(directory: string) {
  const path = join(directory, 'agents.json');
  writeFileSync(
    path,
    JSON.stringify({
      instance_id: 'jarvis-demo',
      subjects: [{ telegram_user_id: 42, subject_ref: 'owner-demo' }],
      agents: [],
      allowed_endpoints: [],
      credential_variables: {},
      result_cache_ms: 1000,
    }),
  );
  return path;
}

test('CLI inicializa exclusivamente, rechaza reemplazo y compacta sin efectos externos', async (t) => {
  const file = temporaryState(t);
  const created = await run(
    [...preload(noFetch), stateScript, 'init', file.path],
    file.directory,
  );
  assert.equal(created.code, 0);
  assert.equal(created.stderr, '');
  assert.equal(existsSync(file.path), true);
  const duplicate = await run(
    [...preload(noFetch), stateScript, 'init', file.path],
    file.directory,
  );
  assert.equal(duplicate.code, 1);
  assert.doesNotMatch(
    duplicate.stderr,
    new RegExp(file.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  const compacted = await run(
    [...preload(noFetch), stateScript, 'compact', file.path],
    file.directory,
  );
  assert.equal(compacted.code, 0);
  assert.match(compacted.stdout, /Claves de bloqueo conservadas/);
  assert.ok(
    !`${created.stdout}${duplicate.stdout}${compacted.stdout}`.includes(
      'UNEXPECTED_FETCH',
    ),
  );
});

test('bot normal con agentes activos exige DB antes de cualquier llamada Telegram', async (t) => {
  const file = temporaryState(t);
  const env = environment();
  const result = await run([...preload(noFetch), botScript], file.directory, {
    ...env,
    JARVIS_AGENTS_CONFIG_FILE: writeConfig(file.directory),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Configuración inválida de agentes Telegram/);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(env.TELEGRAM_BOT_TOKEN));
});

test('bot normal rechaza DB perdida con config válida y nunca la recrea', async (t) => {
  const file = temporaryState(t);
  const env = environment();
  const result = await run([...preload(noFetch), botScript], file.directory, {
    ...env,
    JARVIS_AGENTS_CONFIG_FILE: writeConfig(file.directory),
    JARVIS_STATE_FILE: file.path,
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(file.path), false);
  assert.ok(
    !result.stderr.includes(file.path) &&
      !result.stderr.includes(env.TELEGRAM_BOT_TOKEN),
  );
});

test('entrada productiva conecta journal y recupera offset entre dos procesos reales', async (t) => {
  const file = temporaryState(t);
  const initialized = await run(
    [stateScript, 'init', file.path],
    file.directory,
  );
  assert.equal(initialized.code, 0);
  const code = `
let polls = 0;
globalThis.fetch = async (input, options) => {
 const url = new URL(input);
 if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected destination');
 const method = url.pathname.split('/').at(-1);
 const body = JSON.parse(options.body);
 const reply = result => new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});
 if (method === 'getMe') return reply({id:12345,is_bot:true,username:'JarvisBot'});
 if (method === 'getUpdates') {
  polls += 1;
  if (process.env.TEST_BOOT === 'first' && polls === 1) return reply([{update_id:700,message:{message_id:5,text:'/agents',from:{id:42,is_bot:false},chat:{id:42,type:'private'}}}]);
  if (body.offset !== 701) throw new Error('Durable offset not recovered');
  process.stdout.write('durable-offset-confirmed\\n'); process.emit('SIGTERM'); return reply([]);
 }
 if (method === 'sendMessage') {
  if (body.text !== 'No tienes agentes de lectura disponibles.') throw new Error('Invalid response');
  process.stdout.write('durable-response-confirmed\\n'); return reply({message_id:1});
 }
 throw new Error('Unexpected Telegram method');
};`;
  const env = {
    ...environment(),
    JARVIS_AGENTS_CONFIG_FILE: writeConfig(file.directory),
    JARVIS_STATE_FILE: file.path,
  };
  const first = await run([...preload(code), botScript], file.directory, {
    ...env,
    TEST_BOOT: 'first',
  });
  assert.equal(first.code, 0);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /durable-response-confirmed/);
  const second = await run([...preload(code), botScript], file.directory, {
    ...env,
    TEST_BOOT: 'second',
  });
  assert.equal(second.code, 0);
  assert.equal(second.stderr, '');
  assert.match(second.stdout, /durable-offset-confirmed/);
  assert.doesNotMatch(second.stdout, /durable-response-confirmed/);
  assert.ok(
    !`${first.stdout}${second.stdout}`.includes(env.TELEGRAM_BOT_TOKEN),
  );
});
