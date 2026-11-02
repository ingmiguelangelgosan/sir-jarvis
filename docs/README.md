# Jarvis — asistente personal autogestionado

**Estado:** Fase 0 y Fase 1A implementadas: diagnóstico local y adaptador de texto
por Telegram con acceso restringido. IA, base de datos y finanzas siguen pendientes.
El diagnóstico termina tras imprimir el resultado; el proceso Telegram se inicia
explícitamente con `npm run telegram`. Sus pruebas usan Telegram simulado; falta
la prueba manual con credenciales propias. Consulta [TELEGRAM.md](TELEGRAM.md).

Jarvis busca ser un asistente personal open source, self-hosted y de bajo costo.
Comienza por texto en Telegram y después finanzas conversacionales. Cada instalación usará sus
propios recursos y credenciales; voz, imágenes, Calendar y web/PWA vendrán después.
La licencia definitiva sigue pendiente: `UNLICENSED` y `private: true` evitan
presentar una licencia aprobada o publicar accidentalmente el paquete en npm.

## Arranque local

Requisitos: **Node.js 24.22.1 o posterior de la rama 24 LTS** y npm 11 o 12.
Las versiones de referencia están en `.node-version`, `.nvmrc` y `package.json` en la raíz.
No hacen falta API keys, Telegram, PostgreSQL, Docker ni recursos en la nube.

Desde la raíz del proyecto:

```sh
npm ci
npm run diagnose
npm run check
npm start
```

`npm ci` instala exactamente el lockfile; necesita acceso al registro npm la primera
vez. El diagnóstico y las pruebas no hacen solicitudes externas. El comando
`telegram` se conecta únicamente a la Bot API de Telegram al iniciarlo expresamente.
`npm run check` incluye compilación y debe ejecutarse antes de `npm start`.
En PowerShell, si la política impide ejecutar `npm.ps1`, usa **`npm.cmd`** en los
mismos comandos; no es necesario modificar la política de ejecución.

El resultado esperado de `diagnose`, `dev` y `start` es:

```json
{
  "application": "jarvis",
  "phase": "1A",
  "status": "bootstrap-ready",
  "checks": {
    "configuration": "valid"
  },
  "capabilities": {
    "telegram": "available-not-connected",
    "persistence": "not-implemented",
    "finance": "not-implemented",
    "ai": "disabled"
  }
}
```

Esto verifica que el proceso arranca y la configuración es válida. No prueba
conectividad ni salud de servicios todavía no implementados. Una configuración
inválida produce un mensaje sin valores privados en stderr y código de salida 1.

## Configuración

El archivo `.env` es opcional. Para personalizarlo en PowerShell:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

En Linux/macOS: `cp .env.example .env`. El archivo se lee desde el directorio de
trabajo; ejecuta los comandos desde la raíz. Las variables del proceso prevalecen
sobre `.env`. Un error de lectura distinto de archivo inexistente impide iniciar.

| Variable          | Predeterminado   | Valores aceptados                     |
| ----------------- | ---------------- | ------------------------------------- |
| `NODE_ENV`        | `development`    | `development`, `test`, `production`   |
| `JARVIS_TIMEZONE` | `America/Bogota` | Zona horaria reconocida por Node/Intl |
| `JARVIS_AI_MODE`  | `disabled`       | Solo `disabled` en esta fase          |

Los valores vacíos de las variables del diagnóstico se rechazan. Para iniciar
Telegram se requieren además `TELEGRAM_BOT_TOKEN` y `TELEGRAM_ALLOWED_USER_IDS`;
solo ese comando las valida y utiliza. No hacen falta claves para diagnóstico o
tests. Las variables desconocidas no habilitan integraciones. `.env` y sus variantes, logs, comprobantes y backups
locales se excluyen de Git; solo `.env.example` se incluye.

## Estructura y capas

```text
src/
  app/                 # configuración, respuestas deterministas y composición
  channels/cli/        # entrada/salida de consola y códigos de salida
  channels/telegram/   # autorización, traducción, HTTP y long polling
  infrastructure/      # lectura local de .env, sin modificar process.env
tests/                 # configuración, CLI real y errores; datos ficticios
.github/workflows/     # CI para Windows y Linux
```

`main.ts` compone el diagnóstico y `telegram-main.ts` el proceso del bot. El núcleo
`assistant.ts` responde sin depender de Telegram. El reporte local no contiene
credenciales y no conecta servicios. El canal autoriza antes de llamar al núcleo y
no contiene reglas financieras. Dominio financiero, adaptadores de IA y persistencia se
añadirán con el siguiente flujo; no se crean carpetas vacías ni contratos financieros
prematuros. Los límites previstos están en [ARCHITECTURE.md](ARCHITECTURE.md).

## Dependencias y herramientas

Versiones contrastadas con el registro npm el **2026-11-01**, fijadas sin rangos y
con resolución transitiva en `package-lock.json`:

| Dependencia       | Versión | Uso                            |
| ----------------- | ------- | ------------------------------ |
| Zod               | 4.6.7   | Validación de configuración    |
| TypeScript        | 6.0.3   | Comprobación estricta y build  |
| `@types/node`     | 24.19.2 | Tipos de la rama de Node usada |
| ESLint            | 10.14.0 | Lint                           |
| `@eslint/js`      | 10.0.1  | Reglas recomendadas            |
| typescript-eslint | 8.72.1  | Análisis de TypeScript         |
| Prettier          | 3.9.10  | Formato                        |

