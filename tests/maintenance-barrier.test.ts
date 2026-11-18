import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  initializeFixtureBarrier,
  MaintenanceBarrier,
} from './maintenance-barrier.ts';

function fixturePath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-c1-'));
  const path = join(directory, 'maintenance.sqlite');
  t.after(() => {
    rmSync(path, { force: true });
    rmdirSync(directory);
  });
  return path;
}

test('C1 admission denies an absent, corrupt or internally inconsistent barrier', (t) => {
  const path = fixturePath(t);
  const absent = new MaintenanceBarrier(path, randomUUID());
  assert.throws(() => absent.openWriter('interop-runtime'), {
    code: 'STATE_UNAVAILABLE',
  });

  const barrier = initializeFixtureBarrier(path);
  const writer = barrier.openWriter('interop-runtime');
  const never = () => assert.fail('unexpected execution');
  {
    using db = new DatabaseSync(path);
    db.prepare('DELETE FROM control').run();
  }
  assert.throws(() => barrier.claim(), { code: 'STATE_UNAVAILABLE' });
  assert.throws(() => writer.runSync('gateway', never), {
    code: 'STATE_UNAVAILABLE',
  });
  unlinkSync(path);
  assert.throws(() => writer.runSync('gateway', never), {
    code: 'STATE_UNAVAILABLE',
  });
  writeFileSync(path, 'damaged SQLite fixture');
  assert.throws(() => writer.runSync('gateway', never), {
    code: 'STATE_UNAVAILABLE',
  });
});

test('C1 rejects a stale installation epoch even after replacement at the same path', (t) => {
  const path = fixturePath(t);
  const first = initializeFixtureBarrier(path);
  const claim = first.claim();
  unlinkSync(path);
  const replacement = initializeFixtureBarrier(path);
  assert.notEqual(replacement.epoch, first.epoch);
  assert.throws(() => first.status(claim), { code: 'STALE_EPOCH' });
  assert.throws(() => first.claim(), { code: 'STALE_EPOCH' });
  assert.throws(() => first.openWriter('conversation'), {
    code: 'STALE_EPOCH',
  });
});

test('C1 records admitted work until it finishes and requires explicit writer shutdown', async (t) => {
  const barrier = initializeFixtureBarrier(fixturePath(t));
  const writer = barrier.openWriter('conversation');
  assert.throws(() => barrier.openWriter('conversation'), {
    code: 'WRITER_BUSY',
  });
  const work = Promise.withResolvers<string>();
  const inFlight = writer.run('command', () => work.promise);
  const claim = barrier.claim();
  const status = barrier.status(claim);
  assert.equal(status.quiescent, false);
  assert.equal(status.writers[0]?.id, status.operations[0]?.writer_id);
  assert.equal(status.operations[0]?.stage, 'command');
  assert.throws(() => writer.stop(() => {}), { code: 'WRITER_BUSY' });
  await assert.rejects(
    writer.run('command', () => assert.fail()),
    { code: 'ADMISSION_CLOSED' },
  );
  assert.throws(() => barrier.status(randomUUID()), { code: 'NOT_OWNER' });
  work.resolve('finished');
  assert.equal(await inFlight, 'finished');
  assert.deepEqual(barrier.status(claim).operations, []);
  assert.equal(barrier.status(claim).quiescent, false);
  await writer.stop(() => {});
  assert.equal(barrier.status(claim).quiescent, true);
});

test('C1 holds the SQLite write lock through the synchronous send start', (t) => {
  const barrier = initializeFixtureBarrier(fixturePath(t));
  const writer = barrier.openWriter('interop-runtime');
  using contender = new DatabaseSync(barrier.path, { timeout: 0 });
  writer.runSync('dispatch', () => {
    writer.withSendStart(() => {
      assert.throws(
        () => contender.exec('BEGIN IMMEDIATE'),
        /database is locked/,
      );
    });
    contender.exec('BEGIN IMMEDIATE');
    contender.exec('ROLLBACK');
  });
  const claim = barrier.claim();
  assert.deepEqual(barrier.status(claim).operations, []);
  assert.throws(() => writer.withSendStart(() => assert.fail()), {
    code: 'ADMISSION_CLOSED',
  });
});

test('C1 failed writer shutdown leaves durable evidence and cannot attest quiescence', async (t) => {
  const barrier = initializeFixtureBarrier(fixturePath(t));
  const writer = barrier.openWriter('interop-runtime');
  const claim = barrier.claim();
  await assert.rejects(
    writer.stop(() => {
      throw new Error('synthetic close failure');
    }),
    /synthetic close failure/,
  );
  assert.equal(
    new MaintenanceBarrier(barrier.path, barrier.epoch).status(claim).quiescent,
    false,
  );
});

test(
  'C1 only one coordinator process claims the cut, and killing it never reopens admission',
  { timeout: 10000 },
  async (t) => {
    const barrier = initializeFixtureBarrier(fixturePath(t));
    const worker = fileURLToPath(
      new URL('./fixtures/maintenance-coordinator.ts', import.meta.url),
    );
    const children = Array.from({ length: 2 }, () =>
      fork(worker, [barrier.path, barrier.epoch], {
        execArgv: [],
        silent: true,
      }),
    );
    const exits = children.map((child) => once(child, 'exit'));
    t.after(async () => {
      for (const child of children) child.kill();
      await Promise.all(exits);
    });
    assert.deepEqual(
      await Promise.all(
        children.map(async (child) => (await once(child, 'message'))[0]),
      ),
      [{ ready: true }, { ready: true }],
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const response = once(child, 'message');
        child.send('claim');
        return (await response)[0] as { claim?: string; code?: string };
      }),
    );
    const winner = results.findIndex((result) => result.claim);
    assert.notEqual(winner, -1);
    assert.deepEqual(results[1 - winner], { code: 'ADMISSION_CLOSED' });
    children[winner]?.kill();
    await exits[winner];

    const restarted = new MaintenanceBarrier(barrier.path, barrier.epoch);
    const claim = results[winner]?.claim;
    assert.ok(claim);
    const { closedAt } = restarted.status(claim);
    assert.ok(closedAt);
    t.mock.timers.enable({ apis: ['Date'], now: closedAt });
    t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
    assert.throws(() => restarted.openWriter('interop-runtime'), {
      code: 'ADMISSION_CLOSED',
    });
    assert.throws(() => restarted.claim(), { code: 'ADMISSION_CLOSED' });
    assert.equal(restarted.status(claim).closedAt, closedAt);
  },
);
