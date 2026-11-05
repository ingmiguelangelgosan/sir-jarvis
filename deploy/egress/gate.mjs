import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setInterval, clearInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

// Mounted operational gate, not a new Jarvis domain. No DNS/API calls here.
const challenge = randomBytes(32).toString('hex');
const permitPath = '/run/jarvis-egress/permit.json';
let child;
let stopping = false;
let lease;
let acceptedAt;
let remaining;
function stop() {
  stopping = true;
  child?.kill('SIGTERM');
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
function readPermit() {
  const info = lstatSync(permitPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 4096
  )
    throw new Error();
  const p = JSON.parse(readFileSync(permitPath, 'utf8'));
  if (
    Object.keys(p).sort().join(',') !==
      'challenge,expiresAt,issuedAt,policyHash' ||
    p.challenge !== challenge ||
    !/^[a-f0-9]{64}$/.test(p.policyHash) ||
    !Number.isSafeInteger(p.issuedAt) ||
    p.issuedAt < 0 ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt <= p.issuedAt ||
    p.issuedAt > Date.now() ||
    p.expiresAt <= Date.now() ||
    p.expiresAt - p.issuedAt > 900000
  )
    throw new Error();
  return p;
}
try {
  writeFileSync('/tmp/jarvis-egress-challenge', challenge, {
    flag: 'wx',
    mode: 0o600,
  });
  const waitUntil = performance.now() + 60_000;
  while (!stopping && performance.now() < waitUntil) {
    try {
      lease = readPermit();
      break;
    } catch {
      await delay(100);
    }
  }
  if (stopping) process.exitCode = 0;
  else {
    if (!lease) throw new Error();
    acceptedAt = performance.now();
    remaining = lease.expiresAt - Date.now();
    child = spawn(process.execPath, ['dist/app/telegram-main.js'], {
      stdio: 'inherit',
      env: process.env,
    });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
      child.once('error', () => resolve({ code: 1 }));
    });
    const monitor = setInterval(() => {
      try {
        const p = readPermit();
        if (
          stopping ||
          JSON.stringify(p) !== JSON.stringify(lease) ||
          performance.now() - acceptedAt >= remaining ||
          Date.now() < lease.issuedAt
        )
          throw new Error();
      } catch {
        stop();
      }
    }, 250);
    const killTimeout = setInterval(() => {
      if (stopping) child?.kill('SIGKILL');
    }, 10_000);
    const result = await exited;
    clearInterval(monitor);
    clearInterval(killTimeout);
    process.exitCode = stopping ? 0 : (result.code ?? 1);
  }
} catch {
  stop();
  process.stderr.write('Egress gate closed before or during execution.\n');
  process.exitCode = 1;
}
