import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EnvironmentAgentCredentials } from '../src/agents/credentials.ts';
import { AgentGatewayError } from '../src/agents/errors.ts';
import { HttpsEndpointPolicy } from '../src/agents/network-policy.ts';

const origin = 'https://agent.example.invalid';
const signal = () => new AbortController().signal;
const denied = (code: string) => (error: unknown) =>
  error instanceof AgentGatewayError && error.code === code;

test('política HTTPS solo resuelve orígenes exactos configurados, sin red real', async () => {
  let lookups = 0;
  const policy = new HttpsEndpointPolicy([{ origin }], async () => {
    lookups += 1;
    return [{ address: '8.8.8.8', family: 4 }];
  });
  for (const other of [
    'https://other.example.invalid',
    `${origin}:444`,
    'http://agent.example.invalid',
  ])
    await assert.rejects(
      policy.resolve(other, signal()),
      (error: unknown) => error instanceof AgentGatewayError,
    );
  assert.equal(lookups, 0);
  assert.deepEqual(await policy.resolve(origin, signal()), {
    origin,
    hostname: 'agent.example.invalid',
    port: 443,
    address: '8.8.8.8',
    family: 4,
  });
  assert.equal(lookups, 1);
});

test('DNS se revalida en cada intento y una respuesta mixta falla cerrada', async () => {
  let lookups = 0;
  const policy = new HttpsEndpointPolicy([{ origin }], async () => {
    lookups += 1;
    return lookups === 1
      ? [{ address: '8.8.8.8', family: 4 }]
      : [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ];
  });
  await policy.resolve(origin, signal());
  await assert.rejects(policy.resolve(origin, signal()), denied('FORBIDDEN'));
  assert.equal(lookups, 2);
});

for (const address of [
  '0.0.0.0',
  '10.1.2.3',
  '100.100.100.200',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.1.2',
  '192.0.0.9',
  '192.0.2.1',
  '192.31.196.1',
  '192.52.193.1',
  '192.88.99.1',
  '192.168.0.1',
  '192.175.48.1',
  '198.18.0.1',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '255.255.255.255',
  '168.63.129.16',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:8.8.8.8',
  '64:ff9b::7f00:1',
  '100::1',
  '2001::1',
  '2001:db8::1',
  '2002:7f00:1::',
  '2620:4f:8000::1',
  '3fff::1',
  'fc00::1',
  'fd00:ec2::254',
  'fd00:ec2::23',
  'fd20:ce::254',
  'fe80::1',
  'ff02::1',
  'fe80::1%eth0',
])
  test(`SSRF bloquea ${address} aunque el hostname esté autorizado`, async () => {
    const policy = new HttpsEndpointPolicy([{ origin }], async () => [
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    await assert.rejects(policy.resolve(origin, signal()), denied('FORBIDDEN'));
  });

test('excepción privada requiere IP exacta por origen y conserva bloqueo de metadata', async () => {
  for (const address of ['10.4.3.2', 'fd12:3456::10']) {
    const policy = new HttpsEndpointPolicy(
      [{ origin, privateAddresses: [address] }],
      async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    );
    assert.equal((await policy.resolve(origin, signal())).address, address);
  }
  const deniedPolicy = new HttpsEndpointPolicy(
    [{ origin, privateAddresses: ['10.4.3.2'] }],
    async () => [{ address: '10.4.3.3', family: 4 }],
  );
  await assert.rejects(
    deniedPolicy.resolve(origin, signal()),
    denied('FORBIDDEN'),
  );
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    'fd00:ec2::23',
    'fd00:0ec2:0000::0254',
    'fd20:ce::254',
    '8.8.8.8',
  ])
    assert.throws(
      () => new HttpsEndpointPolicy([{ origin, privateAddresses: [address] }]),
      denied('INVALID_CONFIGURATION'),
    );
});

test('IPv6 público válido y privado exacto normalizado funcionan sin relajar rangos', async () => {
  const address = '2606:4700:4700::1111';
  const policy = new HttpsEndpointPolicy([{ origin }], async () => [
    { address, family: 6 },
  ]);
  assert.equal((await policy.resolve(origin, signal())).address, address);
  const privatePolicy = new HttpsEndpointPolicy(
    [{ origin, privateAddresses: ['fd12:3456::10'] }],
    async () => [{ address: 'fd12:3456:0:0:0:0:0:10', family: 6 }],
  );
  assert.equal((await privatePolicy.resolve(origin, signal())).family, 6);
});

