import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { AgentGatewayError } from '../agents/errors.ts';
import { jsonObjectSnapshot } from '../agents/json.ts';
import type {
  DurableAction,
  DurableActionPhase,
  DurableContext,
  DurableExecution,
  DurableStateStore,
  ExecutionTransition,
} from '../agents/state-store.ts';
import { identifierSchema } from '../agents/validation.ts';

const applicationId = 1246901078;
const retentionMs = 7 * 86_400_000;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const executionPhase = z.enum([
  'reserved',
  'started',
  'not-started',
  'uncertain',
  'completed',
  'pending',
  'failed',
]);
const outcomeSchema = z.enum([
  'not-started',
  'uncertain',
  'completed',
  'pending',
  'failed',
]);
const errorCode = z.enum([
  'UNSUPPORTED_PROTOCOL',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'UNKNOWN_CAPABILITY',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'TIMEOUT',
  'UNAVAILABLE',
  'INTERNAL_ERROR',
  'INVALID_CONFIGURATION',
  'UNKNOWN_AGENT',
  'UNKNOWN_OPERATION',
  'AGENT_DISABLED',
  'AGENT_UNAVAILABLE',
  'INVALID_RESPONSE',
  'CANCELLED',
  'RESULT_EXPIRED',
  'CAPACITY_EXCEEDED',
]);
const contextSchema = z.strictObject({
  protocol_version: z.literal('1.0'),
  instance_id: identifierSchema,
  subject_ref: identifierSchema,
  agent_id: identifierSchema,
  request_id: identifierSchema,
  correlation_id: identifierSchema,
  capability: z.strictObject({
    name: identifierSchema,
    version: identifierSchema,
  }),
});
const transitionSchema = z.strictObject({
  phase: executionPhase,
  errorCode: errorCode.optional(),
  outcome: outcomeSchema.optional(),
  operationId: identifierSchema.optional(),
  pollAfterMs: z.number().int().min(1).max(86_400_000).optional(),
  pendingExpiresAt: timestamp.optional(),
});
const executionSchema = z
  .strictObject({
    key: identifierSchema,
    commandHash: hashSchema,
    owner: identifierSchema,
    context: contextSchema,
    ...transitionSchema.shape,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine((value) => value.updatedAt >= value.createdAt)
  .refine(
    (value) =>
      value.phase !== 'pending' ||
      (value.operationId !== undefined &&
        value.pollAfterMs !== undefined &&
        value.pendingExpiresAt !== undefined),
  );
const actionPhase = z.enum([
  'reserved',
  'result-confirmed',
  'delivery-pending',
  'delivery-started',
  'delivered',
  'delivery-uncertain',
  'delivery-rejected',
]);
const actionSchema = z
  .strictObject({
    key: identifierSchema,
    commandHash: hashSchema,
    owner: identifierSchema,
    phase: actionPhase,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine((value) => value.updatedAt >= value.createdAt);

const executionTransitions: Readonly<
  Record<DurableExecution['phase'], readonly string[]>
> = {
  reserved: ['started', 'not-started', 'uncertain'],
  started: [
    'started',
    'not-started',
    'uncertain',
    'completed',
    'pending',
    'failed',
  ],
  pending: ['pending', 'uncertain', 'completed', 'failed'],
  uncertain: [],
  completed: [],
  failed: [],
  'not-started': [],
};
const actionTransitions: Readonly<
  Record<DurableActionPhase, readonly string[]>
> = {
  reserved: ['result-confirmed', 'delivery-pending', 'delivery-uncertain'],
  'result-confirmed': ['delivery-pending', 'delivery-uncertain'],
  'delivery-pending': ['delivery-started', 'delivery-uncertain'],
  'delivery-started': [
    'delivered',
    'delivery-pending',
    'delivery-rejected',
    'delivery-uncertain',
  ],
  delivered: [],
  'delivery-uncertain': [],
  'delivery-rejected': [],
};

export interface SqliteStateStoreOptions {
  readonly path: string;
  /** Exclusive bootstrap of a new empty database, never recreate an existing file. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
  readonly maxRecords?: number;
}

/** Local single-host state only. SQL transactions never span network awaits. */
export class SqliteStateStore implements DurableStateStore {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #maxRecords: number;
  readonly #fileIdentity: { readonly ino: number; readonly dev: number };
  readonly #directoryIdentity: string;
  #closed = false;

  constructor(options: SqliteStateStoreOptions) {
    let database: DatabaseSync | undefined;
    try {
      if (
        !isAbsolute(options.path) ||
        options.path.includes('\0') ||
        options.path.startsWith('\\\\')
      )
        throw new Error();
      this.#path = resolve(options.path);
      this.#directoryIdentity = realpathSync(dirname(this.#path));
      const timeout = options.busyTimeoutMs ?? 250;
      this.#maxRecords = options.maxRecords ?? 100_000;
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < 0 ||
        timeout > 1000 ||
        !Number.isSafeInteger(this.#maxRecords) ||
        this.#maxRecords < 1 ||
        this.#maxRecords > 1_000_000
      )
        throw new Error();
      this.#checkDirectory();
      this.#checkSidecars();
      if (options.create) {
        const descriptor = openSync(this.#path, 'wx', 0o600);
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      this.#checkFile(this.#path, false);
      const identity = lstatSync(this.#path);
      this.#fileIdentity = { ino: identity.ino, dev: identity.dev };
      database = new DatabaseSync(this.#path, { allowExtension: false });
      this.#db = database;
      database.exec(
        `PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;`,
      );
      const version = database
        .prepare('PRAGMA user_version')
        .get()?.user_version;
      const app = database
        .prepare('PRAGMA application_id')
        .get()?.application_id;
      const migration = readFileSync(
        new URL('../../migrations/001_durable_state.sql', import.meta.url),
        'utf8',
      );
      const checksum = createHash('sha256').update(migration).digest('hex');
      if (version === 0 && app === 0 && options.create) {
        if (
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
            )
            .all().length
        )
          throw new Error();
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(migration);
          database
            .prepare(
              'INSERT INTO schema_migrations(version, checksum) VALUES(1, ?)',
            )
            .run(checksum);
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      } else if (version !== 1 || app !== applicationId) throw new Error();
      if (
        database
          .prepare('SELECT checksum FROM schema_migrations WHERE version=1')
          .get()?.checksum !== checksum
      )
        throw new Error();
      // Detect edited/dropped columns and constraints instead of silently repairing history.
      const fresh = new DatabaseSync(':memory:');
      try {
        fresh.exec(migration);
        const sql =
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        if (
          JSON.stringify(database.prepare(sql).all()) !==
          JSON.stringify(fresh.prepare(sql).all())
        )
          throw new Error();
      } finally {
        fresh.close();
      }
      if (database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error();
      if (
        database.prepare('PRAGMA journal_mode=WAL').all()[0]?.journal_mode !==
        'wal'
      )
        throw new Error();
      database.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=100;');
      if (
        database.prepare('PRAGMA synchronous').get()?.synchronous !== 2 ||
        database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
      )
        throw new Error();
      this.#checkSidecars();
    } catch {
      try {
        database?.close();
      } catch {
        /* fail closed without raw details */
      }
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    }
  }

  #checkDirectory(): void {
    const info = lstatSync(dirname(this.#path));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(dirname(this.#path)) !== this.#directoryIdentity ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw new Error();
  }

  #checkFile(path: string, optional: boolean): void {
    try {
      const info = lstatSync(path);
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

  #checkSidecars(): void {
    this.#checkFile(`${this.#path}-wal`, true);
    this.#checkFile(`${this.#path}-shm`, true);
    this.#checkFile(`${this.#path}-journal`, true);
  }

  #safe<T>(work: () => T): T {
    try {
      if (this.#closed) throw new Error();
      this.#checkDirectory();
      this.#checkFile(this.#path, false);
      this.#checkSidecars();
      const identity = lstatSync(this.#path);
      if (
        identity.ino !== this.#fileIdentity.ino ||
        identity.dev !== this.#fileIdentity.dev
      )
        throw new Error();
      return work();
    } catch (error) {
      if (error instanceof AgentGatewayError) throw error;
      throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }

  #transaction<T>(work: () => T): T {
    return this.#safe(() => {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const value = work();
        this.#db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          /* no original error exposure */
        }
        throw error;
      }
    });
  }

  #capacity(): void {
    const row = this.#db
      .prepare(
        'SELECT (SELECT count(*) FROM executions)+(SELECT count(*) FROM actions) AS total',
      )
      .get();
    if (typeof row?.total !== 'number' || row.total >= this.#maxRecords)
      throw new AgentGatewayError('CAPACITY_EXCEEDED');
  }

  #audit(key: string, event: string, now: number): void {
    // Fixed vocabulary and at most the last 32 transitions per record.
    this.#db
      .prepare('INSERT INTO audit(record_key,event,at) VALUES(?,?,?)')
      .run(key, event, now);
    this.#db
      .prepare(
        'DELETE FROM audit WHERE record_key=? AND id NOT IN (SELECT id FROM audit WHERE record_key=? ORDER BY id DESC LIMIT 32)',
      )
      .run(key, key);
  }

  bind(namespace: string, fingerprint: string): void {
    this.#transaction(() => {
      identifierSchema.parse(namespace);
      hashSchema.parse(fingerprint);
      const row = this.#db
        .prepare('SELECT fingerprint FROM bindings WHERE namespace=?')
        .get(namespace);
      if (row && row.fingerprint !== fingerprint)
        throw new AgentGatewayError('INVALID_CONFIGURATION');
      if (!row) {
        const count = this.#db
          .prepare('SELECT count(*) AS total FROM bindings')
          .get()?.total;
        if (typeof count !== 'number' || count >= 256)
          throw new AgentGatewayError('CAPACITY_EXCEEDED');
        this.#db
          .prepare('INSERT INTO bindings(namespace,fingerprint) VALUES(?,?)')
          .run(namespace, fingerprint);
      }
    });
  }

  #execution(key: string): DurableExecution | undefined {
    const row = this.#db
      .prepare('SELECT * FROM executions WHERE key=?')
      .get(key);
    if (!row) return undefined;
    if (row.compacted === 1)
      throw new AgentGatewayError(
        'RESULT_EXPIRED',
        row.phase === 'completed'
          ? 'completed'
          : row.phase === 'failed'
            ? 'failed'
            : 'not-started',
      );
    const parsed = executionSchema.parse({
      key: row.key,
      commandHash: row.command_hash,
      owner: row.owner,
      context: JSON.parse(String(row.context)),
      phase: row.phase,
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
      ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
      ...(row.poll_after_ms === null ? {} : { pollAfterMs: row.poll_after_ms }),
      ...(row.pending_expires_at === null
        ? {}
        : { pendingExpiresAt: row.pending_expires_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (
      parsed.context.instance_id !== row.instance_id ||
      parsed.context.agent_id !== row.agent_id ||
      parsed.context.subject_ref !== row.subject_ref
    )
      throw new Error();
    return jsonObjectSnapshot(parsed) as unknown as DurableExecution;
  }

  getExecution(key: string): DurableExecution | undefined {
    return this.#safe(() => {
      identifierSchema.parse(key);
      return this.#execution(key);
    });
  }

  reserveExecution(value: DurableExecution): {
    readonly created: boolean;
    readonly record: DurableExecution;
  } {
    return this.#transaction(() => {
      const record = executionSchema.parse(value);
      if (
        record.phase !== 'reserved' ||
        record.errorCode !== undefined ||
        record.outcome !== undefined ||
        record.operationId !== undefined ||
        record.pollAfterMs !== undefined ||
        record.pendingExpiresAt !== undefined
      )
        throw new Error();
      const old = this.#db
        .prepare('SELECT command_hash FROM executions WHERE key=?')
        .get(record.key);
      if (old) {
        if (old.command_hash !== record.commandHash)
          throw new AgentGatewayError('IDEMPOTENCY_CONFLICT');
        return { created: false, record: this.#execution(record.key)! };
      }
      this.#capacity();
      this.#db
        .prepare(
          `INSERT INTO executions(key,command_hash,owner,context,instance_id,agent_id,subject_ref,phase,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?)`,
        )
        .run(
          record.key,
          record.commandHash,
          record.owner,
          JSON.stringify(record.context),
          record.context.instance_id,
          record.context.agent_id,
          record.context.subject_ref,
          record.createdAt,
          record.updatedAt,
        );
      this.#audit(record.key, 'execution.reserved', record.createdAt);
      return { created: true, record: this.#execution(record.key)! };
    });
  }

  findOperation(
    scope: Pick<DurableContext, 'instance_id' | 'agent_id' | 'subject_ref'>,
    operationId: string,
  ): DurableExecution | undefined {
    return this.#safe(() => {
      const parsed = z
        .strictObject({
          instance_id: identifierSchema,
          agent_id: identifierSchema,
          subject_ref: identifierSchema,
        })
        .parse(scope);
      identifierSchema.parse(operationId);
      const row = this.#db
        .prepare(
          'SELECT key FROM executions WHERE instance_id=? AND agent_id=? AND subject_ref=? AND operation_id=?',
        )
        .get(
          parsed.instance_id,
          parsed.agent_id,
          parsed.subject_ref,
          operationId,
        );
      return row ? this.#execution(String(row.key)) : undefined;
    });
  }

  transitionExecution(
    key: string,
    owner: string,
    change: ExecutionTransition,
    now: number,
  ): void {
    this.#transaction(() => {
      identifierSchema.parse(key);
      identifierSchema.parse(owner);
      timestamp.parse(now);
      const parsed = transitionSchema.parse(change);
      const current = this.#execution(key);
      if (
        !current ||
        current.owner !== owner ||
        now < current.updatedAt ||
        !executionTransitions[current.phase].includes(parsed.phase)
      )
        throw new Error();
      if (
        current.operationId &&
        parsed.operationId &&
        current.operationId !== parsed.operationId
      )
        throw new Error();
      if (
        current.pendingExpiresAt !== undefined &&
        parsed.pendingExpiresAt !== undefined &&
        parsed.pendingExpiresAt > current.pendingExpiresAt
      )
        throw new Error();
      const next = executionSchema.parse({
        ...current,
        ...parsed,
        updatedAt: now,
      });
      this.#db
        .prepare(
          `UPDATE executions SET phase=?,error_code=?,outcome=?,operation_id=?,poll_after_ms=?,pending_expires_at=?,updated_at=? WHERE key=? AND owner=?`,
        )
        .run(
          next.phase,
          next.errorCode ?? null,
          next.outcome ?? null,
          next.operationId ?? null,
          next.pollAfterMs ?? null,
          next.pendingExpiresAt ?? null,
          now,
          key,
          owner,
        );
      this.#audit(key, `execution.${parsed.phase}`, now);
    });
  }

  #action(key: string): DurableAction | undefined {
    const row = this.#db.prepare('SELECT * FROM actions WHERE key=?').get(key);
    if (!row) return undefined;
    return Object.freeze(
      actionSchema.parse({
        key: row.key,
        commandHash: row.command_hash,
        owner: row.owner,
        phase: row.phase,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  getAction(key: string): DurableAction | undefined {
    return this.#safe(() => {
      identifierSchema.parse(key);
      return this.#action(key);
    });
  }

  reserveAction(value: DurableAction): {
    readonly created: boolean;
    readonly record: DurableAction;
  } {
    return this.#transaction(() => {
      const record = actionSchema.parse(value);
      if (record.phase !== 'reserved') throw new Error();
      const current = this.#action(record.key);
      if (current) {
        if (current.commandHash !== record.commandHash)
          throw new AgentGatewayError('IDEMPOTENCY_CONFLICT');
        return { created: false, record: current };
      }
      this.#capacity();
      this.#db
        .prepare(
          "INSERT INTO actions(key,command_hash,owner,phase,created_at,updated_at) VALUES(?,?,?,'reserved',?,?)",
        )
        .run(
          record.key,
          record.commandHash,
          record.owner,
          record.createdAt,
          record.updatedAt,
        );
      this.#audit(record.key, 'action.reserved', record.createdAt);
      return { created: true, record: this.#action(record.key)! };
    });
  }

  transitionAction(
    key: string,
    owner: string,
    phase: DurableActionPhase,
    now: number,
  ): void {
    this.#transaction(() => {
      identifierSchema.parse(key);
      identifierSchema.parse(owner);
      actionPhase.parse(phase);
      timestamp.parse(now);
      const current = this.#action(key);
      if (
        !current ||
        current.owner !== owner ||
        now < current.updatedAt ||
        !actionTransitions[current.phase].includes(phase)
      )
        throw new Error();
      this.#db
        .prepare(
          'UPDATE actions SET phase=?,updated_at=? WHERE key=? AND owner=?',
        )
        .run(phase, now, key, owner);
      this.#audit(key, `action.${phase}`, now);
    });
  }

  getOffset(namespace: string): number | undefined {
    return this.#safe(() => {
      identifierSchema.parse(namespace);
      const row = this.#db
        .prepare('SELECT offset FROM offsets WHERE namespace=?')
        .get(namespace);
      return row ? timestamp.parse(row.offset) : undefined;
    });
  }

  advanceOffset(namespace: string, offset: number, now: number): void {
    this.#transaction(() => {
      identifierSchema.parse(namespace);
      timestamp.parse(offset);
      timestamp.parse(now);
      const current = this.#db
        .prepare('SELECT offset,updated_at FROM offsets WHERE namespace=?')
        .get(namespace);
      if (
        current &&
        (typeof current.updated_at !== 'number' || now < current.updated_at)
      )
        throw new Error();
      if (
        !current &&
        Number(
          this.#db.prepare('SELECT count(*) AS total FROM offsets').get()
            ?.total,
        ) >= 256
      )
        throw new AgentGatewayError('CAPACITY_EXCEEDED');
      this.#db
        .prepare(
          `INSERT INTO offsets(namespace,offset,updated_at) VALUES(?,?,?)
        ON CONFLICT(namespace) DO UPDATE SET offset=max(offset,excluded.offset),updated_at=excluded.updated_at`,
        )
        .run(namespace, offset, now);
    });
  }

  compact(before: number, now: number): number {
    return this.#transaction(() => {
      timestamp.parse(before);
      timestamp.parse(now);
      if (now - before < retentionMs) throw new Error();
      const rows = this.#db
        .prepare(
          "SELECT key FROM executions WHERE compacted=0 AND phase IN ('completed','failed','not-started') AND updated_at<?",
        )
        .all(before);
      this.#db
        .prepare(
          `UPDATE executions SET owner=NULL,context=NULL,instance_id=NULL,agent_id=NULL,subject_ref=NULL,error_code=NULL,
        outcome=NULL,operation_id=NULL,poll_after_ms=NULL,pending_expires_at=NULL,compacted=1
        WHERE compacted=0 AND phase IN ('completed','failed','not-started') AND updated_at<?`,
        )
        .run(before);
      this.#db
        .prepare(
          'DELETE FROM audit WHERE at<? AND record_key IN (SELECT key FROM executions WHERE compacted=1)',
        )
        .run(before);
      // Action keys retain owner+hash for stable typed dedup; detailed audit expires.
      this.#db
        .prepare(
          "DELETE FROM audit WHERE at<? AND record_key IN (SELECT key FROM actions WHERE phase IN ('delivered','delivery-rejected'))",
        )
        .run(before);
      return rows.length;
    });
  }

  close(): void {
    if (this.#closed) return;
    // A busy checkpoint is not a reason to leave the database handle open.
    // SQLite retains committed WAL pages until a subsequent safe checkpoint.
    try {
      this.#db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all();
    } catch {
      /* checkpoint may be busy */
    }
    try {
      this.#db.close();
      this.#closed = true;
    } catch {
      throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
    }
  }
}
