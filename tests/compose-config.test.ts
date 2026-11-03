import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpsEndpointPolicy } from '../src/agents/network-policy.ts';
import { parseTelegramAgentsConfig } from '../src/app/telegram-agents.ts';
import { temporaryState } from './durable-test.fixtures.ts';

test('local Compose setup creates separate keys and valid isolated TLS without Telegram credentials', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'new-installation');
  const result = spawnSync(process.execPath, ['deploy/setup-local.mjs', path], {
    encoding: 'utf8',
    env:
      process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot }
        : {},
  });
  assert.equal(result.status, 0, result.stderr);
  const secrets = join(path, 'secrets');
  const read = (name: string) => readFileSync(join(secrets, name), 'utf8');
  const keys = ['hmac.key', 'backup.key', 'echo-bearer'].map((name) =>
    read(name).trim(),
  );
  assert.equal(new Set(keys).size, 3);
  assert.ok(keys.every((key) => /^[A-Za-z0-9_-]{43}$/.test(key)));
  assert.ok(keys.every((key) => !result.stdout.includes(key)));
  assert.equal(existsSync(join(secrets, 'telegram-token')), false);
  assert.equal(
    readdirSync(secrets).filter((name) => /ca.*key/i.test(name)).length,
    0,
  );
  const ca = new X509Certificate(read('echo-ca.crt'));
  const certificate = new X509Certificate(read('echo-server.crt'));
  assert.equal(ca.ca, true);
  assert.equal(certificate.ca, false);
  assert.ok(certificate.checkIssued(ca));
  assert.ok(certificate.verify(ca.publicKey));
  assert.equal(certificate.checkHost('echo'), 'echo');
  assert.equal(certificate.checkHost('untrusted.invalid'), undefined);
  assert.equal(
    certificate.checkPrivateKey(createPrivateKey(read('echo-server.key'))),
    true,
  );
  assert.ok(Date.parse(certificate.validTo) > Date.now());
  assert.ok(Date.parse(certificate.validTo) <= Date.now() + 31 * 86_400_000);
  const configuration = parseTelegramAgentsConfig(
    JSON.parse(read('agents.json')),
    [42],
  );
  assert.equal(
    configuration.agents[0]?.descriptor.capabilities[0]?.effect,
    'read',
  );
  assert.deepEqual(configuration.allowed_endpoints, [
    { origin: 'https://echo:8443', private_addresses: ['172.30.77.10'] },
  ]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(secrets).mode & 0o777, 0o700);
    for (const name of readdirSync(secrets))
      assert.equal(statSync(join(secrets, name)).mode & 0o777, 0o600);
  }
});

test('local setup refuses existing or relative destinations and never overwrites material', (t) => {
  const files = temporaryState(t);
  const path = join(files.directory, 'new-installation');
  assert.equal(
    spawnSync(process.execPath, ['deploy/setup-local.mjs', path]).status,
    0,
  );
  const key = readFileSync(join(path, 'secrets', 'hmac.key'));
  const retry = spawnSync(process.execPath, ['deploy/setup-local.mjs', path], {
    encoding: 'utf8',
  });
  assert.equal(retry.status, 1);
  assert.deepEqual(readFileSync(join(path, 'secrets', 'hmac.key')), key);
  assert.ok(!retry.stderr.includes(path));
  assert.equal(
    spawnSync(process.execPath, [
      'deploy/setup-local.mjs',
      'relative-disallowed',
    ]).status,
    1,
  );
});

test('Compose exact private-IP rule accepts Echo DNS only and rejects drift/poisoning/metadata', async () => {
  const rules = [
    { origin: 'https://echo:8443', privateAddresses: ['172.30.77.10'] },
  ];
  const policy = new HttpsEndpointPolicy(rules, async (hostname) => {
    assert.equal(hostname, 'echo');
    return [{ address: '172.30.77.10', family: 4 }];
  });
  assert.equal(
    (await policy.resolve('https://echo:8443', new AbortController().signal))
      .address,
    '172.30.77.10',
  );
  for (const addresses of [
    ['172.30.77.11'],
    ['172.30.77.10', '172.30.77.11'],
    ['172.30.77.10', '169.254.169.254'],
    ['127.0.0.1'],
  ]) {
    const poisoned = new HttpsEndpointPolicy(rules, async () =>
      addresses.map((address) => ({ address, family: 4 })),
    );
    await assert.rejects(
      poisoned.resolve('https://echo:8443', new AbortController().signal),
    );
  }
  await assert.rejects(
    policy.resolve('https://another:8443', new AbortController().signal),
  );
});
