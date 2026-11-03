import { readFileSync } from 'node:fs';
import process from 'node:process';

try {
  const value = JSON.parse(readFileSync('/tmp/jarvis-health', 'utf8'));
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isSafeInteger(value.at) ||
    Date.now() - value.at > 90_000 ||
    value.at > Date.now() + 1000
  )
    throw new Error();
  process.kill(value.pid, 0);
} catch {
  process.exitCode = 1;
}
