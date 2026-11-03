import { resolve } from 'node:path';
import { SqliteStateStore } from '../infrastructure/sqlite-state-store.ts';

let store: SqliteStateStore | undefined;
try {
  const [operation, path, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['init', 'compact'].includes(operation ?? ''))
    throw new Error();
  store = new SqliteStateStore({
    path: resolve(path),
    create: operation === 'init',
  });
  if (operation === 'compact') {
    const now = Date.now();
    const count = store.compact(now - 7 * 86_400_000, now);
    process.stdout.write(
      `Metadatos terminales compactados: ${count}. Claves de bloqueo conservadas.\n`,
    );
  } else
    process.stdout.write(
      'Almacén local inicializado. No se ejecutaron agentes o llamadas externas.\n',
    );
} catch {
  process.stderr.write(
    'No se pudo abrir el almacén. Uso: state-main.ts init|compact <ruta>. Revisa permisos y docs/AGENT_RUNTIME.md.\n',
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
