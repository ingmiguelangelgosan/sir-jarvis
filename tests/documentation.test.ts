import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const financeSnapshotPath = join(
  repositoryRoot,
  'docs/history/PRODUCT_RULES_FINANCE_V0.1.md',
);
const financeSpecPath = join(
  repositoryRoot,
  'docs/agents/FINANCE_AGENT_SPEC.md',
);
const financeSnapshotSha256 =
  '5c033df0f76911740a1605fa8e468c81e90bb6a0cb8f3aa1110c4be59a27500c';

interface MarkdownTarget {
  readonly target: string;
  readonly line: number;
}

function maskFencedCode(markdown: string): string {
  let fence: { character: string; length: number } | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker?.[1]?.[0] === fence.character &&
          marker[1].length >= fence.length &&
          !marker[2]?.trim()
        ) {
          fence = undefined;
        }
        return ' '.repeat(line.length);
      }
      if (marker?.[1]) {
        fence = { character: marker[1][0] ?? '', length: marker[1].length };
        return ' '.repeat(line.length);
      }
      return line;
    })
    .join('\n');
}

function maskCode(markdown: string): string {
  return maskFencedCode(markdown).replace(/(`+)([\s\S]*?)\1/g, (code: string) =>
    code.replace(/[^\n]/g, ' '),
  );
}

function markdownAnchors(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const content = maskFencedCode(markdown);
  for (const match of maskCode(markdown).matchAll(
    /<[a-z][^>]*\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi,
  )) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) anchors.add(id);
  }

  const headingAnchors = new Set<string>();
  for (const match of content.matchAll(/^ {0,3}#{1,6}[ \t]+(.+)[ \t]*$/gm)) {
    const base = (match[1] ?? '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/(?<!\w)_{1,3}([^_]+)_{1,3}(?!\w)/g, '$1')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let anchor = base;
    let suffix = 0;
    while (headingAnchors.has(anchor)) anchor = `${base}-${++suffix}`;
    headingAnchors.add(anchor);
    anchors.add(anchor);
  }
  return anchors;
}

function markdownTargets(markdown: string): readonly MarkdownTarget[] {
  const content = maskCode(markdown);
  const targets: MarkdownTarget[] = [];
  const patterns = [
    /!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s\\]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g,
    /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const target = match[1];
      if (target === undefined) continue;
      targets.push({
        target:
          target.startsWith('<') && target.endsWith('>')
            ? target.slice(1, -1)
            : target,
        line: content.slice(0, match.index).split('\n').length,
      });
    }
  }
  return targets;
}

function localDestination(
  sourcePath: string,
  target: string,
): string | undefined {
  // Nunca consultar enlaces de red, esquemas de skills ni rutas de otra máquina.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return undefined;
  const path = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? '').replace(
    /\\([\\()[\] ])/g,
    '$1',
  );
  if (!path) return target.includes('#') ? sourcePath : undefined;
  if (path.split(/[\\/]/).includes('.tools')) return undefined;
  return path.startsWith('/')
    ? resolve(repositoryRoot, path.slice(1))
    : resolve(dirname(sourcePath), path);
}

function isInsideRepository(path: string): boolean {
  const fromRoot = relative(repositoryRoot, path);
  return (
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
  );
}

function markdownFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    // No recorrer symlinks ni archivos privados fuera del árbol documental.
    return entry.isFile() && /\.md$/i.test(entry.name) ? [path] : [];
  });
}

test('la especificación financiera histórica mantiene sus bytes y SHA256 originales', () => {
  const snapshot = readFileSync(financeSnapshotPath);
  assert.equal(
    createHash('sha256').update(snapshot).digest('hex'),
    financeSnapshotSha256,
  );
});

test('FinanceAgent conserva íntegro el snapshot de las catorce secciones funcionales', () => {
  const snapshot = readFileSync(financeSnapshotPath, 'utf8');
  const spec = readFileSync(financeSpecPath, 'utf8');
  const sections = [...snapshot.matchAll(/^## (\d+)\./gm)].map((match) =>
    Number(match[1]),
  );
  assert.deepEqual(
    sections,
    Array.from({ length: 14 }, (_, index) => index + 1),
  );
  assert.ok(
    spec.includes(snapshot),
    'FINANCE_AGENT_SPEC.md debe contener el snapshot completo sin reescritura.',
  );
});

test('las reglas globales remiten a FinanceAgent y no duplican el detalle del ledger', () => {
  const productPath = join(repositoryRoot, 'docs/PRODUCT_RULES.md');
  const productRules = readFileSync(productPath, 'utf8');
  const financeSnapshot = readFileSync(financeSnapshotPath, 'utf8');
  assert.ok(
    markdownTargets(productRules).some(
      ({ target }) => localDestination(productPath, target) === financeSpecPath,
    ),
    'PRODUCT_RULES.md debe enlazar la especificación de FinanceAgent.',
  );

  const financialHeadings = [...financeSnapshot.matchAll(/^## (\d+)\. (.+)$/gm)]
    .filter((match) => Number(match[1]) >= 2 && Number(match[1]) <= 11)
    .map((match) => match[2]?.trim());
  const globalHeadings = [
    ...productRules.matchAll(/^#{2,6}\s+(?:\d+\.\s+)?(.+)$/gm),
  ].map((match) => match[1]?.trim());
  assert.equal(
    financialHeadings.some((heading) => globalHeadings.includes(heading)),
    false,
    'Los bloques de reglas financieras detalladas deben vivir en FinanceAgent.',
  );

  for (const financialRule of [
    'Cada cuota pagada es un movimiento de caja único',
    'FIFO al periodo salarial más antiguo',
    'reparto equitativo es la regla definida',
  ]) {
    assert.equal(
      productRules.includes(financialRule),
      false,
      'Las cláusulas de ledger preservadas no deben duplicarse en las reglas globales.',
    );
  }
});

test('la revisión de enlaces ignora ejemplos de código y acepta destinos con espacios', () => {
  const markdown = [
    '[Documento](guia.md#inicio)',
    '`[Código inline](no-existe.md)`',
    '```markdown',
    '[Ejemplo fenced](tampoco-existe.md)',
    '```',
    '~~~md',
    '[Otro ejemplo](no-validar.md)',
    '~~~',
    '[Con espacios](<guia local.md> "Título")',
    '[referencia]: otra-guia.md "Título"',
  ].join('\n');
  assert.deepEqual(markdownTargets(markdown), [
    { target: 'guia.md#inicio', line: 1 },
    { target: 'guia local.md', line: 9 },
    { target: 'otra-guia.md', line: 10 },
  ]);
});

