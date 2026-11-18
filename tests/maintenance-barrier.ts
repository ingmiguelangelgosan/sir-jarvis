import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const applicationId = 0x4a424331;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type WriterRole = 'interop-runtime' | 'conversation';
type Stage =
  | 'command'
  | 'poll'
  | 'channel-journal'
  | 'delivery'
  | 'gateway'
  | 'dispatch'
  | 'adapter'
  | 'gateway-restart';
type Failure =
  | 'STATE_UNAVAILABLE'
  | 'STALE_EPOCH'
  | 'ADMISSION_CLOSED'
  | 'NOT_OWNER'
  | 'WRITER_BUSY'
  | 'WRITER_INACTIVE';

export class MaintenanceError extends Error {
  readonly code: Failure;

  constructor(code: Failure, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}

const unavailable = () => new MaintenanceError('STATE_UNAVAILABLE');

/** Provision once, in a newly allocated synthetic directory. Runtime never provisions. */
export function initializeFixtureBarrier(path: string) {
  const epoch = randomUUID();
  closeSync(openSync(path, 'wx', 0o600));
  using db = new DatabaseSync(path);
  db.exec(`
    PRAGMA synchronous = FULL;
    BEGIN IMMEDIATE;
    PRAGMA application_id = ${applicationId};
    PRAGMA user_version = 1;
    CREATE TABLE control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      epoch TEXT NOT NULL,
      owner TEXT,
      closed_at INTEGER,
      CHECK ((owner IS NULL) = (closed_at IS NULL))
    ) STRICT;
    CREATE TABLE writer (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('interop-runtime', 'conversation')),
      opened_at INTEGER NOT NULL,
      finished_at INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX active_writer ON writer(role) WHERE finished_at IS NULL;
    CREATE TABLE operation (
      id TEXT PRIMARY KEY,
      writer_id TEXT NOT NULL REFERENCES writer(id),
      stage TEXT NOT NULL CHECK (stage IN ('command', 'poll', 'channel-journal', 'delivery', 'gateway', 'dispatch', 'adapter', 'gateway-restart')),
      opened_at INTEGER NOT NULL,
      finished_at INTEGER
    ) STRICT;
  `);
  db.prepare('INSERT INTO control (singleton, epoch) VALUES (1, ?)').run(epoch);
  db.exec('COMMIT');
  return new MaintenanceBarrier(path, epoch);
}

/** Shared by fixture processes. Each decision opens the current file and checks the expected epoch. */
export class MaintenanceBarrier {
  readonly path: string;
  readonly epoch: string;

  constructor(path: string, epoch: string) {
    this.path = resolve(path);
    this.epoch = epoch;
  }

  #transaction<T>(
    write: boolean,
    work: (
      db: DatabaseSync,
      owner: string | null,
      closedAt: number | null,
    ) => T,
  ): T {
    try {
      if (!existsSync(this.path)) throw unavailable();
      using db = new DatabaseSync(this.path, {
        readOnly: !write,
        timeout: 2000,
      });
      if (write) db.exec('PRAGMA synchronous = FULL');
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      if (
        db.prepare('PRAGMA application_id').get()?.application_id !==
          applicationId ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
        db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get() ||
        db
          .prepare(
            `SELECT operation.id FROM operation JOIN writer ON writer.id = operation.writer_id
          WHERE operation.finished_at IS NULL AND writer.finished_at IS NOT NULL LIMIT 1`,
          )
          .get()
      )
        throw unavailable();
      const rows = db
        .prepare('SELECT singleton, epoch, owner, closed_at FROM control')
        .all();
      const state = rows[0];
      if (
        rows.length !== 1 ||
        state?.singleton !== 1 ||
        typeof state.epoch !== 'string' ||
        !uuid.test(state.epoch)
      )
        throw unavailable();
      const { owner, closed_at: closedAt } = state;
      if (owner === null) {
        if (closedAt !== null) throw unavailable();
      } else if (
        typeof owner !== 'string' ||
        !uuid.test(owner) ||
        typeof closedAt !== 'number' ||
        !Number.isSafeInteger(closedAt) ||
        closedAt <= 0
      ) {
        throw unavailable();
      }
      if (state.epoch !== this.epoch) throw new MaintenanceError('STALE_EPOCH');
      const result = work(db, owner, closedAt);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('STATE_UNAVAILABLE', { cause: error });
    }
  }

