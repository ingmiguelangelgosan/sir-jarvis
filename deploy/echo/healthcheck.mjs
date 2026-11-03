import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import process from 'node:process';

try {
  const request = get(
    {
      hostname: '127.0.0.1',
      servername: 'echo',
      port: 8443,
      path: '/healthz',
      ca: readFileSync('/run/secrets/echo_ca'),
      rejectUnauthorized: true,
      timeout: 2000,
    },
    (response) => {
      response.resume();
      if (response.statusCode !== 200) process.exitCode = 1;
    },
  );
  request.on('timeout', () => request.destroy());
  request.on('error', () => {
    process.exitCode = 1;
  });
} catch {
  process.exitCode = 1;
}
