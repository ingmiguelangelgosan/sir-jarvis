import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const {
  BOT_IP,
  CHAIN_HOST,
  CHAIN_NS4,
  CHAIN_NS6,
  DNS_SERVER,
  HOSTNAME,
  MAX_LEASE_MS,
  SET_HOST,
  SET_NS,
  composeOverride,
  denyRules,
  firewallRules,
  policyHash,
  publicAddresses,
  validatePermit,
  validatePolicy,
} = await import(pathToFileURL(resolve('deploy/egress/policy.mjs')).href);

const clock = 1_800_000_000_000;
const addresses = ['149.154.166.110', '91.108.56.130'];
const challenge = 'a'.repeat(64);
const fingerprint = 'b'.repeat(64);

function policy(now = clock) {
  return {
    version: 1,
    hostname: 'api.telegram.org',
    resolver: '172.26.0.2',
    addresses: [...addresses],
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

function permit(now = clock) {
  return {
    challenge,
    policyHash: fingerprint,
    issuedAt: now,
    expiresAt: now + 60_000,
  };
}

test('egress permits only bounded unique literal public IPv4 addresses without mutating review data', () => {
  const source = [...addresses].reverse();
  const original = [...source];
  assert.deepEqual(publicAddresses(source), [...addresses].sort());
  assert.deepEqual(source, original);
  assert.deepEqual(publicAddresses(['149.154.166.110']), ['149.154.166.110']);
  assert.throws(() => publicAddresses([]));
  assert.throws(() => publicAddresses(['149.154.166.110', '149.154.166.110']));
  assert.throws(() =>
    publicAddresses(Array.from({ length: 9 }, (_, i) => `8.8.8.${i + 1}`)),
  );
});

test('egress rejects private, metadata, link-local, reserved, multicast and every IPv6 form', () => {
  for (const address of [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '100.127.255.255',
    '127.0.0.1',
    '127.0.0.11',
    '169.254.169.254',
    '169.254.170.2',
    '172.16.0.1',
    '172.26.0.2',
    '172.30.78.2',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:149.154.166.110',
    'fe80::1',
    'fd00::1',
    '2001:4860:4860::8888',
  ]) {
    assert.throws(
      () => publicAddresses([address]),
      `Unexpected approval: ${address}`,
    );
    assert.throws(() =>
      validatePolicy(
        { ...policy(), addresses: [addresses[0], address] },
        clock,
      ),
    );
  }
});

test('malformed addresses and command-shaped data never reach an executable firewall plan', () => {
  for (const address of [
    'api.telegram.org',
    '149.154.166.110/32',
    '149.154.166.110:443',
    '149.154.166.110\n-A FORWARD -j ACCEPT',
    '149.154.166.110; echo private',
    '$(curl private.invalid)',
    '--flush',
    '149.154.166.110 ',
    '149.154.166.011',
    '0x959aa66e',
    149154166110,
    null,
    { address: '149.154.166.110' },
  ]) {
    assert.throws(() => publicAddresses([address]));
    assert.throws(() => firewallRules([address]));
  }
  for (const value of [undefined, null, {}, addresses.join(','), [undefined]])
    assert.throws(() => publicAddresses(value));
});

test('policy runtime validation rejects unknown fields, versions and crossed hostname/resolver', () => {
  for (const value of [
    null,
    [],
    { ...policy(), version: 2 },
    { ...policy(), version: '1' },
    { ...policy(), hostname: 'attacker.invalid' },
    { ...policy(), hostname: 'api.telegram.org.' },
    { ...policy(), resolver: '1.1.1.1' },
    { ...policy(), resolver: '172.26.0.2:53' },
    { ...policy(), enabled: true },
    { ...policy(), allow_private: true },
    { ...policy(), addresses: [] },
    { ...policy(), addresses: [addresses[0], addresses[0]] },
  ])
    assert.throws(() => validatePolicy(value, clock));
  const missing: Partial<ReturnType<typeof policy>> = policy();
  delete missing.resolver;
  assert.throws(() => validatePolicy(missing, clock));
});

test('policy expiry and clock validation fail closed at deadline, on rollback and beyond 15 minutes', () => {
  const value = policy();
  assert.equal(MAX_LEASE_MS, 900_000);
  assert.ok(validatePolicy(value, value.expiresAt - 1));
  for (const now of [
    value.createdAt - 1,
    value.expiresAt,
    value.expiresAt + 1,
    NaN,
    Infinity,
    1.5,
    -1,
  ])
    assert.throws(() => validatePolicy(value, now));
  for (const changes of [
    { createdAt: -1 },
    { createdAt: clock + 1 },
    { expiresAt: clock },
    { expiresAt: clock - 1 },
    { expiresAt: clock + MAX_LEASE_MS + 1 },
    { createdAt: clock + 0.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: String(clock + 5000) },
  ])
    assert.throws(() => validatePolicy({ ...value, ...changes }, clock));
  assert.ok(
    validatePolicy({ ...value, expiresAt: clock + MAX_LEASE_MS }, clock),
  );
});

test('validated review is immutable and its fingerprint distinguishes changed addresses or lease', () => {
  const input = policy();
  const accepted = validatePolicy(input, clock);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.addresses));
  assert.throws(() => accepted.addresses.push('8.8.8.8'));
  input.addresses[0] = '8.8.8.8';
  assert.deepEqual(accepted.addresses, [...addresses].sort());
  const hash = policyHash(accepted);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(policyHash(accepted), hash);
  assert.notEqual(policyHash(validatePolicy(input, clock)), hash);
  assert.notEqual(
    policyHash(
      validatePolicy({ ...policy(), expiresAt: clock + 30_000 }, clock),
    ),
    hash,
  );
});

