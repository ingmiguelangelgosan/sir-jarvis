import assert from 'node:assert/strict';
import { chmodSync, linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigurationError } from '../src/app/config.ts';
import {
  readMountedSecretFile,
  resolveFileSecrets,
} from '../src/infrastructure/file-secrets.ts';
import { temporaryState } from './durable-test.fixtures.ts';

test('mounted secrets resolve only explicit supported names without expansion', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  writeFileSync(path, 'fictitious-not-a-real-secret\n', { mode: 0o600 });
  const environment = {
    TELEGRAM_BOT_TOKEN_FILE: path,
    JARVIS_ECHO_BEARER_FILE: path,
    JARVIS_STATE_FILE: '/data/state.sqlite',
    SOMETHING_FILE: '/unread/unknown',
  };
  const loaded = resolveFileSecrets(environment);
  assert.equal(loaded.TELEGRAM_BOT_TOKEN, 'fictitious-not-a-real-secret');
  assert.equal(loaded.JARVIS_ECHO_BEARER, 'fictitious-not-a-real-secret');
  assert.equal(loaded.TELEGRAM_BOT_TOKEN_FILE, undefined);
  assert.equal(loaded.JARVIS_STATE_FILE, '/data/state.sqlite');
  assert.equal(loaded.SOMETHING_FILE, '/unread/unknown');
  assert.ok(Object.isFrozen(loaded));
  assert.equal(environment.TELEGRAM_BOT_TOKEN_FILE, path);
});

test('mounted secret conflicts, relative/missing/empty paths fail safely', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  writeFileSync(path, 'example', { mode: 0o600 });
  for (const environment of [
    { TELEGRAM_BOT_TOKEN_FILE: path, TELEGRAM_BOT_TOKEN: 'sensitive-canary' },
    { TELEGRAM_BOT_TOKEN_FILE: path, TELEGRAM_BOT_TOKEN: '' },
    { TELEGRAM_BOT_TOKEN_FILE: 'relative' },
    { TELEGRAM_BOT_TOKEN_FILE: '' },
    { TELEGRAM_BOT_TOKEN_FILE: '\\\\host\\share\\credential' },
    { TELEGRAM_BOT_TOKEN_FILE: '//host/share/credential' },
    { TELEGRAM_BOT_TOKEN_FILE: `${path}\0` },
    {
      TELEGRAM_BOT_TOKEN_FILE: join(files.directory, 'missing-sensitive-path'),
    },
    { TELEGRAM_BOT_TOKEN_FILE: files.directory },
  ]) {
    assert.throws(
      () => resolveFileSecrets(environment),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.message === 'No se pudieron cargar los secretos montados.',
    );
  }
});

test('mounted secrets reject oversized, multiline, invalid UTF8 and control data', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  for (const value of [
    '',
    'x'.repeat(4097),
    'canary\nsecond',
    'canary\n\n',
    ' canary',
    'canary\0',
    Buffer.from([0xc3, 0x28]),
  ]) {
    writeFileSync(path, value, { mode: 0o600 });
    assert.throws(() => resolveFileSecrets({ JARVIS_ECHO_BEARER_FILE: path }));
  }
  writeFileSync(path, '42,77\r\n');
  assert.equal(
    resolveFileSecrets({ TELEGRAM_ALLOWED_USER_IDS_FILE: path })
      .TELEGRAM_ALLOWED_USER_IDS,
    '42,77',
  );
});

test('mounted secrets reject hardlinks and symlinks', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  writeFileSync(path, 'example', { mode: 0o600 });
  const hardlink = join(files.directory, 'hardlink');
  linkSync(path, hardlink);
  assert.throws(() =>
    resolveFileSecrets({ TELEGRAM_BOT_TOKEN_FILE: hardlink }),
  );
  if (process.platform !== 'win32') {
    const symbolic = join(files.directory, 'symlink');
    symlinkSync(path, symbolic);
    assert.throws(() =>
      resolveFileSecrets({ TELEGRAM_BOT_TOKEN_FILE: symbolic }),
    );
  }
});

test('read-only Compose secret mounts are supported; writable-by-others denied', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  writeFileSync(path, 'example', { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(path, 0o444);
    assert.equal(
      resolveFileSecrets({ JARVIS_TELEGRAM_AGENT_KEY_FILE: path })
        .JARVIS_TELEGRAM_AGENT_KEY,
      'example',
    );
    chmodSync(path, 0o666);
    assert.throws(() =>
      resolveFileSecrets({ JARVIS_TELEGRAM_AGENT_KEY_FILE: path }),
    );
    chmodSync(path, 0o600);
  } else {
    assert.equal(
      resolveFileSecrets({ JARVIS_TELEGRAM_AGENT_KEY_FILE: path })
        .JARVIS_TELEGRAM_AGENT_KEY,
      'example',
    );
  }
});

test('backup mounted-key helper rejects ordinary files and invalid bounds', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'secret');
  writeFileSync(path, 'example', { mode: 0o600 });
  for (const maximum of [0, -1, 4097, 1.5, 128])
    assert.throws(() => readMountedSecretFile(path, maximum));
});
