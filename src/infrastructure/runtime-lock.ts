import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ConfigurationError } from '../app/config.ts';

export interface RuntimeLock {
  /** Detect accidental unlink/replacement; never unlink an active lock file. */
  assertHeld(): void;
  close(): void;
}

const failure = () =>
  new ConfigurationError(
    'No se pudo reservar el runtime local. Revisa otras instancias y permisos.',
  );
const applicationId = 1246901079;

function acquire(path: string): RuntimeLock {
  let database: DatabaseSync | undefined;
  let closed = false;
  try {
    if (!isAbsolute(path) || path.includes('\0') || path.startsWith('\\\\'))
      throw new Error();
    const actual = resolve(path);
    const parent = dirname(actual);
    const parentIdentity = realpathSync(parent);
    function checkDirectory() {
      const info = lstatSync(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(parent) !== parentIdentity ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw new Error();
    }
    function checkFile(file: string, optional = false) {
      try {
        const info = lstatSync(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        )
          throw new Error();
      } catch (error) {
        if (
          optional &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return;
        throw error;
      }
    }
    checkDirectory();
    // Exclusive creation is race-safe. Existing lock files are retained across
    // restarts: ownership comes from the OS SQLite lock, never mere existence.
    try {
      const descriptor = openSync(actual, 'wx', 0o600);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    checkFile(actual);
    checkFile(`${actual}-journal`, true);
    checkFile(`${actual}-wal`, true);
    checkFile(`${actual}-shm`, true);
    const identity = lstatSync(actual);
    database = new DatabaseSync(actual, { allowExtension: false });
    database.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;');
    if (
      database.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !==
      'delete'
    )
      throw new Error();
    database.exec('BEGIN EXCLUSIVE');
    const app = database.prepare('PRAGMA application_id').get()?.application_id;
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all();
    if (app === 0 && version === 0 && tables.length === 0) {
      database.exec(
        `PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT; BEGIN EXCLUSIVE;`,
      );
    } else if (app !== applicationId || version !== 1 || tables.length !== 0)
      throw new Error();

    const db = database;
    const assertHeld = () => {
      try {
        if (closed) throw new Error();
        checkDirectory();
        checkFile(actual);
        checkFile(`${actual}-journal`, true);
        checkFile(`${actual}-wal`, true);
        checkFile(`${actual}-shm`, true);
        const next = lstatSync(actual);
        if (next.ino !== identity.ino || next.dev !== identity.dev)
          throw new Error();
        // A read uses the still-open, exclusive transaction. No state DB is locked.
        if (
          db.prepare('PRAGMA application_id').get()?.application_id !==
          applicationId
        )
          throw new Error();
      } catch {
        throw failure();
      }
    };
    assertHeld();
    return {
      assertHeld,
      close() {
        if (closed) return;
        closed = true;
        try {
          try {
            db.exec('ROLLBACK');
          } finally {
            db.close();
          }
        } catch {
          throw failure();
        }
      },
    };
  } catch {
    try {
      database?.close();
    } catch {
      // No raw paths, SQLite errors or credential-bearing context escapes.
    }
    throw failure();
  }
}

/** Separate rollback-journal DB; the operating system releases it on SIGKILL. */
export function acquireRuntimeLock(statePath: string): RuntimeLock {
  return acquire(`${statePath}.runtime-lock`);
}

/** All consumers of a bot must share this canonical, private directory/volume. */
export function acquireTelegramConsumerLock(
  directory: string,
  botId: string,
): RuntimeLock {
  if (!/^[1-9]\d{4,19}$/.test(botId)) throw failure();
  const identity = createHash('sha256').update(botId).digest('hex');
  return acquire(join(directory, `telegram-${identity}.runtime-lock`));
}
