import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const { preflightPilot, validatePilotImage } = await import(
  pathToFileURL(resolve('deploy/pilot-preflight.mjs')).href
);
const image = `sha256:${'a'.repeat(64)}`;

function configuration() {
  const common = {
    image,
    pull_policy: 'never',
    user: '1000:1000',
    read_only: true,
    init: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: 384 * 1024 * 1024,
    pids_limit: 64,
    cpus: 0.75,
    volumes: [{ type: 'volume', source: 'pilot_state', target: '/data' }],
  };
  return {
    services: {
      jarvis: {
        ...common,
        environment: {
          JARVIS_AI_MODE: 'disabled',
          JARVIS_TELEGRAM_AGENTS_ENABLED: 'false',
          JARVIS_STATE_FILE: '/data/state/jarvis.sqlite',
          JARVIS_RUNTIME_DIRECTORY: '/data/runtime',
        },
        secrets: [{ source: 'telegram_token' }, { source: 'allowed_users' }],
        networks: { pilot_egress: { ipv4_address: '172.30.78.2' } },
      },
      maintenance: {
        ...common,
        mem_limit: 768 * 1024 * 1024,
        network_mode: 'none',
        secrets: [{ source: 'backup_key' }],
      },
    },
    networks: {
      pilot_egress: {
        enable_ipv6: false,
        ipam: { config: [{ subnet: '172.30.78.0/28' }] },
      },
    },
  };
}
function check(config: unknown, calls: string[][] = []) {
  return preflightPilot(
    'sir-jarvis-pilot',
    { JARVIS_PILOT_IMAGE: image },
    (args: string[]) => {
      calls.push(args);
      return args[0] === 'image' ? `${image}\n` : JSON.stringify(config);
    },
  );
}

test('pilot rejects mutable tags and incomplete image identities before Docker access', () => {
  for (const value of [
    'latest',
    'sir-jarvis:pilot',
    'node:24',
    'sha256:abc',
    `registry/image@${image}`,
    '',
    undefined,
  ])
    assert.throws(() => validatePilotImage(value));
  assert.equal(validatePilotImage(image), image);
});

test('pilot preflight accepts minimal offline-verified configuration without declaring AWS authorization', () => {
  const calls: string[][] = [];
  const result = check(configuration(), calls);
  assert.equal(result.status, 'configuration-checked');
  assert.equal(result.externalAgents, 'disabled');
  assert.equal(result.publicPorts, 0);
  assert.equal(result.awsAuthorization, 'not-granted-by-this-tool');
  assert.equal(
    result.ubuntuEgressFirewall,
    'requires-separate-host-validation',
  );
  assert.ok(
    calls.every((args) => args[0] === 'image' || args.includes('config')),
  );
  assert.ok(
    calls.every(
      (args) =>
        !args.includes('up') && !args.includes('run') && !args.includes('pull'),
    ),
  );
});

test('pilot rejects exposed ports, socket binds, host privileges, paid AI and excessive resources', () => {
  const variations: ((config: ReturnType<typeof configuration>) => void)[] = [
    (value) => {
      Object.assign(value.services.jarvis, {
        ports: [{ target: 80, published: 80 }],
      });
    },
    (value) => {
      value.services.jarvis.volumes = [
        { type: 'bind', source: '/var/run/docker.sock', target: '/data' },
      ];
    },
    (value) => {
      Object.assign(value.services.jarvis, { privileged: true });
    },
    (value) => {
      Object.assign(value.services.jarvis, { network_mode: 'host' });
    },
    (value) => {
      Object.assign(value.services.jarvis, { cap_add: ['SYS_ADMIN'] });
    },
    (value) => {
      value.services.jarvis.environment.JARVIS_AI_MODE = 'enabled';
    },
    (value) => {
      value.services.jarvis.environment.JARVIS_TELEGRAM_AGENTS_ENABLED = 'true';
    },
    (value) => {
      Object.assign(value.services.jarvis.environment, {
        AWS_SECRET_ACCESS_KEY: 'PRIVATE-CANARY',
      });
    },
    (value) => {
      value.services.jarvis.mem_limit = 1024 ** 3;
    },
    (value) => {
      value.services.jarvis.cpus = 2;
    },
    (value) => {
      value.services.jarvis.pids_limit = 1024;
    },
    (value) => {
      value.services.maintenance.network_mode = 'bridge';
    },
    (value) => {
      value.services.jarvis.secrets.push({ source: 'backup_key' });
    },
    (value) => {
      value.networks.pilot_egress.enable_ipv6 = true;
    },
  ];
  for (const variation of variations) {
    const value = configuration();
    variation(value);
    assert.throws(() => check(value));
  }
});

test('pilot rejects unexpected services and image drift without leaking Docker data', () => {
  const value = configuration();
  Object.assign(value.services, { echo: value.services.jarvis });
  assert.throws(() => check(value));
  assert.throws(
    () =>
      preflightPilot(
        'valid',
        { JARVIS_PILOT_IMAGE: image },
        () => 'PRIVATE_DOCKER_CANARY',
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('PRIVATE_DOCKER_CANARY'));
      return true;
    },
  );
  for (const project of [
    '--help',
    'invalid/project',
    'name;echo',
    'UPPER',
    'a'.repeat(64),
  ])
    assert.throws(() =>
      preflightPilot(project, { JARVIS_PILOT_IMAGE: image }, () =>
        assert.fail('No subprocess'),
      ),
    );
});
