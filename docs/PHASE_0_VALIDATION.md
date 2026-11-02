# Fase 0 — registro de entrega y verificación

Fecha: **2026-11-01**, America/Bogota. Alcance autorizado por
[CODEX_START_PROMPT.md](CODEX_START_PROMPT.md): solamente Fase 0.

## Cambios

- `src/app/config.ts`: esquema Zod con selección de variables conocidas, defaults,
  zona horaria validada y errores que solo identifican campos.
- `src/app/diagnostics.ts`: reporte de bootstrap sin credenciales y capacidades
  pendientes explícitas.
- `src/app/main.ts`: composición de dependencias y entrada del proceso.
- `src/channels/cli/run.ts`: salida de consola y códigos de error; sin reglas de dinero.
- `src/infrastructure/environment.ts`: lectura opcional de `.env`, precedencia del
  entorno y bloqueo ante otros errores de lectura.
- `tests/config.test.ts` y `tests/bootstrap.test.ts`: 20 pruebas de configuración,
  errores, valores privados ficticios y arranque real del proceso.
- `package.json`, `package-lock.json`, `tsconfig*.json`, `eslint.config.mjs`,
  `.prettierrc.json`, `.prettierignore`, `.npmrc`, `.node-version` y `.nvmrc`:
  dependencias fijadas, compilación, herramientas y versión de referencia.
- `.gitignore`, `.gitattributes` y `.env.example`: exclusión de secretos/artefactos,
  finales de línea LF reproducibles y configuración de ejemplo sin credenciales.
- `.github/workflows/ci.yml`: checks en Windows/Linux, sin secretos, con permiso
  de lectura y sin persistir credenciales de checkout.
- `README.md`, `AGENTS.md`, `CODEX_START_PROMPT.md` y `ROADMAP.md`: comandos reales,
  alcance implementado y referencias corregidas a las especificaciones de la raíz.
  Las reglas financieras de `PRODUCT_RULES.md` no se modificaron.

## Entorno y comandos ejecutados

Entorno inicial: Windows/PowerShell, Node **24.19.0**, npm **11.17.0**, Codex CLI
**0.154.0**. Se verificaron las versiones de dependencias mediante `npm.cmd view`
y compatibilidad en la documentación oficial enlazada en README.

La versión instalada de Node precede la actualización de seguridad 24.22.1.
Para ejecutar las verificaciones con la versión requerida se descargó
`node-win-x64@24.22.1` desde el registro npm con `npm.cmd pack`, comprobando la
integridad registrada por npm. Se extrajo a `.tools/package/bin/node.exe`.
`.tools/` está ignorado y no forma parte de la entrega versionable. No se modificó
Node global, la política de PowerShell ni las credenciales del sistema.

Prefijo PowerShell utilizado en esta máquina para las verificaciones:

```powershell
$env:Path = (Resolve-Path -LiteralPath .tools/package/bin).Path + [IO.Path]::PathSeparator + $env:Path
$jarvisNode = '.\.tools\package\bin\node.exe'
$jarvisNpmCli = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
& $jarvisNode $jarvisNpmCli ci
& $jarvisNode $jarvisNpmCli run check
& $jarvisNode $jarvisNpmCli run diagnose
& $jarvisNode $jarvisNpmCli run dev
& $jarvisNode $jarvisNpmCli start
& $jarvisNode $jarvisNpmCli audit
```

Ese prefijo solo afecta al proceso de terminal. En otra instalación con Node
24.22.1+ de la rama 24 en PATH, usar los comandos normales de README.

