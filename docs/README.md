# Sir Jarvis — documentación y arranque

Un orquestador personal de agentes de inteligencia artificial, open source, modular
y autogestionado, que permite conectar, controlar y recibir información de agentes
independientes mediante una interfaz conversacional.

## Identidad y principios

1. Jarvis no contiene la lógica de negocio específica de los agentes.
2. Cada agente puede funcionar y probarse sin Jarvis.
3. Puede tener repositorio, lenguaje, base de datos, licencia y alojamiento propios.
4. Los contratos son estandarizados y versionados.
5. Jarvis centraliza permisos, conversaciones, coordinación y notificaciones.
6. Privacidad y seguridad tienen prioridad sobre costo o disponibilidad.
7. Mantener costos bajos y recursos acordes con consumo medido.
8. Objetivo open source y autogestionado; licencia definitiva aún pendiente.
9. Ninguna integración genera gastos sin autorización expresa y presupuesto.
10. Nuevos agentes se incorporan detrás de contratos sin modificar el núcleo
    innecesariamente.

El [roadmap de Jarvis](ROADMAP.md) es independiente del de
[Finance Agent](agents/FINANCE_AGENT_ROADMAP.md). Su negocio y sus datos no se
mueven al núcleo. Sus [reglas completas](agents/FINANCE_AGENT_SPEC.md), la
[copia original](history/PRODUCT_RULES_FINANCE_V0.1.md) y la
[trazabilidad](agents/FINANCE_AGENT_TRACEABILITY.md) conservan las decisiones previas.

## Estado actual

Fase 0 y Telegram de Fase 1A implementados y fusionados. El operador reportó
aceptación real exitosa el 2026-11-02; los tests automatizados usan Telegram
simulado. Fase 1B aporta Registry/Gateway en memoria, validadores y un caso de uso
autorizado con transporte falso, sin cambiar respuestas o flujos del bot. Fase 1C
añade transporte HTTPS real contra un fixture independiente temporal. No hay
agentes de dominio, eventos durables, IA ni persistencia. AWS/Lightsail es la
estrategia principal documentada; no se contrataron servicios ni accedió a la cuenta.

La arquitectura y su diagrama están en [ARCHITECTURE](ARCHITECTURE.md), el contrato
en [AGENT_PROTOCOL](AGENT_PROTOCOL.md) y el plan de recursos en
[DEPLOYMENT_STRATEGY](DEPLOYMENT_STRATEGY.md). Las referencias a finanzas en los
mensajes actuales indican funcionalidad pendiente; no implican un módulo interno
ni integración con Finance Agent.

## Arranque local sin credenciales

Desde la raíz del repositorio, con Node **24.22.1+ de la rama 24 LTS** y npm 11/12:

```sh
npm ci
npm run diagnose
npm run check
npm start
```

`npm ci` necesita el registro npm para instalar el lockfile. Diagnóstico y pruebas
no hacen solicitudes externas. `npm run check` compila antes de `npm start`.
En PowerShell, usa `npm.cmd` si la política bloquea `npm.ps1`; no hace falta
modificar la política. Las versiones fijadas están en [package.json](../package.json),
[.node-version](../.node-version) y [.nvmrc](../.nvmrc), sin dependencias nuevas aquí.

`dev`, `diagnose` y `start` siguen imprimiendo el diagnóstico de Fase 1A y terminan.
La capacidad Telegram indica `available-not-connected`: no prueba conectividad
ni revela token. Finanzas/persistencia aparecen pendientes e IA deshabilitada.
La nueva ejecución simulada se demuestra por separado, sin cambiar ese contrato:

```sh
npm run agents:demo
```

Responde `{"mode":"simulated","status":"completed"}` y termina, sin `.env`,
credenciales o red. [Composición, concurrencia y límites](AGENT_RUNTIME.md).

Para HTTPS real entre procesos, sin claves propias ni llamadas públicas:

```sh
npm run agents:https:demo
```

