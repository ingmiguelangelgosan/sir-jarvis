import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import { SqliteStateStore } from './sqlite-state-store.ts';
import { readMountedSecretFile } from './file-secrets.ts';

const magic = Buffer.from('JARVIS-BACKUP-1\n');
const maxBytes = 128 * 1024 * 1024;
const metadataSchema = z
  .strictObject({
    format: z.literal(1),
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    snapshotStartedAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    snapshotFinishedAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    bytes: z.number().int().positive().max(maxBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.snapshotFinishedAt >= value.snapshotStartedAt);
export type BackupMetadata = z.infer<typeof metadataSchema>;

export class StateBackupError extends Error {
  constructor() {
    super(
      'No se pudo completar la operación de backup/recuperación. Revisa espacio, permisos, clave, integridad y versión; los efectos siguen bloqueados.',
    );
    this.name = 'StateBackupError';
  }
}

/** Local files only. Windows additionally requires operator-verified private ACLs. */
export function privateDirectory(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || path.startsWith('\\\\'))
    throw new StateBackupError();
  const canonical = realpathSync(path);
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && info.mode & 0o077) ||
    relative(canonical, resolve(path)) !== ''
  )
    throw new StateBackupError();
  return canonical;
}

function fileInfo(path: string, limit = maxBytes + 8192) {
  privateDirectory(dirname(path));
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > limit ||
    (process.platform !== 'win32' && info.mode & 0o077)
  )
    throw new StateBackupError();
  return info;
}

export function readPrivateFile(path: string, limit: number): Buffer {
  const info = fileInfo(path, limit);
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const current = fstatSync(fd);
    if (
      info.ino !== current.ino ||
      info.dev !== current.dev ||
      current.size > limit
    )
      throw new StateBackupError();
    const content = readFileSync(fd);
    if (content.length > limit) throw new StateBackupError();
    return content;
  } finally {
    closeSync(fd);
  }
}

function keyFromFile(path: string): Buffer {
  let text: string;
  try {
    text = readPrivateFile(path, 128)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  } catch {
    text = readMountedSecretFile(path, 128);
  }
  const key = Buffer.from(text, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== text)
    throw new StateBackupError();
  return key;
}

function syncFile(path: string) {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string) {
  if (process.platform === 'win32') return; // No portable directory fsync on Windows.
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function cleanup(directory: string) {
  // Only private mkdtemp directories made by this workflow, never operator data.
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  } catch {
    throw new StateBackupError();
  }
}

function spaceFor(directory: string, bytes: number) {
  const space = statfsSync(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(bytes) + 16n * 1024n * 1024n)
    throw new StateBackupError();
}

function validate(path: string) {
  const store = new SqliteStateStore({ path });
  try {
    store.checkIntegrity();
    return store.inspect();
  } finally {
    store.close();
  }
}

/** Snapshot while WAL writers continue, authenticated streaming encryption, exclusive publication. */
export async function createStateBackup(options: {
  readonly statePath: string;
  readonly backupDirectory: string;
  readonly keyFile: string;
}) {
  const start = performance.now();
  let temporary: string | undefined;
  let store: SqliteStateStore | undefined;
  let key: Buffer | undefined;
  try {
    const directory = privateDirectory(options.backupDirectory);
    const activeDirectory = privateDirectory(dirname(options.statePath));
    const fromActive = relative(activeDirectory, directory);
    if (
      !fromActive ||
      (!fromActive.startsWith(`..${sep}`) &&
        fromActive !== '..' &&
        !isAbsolute(fromActive))
    )
      throw new Error();
    const size =
      fileInfo(options.statePath).size +
      (existsSync(`${options.statePath}-wal`)
        ? fileInfo(`${options.statePath}-wal`).size
        : 0);
    if (size > maxBytes) throw new Error();
    spaceFor(directory, Math.max(size * 3, 4 * 1024 * 1024));
    key = keyFromFile(options.keyFile);
    temporary = mkdtempSync(join(directory, '.backup-'));
    const snapshot = join(temporary, 'snapshot.sqlite');
    // Backup API may replace a target: it only ever receives this exclusively owned path.
    const fd = openSync(snapshot, 'wx', 0o600);
    closeSync(fd);
    const snapshotStartedAt = Date.now();
    store = new SqliteStateStore({ path: options.statePath });
    await store.backupTo(snapshot);
    store.close();
    store = undefined;
    validate(snapshot);
    const content = readPrivateFile(snapshot, maxBytes);
    const metadata = metadataSchema.parse({
      format: 1,
      schemaVersion: 1,
      id: randomUUID(),
      snapshotStartedAt,
      snapshotFinishedAt: Date.now(),
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    content.fill(0);
    const header = Buffer.from(JSON.stringify(metadata));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const nonce = randomBytes(12);
    const aad = Buffer.concat([magic, length, header, nonce]);
    const partial = join(temporary, 'encrypted.part');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const output = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    output.write(aad);
    await pipeline(createReadStream(snapshot), cipher, output, { end: false });
    await new Promise<void>((accept, reject) => {
      output.once('error', reject);
      output.end(cipher.getAuthTag(), () => accept());
    });
    syncFile(partial);
    const name = `backup-${metadata.id}.jvb`;
    const final = join(directory, name);
    linkSync(partial, final); // Fails if final exists; rename() would replace on POSIX.
    unlinkSync(partial);
    syncDirectory(directory);
    return {
      file: name,
      metadata,
      bytes: fileInfo(final).size,
      durationMs: Math.round(performance.now() - start),
    };
  } catch {
    throw new StateBackupError();
  } finally {
    try {
      store?.close();
    } finally {
      key?.fill(0);
      if (temporary) cleanup(temporary);
    }
  }
}

async function decode(backupFile: string, keyFile: string, directory: string) {
  const info = fileInfo(backupFile);
  if (info.size < magic.length + 4 + 12 + 16) throw new Error();
  let key: Buffer | undefined;
  try {
    const bytes = readPrivateFile(backupFile, maxBytes + 8192); // bounded; verify descriptor identity
    if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error();
    const length = bytes.readUInt32BE(magic.length);
    if (length < 1 || length > 4096) throw new Error();
    const offset = magic.length + 4 + length + 12;
    if (offset + 16 >= bytes.length) throw new Error();
    key = keyFromFile(keyFile);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      bytes.subarray(offset - 12, offset),
    );
    decipher.setAAD(bytes.subarray(0, offset));
    decipher.setAuthTag(bytes.subarray(-16));
    // Authentication succeeds before any plaintext is written or interpreted as SQLite.
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(offset, -16)),
      decipher.final(),
    ]);
    const metadata = metadataSchema.parse(
      JSON.parse(
        bytes.subarray(magic.length + 4, offset - 12).toString('utf8'),
      ),
    );
    if (
      plaintext.length !== metadata.bytes ||
      createHash('sha256').update(plaintext).digest('hex') !== metadata.sha256
    )
      throw new Error();
    spaceFor(directory, plaintext.length * 2);
    const path = join(directory, 'state.sqlite');
    const output = openSync(path, 'wx', 0o600);
    try {
      // writeFileSync via fd does not reopen or replace a different path.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(output, plaintext);
      fsyncSync(output);
    } finally {
      plaintext.fill(0);
      closeSync(output);
    }
    const state = validate(path);
    return { path, metadata, state };
  } finally {
    key?.fill(0);
  }
}