test('los anchors conservan Unicode y código de títulos, resuelven duplicados e IDs HTML', () => {
  const markdown = [
    '<a id="finance-original"></a>',
    '## Sección: Árbol y NIÑEZ!',
    '## Sección: Árbol y NIÑEZ!',
    '## `request_id` y **Estado**',
    '```md',
    '## Título que es solo un ejemplo',
    '<a id="no-validar"></a>',
    '```',
    '`<a id="inline-no-validar"></a>`',
  ].join('\n');
  assert.deepEqual(
    markdownAnchors(markdown),
    new Set([
      'finance-original',
      'sección-árbol-y-niñez',
      'sección-árbol-y-niñez-1',
      'request_id-y-estado',
    ]),
  );
});

test('los enlaces Markdown locales y sus fragmentos apuntan a destinos existentes', () => {
  const documents = [
    join(repositoryRoot, 'README.md'),
    join(repositoryRoot, 'AGENTS.md'),
    ...markdownFiles(join(repositoryRoot, 'docs')),
  ];
  const failures: string[] = [];
  const anchorCache = new Map<string, ReadonlySet<string>>();
  for (const document of documents) {
    const source = relative(repositoryRoot, document).split(sep).join('/');
    for (const link of markdownTargets(readFileSync(document, 'utf8'))) {
      const location = `${source}:${link.line}`;
      try {
        const destination = localDestination(document, link.target);
        if (destination === undefined) continue;
        if (!isInsideRepository(destination)) {
          failures.push(`${location}: destino fuera del repositorio.`);
        } else if (!existsSync(destination)) {
          failures.push(`${location}: destino local inexistente.`);
        } else if (!isInsideRepository(realpathSync(destination))) {
          failures.push(`${location}: destino enlazado fuera del repositorio.`);
        } else if (/\.md$/i.test(destination) && link.target.includes('#')) {
          const fragment = decodeURIComponent(
            link.target.slice(link.target.indexOf('#') + 1),
          );
          if (!fragment) continue;
          let anchors = anchorCache.get(destination);
          if (!anchors) {
            anchors = markdownAnchors(readFileSync(destination, 'utf8'));
            anchorCache.set(destination, anchors);
          }
          if (!anchors.has(fragment)) {
            failures.push(
              `${location}: fragmento Markdown o ID HTML inexistente.`,
            );
          }
        }
      } catch {
        failures.push(`${location}: destino local inválido o inaccesible.`);
      }
    }
  }
  assert.equal(
    failures.length,
    0,
    `Enlaces documentales pendientes de corrección:\n${failures.join('\n')}`,
  );
});
