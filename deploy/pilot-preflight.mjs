import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const failure = () =>
  new Error(
    'Pilot preflight rejected the image or configuration. No deployment was performed.',
  );

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw failure();
  return result.stdout;
}

/** An explicit local image ID is required: neither a moving tag nor an unresolved registry name. */
export function validatePilotImage(image) {
  if (typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw failure();
  return image;
}

export function preflightPilot(
  project,
  environment = process.env,
  run = docker,
) {
  if (
    typeof project !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)
  )
    throw failure();
  const image = validatePilotImage(environment.JARVIS_PILOT_IMAGE);
  const inspected = run([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image,
  ]).trim();
  if (inspected !== image) throw failure();
  const config = JSON.parse(
    run([
      'compose',
      '-p',
      project,
      '-f',
      'deploy/compose.pilot.yaml',
      '--profile',
      'tools',
      'config',
      '--format',
      'json',
    ]),
  );
  const services = config.services;
  if (
    !services ||
    Object.keys(services).sort().join(',') !== 'jarvis,maintenance'
  )
    throw failure();
  for (const name of ['jarvis', 'maintenance']) {
    const service = services[name];
    if (
      service.image !== image ||
      service.build ||
      service.pull_policy !== 'never' ||
      service.user !== '1000:1000' ||
      !service.read_only ||
      !service.init ||
      service.privileged ||
      service.ports?.length ||
      service.network_mode === 'host' ||
      service.pid === 'host' ||
      service.devices?.length ||
      service.cap_add?.length ||
      !service.cap_drop?.includes('ALL') ||
      !service.security_opt?.includes('no-new-privileges:true') ||
      service.mem_limit > (name === 'jarvis' ? 384 : 768) * 1024 * 1024 ||
      service.pids_limit > 64 ||
      Number(service.cpus) > 0.75
    )
      throw failure();
    if (!service.mem_limit || !service.pids_limit || !service.cpus)
      throw failure();
    if (
      service.volumes.some(
        (volume) =>
          volume.type !== 'volume' ||
          !['/data', '/backups', '/recovery'].includes(volume.target),
      )
    )
      throw failure();
  }
  const jarvis = services.jarvis;
  if (
    String(jarvis.environment.JARVIS_TELEGRAM_AGENTS_ENABLED) !== 'false' ||
    jarvis.environment.JARVIS_AI_MODE !== 'disabled' ||
    jarvis.environment.JARVIS_STATE_FILE !== '/data/state/jarvis.sqlite' ||
    jarvis.environment.JARVIS_RUNTIME_DIRECTORY !== '/data/runtime'
  )
    throw failure();
  if (
    Object.keys(jarvis.environment).some((key) =>
      /AWS|BEARER|AGENT_KEY|NODE_OPTIONS|PROXY|TOKEN$/.test(key),
    )
  )
    throw failure();
  const secrets = (service) =>
    service.secrets
      .map((secret) => secret.source)
      .sort()
      .join(',');
  if (
    secrets(jarvis) !== 'allowed_users,telegram_token' ||
    secrets(services.maintenance) !== 'backup_key' ||
    services.maintenance.network_mode !== 'none'
  )
    throw failure();
  const network = config.networks?.pilot_egress;
  if (
    !network ||
    network.enable_ipv6 !== false ||
    network.ipam?.config?.[0]?.subnet !== '172.30.78.0/28' ||
    jarvis.networks?.pilot_egress?.ipv4_address !== '172.30.78.2'
  )
    throw failure();
  // This proves local configuration, NOT that Ubuntu forwarding/egress rules exist.
  return {
    status: 'configuration-checked',
    image,
    externalAgents: 'disabled',
    paidServices: 'disabled',
    publicPorts: 0,
    ubuntuEgressFirewall: 'requires-separate-host-validation',
    awsAuthorization: 'not-granted-by-this-tool',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) throw failure();
    process.stdout.write(
      `${JSON.stringify(preflightPilot(process.argv[2]))}\n`,
    );
  } catch {
    process.stderr.write(`${failure().message}\n`);
    process.exitCode = 1;
  }
}
