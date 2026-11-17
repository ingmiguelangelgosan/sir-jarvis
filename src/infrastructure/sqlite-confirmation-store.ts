import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AgentGatewayError } from '../agents/errors.ts';
import { canonicalJson, jsonObjectSnapshot } from '../agents/json.ts';
import {
  identifierSchema,
  parseExecutionRequest,
} from '../agents/validation.ts';
import { recordInputSchema } from '../agents/finance-expense-profile.ts';
import type {
  Confirmation,
  ConfirmationAudit,
  ConfirmationChange,
  ConfirmationScope,
  ConfirmationState,
  ConfirmationStore,
  ExpenseDraft,
} from '../app/confirmation-store.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({
  instance_id: identifierSchema,
  subject_ref: identifierSchema,
  conversation_ref: hash,
});
const draftSchema = recordInputSchema.extend({
  label: z
    .string()
    .min(1)
    .max(128)
    .refine((v) => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)),
});
const timestamp = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 300000);
const stateSchema = z.enum([
  'awaiting_confirmation',
  'cancelled',
  'executing',
  'completed',
  'uncertain',
  'failed',
]);
const outcomeSchema = z.enum([
  'not-started',
  'uncertain',
  'completed',
  'pending',
  'failed',
]);
const rowSchema = z.strictObject({
  reference: z.string().regex(/^G-[a-f0-9]{12}$/),
  scope: scopeSchema,
  draft: draftSchema,
  revision: z.number().int().positive(),
  version: z.number().int().nonnegative(),
  state: stateSchema,
  createdAt: timestamp,
  expiresAt: timestamp,
  sourceRef: hash,
  consentSourceRef: hash.nullable(),
  consentedAt: timestamp.nullable(),
  requestId: identifierSchema,
  correlationId: identifierSchema,
  intentKey: identifierSchema,
  request: z.unknown(),
  outcome: outcomeSchema.nullable(),
  evidence: z.unknown(),
  reason: z.string().max(64).nullable(),
});
const transitions: Record<ConfirmationState, readonly ConfirmationState[]> = {
  awaiting_confirmation: ['cancelled', 'executing'],
  cancelled: [],
  executing: ['completed', 'failed', 'uncertain'],
  completed: [],
  uncertain: ['uncertain', 'completed'],
  failed: [],
};
function fail(): never {
  throw new AgentGatewayError('UNAVAILABLE', 'uncertain');
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
function scopeKey(scope: ConfirmationScope): string {
  return canonicalJson(jsonObjectSnapshot(scopeSchema.parse(scope)));
}
function validate(row: unknown): Confirmation {
  const parsed = rowSchema.parse(row);
  const request =
    parsed.request === null ? null : parseExecutionRequest(parsed.request);
  const evidence =
    parsed.evidence === null ? null : jsonObjectSnapshot(parsed.evidence);
  if (parsed.expiresAt !== parsed.createdAt + 300000) fail();
  if (
    request &&
    (request.instance_id !== parsed.scope.instance_id ||
      request.subject_ref !== parsed.scope.subject_ref ||
      request.idempotency_key !== parsed.intentKey ||
      request.request_id !== parsed.requestId ||
      request.correlation_id !== parsed.correlationId ||
      request.capability.name !== 'finance.expense.record')
  )
    fail();
  if (
    request &&
    canonicalJson(request.input) !==
      canonicalJson(
        jsonObjectSnapshot({
          amount: parsed.draft.amount,
          currency: parsed.draft.currency,
          categoryId: parsed.draft.categoryId,
          occurredOn: parsed.draft.occurredOn,
        }),
      )
  )
    fail();
  return immutable({ ...parsed, request, evidence });
}

/** Experimental local store, separate from gateway metadata and financial ledgers. */
export class SqliteConfirmationStore implements ConfirmationStore {
  readonly #db: DatabaseSync;
  constructor(options: {
    readonly path: string;
    readonly create?: boolean;
    readonly installation: string;
  }) {
    if (
      !isAbsolute(options.path) ||
      options.path.startsWith('\\\\') ||
      !options.installation ||
      options.installation.length > 256
    )
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    if (options.create) {
      const fd = openSync(options.path, 'wx', 0o600);
      closeSync(fd);
    } else if (!existsSync(options.path))
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    const stat = lstatSync(options.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new AgentGatewayError('INVALID_CONFIGURATION');
    this.#db = new DatabaseSync(options.path, { allowExtension: false });
    try {
      this.#db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500;',
      );
      if (options.create) {
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE binding (identity TEXT NOT NULL) STRICT;
          CREATE TABLE confirmations (reference TEXT PRIMARY KEY, scope TEXT NOT NULL, source TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, UNIQUE(scope,source)) STRICT;
          CREATE UNIQUE INDEX one_active_confirmation ON confirmations(scope) WHERE state IN ('awaiting_confirmation','executing','uncertain');
          CREATE TABLE confirmation_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL REFERENCES confirmations(reference), document TEXT NOT NULL) STRICT;
          CREATE TRIGGER no_audit_update BEFORE UPDATE ON confirmation_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
          CREATE TRIGGER no_audit_delete BEFORE DELETE ON confirmation_audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
          CREATE TRIGGER no_confirmation_delete BEFORE DELETE ON confirmations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
          PRAGMA user_version=1; PRAGMA application_id=1245922126; COMMIT;`);
        this.#db
          .prepare('INSERT INTO binding VALUES (?)')
          .run(options.installation);
      }
      if (
        this.#db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
        this.#db.prepare('PRAGMA application_id').get()?.application_id !==
          1245922126 ||
        this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
      )
        fail();
      const bindings = this.#db.prepare('SELECT identity FROM binding').all();
      if (
        bindings.length !== 1 ||
        bindings[0]?.identity !== options.installation
      )
        throw new AgentGatewayError('FORBIDDEN');
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #decode(value: unknown): Confirmation {
    if (typeof value !== 'string') fail();
    try {
      return validate(JSON.parse(value));
    } catch {
      return fail();
    }
  }
  get(scope: ConfirmationScope, reference: string): Confirmation {
    if (!/^G-[a-f0-9]{12}$/.test(reference))
      throw new AgentGatewayError('VALIDATION_FAILED');
    const row = this.#db
      .prepare(
        'SELECT document,state,version FROM confirmations WHERE reference=? AND scope=?',
      )
      .get(reference, scopeKey(scope));
    if (!row) throw new AgentGatewayError('FORBIDDEN');
    const result = this.#decode(row.document);
    if (
      result.state !== row.state ||
      result.version !== row.version ||
      scopeKey(result.scope) !== scopeKey(scope) ||
      result.reference !== reference
    )
      fail();
    return result;
  }
  active(scope: ConfirmationScope): Confirmation | undefined {
    const row = this.#db
      .prepare(
        "SELECT reference FROM confirmations WHERE scope=? AND state IN ('awaiting_confirmation','executing','uncertain')",
      )
      .get(scopeKey(scope));
    return row ? this.get(scope, String(row.reference)) : undefined;
  }
  #audit(
    row: Confirmation,
    fromState: ConfirmationState | null,
    event: string,
    sourceRef: string,
    now: number,
  ): void {
    this.#db
      .prepare(
        'INSERT INTO confirmation_audit(reference,document) VALUES (?,?)',
      )
      .run(
        row.reference,
        JSON.stringify({
          reference: row.reference,
          fromState,
          toState: row.state,
          event,
          sourceRef: hash.parse(sourceRef),
          at: timestamp.parse(now),
          version: row.version,
        }),
      );
  }
  #write(
    old: Confirmation,
    next: Confirmation,
    event: string,
    source: string,
    now: number,
  ): Confirmation {
    const row = validate(next);
    const result = this.#db
      .prepare(
        'UPDATE confirmations SET document=?,state=?,version=? WHERE reference=? AND version=?',
      )
      .run(
        JSON.stringify(row),
        row.state,
        row.version,
        row.reference,
        old.version,
      );
    if (result.changes !== 1) fail();
    this.#audit(row, old.state, event, source, now);
    return row;
  }
  prepare(
    scope: ConfirmationScope,
    draft: ExpenseDraft,
    sourceRef: string,
    now: number,
  ): Confirmation {
    const bound = scopeSchema.parse(scope),
      input = draftSchema.parse(draft),
      source = hash.parse(sourceRef),
      at = timestamp.parse(now);
    const fingerprint = createHash('sha256')
      .update(canonicalJson(jsonObjectSnapshot(input)))
      .digest('hex');
    return this.#transaction(() => {
      const existing = this.#db
        .prepare(
          'SELECT reference,fingerprint FROM confirmations WHERE scope=? AND source=?',
        )
        .get(scopeKey(bound), source);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new AgentGatewayError('IDEMPOTENCY_CONFLICT');
        return this.get(bound, String(existing.reference));
      }
      const active = this.active(bound);
      if (active && active.state !== 'awaiting_confirmation')
        throw new AgentGatewayError('IDEMPOTENCY_CONFLICT', 'uncertain');
      const count = this.#db
        .prepare('SELECT count(*) AS count FROM confirmations')
        .get()?.count;
      if (typeof count !== 'number' || count >= 10000)
        throw new AgentGatewayError('CAPACITY_EXCEEDED');
      if (active)
        this.#write(
          active,
          {
            ...active,
            state: 'cancelled',
            reason: 'superseded',
            version: active.version + 1,
          },
          'superseded',
          source,
          at,
        );
      const previous = this.#db
        .prepare(
          'SELECT document FROM confirmations WHERE scope=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(scopeKey(bound));
      const revision = previous
        ? this.#decode(previous.document).revision + 1
        : 1;
      const row = validate({
        reference: `G-${randomBytes(6).toString('hex')}`,
        scope: bound,
        draft: input,
        revision,
        version: 0,
        state: 'awaiting_confirmation',
        createdAt: at,
        expiresAt: at + 300000,
        sourceRef: source,
        consentSourceRef: null,
        consentedAt: null,
        requestId: `req.${randomUUID()}`,
        correlationId: `flow.${randomUUID()}`,
        intentKey: `expense.${randomUUID()}`,
        request: null,
        outcome: null,
        evidence: null,
        reason: null,
      });
      this.#db
        .prepare('INSERT INTO confirmations VALUES (?,?,?,?,?,?,?)')
        .run(
          row.reference,
          scopeKey(bound),
          source,
          fingerprint,
          row.state,
          row.version,
          JSON.stringify(row),
        );
      this.#audit(row, null, 'prepared', source, at);
      return row;
    });
  }
  change(
    scope: ConfirmationScope,
    reference: string,
    expectedVersion: number,
    change: ConfirmationChange,
    event: string,
    sourceRef: string,
    now: number,
  ): Confirmation | undefined {
    return this.#transaction(() => {
      const old = this.get(scope, reference);
      if (old.version !== expectedVersion) return undefined;
      if (!transitions[old.state].includes(change.state))
        throw new AgentGatewayError('VALIDATION_FAILED');
      return this.#write(
        old,
        { ...old, ...change, version: old.version + 1 },
        event,
        sourceRef,
        now,
      );
    });
  }
  history(
    scope: ConfirmationScope,
    reference: string,
  ): readonly ConfirmationAudit[] {
    this.get(scope, reference);
    return immutable(
      this.#db
        .prepare(
          'SELECT sequence,document FROM confirmation_audit WHERE reference=? ORDER BY sequence',
        )
        .all(reference)
        .map((row) => ({
          ...(JSON.parse(String(row.document)) as Omit<
            ConfirmationAudit,
            'sequence'
          >),
          sequence: Number(row.sequence),
        })),
    );
  }
  close(): void {
    this.#db.close();
  }
}