export async function verifyStateBackup(options: {
  readonly backupFile: string;
  readonly keyFile: string;
}) {
  let directory: string | undefined;
  try {
    directory = mkdtempSync(
      join(privateDirectory(dirname(options.backupFile)), '.verify-'),
    );
    const result = await decode(options.backupFile, options.keyFile, directory);
    return { metadata: result.metadata, state: result.state };
  } catch {
    throw new StateBackupError();
  } finally {
    if (directory) cleanup(directory);
  }
}

/** Always a NEW isolated directory and NEW blocked restore, even if its backup was authorized. */
export async function restoreStateBackup(options: {
  readonly backupFile: string;
  readonly keyFile: string;
  readonly destinationDirectory: string;
}) {
  const start = performance.now();
  let created = false;
  let temporary: string | undefined;
  let store: SqliteStateStore | undefined;
  try {
    privateDirectory(dirname(options.destinationDirectory));
    mkdirSync(options.destinationDirectory, { mode: 0o700 });
    created = true;
    const directory = privateDirectory(options.destinationDirectory);
    temporary = mkdtempSync(join(directory, '.restore-'));
    const decoded = await decode(
      options.backupFile,
      options.keyFile,
      temporary,
    );
    const restoreId = randomBytes(32).toString('hex');
    store = new SqliteStateStore({ path: decoded.path });
    store.blockRecovery(restoreId, Date.now());
    store.checkIntegrity();
    const state = store.inspect();
    store.sealForTransfer();
    store.close();
    store = undefined;
    syncFile(decoded.path);
    linkSync(decoded.path, join(directory, 'state.sqlite'));
    unlinkSync(decoded.path);
    syncDirectory(directory);
    return {
      metadata: decoded.metadata,
      state,
      durationMs: Math.round(performance.now() - start),
    };
  } catch {
    if (created) {
      try {
        store?.close();
        store = undefined;
        cleanup(options.destinationDirectory);
        temporary = undefined;
      } catch {
        /* Keep failed isolated artifacts private; never touch original storage. */
      }
    }
    throw new StateBackupError();
  } finally {
    try {
      store?.close();
    } finally {
      if (temporary) cleanup(temporary);
    }
  }
}

/** Explicit retention: only decryptable, verified artifacts created by this format are eligible. */
export async function pruneStateBackups(
  directory: string,
  keyFile: string,
  keep: number,
): Promise<number> {
  try {
    privateDirectory(directory);
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10_000)
      throw new Error();
    const valid: { path: string; created: number }[] = [];
    for (const name of readdirSync(directory)) {
      if (!/^backup-[a-f0-9-]{36}\.jvb$/.test(name)) continue;
      const path = join(directory, name);
      // A wrong key/corrupt artifact aborts retention, rather than silently deleting evidence.
      const result = await verifyStateBackup({ backupFile: path, keyFile });
      if (`backup-${result.metadata.id}.jvb` !== name) throw new Error();
      valid.push({ path, created: result.metadata.snapshotStartedAt });
    }
    valid.sort((a, b) => b.created - a.created);
    for (const entry of valid.slice(keep)) {
      fileInfo(entry.path);
      unlinkSync(entry.path);
    }
    syncDirectory(directory);
    return Math.max(0, valid.length - keep);
  } catch {
    throw new StateBackupError();
  }
}