test('firewall plan touches only owned chains and never creates a global established-connection bypass', () => {
  const rules = firewallRules(addresses);
  assert.deepEqual(rules.sets, { host: SET_HOST, namespace: SET_NS });
  assert.match(
    rules.host,
    new RegExp(
      `-s ${BOT_IP.replaceAll('.', '\\.')}/32 -p tcp --dport 443 -m set --match-set ${SET_HOST} dst -j ACCEPT`,
    ),
  );
  for (const [plan, chain] of [
    [rules.host, CHAIN_HOST],
    [rules.namespace4, CHAIN_NS4],
    [rules.namespace6, CHAIN_NS6],
  ] as const) {
    assert.equal(plan.trim().split('\n').at(-1), 'COMMIT');
    assert.match(plan, new RegExp(`-A ${chain} -j DROP\\nCOMMIT`));
    assert.ok(
      !/ESTABLISHED|RELATED|--ctstate|\bINPUT\b|\bFORWARD\b|DOCKER-USER|ufw|--flush|--policy/.test(
        plan,
      ),
    );
    for (const line of plan
      .split('\n')
      .filter((line: string) => /^-[AFX]/.test(line)))
      assert.equal(line.split(' ')[1], chain);
  }
});

test('namespace plan blocks all non-approved traffic before DNS DNAT and denies every IPv6 output', () => {
  const rules = firewallRules(addresses);
  assert.match(rules.namespace4, /^\*raw\n/);
  assert.match(
    rules.namespace4,
    new RegExp(`--dport 443 -m set --match-set ${SET_NS} dst -j RETURN`),
  );
  assert.equal(
    rules.namespace4
      .split('\n')
      .filter((line: string) => line.includes('-j RETURN')).length,
    1,
  );
  assert.ok(
    !/--dport 53|--sport 53|127\.0\.0\.11|172\.26\.0\.2/.test(rules.namespace4),
  );
  assert.match(rules.namespace6, /^\*raw\n/);
  assert.ok(!/ACCEPT|RETURN|--dport/.test(rules.namespace6));
  assert.match(rules.namespace6, new RegExp(`-A ${CHAIN_NS6} -j DROP`));
});