Se usa TypeScript 6.0.3 porque typescript-eslint declara soporte `<6.1.0`, aunque
el registro ya ofrece TypeScript 7. [Compatibilidad oficial](https://typescript-eslint.io/users/dependency-versions/).
Node 24 continúa siendo [LTS](https://nodejs.org/en/about/previous-releases);
24.22.1 incorpora [correcciones de seguridad](https://nodejs.org/en/blog/release/v24.22.1).

El `override` de desarrollo `minimatch@11.0.3` evita la versión transitiva afectada
por [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Revisarlo al actualizar ESLint/typescript-eslint y retirarlo cuando sus rangos
incluyan la corrección. Su compatibilidad con este proyecto se verifica al ejecutar
el lint. No se aplica `npm audit fix --force` ni se degradan las herramientas.

Para volver a consultar versiones: `npm view typescript version` y
`npm view typescript-eslint peerDependencies --json`.
`.npmrc` mantiene la caché en `.npm-cache/` y deshabilita scripts de instalación;
las dependencias actuales no los requieren. No incluye tokens de registro.

| Comando                  | Resultado                                                |
| ------------------------ | -------------------------------------------------------- |
| `npm run dev`            | Ejecutar el diagnóstico directamente desde TS            |
| `npm run diagnose`       | Diagnóstico explícito, sin compilar                      |
| `npm run build`          | Compilar solo `src/` a `dist/`                           |
| `npm start`              | Ejecutar el diagnóstico compilado                        |
| `npm run telegram`       | Iniciar el bot desde TypeScript con credenciales propias |
| `npm run telegram:start` | Iniciar el bot compilado después de `build`              |
| `npm run typecheck`      | Comprobar tipos de aplicación y tests sin emitir JS      |
| `npm run lint`           | Revisar TS y configuración JS, sin warnings              |
| `npm run format`         | Formatear código, README y configuración                 |
| `npm run format:check`   | Verificar formato                                        |
| `npm test`               | Ejecutar tests con el runner nativo de Node              |
| `npm run check`          | Formato, lint, tipos, tests y build en secuencia         |
| `npm audit`              | Consultar vulnerabilidades conocidas en dependencias     |

Las pruebas usan objetos de entorno ficticios, archivos temporales y procesos
locales de Node, sin llamadas reales a proveedores. Cubren arranque sin `.env`,
precedencia, valores inválidos, rechazo de IA habilitada, errores de lectura y
ausencia de secretos en la salida. Telegram añade tests de autorización, comandos,
duplicados, límites, errores, cancelación y contratos HTTP con `fetch` falso.
Las reglas financieras todavía no están
implementadas ni simuladas en estas pruebas.

La CI ejecuta `npm ci`, `npm run check`, `npm run diagnose` y `npm start` en Windows
y Linux, con permisos de lectura y sin secretos. No se modificó el workflow para
Telegram: `start` sigue siendo un diagnóstico sin red ni credenciales. El resultado
de esta entrega se registra en [PHASE_1A_VALIDATION.md](PHASE_1A_VALIDATION.md) y en
los checks del PR. No hay migraciones en Fase 1A.

## Reglas aplicadas y siguiente incremento

La fuente funcional es [PRODUCT_RULES.md](PRODUCT_RULES.md):

- **§1:** instalación por operador con credenciales propias; diagnóstico sin keys.
- **§12:** sin proveedor habilitado ni llamadas a IA; intentar activarla en esta
  fase impide iniciar. Las políticas contractuales, el router y los controles de
  presupuesto reales siguen pendientes para integrar una API elegible.
- **§14:** sin banca, transferencias, modelos locales ni entrenamiento privado.
- **§2 y §4:** el próximo pago debe ser una única salida de caja confirmada,
  vinculada a la deuda sin duplicar consumo; ningún movimiento se registra aún.

Tras esta integración de Telegram, el siguiente incremento financiero será
**«pagué 250.000 de la cuota del iPhone»**:
propietario Telegram autorizado, interpretación con proveedor falso, confirmación,
PostgreSQL con migración y transacción idempotente, cantidad decimal exacta y
moneda ISO 4217. Debe crear un movimiento aplicado a una cuota, reducir el saldo
de referencia y aparecer una vez en caja mensual; repetir el mismo evento no debe
duplicarlo. Pruebas incluirán pagos duplicados, permisos y separación entre capital
e intereses conocidos o saldo estimado. Una API real esperará verificación de
privacidad y costos. Consulta [ROADMAP.md](ROADMAP.md).

Las instrucciones de trabajo están en [AGENTS.md](AGENTS.md) y el prompt de arranque
en [CODEX_START_PROMPT.md](CODEX_START_PROMPT.md). Esta distribución no contiene
`CODEX_WORKFLOW.md` ni perfiles `.codex/agents`; no son requisitos para ejecutar
Jarvis. La capacidad de subagentes depende de la sesión de Codex disponible.
