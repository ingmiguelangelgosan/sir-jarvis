import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

type Runner = (args: string[]) => string;
interface Inspection {
  readonly status: string;
  readonly heartbeatHealth: string;
  readonly restartCount: number;
  readonly resources: unknown;
  readonly storage: unknown;
  readonly telegramEvents: {
    readonly windowMinutes: number;
    readonly maximumLines: number;
    readonly counts: Readonly<Record<string, number>>;
  };
  readonly limitations: readonly string[];
}
interface PilotInspect {
  aggregateEvents(value: unknown): Readonly<Record<string, number>>;
  summarizeStorage(value: unknown): Readonly<Record<string, unknown>>;
  inspectPilot(project: unknown, run: Runner): Inspection;
}
const inspector = (await import(
  pathToFileURL(resolve('deploy/pilot-inspect.mjs')).href
)) as PilotInspect;

const id = 'a'.repeat(64);
const privateCanary = 'PRIVATE_CONTENT_MUST_NOT_APPEAR';
const storage = () => ({
  databaseBytes: 53248,
  walBytes: 0,
  availableBytes: 1_000_000,
  recovery: { status: 'normal', restoreId: privateCanary },
  executions: { pending: 2, uncertain: 1, privateSubject: privateCanary },
  actions: { delivered: 4, privateMessage: privateCanary },
  review: [{ requestId: privateCanary, subject_ref: privateCanary }],
  token: privateCanary,
});

function fakeDocker(overrides: Partial<Record<string, string>> = {}) {
  const calls: string[][] = [];
  const run: Runner = (args) => {
    calls.push(args);
    if (args[0] === 'ps') return overrides.ps ?? id;
    if (args[0] === 'inspect') {
      if (args[2] === '{{.State.Status}}') return overrides.status ?? 'running';
      if (args[2] === '{{.RestartCount}}') return overrides.restartCount ?? '1';
      return overrides.health ?? 'healthy';
    }
    if (args[0] === 'stats')
      return (
        overrides.stats ??
        JSON.stringify({
          CPUPerc: '0.25%',
          MemUsage: '28MiB / 384MiB',
          PIDs: '8',
          Name: privateCanary,
          unrelated: privateCanary,
        })
      );
    if (args[0] === 'exec')
      return overrides.storage ?? JSON.stringify(storage());
    if (args[0] === 'logs')
      return overrides.logs ?? `telegram-started\n${privateCanary}\n`;
    return assert.fail('Unexpected local Docker operation');
  };
  return { run, calls };
}

test('pilot inspection scopes Docker to one exact project/service and emits only safe summaries', () => {
  const fake = fakeDocker();
  const result = inspector.inspectPilot('jarvis-pilot-test', fake.run);
  assert.equal(result.status, 'running');
  assert.equal(result.restartCount, 1);
  assert.equal(result.heartbeatHealth, 'healthy');
  assert.deepEqual(result.resources, {
    cpu: '0.25%',
    memory: '28MiB / 384MiB',
    pids: '8',
  });
  assert.deepEqual(fake.calls[0], [
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=jarvis-pilot-test',
    '--filter',
    'label=com.docker.compose.service=jarvis',
  ]);
  assert.ok(!JSON.stringify(result).includes(privateCanary));
  for (const call of fake.calls.filter((entry) => entry[0] === 'inspect')) {
    assert.equal(call.length, 4);
    assert.equal(call[1], '--format');
    assert.ok(!call[2]?.includes('Config.Env'));
    assert.ok(!call[2]?.includes('Mounts'));
    assert.equal(call[3], id);
  }
  const query = fake.calls.find((entry) => entry[0] === 'exec')?.at(-1);
  assert.ok(query?.includes('readOnly:true'));
  assert.ok(query?.includes('PRAGMA query_only=ON'));
  assert.ok(!query?.includes('new SqliteStateStore'));
});

test('invalid project names are rejected before invoking Docker', () => {
  for (const project of [
    '',
    '--all',
    'jarvis;touch unwanted',
    'project\nsecond',
    'UPPERCASE',
    'x'.repeat(64),
    null,
    42,
  ]) {
    let calls = 0;
    assert.throws(() =>
      inspector.inspectPilot(project, () => {
        calls += 1;
        return '';
      }),
    );
    assert.equal(calls, 0);
  }
});