test('deny plan cannot retain an expired allowlist or grant any forwarding exception', () => {
  const deny = denyRules();
  assert.match(deny, new RegExp(`-A ${CHAIN_HOST} -j DROP\\nCOMMIT`));
  assert.ok(
    !/ACCEPT|RETURN|--match-set|--dport|ESTABLISHED|RELATED|\bINPUT\b|\bFORWARD\b/.test(
      deny,
    ),
  );
  assert.deepEqual(
    deny.split('\n').filter((line: string) => line.startsWith('-F')),
    [`-F ${CHAIN_HOST}`],
  );
});

test('Compose override pins reviewed hostname and disables DNS forwarding/restart without granting container capabilities', () => {
  const value = policy(Date.now());
  const override = composeOverride(
    value,
    '/opt/sir-jarvis/release',
    '/run/jarvis-egress/public',
  );
  const bot = override.services.jarvis;
  assert.equal(bot.restart, 'no');
  assert.deepEqual(bot.dns, ['127.0.0.1']);
  assert.deepEqual(bot.extra_hosts, [
    `${HOSTNAME}=${[...addresses].sort()[0]}`,
  ]);
  assert.deepEqual(bot.command, ['node', '/egress/gate.mjs']);
  assert.equal(bot.volumes.length, 2);
  assert.ok(
    bot.volumes.every(
      (entry: { read_only: boolean }) => entry.read_only === true,
    ),
  );
  assert.deepEqual(
    bot.volumes.map((entry: { target: string }) => entry.target).sort(),
    ['/egress/gate.mjs', '/run/jarvis-egress'],
  );
  for (const forbidden of [
    'privileged',
    'cap_add',
    'network_mode',
    'pid',
    'ports',
    'environment',
  ])
    assert.equal(bot[forbidden], undefined);
  assert.equal(JSON.stringify(override).includes(DNS_SERVER), false);
  assert.throws(() =>
    composeOverride(
      { ...value, expiresAt: value.createdAt },
      '/release',
      '/public',
    ),
  );
});

test('permit is bound to one fresh challenge and cannot be widened by extra fields', () => {
  const value = permit();
  assert.equal(validatePermit(value, challenge, clock).policyHash, fingerprint);
  for (const replacement of ['c'.repeat(64), '', undefined, `${challenge}\n`])
    assert.throws(() => validatePermit(value, replacement, clock));
  for (const changes of [
    { policyHash: 'invalid' },
    { policyHash: 'B'.repeat(64) },
    { challenge: 'c'.repeat(64) },
    { allow: true },
    { addresses: ['8.8.8.8'] },
  ])
    assert.throws(() =>
      validatePermit({ ...value, ...changes }, challenge, clock),
    );
  assert.throws(() =>
    validatePermit(
      { challenge, expiresAt: clock + 5000, issuedAt: clock },
      challenge,
      clock,
    ),
  );
});

test('permit rejects malformed clocks, expired deadlines and excessive duration instead of reusing an old approval', () => {
  const value = permit();
  assert.ok(validatePermit(value, challenge, value.expiresAt - 1));
  for (const now of [
    value.issuedAt - 1,
    value.expiresAt,
    value.expiresAt + 1,
    NaN,
    Infinity,
    1.5,
    -1,
  ])
    assert.throws(() => validatePermit(value, challenge, now));
  for (const changes of [
    { issuedAt: -1 },
    { issuedAt: clock + 1 },
    { issuedAt: clock + 0.5 },
    { expiresAt: clock },
    { expiresAt: clock - 1 },
    { expiresAt: clock + MAX_LEASE_MS + 1 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: String(clock + 1000) },
  ])
    assert.throws(() =>
      validatePermit({ ...value, ...changes }, challenge, clock),
    );
  assert.throws(() =>
    validatePermit({ ...value, issuedAt: -1, expiresAt: 100 }, challenge, 0),
  );
});
