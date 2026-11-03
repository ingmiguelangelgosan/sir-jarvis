import { actor, request } from './agent-runtime.fixtures.ts';
import { httpsRuntime } from './agent-https-fixtures.ts';
import { startEchoAgent } from './https-process.ts';

const server = await startEchoAgent();
const runtime = httpsRuntime(server);
try {
  const result = await runtime.core.execute(
    actor,
    request(),
    new AbortController().signal,
  );
  const counts = await server.stats();
  if (result.status !== 'completed' || counts.executions !== 1)
    throw new Error('HTTPS demo failed.');
  process.stdout.write(
    `${JSON.stringify({ mode: 'https-local-test', status: result.status, executions: counts.executions })}\n`,
  );
} finally {
  runtime.close();
  await server.close();
}