test('missing, ambiguous or malformed container identity fails closed before any inspect or exec', () => {
  for (const ps of ['', `${id}\n${'b'.repeat(64)}`, '--privileged', 'abc']) {
    const fake = fakeDocker({ ps });
    assert.throws(() => inspector.inspectPilot('jarvis-pilot', fake.run));
    assert.equal(fake.calls.length, 1);
  }
});

test('event aggregation counts only fixed log events and never returns raw conversation lines', () => {
  const result = inspector.aggregateEvents(
    [
      'telegram-started',
      'telegram-poll-retry',
      'telegram-poll-retry',
      `telegram-started ${privateCanary}`,
      privateCanary,
      JSON.stringify({ event: 'telegram-started', token: privateCanary }),
      'telegram-delivery-unconfirmed',
    ].join('\n'),
  );
  assert.equal(result['telegram-started'], 1);
  assert.equal(result['telegram-poll-retry'], 2);
  assert.equal(result['telegram-delivery-unconfirmed'], 1);
  assert.equal(Object.keys(result).length, 6);
  assert.ok(!JSON.stringify(result).includes(privateCanary));
  assert.throws(() =>
    inspector.aggregateEvents('x'.repeat(2 * 1024 * 1024 + 1)),
  );
  assert.throws(() => inspector.aggregateEvents({ secret: privateCanary }));
});

test('state summary strips restore/actor/request references and rejects invalid numeric metadata', () => {
  const result = inspector.summarizeStorage(storage());
  assert.equal(result.recovery, 'normal');
  assert.equal(result.databaseBytes, 53248);
  assert.equal(result.dataFilesystemAvailableBytes, 1_000_000);
  assert.deepEqual(result.executions, {
    reserved: 0,
    started: 0,
    pending: 2,
    uncertain: 1,
    completed: 0,
    failed: 0,
    'not-started': 0,
  });
  assert.ok(!JSON.stringify(result).includes(privateCanary));
  for (const value of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      inspector.summarizeStorage({ ...storage(), databaseBytes: value }),
    );
    assert.throws(() =>
      inspector.summarizeStorage({
        ...storage(),
        executions: { pending: value },
      }),
    );
  }
  assert.throws(() =>
    inspector.summarizeStorage({
      ...storage(),
      recovery: { status: privateCanary },
    }),
  );
});

test('hostile Docker state and resource fields reject without reflecting their contents', () => {
  for (const overrides of [
    { status: privateCanary },
    { health: privateCanary },
    { restartCount: privateCanary },
    {
      stats: JSON.stringify({
        CPUPerc: privateCanary,
        MemUsage: '28MiB / 384MiB',
        PIDs: '8',
      }),
    },
    {
      stats: JSON.stringify({
        CPUPerc: '0.25%',
        MemUsage: privateCanary,
        PIDs: '8',
      }),
    },
    { storage: JSON.stringify({ ...storage(), databaseBytes: -1 }) },
  ]) {
    const fake = fakeDocker(overrides);
    assert.throws(
      () => inspector.inspectPilot('jarvis-pilot', fake.run),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(privateCanary),
    );
  }
});

test('a stopped container causes no exec/stats and exposes connectivity/instrumentation limits', () => {
  const fake = fakeDocker({ status: 'exited', health: 'unhealthy' });
  const result = inspector.inspectPilot('jarvis-pilot', fake.run);
  assert.equal(result.storage, null);
  assert.equal(result.resources, null);
  assert.equal(result.status, 'exited');
  assert.ok(
    fake.calls.every((entry) => !['exec', 'stats'].includes(entry[0]!)),
  );
  assert.ok(
    result.limitations.includes(
      'heartbeat-is-not-a-telegram-connectivity-proof',
    ),
  );
  assert.ok(
    result.limitations.includes(
      'gateway-latency-and-remote-errors-not-instrumented',
    ),
  );
  assert.ok(
    result.limitations.includes(
      'billing-and-credit-usage-require-separate-authorized-review',
    ),
  );
  assert.equal(result.telegramEvents.maximumLines, 1000);
  assert.equal(result.telegramEvents.windowMinutes, 60);
});
