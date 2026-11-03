# Fase 1D — Telegram, Core y agente HTTPS independiente

## Prerrequisitos y alcance

Se verificó en GitHub que [PR #5](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/5)
está MERGED, commit `d75f3b87d256636b7fe3b3d8950778ff325e1caf`, antes de modificar
el proyecto. Se actualizó main por fast-forward, con árbol limpio, y se creó
`feat/telegram-agent-orchestration`. No se modifica protección de main, CI,
dependencias o lockfile; sin force push, merge o auto-merge.

Fase 1D conecta el canal Telegram existente con `AgentExecutionService`, Registry,
Gateway y transporte HTTPS de Fase 1C. Es una integración opcional y apagada por
defecto, con comandos deterministas, sin IA ni interpretación libre. La evidencia
principal recorre **Telegram simulado → Core → Gateway → proceso Echo HTTPS
independiente → respuesta simulada de Telegram**, no solo piezas aisladas.

## Archivos y decisiones

- `src/app/agent-read.ts`: caso de uso conversacional de lectura, filtrado de
  agentes/capacidades, autorización previa al Gateway y mensajes seguros. Adapta
  únicamente `echo.reply` 1.0 con schemas `demo.input.v1`/`demo.output.v1`.
- `src/app/telegram-agents.ts`: configuración estricta, bindings internos,
  allowlist de conexiones, composición de Registry/Core/Gateway/HTTPS y cierre.
  Lee solo el archivo local configurado al activar la integración, con límite
  64 KiB y errores fijos. No hay registro por mensajes o auto-discovery.
- `src/channels/telegram/agent-commands.ts`: sintaxis `/agents` y
  `/agent <agente> <capacidad> <texto>`, actor interno y IDs HMAC por acción.
- `src/channels/telegram/handler.ts`, `polling.ts` y `runtime.ts`: instalación
  opcional después de allowlist/chat privado, reserva síncrona de mensajes,
  callback asíncrono, envío serializado y paso del bot ID autenticado.
- `src/app/telegram-main.ts`: carga opcional antes del polling, sin cambios de
  respuestas `/start`, `/status` o fallback. Cierra los recursos en `finally`.
- `src/agents/credentials.ts`: permite un mapa vacío para arrancar sin agentes;
  resolver referencias desconocidas continúa fallando cerrado. No cambia la
  implementación del Gateway, protocolo o transporte HTTPS de Fase 1C.
- `.env.example`, `.gitignore` y `config/agents.example.json`: flag false,
  variables sin secretos y plantilla ficticia deshabilitada. `.local/` excluida
  de Git para configuración propia con bindings privados.
- `tests/agent-read.test.ts`, `telegram-agent-config.test.ts`,
  `telegram-agent-handler.test.ts`, `telegram-agents.e2e.test.ts` y
  `telegram-agent-supervisor.test.ts`: nuevas pruebas de permisos, configuración,
  concurrencia, límites, error/cancelación y recorrido HTTPS real.
- `tests/run-telegram-agents-demo.ts`, `run-telegram-agents-live.ts` y scripts
  nuevos en `package.json`: demo automática sin red pública y supervisor manual
  explícito para el operador. Los scripts de testing no entran en `dist/`.
- README, índice, Telegram, runtime, arquitectura, roadmap e instrucciones:
  estado implementado, guía manual y Fase 1E previa al despliegue sensible.
  PRODUCT_RULES solo añade el estado de Fase 1D a ORC-12; reglas de producto y
  requisitos financieros preservados.

## Autorización, privacidad y costos

El handler valida allowlist numérica, chat privado, from/chat coherentes y ausencia
de sender_chat antes del callback. El texto nunca decide la identidad: binding
local único por ID permitido → alias `subject_ref` opaco no numérico. Solo se
envían instancia/sujeto y IDs opacos del protocolo; no IDs de Telegram, token del
bot, referencias de secretos o configuración de conexión.

El caso de uso valida permiso, agente habilitado/disponible y capacidad read antes
de `AgentExecutionService`; Core y Gateway conservan sus propias validaciones.
Una capacidad write llamada `echo.reply` también se bloquea. `/agents` solo muestra
IDs públicos/capacidades soportadas y autorizadas, sin nombres/descripciones libres,
URLs o referencias; limita la lista a un mensaje. Ningún resultado amplía permisos.

Input de Echo: texto no vacío de 1–128 unidades UTF-16, sin controles, bidi,
formato invisible o surrogate aislado. El output debe coincidir exactamente con
ese texto aprobado para mostrarse; no se presentan campos/instrucciones arbitrarios.
Telegram recibe texto plano sin markup/previews. `pending` y errores se presentan
sin IDs internos, detalles técnicos, secretos o afirmaciones falsas de éxito.
No se añade polling automático ni comando de operación pendiente.

Perfil `no-paid-services` siempre obligatorio. Bearer por agente y clave HMAC
propia separados: no se admiten las variables del token Telegram/HMAC como Bearer
ni enviar el mismo valor HMAC mediante otro nombre de variable. HTTPS/TLS, DNS/IP,
SSRF, redirects y validación runtime siguen siendo los controles de Fase 1C.
No se usa AWS, contrata infraestructura, activa IA o genera cargos en las pruebas.

## Idempotencia, concurrencia y límites

La clave HMAC persistente configurada deriva request/correlation/idempotency de
namespace + instancia + sujeto + bot ID autenticado + chat/message locales. No
incluye texto, agente o capacidad, y los IDs numéricos no salen al agente. Cambiar
texto dentro del mismo scope conserva clave y produce409 en Gateway; cambiar
agente/capacidad del mismo mensaje se frena por la reserva del handler. Bot ID
estable evita cambios por renombrar el bot en polling; adaptadores directos sin
ese ID usan el username como namespace y deben conservarlo estable.

Clave, instancia y binding deben mantenerse para continuidad de IDs. Eso no
persiste reservas, offset o resultados: reiniciar pierde toda la memoria local.
La demo manual usa claves efímeras y no ofrece continuidad entre ejecuciones.
No se promete exactamente-una-vez, retención durable o idempotencia financiera.

Se reserva antes del primer await: duplicados concurrentes del mismo chat/mensaje
causan una ejecución y una respuesta. Las acciones de agentes tienen un índice
no expulsable de 1024 por handler; al llenarse se rechazan sin efecto y solo se
registra `telegram-agent-capacity`. Tráfico legacy no expulsa esas acciones.
Como máximo ocho consultas activas en el adaptador y 32 entregas en espera;
los envíos comparten ritmo/cooldown y solo reintentan429 de Telegram, sin consultar
otra vez al agente. Gateway conserva su límite independiente de 256 reservas.
La entrega incierta puede perderse, no se reenvía a ciegas.

Timeout/abort cancela la espera local y no prueba cancelación/fallo remoto. No se
responde tras abort global ni se reejecuta por recibir el mismo update. Los estados
inciertos del Gateway y sus límites/TTL de Fase 1B permanecen intactos. Solo lectura
en este corte para evitar efectos sensibles bajo estas limitaciones.

## Ejecución y evidencia

Con Node 24.22.1+ de la rama 24 y npm 11/12, desde la raíz:

```powershell
npm.cmd ci
npm.cmd run format
npm.cmd run check
npm.cmd run agents:telegram:demo
npm.cmd run agents:https:demo
npm.cmd run agents:demo
```

Demo de recorrido completo observada:

```json
{
  "mode": "telegram-simulated-https-local",
  "status": "completed",
  "executions": 1,
  "replies": 1
}
```

El test del supervisor ejecuta el script manual real con `fetch` de Telegram
simulado en un proceso aislado, sin `.env` del operador, y HTTPS real hasta Echo;
comprueba respuesta y cierre. No equivale a usar Telegram real. Certificados,
tokens y clave de pruebas son efímeros, sin escribirlos a disco o logs. Tests
negativos bloquean incluso fork/fetch si se intentan antes de validar la configuración.

| Verificación     | Resultado local final                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `npm ci`         | Correcto, 102 paquetes auditados y 0 vulnerabilidades conocidas                 |
| `npm run check`  | Correcto: formato, lint sin warnings, tipos, tests y build                      |
| Pruebas          | **343/343**, sin fallos, omitidas o canceladas                                  |
| Regresión        | Las 285 pruebas anteriores permanecen intactas y pasan                          |
| Nuevas           | 24 E2E, 12 caso de uso/HMAC, 11 configuración, 6 handler y 5 supervisor         |
| Enlaces/finanzas | 6 pruebas documentales incluidas; anchors y hash/inclusión financiera correctos |
| Demos            | Telegram simulado + HTTPS, HTTPS aislado y fake TS/JS: correctas, código 0      |
| Build            | Correcto; sin supervisor, fixture, PKI o política loopback de tests en `dist/`  |

Se utilizó Node **24.22.1** portable en `.tools/package/bin/node.exe` y npm
**11.17.0** en `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`, anteponiendo
`.tools/package/bin` al PATH del proceso, sin cambiar Node global. Los comandos
anteriores son equivalentes con esa versión instalada. No se ejecutó el
supervisor con credenciales del operador; su test usa entorno/Telegram simulados.
Se ejecutó además `git diff --check`, revisión de archivos y comprobación de que
Gateway/HTTPS/protocolo, dependencias, CI y snapshot no cambian.
La revisión de secretos se aplica al índice completo antes del commit. La CI
remota Windows/Linux se verificará en el PR y se documentará en su descripción;
no se infiere del éxito local. El PR queda para revisión manual sin auto-merge.

En verificaciones parciales se corrigieron un import de tipo observado por lint
y una fixture que declaraba versión/grant incompatibles; no fue un fallo de la
autorización productiva. La revisión independiente de seguridad no encontró
bloqueos en el alcance implementado.

## Prueba manual del operador y pendientes

La [guía Telegram](TELEGRAM.md#prueba-manual-con-telegram-real-y-echo-local) indica
cómo reutilizar su bot propio, detener otro poller y abrir una terminal dedicada:

```powershell
$env:NODE_ENV = 'development'
$env:JARVIS_TELEGRAM_AGENTS_ENABLED = 'true'
npm.cmd run telegram:agents:demo
```

Requiere token propio de Telegram y exactamente un ID autorizado en su entorno
privado. Desde el chat privado: `/agents` y
`/agent demo.echo echo.reply Hola Jarvis`. Esperado: `Respuesta del agente: Hola Jarvis`.
Ctrl+C cierra el servidor temporal y el bot; cerrar la terminal dedicada elimina
esa habilitación temporal. No se leen aquí sus credenciales ni se contacta su bot.
**Aceptación de Fase 1D con Telegram real: pendiente del operador.** La aceptación
Telegram de Fase 1A fue reportada por el operador y no prueba este flujo nuevo.

El bot normal puede usar configuración administrada con endpoint HTTPS aprobado,
CA, Bearer y clave HMAC propia estable; no permite localhost/loopback por env.
La excepción exacta de red local existe solo en los supervisores de testing,
fuera del build y sin desactivar TLS. No usar la demo con datos sensibles.

Siguiente corte: **Fase 1E, persistencia durable, Docker Compose y recuperación
local**, antes de AWS con efectos sensibles. Elegir almacenamiento mínimo,
probar reinicios/duplicados/conciliación, secretos/redes/TLS y backup/restore.
No se implementa DB o Compose aquí. Lightsail permanece como principal previsto;
Billing, créditos, región, presupuesto y recursos exactos requieren revisión y
autorización antes de cualquier despliegue.

Se aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/09/11/12:
fronteras, permisos, privacidad, costo cero autorizado, incertidumbre, minimización,
contratos, deduplicación, ausencia de avisos autónomos y portabilidad. No hay
Finance/Flight/Sports Agent, MCP, colas, microservicios, webhooks, IA o nuevas
reglas financieras dentro de Jarvis. Snapshot y trazabilidad deben seguir pasando.