Inicia un servidor independiente temporal, genera CA/certificado/token en memoria,
ejecuta `echo.reply` desde el Core y limpia procesos. Devuelve
`{"mode":"https-local-test","status":"completed","executions":1}`.
La excepción de loopback existe únicamente en tests, fuera del build;
TLS y hostname se comprueban. [Guía HTTPS](AGENT_RUNTIME.md#transporte-https-de-fase-1c).

## Telegram y configuración

Para el bot propio sigue [TELEGRAM.md](TELEGRAM.md), incluida la configuración en
BotFather. Conserva tu `.env` existente; copia [.env.example](../.env.example) solo
si no existe. El entorno del proceso prevalece sobre el archivo local.

| Variable                    | Uso                                                    |
| --------------------------- | ------------------------------------------------------ |
| `NODE_ENV`                  | development/test/production; default development       |
| `JARVIS_TIMEZONE`           | Zona válida para Node/Intl; default America/Bogota     |
| `JARVIS_AI_MODE`            | Solo disabled                                          |
| `TELEGRAM_BOT_TOKEN`        | Requerida únicamente al iniciar Telegram; token propio |
| `TELEGRAM_ALLOWED_USER_IDS` | Requerida para Telegram; IDs numéricos explícitos      |

```sh
npm run telegram
```

Alternativa compilada: `npm run build` y `npm run telegram:start`. Solo esos
comandos se conectan a Telegram. No cambian tu bot, webhook ni preferencias.
Ctrl+C cancela peticiones y esperas. El diagnóstico no requiere credenciales.

La demo HTTPS no necesita variables nuevas. Una composición servidor aprobada
puede mapear explícitamente referencias de credenciales a variables propias;
ver [resolver server-only](AGENT_RUNTIME.md#transporte-https-de-fase-1c).
No publiques tokens, comprobantes ni datos financieros en logs/commits. La
autorización sigue limitada a chats privados de los IDs permitidos; una allowlist
plural no implementa aislamiento multiusuario.

## Capas y preparación técnica

```text
src/
  app/                 # composición y respuestas actuales
  channels/cli/        # diagnóstico
  channels/telegram/   # transporte existente
  infrastructure/      # entorno local
  agents/              # protocolo, Registry/Gateway, transporte fake y HTTPS
tests/                 # fakes, HTTPS local independiente y conservación documental
docs/agents/           # requisitos de aplicaciones externas, sin implementación
docs/history/          # snapshot financiero inmutable
```

El contrato describe solicitudes, resultados completados/pendientes/fallidos,
eventos, correlación e idempotencia. Sus tipos siguen siendo puros; Fase 1B añade
validación runtime estricta de ejecuciones y schemas de capacidades ficticias,
reservas concurrentes, cancelación y estados inciertos. Los eventos todavía no se
procesan. Se conservan fixtures estáticos, snapshot financiero y enlaces verificados.
HTTPS se verifica contra un proceso ficticio, sin DB nueva, MCP o cola distribuida.

## Herramientas y evidencia

| Comando                                       | Resultado esperado                                         |
| --------------------------------------------- | ---------------------------------------------------------- |
| `npm run dev` / `npm run diagnose`            | Diagnóstico desde TS                                       |
| `npm run build` / `npm start`                 | Compilar / ejecutar diagnóstico JS                         |
| `npm run telegram` / `npm run telegram:start` | Bot TS / compilado con configuración propia                |
| `npm run agents:demo`                         | Demostración local con transporte falso y sin credenciales |
| `npm run agents:https:demo`                   | HTTPS real con proceso ficticio temporal, sin red pública  |
| `npm run format` / `npm run format:check`     | Aplicar / comprobar formato                                |
| `npm run lint` / `npm run typecheck`          | Lint y tipos, incluidos contratos estáticos                |
| `npm test`                                    | Tests sin APIs reales ni claves                            |
| `npm run check`                               | Formato, lint, tipos, tests y build                        |
| `npm audit`                                   | Consulta de vulnerabilidades conocidas                     |

ESLint, TypeScript, Prettier y Zod conservan las versiones del lockfile. La caché
local y `ignore-scripts` de [.npmrc](../.npmrc) permanecen. Snapshot y bloque
normativo de Finance Agent se excluyen de Prettier para preservar texto exacto;
los tests verifican hash e inclusión íntegra.

- [Verificación de Fase 0](PHASE_0_VALIDATION.md), registro histórico.
- [Verificación de Fase 1A](PHASE_1A_VALIDATION.md), automatizada y aceptación reportada.
- [Verificación de Fase 1A.5](PHASE_1A5_VALIDATION.md), registro histórico de arquitectura.
- [Verificación de Fase 1B](PHASE_1B_VALIDATION.md), registro del Gateway en memoria.
- [Verificación de Fase 1C](PHASE_1C_VALIDATION.md), HTTPS real local y pruebas.
- [Plan AWS](AWS_DEPLOYMENT_PLAN.md), costos, créditos y preparación sin desplegar.
- [Instrucciones Codex](AGENTS.md) y [flujo de Git](GIT_WORKFLOW.md).
- [Prompt de Fase 1B](prompts/PHASE_1B_PROMPT.md).

La CI conserva los checks obligatorios Windows/Linux, sin secretos y sin iniciar
el bot. `main` se integra por PR, sin force push ni auto-merge. Los subagentes de
Codex trabajan en desarrollo; los agentes del producto son aplicaciones externas
en ejecución. Ver [PRODUCT_RULES](PRODUCT_RULES.md), ORC-01…ORC-12.
