import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { TestContext } from 'node:test';

export function temporaryState(t: TestContext) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'jarvis-durable-'));
  const callbacks: (() => void)[] = [];
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  t.after(() => {
    for (const callback of callbacks) callback();
    const target = realpathSync(directory);
    const fromRoot = relative(root, target);
    assert.ok(
      !isAbsolute(fromRoot) &&
        fromRoot !== '..' &&
        !fromRoot.startsWith('../') &&
        !fromRoot.startsWith('..\\') &&
        basename(target).startsWith('jarvis-durable-'),
    );
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  });
  return {
    directory,
    path: join(directory, 'state.sqlite'),
    cleanup: (callback: () => void) => callbacks.push(callback),
  };
}
