import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const events = [
  'telegram-started',
  'telegram-stopped',
  'telegram-poll-retry',
  'telegram-send-rejected',
  'telegram-delivery-unconfirmed',
  'telegram-agent-capacity',
];
const safeError = () =>
  new Error('Local pilot inspection failed; no raw Docker output was emitted.');

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    // No shell, no command interpolation, no AWS clients or public network probes.
  });
  if (result.status !== 0 || result.error) throw safeError();
  return result.stdout;
}

export function aggregateEvents(output) {
  if (typeof output !== 'string' || output.length > 2 * 1024 * 1024)
    throw safeError();
  const counts = Object.fromEntries(events.map((event) => [event, 0]));
  for (const line of output.split('\n'))
    if (Object.hasOwn(counts, line.trim())) counts[line.trim()]++;
  return counts;
}

/** Keep only bounded numeric state summaries; never output request/actor/bot identifiers. */
export function summarizeStorage(value) {
  const number = (field) => {
    if (!Number.isSafeInteger(field) || field < 0) throw safeError();
    return field;
  };
  const counts = (input, allowed) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw safeError();
    return Object.fromEntries(
      allowed.map((phase) => [phase, number(input[phase] ?? 0)]),
    );
  };
  if (!['normal', 'blocked', 'authorized'].includes(value?.recovery?.status))
    throw safeError();
  return {
    databaseBytes: number(value.databaseBytes),
    walBytes: number(value.walBytes),
    dataFilesystemAvailableBytes: number(value.availableBytes),
    recovery: value.recovery.status,
    executions: counts(value.executions, [
      'reserved',
      'started',
      'pending',
      'uncertain',
      'completed',
      'failed',
      'not-started',
    ]),
    actions: counts(value.actions, [
      'reserved',
      'result-confirmed',
      'delivery-pending',
      'delivery-started',
      'delivered',
      'delivery-uncertain',
      'delivery-rejected',
    ]),
  };
}

const storageProbe = `
import {statSync,statfsSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const path='/data/state/jarvis.sqlite';
const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
try {
 db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=250');
 if(db.prepare('PRAGMA user_version').get().user_version!==1||db.prepare('PRAGMA application_id').get().application_id!==1246901078) throw new Error();
 const marker=db.prepare("SELECT fingerprint FROM bindings WHERE namespace='recovery.v1.gate'").get()?.fingerprint;
 if(marker!==undefined&&!/^[a-f0-9]{64}$/.test(marker)) throw new Error();
 const counts=table=>Object.fromEntries(db.prepare('SELECT phase,count(*) AS total FROM '+table+' GROUP BY phase').all().map(row=>[row.phase,row.total]));
 const space=statfsSync('/data');
 process.stdout.write(JSON.stringify({databaseBytes:statSync(path).size,walBytes:existsSync(path+'-wal')?statSync(path+'-wal').size:0,availableBytes:Math.floor(space.bavail*space.bsize),recovery:{status:marker===undefined?'normal':marker==='0'.repeat(64)?'authorized':'blocked'},executions:counts('executions'),actions:counts('actions')}));
} finally {db.close()}
`;

export function inspectPilot(project, run = docker) {
  if (
    typeof project !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)
  )
    throw safeError();
  // Exact project/service labels keep unrelated containers outside this inspection.
  const ids = run([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.service=jarvis',
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1 || !ids.every((id) => /^[a-f0-9]{12,64}$/.test(id)))
    throw safeError();
  const id = ids[0];
  // Request individual fields, never raw inspect or Config.Env/Mounts/health logs.
  const status = run(['inspect', '--format', '{{.State.Status}}', id]).trim();
  if (
    ![
      'running',
      'created',
      'restarting',
      'exited',
      'dead',
      'paused',
      'removing',
    ].includes(status)
  )
    throw safeError();
  const restartCount = Number(
    run(['inspect', '--format', '{{.RestartCount}}', id]).trim(),
  );
  if (!Number.isSafeInteger(restartCount) || restartCount < 0)
    throw safeError();
  const healthRaw = run([
    'inspect',
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    id,
  ]).trim();
  if (!['healthy', 'unhealthy', 'starting', 'none'].includes(healthRaw))
    throw safeError();
  let resources = null;
  let storage = null;
  if (status === 'running') {
    const raw = JSON.parse(
      run(['stats', '--no-stream', '--format', '{{json .}}', id]),
    );
    const bounded = (value, pattern) => {
      if (
        typeof value !== 'string' ||
        value.length > 80 ||
        !pattern.test(value)
      )
        throw safeError();
      return value;
    };
    resources = {
      cpu: bounded(raw.CPUPerc, /^\d+(?:\.\d+)?%$/),
      memory: bounded(
        raw.MemUsage,
        /^[\d.]+\s*[kMGTPE]?i?B\s*\/\s*[\d.]+\s*[kMGTPE]?i?B$/,
      ),
      pids: bounded(raw.PIDs, /^\d+$/),
    };
    storage = summarizeStorage(
      JSON.parse(
        run([
          'exec',
          id,
          'node',
          '--no-warnings',
          '--input-type=module',
          '--eval',
          storageProbe,
        ]),
      ),
    );
  }
  const logCounts = aggregateEvents(
    run(['logs', '--since', '60m', '--tail', '1000', id]),
  );
  return {
    status,
    heartbeatHealth: healthRaw,
    restartCount,
    resources,
    storage,
    telegramEvents: {
      windowMinutes: 60,
      maximumLines: 1000,
      counts: logCounts,
    },
    limitations: [
      'heartbeat-is-not-a-telegram-connectivity-proof',
      'logs-are-a-bounded-window-not-lifetime-counters',
      'gateway-latency-and-remote-errors-not-instrumented',
      'billing-and-credit-usage-require-separate-authorized-review',
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) throw safeError();
    process.stdout.write(`${JSON.stringify(inspectPilot(process.argv[2]))}\n`);
  } catch {
    process.stderr.write(`${safeError().message}\n`);
    process.exitCode = 1;
  }
}
