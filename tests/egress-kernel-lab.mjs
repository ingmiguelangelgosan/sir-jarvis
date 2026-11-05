import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

// Explicit privileged kernel integration test, separate from ordinary CI.
// The privileged test container has private PID/network/mount namespaces, no
// host bind mounts, no Docker socket and no operator credentials. Its rules
// affect only its own namespace and child namespaces. The DNS fixture and HTTPS
// peers are local; public-looking addresses are assigned inside that lab only.
const project = `jarvis-egress-lab-${randomBytes(6).toString('hex')}`;
const image = `sir-jarvis-egress-lab:${project}`;
const network = `${project}-private`;
const dns = `${project}-dns`;
const kernel = `${project}-kernel`;
const started = performance.now();
let stage = 'docker-availability';
let networkCreated = false;

function docker(args, timeout = 30_000, required = true) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const kernelStage =
    /Isolated egress kernel lab failed at ([a-z0-9-]+)\./.exec(
      result.stderr ?? '',
    );
  if (kernelStage) stage = kernelStage[1];
  if (required)
    assert.ok(
      result.status === 0 && !result.error,
      `Kernel lab command failed at ${stage}.`,
    );
  return result;
}

try {
  assert.equal(process.argv.length, 2);
  stage = 'local-docker-context';
  const localEndpoint = (value) =>
    typeof value === 'string' && /^(?:unix:\/\/|npipe:\/\/)/.test(value);
  if (process.env.DOCKER_HOST)
    assert.ok(localEndpoint(process.env.DOCKER_HOST));
  const endpoint = docker([
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]).stdout.trim();
  assert.ok(localEndpoint(endpoint));
  stage = 'docker-availability';
  docker(['info', '--format', '{{.ServerVersion}}'], 10_000);
  stage = 'pinned-isolated-test-image';
  docker(
    ['build', '--pull', '-f', 'deploy/egress-lab/Dockerfile', '-t', image, '.'],
    180_000,
  );
  stage = 'internal-test-network';
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  stage = 'local-dns-fixture';
  docker([
    'run',
    '-d',
    '--name',
    dns,
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=4m',
    image,
    'python3',
    '/lab/dns-fixture.py',
  ]);
  const dnsIp = docker([
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    dns,
  ]).stdout.trim();
  assert.equal(isIP(dnsIp), 4);
  stage = 'real-kernel-rules-dns-tls-timeout';
  const output = docker(
    [
      'run',
      '--name',
      kernel,
      '--privileged',
      '--network',
      network,
      '--dns',
      dnsIp,
      '--pids-limit',
      '128',
      '--memory',
      '384m',
      '--env',
      `LAB_DNS_IP=${dnsIp}`,
      image,
    ],
    120_000,
  ).stdout;
  const lines = output.trim().split('\n');
  const report = JSON.parse(
    lines.find((line) => line.startsWith('{"status":')) ?? '{}',
  );
  assert.equal(report.status, 'passed-isolated-linux-kernel');
  assert.ok(report.scenarios.length >= 9);
  stage = 'container-restart-reapplies-private-kernel-policy';
  const restartedOutput = docker(['start', '-a', kernel], 120_000).stdout;
  const restarted = JSON.parse(
    restartedOutput
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{"status":')) ?? '{}',
  );
  assert.equal(restarted.status, 'passed-isolated-linux-kernel');
  assert.deepEqual(restarted.scenarios, report.scenarios);
  stage = 'dns-no-forwarding-evidence';
  const queries = Number(
    docker(['exec', dns, 'cat', '/tmp/dns-count']).stdout.trim(),
  );
  assert.equal(queries, 2); // One baseline per boot, zero after either namespace guard.
  stage = 'namespace-isolation-check';
  const hostMode = docker([
    'inspect',
    '--format',
    '{{.HostConfig.PidMode}} {{.HostConfig.NetworkMode}} {{len .Mounts}}',
    kernel,
  ]).stdout.trim();
  assert.ok(!hostMode.includes('host') && hostMode.endsWith(' 0'));
  process.stdout.write(
    `${JSON.stringify({
      ...report,
      scenarios: [
        ...report.scenarios,
        'container-restart-recreates-namespaces-and-reapplies-policy',
      ],
      project,
      dnsQueriesBeforeGuard: 2,
      dnsQueriesAfterGuard: 0,
      containerBootsTested: 2,
      publicNetworkCallsDuringTests: 0,
      durationMs: Math.round(performance.now() - started),
      targetHostVersionsValidated: false,
      limitations: [
        'isolated-container-kernel-not-aws-host',
        'no-real-docker-daemon-or-ubuntu-reboot',
        'host-rule-jumps-are-installed-only-in-the-lab-router',
      ],
    })}\n`,
  );
} catch {
  process.stderr.write(
    `Egress kernel lab failed or unavailable at ${stage}.\n`,
  );
  process.exitCode = 1;
} finally {
  // Only names generated above, never host resources or another project's data.
  docker(['rm', '-f', kernel, dns], 15_000, false);
  if (
    networkCreated &&
    docker(['network', 'rm', network], 15_000, false).status !== 0
  ) {
    process.stderr.write(
      'Isolated egress lab network cleanup requires inspection.\n',
    );
    process.exitCode = 1;
  }
}
