import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ConfigurationError, type Environment } from '../app/config.ts';

const fileVariables = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'JARVIS_TELEGRAM_AGENT_KEY',
  'JARVIS_ECHO_BEARER',
] as const;

function readOnlyComposeMount(path: string): boolean {
  // Docker Desktop may report 0777 for a Windows-backed file even though its
  // individual bind mount is read-only. Inspect the kernel mount, never an env
  // bypass. This exception applies only to exact files under /run/secrets.
  if (
    process.platform !== 'linux' ||
    path !== resolve(path) ||
    dirname(path) !== '/run/secrets' ||
    lstatSync('/run/secrets').isSymbolicLink()
  )
    return false;
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8');
  if (mounts.length > 1_048_576) return false;
  return mounts.split('\n').some((line) => {
    const fields = line.split(' ');
    const mount = fields[4]?.replace(
      /\\(040|011|012|134)/g,
      (_, value: string) => String.fromCharCode(Number.parseInt(value, 8)),
    );
    return mount === path && fields[5]?.split(',').includes('ro') === true;
  });
}

function readSecretFile(path: string, maximumBytes: number): string {
  if (
    !path ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    /^[/\\]{2}/.test(path)
  )
    throw new Error();
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1)
    throw new Error();
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.nlink !== 1 ||
      opened.size < 1 ||
      opened.size > maximumBytes ||
      (process.platform !== 'win32' &&
        (opened.mode & 0o022) !== 0 &&
        !readOnlyComposeMount(path))
    )
      throw new Error();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length < 1 || length > maximumBytes) throw new Error();
    const value = new TextDecoder('utf-8', { fatal: true })
      .decode(buffer.subarray(0, length))
      .replace(/\r?\n$/, '');
    if (!/^[\x21-\x7e]+$/.test(value)) throw new Error();
    return value;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Backup-key reader: requires an exact Linux read-only secret mount, never env. */
export function readMountedSecretFile(
  path: string,
  maximumBytes = 4096,
): string {
  try {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 4096 ||
      !readOnlyComposeMount(path)
    )
      throw new Error();
    return readSecretFile(path, maximumBytes);
  } catch {
    throw new ConfigurationError(
      'No se pudieron cargar los secretos montados.',
    );
  }
}

/** Only these four server settings support mounted-file indirection. No expansion. */
export function resolveFileSecrets(environment: Environment): Environment {
  const result: Record<string, string | undefined> = { ...environment };
  try {
    for (const variable of fileVariables) {
      const path = environment[`${variable}_FILE`];
      if (path === undefined) continue;
      if (environment[variable] !== undefined) throw new Error();
      result[variable] = readSecretFile(path, 4096);
      delete result[`${variable}_FILE`];
    }
    return Object.freeze(result);
  } catch {
    // Neither the filename, variable contents nor raw filesystem errors are safe logs.
    throw new ConfigurationError(
      'No se pudieron cargar los secretos montados.',
    );
  }
}