test('IP literal no dispara DNS ni admite variantes de loopback', async () => {
  const urls = [
    'https://127.0.0.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://[::1]',
  ];
  for (const value of urls) {
    const policy = new HttpsEndpointPolicy([{ origin: value }], async () => {
      throw new Error('No DNS expected');
    });
    await assert.rejects(policy.resolve(value, signal()), denied('FORBIDDEN'));
  }
});

test('destinos con usuario, ruta, query, fragmento, metadata o alias locales se rechazan', () => {
  for (const value of [
    'http://echo.test',
    'https://user:password@echo.test',
    'https://echo.test/path',
    'https://echo.test?x=1',
    'https://echo.test#fragment',
    'https://localhost',
    'https://x.localhost',
    'https://metadata.google.internal',
    'https://instance-data.ec2.internal',
    'https://echo.test.',
  ])
    assert.throws(
      () => new HttpsEndpointPolicy([{ origin: value }]),
      denied('INVALID_CONFIGURATION'),
    );
  assert.throws(
    () => new HttpsEndpointPolicy([{ origin }, { origin }]),
    denied('INVALID_CONFIGURATION'),
  );
});

test('DNS inválido, vacío, sobredimensionado y con familia cruzada falla cerrado', async () => {
  for (const answers of [
    [],
    [{ address: '8.8.8.8', family: 6 }],
    [{ address: 'invalid', family: 4 }],
    Array.from({ length: 65 }, () => ({ address: '8.8.8.8', family: 4 })),
  ]) {
    const policy = new HttpsEndpointPolicy([{ origin }], async () => answers);
    await assert.rejects(policy.resolve(origin, signal()), denied('FORBIDDEN'));
  }
});

test('DNS cancelado y errores internos no divulgan su contenido', async () => {
  const controller = new AbortController();
  const policy = new HttpsEndpointPolicy([{ origin }], async () => {
    controller.abort();
    return [{ address: '8.8.8.8', family: 4 }];
  });
  await assert.rejects(
    policy.resolve(origin, controller.signal),
    denied('CANCELLED'),
  );
  const broken = new HttpsEndpointPolicy([{ origin }], async () => {
    throw new Error('private resolver details');
  });
  await assert.rejects(broken.resolve(origin, signal()), (error: unknown) => {
    assert.ok(error instanceof AgentGatewayError);
    assert.equal(error.code, 'UNAVAILABLE');
    assert.ok(!String(error.stack).includes('private resolver details'));
    return true;
  });
});

test('resolver server-only usa referencia explícita y admite rotación sin guardar el token', async () => {
  let token = 'runtime-test-value';
  let reads = 0;
  const resolver = new EnvironmentAgentCredentials(
    { request: 'JARVIS_TEST_TOKEN' },
    (name) => {
      reads += 1;
      assert.equal(name, 'JARVIS_TEST_TOKEN');
      return token;
    },
  );
  assert.equal(await resolver.resolve('request', signal()), token);
  token = 'rotated-runtime-value';
  assert.equal(await resolver.resolve('request', signal()), token);
  await assert.rejects(
    resolver.resolve('unknown', signal()),
    denied('INVALID_CONFIGURATION'),
  );
  assert.equal(reads, 2);
  assert.equal(JSON.stringify(resolver), '{}');
});

test('resolver rechaza configuración, tokens inválidos y abort sin leer ambiente', async () => {
  assert.throws(
    () => new EnvironmentAgentCredentials({ request: 'bad-variable' }),
    denied('INVALID_CONFIGURATION'),
  );
  for (const token of [
    undefined,
    '',
    'white space',
    'line\r\nbreak',
    'x'.repeat(4097),
  ]) {
    const resolver = new EnvironmentAgentCredentials(
      { request: 'JARVIS_TEST_TOKEN' },
      () => token,
    );
    await assert.rejects(
      resolver.resolve('request', signal()),
      denied('INVALID_CONFIGURATION'),
    );
  }
  const controller = new AbortController();
  controller.abort();
  const resolver = new EnvironmentAgentCredentials(
    { request: 'JARVIS_TEST_TOKEN' },
    () => {
      throw new Error('Must not read');
    },
  );
  await assert.rejects(
    resolver.resolve('request', controller.signal),
    denied('CANCELLED'),
  );
});