| Comando final          | Resultado observado                                                |
| ---------------------- | ------------------------------------------------------------------ |
| `npm ci`               | Correcto; instalación desde lockfile, sin scripts de terceros      |
| `npm run format`       | Correcto; código, configuración y README formateados               |
| `npm run format:check` | Correcto; ejecutado dentro de `check`                              |
| `npm run lint`         | Correcto; cero warnings, dentro de `check`                         |
| `npm run typecheck`    | Correcto; dentro de `check`                                        |
| `npm test`             | Correcto; **20/20**, sin omitidas ni llamadas a APIs               |
| `npm run build`        | Correcto; solo aplicación a `dist/`, dentro de `check`             |
| `npm run check`        | Correcto; formato, lint, tipos, tests y build                      |
| `npm run diagnose`     | Código 0; configuración válida, IA disabled y servicios pendientes |
| `npm run dev`          | Código 0; mismo diagnóstico desde TypeScript                       |
| `npm start`            | Código 0; diagnóstico desde JavaScript compilado                   |
| `npm audit`            | Código 0; **0 vulnerabilidades conocidas** al verificar            |
| Migraciones            | No aplican: no hay DB ni migraciones en Fase 0                     |

## Incidencias encontradas y resueltas

- `npm --version` falló porque PowerShell bloquea `npm.ps1`. Se usó `npm.cmd`
  sin cambiar la política de ejecución.
- La primera consulta `npm.cmd view` falló con `EPERM` al intentar usar la caché
  fuera del workspace. Se repitió con caché local; `.npmrc` conserva esa solución.
- Las consultas al índice de Node mediante `Invoke-RestMethod` y `curl.exe`
  fallaron por la conexión TLS/credenciales Schannel del entorno. La verificación
  de versiones se hizo con fuentes oficiales en web y el binario local se obtuvo
  del registro npm, sin desactivar validaciones TLS.
- La primera instalación con Node 24.19.0 emitió `EBADENGINE`; los checks finales
  y la instalación reproducible se ejecutaron con Node 24.22.1.
- La primera auditoría devolvió 11 avisos moderados derivados de una vulnerabilidad
  de `minimatch@10.2.6` en herramientas de desarrollo. Se fijó `minimatch@11.0.3`
  mediante override, se reinstaló y se verificaron lint y auditoría; el resultado
  final fue cero avisos. Revisar ese override en la siguiente actualización.
- El primer `npm run check` pasó formato y lint pero falló el typecheck:
  `parseEnv` devuelve un diccionario con valores posiblemente indefinidos. Se
  corrigió el tipo del entorno leído y se repitió `check` completo con éxito.
- `git status --short` falló porque esta carpeta no tiene `.git`. No se inicializó
  Git, no se hicieron commits y no hay verificación de diff o historial de Git.

## Límites y reglas aplicadas

**Implementado y probado:** bootstrap, lectura y validación local, CLI, errores
sin valores privados y herramientas. **Simulado:** únicamente datos ficticios y
salidas capturadas en tests; no hay proveedor de IA falso todavía.

**Pendiente:** Telegram, autorización de propietario, PostgreSQL, idempotencia de
movimientos, finanzas, adaptador de IA falso/real y políticas de presupuesto.
**No verificado:** ejecución del workflow en GitHub, Linux y despliegue. La CI
requiere publicar primero el repositorio; no se creó infraestructura ni se habilitó
facturación. La licencia definitiva sigue pendiente de decisión.

Se aplican [PRODUCT_RULES.md](PRODUCT_RULES.md) **§1** (instancia y credenciales
propias), **§12** (sin ruta de IA elegible no se envían datos; IA deshabilitada) y
**§14** (exclusiones del MVP). **§2/§4** guían el próximo flujo de cuota confirmada
con una sola salida de caja; no se afirma que esas reglas ya estén implementadas.
La aplicación y los tests actuales no contactan proveedores ni generan consumo
de IA. Los controles reales de gasto, privacidad contractual y acceso Telegram
se implementarán y probarán al añadir esas integraciones.

Se utilizó un subagente `security_reviewer` para análisis independiente y revisión
final de solo lectura: sin hallazgos concretos. No editó archivos ni ejecutó tests;
el coordinador implementó y verificó el cambio. La segunda tarea de tests se
mantuvo en el coordinador porque dependía de los contratos recién creados.

Siguiente incremento: Fase 1, «pagué 250.000 de la cuota del iPhone», con datos
ficticios, migración, confirmación, permisos, transacción idempotente y reporte de
caja sin duplicación, antes de conectar una API de IA real.
