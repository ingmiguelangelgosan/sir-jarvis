import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteConfirmationStore } from '../src/infrastructure/sqlite-confirmation-store.ts';

const scope = {
  instance_id: 'synthetic-instance',
  subject_ref: 'synthetic-subject',
  conversation_ref: 'a'.repeat(64),
};
const draft = {
  amount: '45000',
  currency: 'COP' as const,
  categoryId: 'synthetic-gasolina',
  occurredOn: '2026-11-17',
  label: 'Gasolina',
};
function fixture() {
  const root = resolve('.tools/expense-confirmation-tests');
  mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, 'case-')), 'conversation.sqlite');
  return {
    path,
    store: new SqliteConfirmationStore({
      path,
      create: true,
      installation: 'synthetic-installation',
    }),
  };
}

test('confirmation store: source idempotence, supersession and immutable history', () => {
  const f = fixture();
  try {
    const first = f.store.prepare(scope, draft, 'b'.repeat(64), 1000);
    assert.deepEqual(
      f.store.prepare(scope, draft, 'b'.repeat(64), 1001),
      first,
    );
    assert.throws(
      () =>
        f.store.prepare(scope, { ...draft, amount: '1' }, 'b'.repeat(64), 1001),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const second = f.store.prepare(
      scope,
      { ...draft, amount: '20000' },
      'c'.repeat(64),
      2000,
    );
    assert.equal(second.revision, 2);
    assert.equal(f.store.get(scope, first.reference).reason, 'superseded');
    assert.equal(
      f.store.history(scope, first.reference).at(-1)?.event,
      'superseded',
    );
    const probe = new DatabaseSync(f.path);
    try {
      assert.throws(() => probe.exec('DELETE FROM confirmation_audit'));
      assert.throws(() =>
        probe.exec("UPDATE confirmation_audit SET document='{}'"),
      );
      assert.throws(() => probe.exec('DELETE FROM confirmations'));
    } finally {
      probe.close();
    }
  } finally {
    f.store.close();
  }
});

test('confirmation store: two connections cannot both win CAS or overwrite audit', () => {
  const f = fixture();
  const other = new SqliteConfirmationStore({
    path: f.path,
    installation: 'synthetic-installation',
  });
  try {
    const row = f.store.prepare(scope, draft, 'b'.repeat(64), 1000);
    const stale = other.get(scope, row.reference);
    assert.ok(
      f.store.change(
        scope,
        row.reference,
        row.version,
        { state: 'cancelled' },
        'cancelled',
        'c'.repeat(64),
        1001,
      ),
    );
    assert.equal(
      other.change(
        scope,
        row.reference,
        stale.version,
        { state: 'executing' },
        'confirmed',
        'd'.repeat(64),
        1001,
      ),
      undefined,
    );
    assert.equal(other.history(scope, row.reference).length, 2);
    assert.equal(other.get(scope, row.reference).state, 'cancelled');
  } finally {
    other.close();
    f.store.close();
  }
});

test('confirmation store: invalid audit rolls back state and version atomically', () => {
  const f = fixture();
  try {
    const row = f.store.prepare(scope, draft, 'b'.repeat(64), 1000);
    assert.throws(() =>
      f.store.change(
        scope,
        row.reference,
        0,
        { state: 'cancelled' },
        'cancelled',
        'invalid-source',
        1001,
      ),
    );
    assert.deepEqual(f.store.get(scope, row.reference), row);
    assert.equal(f.store.history(scope, row.reference).length, 1);
  } finally {
    f.store.close();
  }
});

test('confirmation store: restart preserves pending and prevents cross-conversation disclosure', () => {
  const f = fixture();
  const row = f.store.prepare(scope, draft, 'b'.repeat(64), 1000);
  f.store.close();
  const reopened = new SqliteConfirmationStore({
    path: f.path,
    installation: 'synthetic-installation',
  });
  try {
    assert.deepEqual(reopened.get(scope, row.reference), row);
    assert.throws(
      () => reopened.get({ ...scope, subject_ref: 'foreign' }, row.reference),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        reopened.history(
          { ...scope, conversation_ref: 'c'.repeat(64) },
          row.reference,
        ),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        new SqliteConfirmationStore({
          path: f.path,
          installation: 'wrong-installation',
        }),
      { code: 'FORBIDDEN' },
    );
    assert.throws(
      () =>
        new SqliteConfirmationStore({
          path: join(f.path, 'missing'),
          installation: 'synthetic-installation',
        }),
    );
  } finally {
    reopened.close();
  }
});
