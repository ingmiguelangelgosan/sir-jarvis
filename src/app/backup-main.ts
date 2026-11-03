import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

import { acquireRuntimeLock } from '../infrastructure/runtime-lock.ts';
import { readMountedSecretFile } from '../infrastructure/file-secrets.ts';
import { SqliteStateStore } from '../infrastructure/sqlite-state-store.ts';
import {
  createStateBackup,
  pruneStateBackups,
  readPrivateFile,
  restoreStateBackup,
  StateBackupError,
  verifyStateBackup,
} from '../infrastructure/state-backup.ts';

const reviewSchema = z.strictObject({
  restore_id: z.string().regex(/^[a-f0-9]{64}$/),
  external_evidence_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .refine((value) => value !== '0'.repeat(64)),
  telegram_next_offset: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  decision: z.literal('allow-read-only'),
  pending_and_uncertain: z.literal('reviewed'),
  backup_rollback: z.literal('reviewed'),
});

try {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === 'backup' && args.length === 3) {
    result = await createStateBackup({
      statePath: resolve(args[0]!),
      backupDirectory: resolve(args[1]!),
      keyFile: resolve(args[2]!),
    });
  } else if (command === 'verify' && args.length === 2) {
    result = await verifyStateBackup({
      backupFile: resolve(args[0]!),
      keyFile: resolve(args[1]!),
    });
  } else if (command === 'restore' && args.length === 3) {
    result = await restoreStateBackup({
      backupFile: resolve(args[0]!),
      destinationDirectory: resolve(args[1]!),
      keyFile: resolve(args[2]!),
    });
  } else if (command === 'prune' && args.length === 3) {
    result = {
      removed: await pruneStateBackups(
        resolve(args[0]!),
        resolve(args[1]!),
        Number(args[2]),
      ),
    };
  } else if (
    (command === 'inspect' && args.length === 1) ||
    (command === 'authorize' &&
      args.length === 4 &&
      args[3] === '--acknowledge-backup-rollback')
  ) {
    const path = resolve(args[0]!);
    // Review/authorization cannot race a running local Jarvis writer.
    const lock = command === 'authorize' ? acquireRuntimeLock(path) : undefined;
    let store: SqliteStateStore | undefined;
    try {
      store = new SqliteStateStore({ path });
      store.checkIntegrity();
      if (command === 'authorize') {
        let content: Buffer;
        try {
          content = readPrivateFile(resolve(args[2]!), 64 * 1024);
        } catch {
          content = Buffer.from(readMountedSecretFile(resolve(args[2]!), 4096));
        }
        const review = reviewSchema.parse(JSON.parse(content.toString('utf8')));
        if (review.restore_id !== args[1]) throw new Error();
        store.authorizeRecovery(
          review.restore_id,
          createHash('sha256').update(content).digest('hex'),
          review.telegram_next_offset,
          Date.now(),
        );
      }
      result = store.inspect();
    } finally {
      try {
        store?.close();
      } finally {
        lock?.close();
      }
    }
  } else {
    throw new Error();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write(`${new StateBackupError().message}\n`);
  process.exitCode = 1;
}
