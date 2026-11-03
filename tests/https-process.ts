import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createTestCertificates } from './https-certificates.ts';

export type EchoMode =
  | 'normal'
  | 'malformed'
  | 'version'
  | 'cross-subject'
  | 'cross-agent'
  | 'slow'
  | 'pending'
  | 'rate-limit'
  | 'raw-rate-limit'
  | 'unavailable'
  | 'raw-unavailable'
  | 'redirect'
  | 'oversize'
  | 'chunked-oversize'
  | 'invalid-schema'
  | 'invalid-content-type'
  | 'invalid-encoding'
  | 'invalid-utf8'
  | 'duplicate-fields'
  | 'bad-status'
  | 'failed';

export interface EchoProcessOptions {
  readonly mode?: EchoMode;
  readonly delayMs?: number;
  readonly retryAfter?: string;
  readonly failures?: number;
  readonly pollAfterMs?: number;
  readonly certificate?: 'valid' | 'untrusted' | 'expired' | 'wrong-host';
}

export interface EchoCounts {
  readonly requests: number;
  readonly executions: number;
  readonly polls: number;
  readonly unauthorized: number;
  readonly duplicates: number;
}

export interface EchoProcess {
  readonly origin: string;
  readonly ca: string;
  readonly token: string;
  diagnosticsBytes(): number;
  stats(): Promise<EchoCounts>;
  close(): Promise<void>;
}

interface Message {
  readonly type: string;
  readonly port?: number;
  readonly id?: number;
  readonly counts?: EchoCounts;
}

/** The child is a standalone application; only protocol bytes cross the boundary. */
export async function startEchoAgent(
  options: EchoProcessOptions = {},
): Promise<EchoProcess> {
  const certificates = createTestCertificates({
    expired: options.certificate === 'expired',
    wrongHost: options.certificate === 'wrong-host',
  });
  const ca =
    options.certificate === 'untrusted'
      ? createTestCertificates().ca
      : certificates.ca;
  const token = randomBytes(32).toString('base64url');
  const child = fork(
    fileURLToPath(new URL('./fixtures/echo-agent.mjs', import.meta.url)),
    [],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
      // Isolate the fixture from operator credentials and Node debug/startup options.
      env:
        process.platform === 'win32' && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {},
    },
  );
  let closed = false;
  let sequence = 0;
  let diagnosticsSize = 0;
  const waiters = new Map<
    number,
    {
      readonly resolve: (counts: EchoCounts) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  // Count and drain without retaining diagnostics; tests assert that output is empty.
  child.stdout?.on('data', (chunk: Buffer) => {
    diagnosticsSize += chunk.length;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnosticsSize += chunk.length;
  });

  const close = (): Promise<void> => {
    if (closed || child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: 'shutdown' }, () => undefined);
      else child.kill();
    });
  };
  child.on('exit', () => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('HTTPS fixture stopped.'));
    }
    waiters.clear();
  });
  child.on('message', (raw: unknown) => {
    const message = raw as Message;
    if (message.type !== 'stats' || message.id === undefined || !message.counts)
      return;
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message.counts);
  });

  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('HTTPS fixture startup timed out.'));
      }, 5000);
      const fail = () => {
        cleanup();
        reject(new Error('HTTPS fixture startup failed.'));
      };
      const ready = (raw: unknown) => {
        const message = raw as Message;
        if (message.type === 'failure') fail();
        else if (
          message.type === 'ready' &&
          Number.isInteger(message.port) &&
          (message.port ?? 0) > 0
        ) {
          cleanup();
          resolve(message.port as number);
        }
      };
      function cleanup(): void {
        clearTimeout(timer);
        child.removeListener('message', ready);
        child.removeListener('error', fail);
        child.removeListener('exit', fail);
      }
      child.on('message', ready);
      child.once('error', fail);
      child.once('exit', fail);
      child.send(
        {
          type: 'configure',
          options: {
            ...options,
            key: certificates.key,
            cert: certificates.cert,
            token,
          },
        },
        (error) => {
          if (error) fail();
        },
      );
    });
  } catch (error) {
    await close();
    throw error;
  }
  // Retain a listener to prevent an asynchronous child-process error escaping tests.
  child.on('error', () => undefined);
  return {
    origin: `https://echo.test:${port}`,
    ca,
    token,
    diagnosticsBytes: () => diagnosticsSize,
    stats: () =>
      new Promise((resolve, reject) => {
        if (closed || !child.connected) {
          reject(new Error('HTTPS fixture stopped.'));
          return;
        }
        sequence += 1;
        const id = sequence;
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error('HTTPS fixture statistics timed out.'));
        }, 2000);
        waiters.set(id, { resolve, reject, timer });
        child.send({ type: 'stats', id }, (error) => {
          if (!error) return;
          clearTimeout(timer);
          waiters.delete(id);
          reject(new Error('HTTPS fixture statistics failed.'));
        });
      }),
    close,
  };
}