  claim() {
    return this.#transaction(true, (db, owner) => {
      if (owner !== null) throw new MaintenanceError('ADMISSION_CLOSED');
      const claim = randomUUID();
      db.prepare(
        'UPDATE control SET owner = ?, closed_at = ? WHERE singleton = 1',
      ).run(claim, Date.now());
      return claim;
    });
  }

  status(claim: string) {
    return this.#transaction(false, (db, owner, closedAt) => {
      if (owner === null || owner !== claim)
        throw new MaintenanceError('NOT_OWNER');
      const writers = db
        .prepare(
          'SELECT id, role, opened_at FROM writer WHERE finished_at IS NULL ORDER BY role',
        )
        .all();
      const stoppedWriters = db
        .prepare(
          'SELECT id, role, finished_at FROM writer WHERE finished_at IS NOT NULL ORDER BY role, id',
        )
        .all();
      const operations = db
        .prepare(
          'SELECT id, writer_id, stage, opened_at FROM operation WHERE finished_at IS NULL ORDER BY opened_at, id',
        )
        .all();
      return {
        epoch: this.epoch,
        closedAt,
        writers,
        stoppedWriters,
        operations,
        quiescent: writers.length === 0 && operations.length === 0,
      };
    });
  }

  openWriter(role: WriterRole) {
    const writerId = randomUUID();
    const checkOpen = (owner: string | null) => {
      if (owner !== null) throw new MaintenanceError('ADMISSION_CLOSED');
    };
    this.#transaction(true, (db, owner) => {
      checkOpen(owner);
      if (
        db
          .prepare(
            'SELECT id FROM writer WHERE role = ? AND finished_at IS NULL',
          )
          .get(role)
      )
        throw new MaintenanceError('WRITER_BUSY');
      db.prepare(
        'INSERT INTO writer (id, role, opened_at) VALUES (?, ?, ?)',
      ).run(writerId, role, Date.now());
    });
    let active = 0;
    let stopping: Promise<void> | undefined;
    const checkLocal = () => {
      if (stopping) throw new MaintenanceError('WRITER_INACTIVE');
    };
    const checkWriter = (db: DatabaseSync) => {
      if (
        !db
          .prepare('SELECT id FROM writer WHERE id = ? AND finished_at IS NULL')
          .get(writerId)
      )
        throw new MaintenanceError('WRITER_INACTIVE');
    };
    const admit = (stage: Stage) => {
      checkLocal();
      const id = randomUUID();
      this.#transaction(true, (db, owner) => {
        checkOpen(owner);
        checkWriter(db);
        db.prepare(
          'INSERT INTO operation (id, writer_id, stage, opened_at) VALUES (?, ?, ?, ?)',
        ).run(id, writerId, stage, Date.now());
      });
      active++;
      return () => {
        active--;
        this.#transaction(true, (db) => {
          if (
            db
              .prepare(
                'UPDATE operation SET finished_at = ? WHERE id = ? AND finished_at IS NULL',
              )
              .run(Date.now(), id).changes !== 1
          )
            throw unavailable();
        });
      };
    };
    return {
      withSendStart: (start: () => void) => {
        checkLocal();
        // Only synchronous request initiation belongs under the same write
        // lock as claim(). The enclosing dispatch tracks the exchange.
        this.#transaction(true, (db, owner) => {
          checkOpen(owner);
          checkWriter(db);
          start();
        });
      },
      assertOpen: () => {
        checkLocal();
        this.#transaction(false, (db, owner) => {
          checkOpen(owner);
          checkWriter(db);
        });
      },
      async run<T>(stage: Stage, work: () => Promise<T> | T) {
        const finish = admit(stage);
        try {
          return await work();
        } finally {
          finish();
        }
      },
      runSync<T>(stage: Stage, work: () => T) {
        const finish = admit(stage);
        try {
          return work();
        } finally {
          finish();
        }
      },
      stop: (close: () => void | Promise<void>) => {
        if (active !== 0) throw new MaintenanceError('WRITER_BUSY');
        stopping ??= Promise.resolve()
          .then(close)
          .then(() => {
            this.#transaction(true, (db) => {
              if (
                db
                  .prepare(
                    'SELECT id FROM operation WHERE writer_id = ? AND finished_at IS NULL',
                  )
                  .get(writerId)
              )
                throw new MaintenanceError('WRITER_BUSY');
              if (
                db
                  .prepare(
                    'UPDATE writer SET finished_at = ? WHERE id = ? AND finished_at IS NULL',
                  )
                  .run(Date.now(), writerId).changes !== 1
              )
                throw unavailable();
            });
          });
        return stopping;
      },
    };
  }
}
