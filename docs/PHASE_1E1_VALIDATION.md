# Fase 1E.1 — estado durable, idempotencia y recuperación

## Base y alcance

Se verificó que [PR #6](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/6)
está MERGED en main, commit `ed793d6a5f4a4ceeb440b02c1935f0a1e0248c86`, antes
de implementar. Árbol limpio; main actualizado por fast-forward y rama
`feat/durable-agent-state`. Sin force push, cambios de protección o CI.

El criterio de aceptación es impedir que una reserva anterior se convierta en
una operación ejecutable nueva al reiniciar. Se añade persistencia alrededor del
Gateway y del canal existentes, sin cambiar el contrato HTTPS público. Registro,
permisos y secretos permanecen administrados localmente; la DB no incorpora datos
de Finance Agent u otros dominios. IA y servicios pagos permanecen deshabilitados.

## Arquitectura y archivos

- [ADR 0001](adr/0001-durable-state-sqlite.md): SQLite WAL frente a PostgreSQL para
  una VPS de 2 GB, sin prometer benchmarks o alta disponibilidad. `node:sqlite`
  es API release candidate en Node 24. No se añade ORM o dependencia.
- `src/agents/state-store.ts`: puerto del almacenamiento, solicitudes, hashes,
  transiciones, operaciones pending, acciones, offsets, vínculos y compactación.
- `src/infrastructure/sqlite-state-store.ts`: transacciones `BEGIN IMMEDIATE`,
  WAL/FULL, restricciones/propietarios, comprobación de esquema, integridad,
  permisos/identidad de archivos y errores sanitizados.
- `migrations/001_durable_state.sql`: esquema versionado y verificable. Hay que
  distribuir `migrations/` junto al árbol `dist/`, sin usar una DB de otro agente.
- `src/agents/durable-gateway.ts`: reserva durable previa a efectos, decorador
  del transporte para marcar started y recuperación conservadora de metadatos.
  El motor `gateway.ts` conserva sus semánticas y añade un observador opcional
  síncrono al asentarse el trabajo compartido, antes de hacer visible el resultado.
- `src/channels/telegram/durable-actions.ts`: journal de acciones/entregas con
  HMAC. `handler.ts`, `polling.ts` y `runtime.ts` admiten ese puerto; conservan
  controles de identidad, ritmo y deduplicación de sesión.
- `src/app/telegram-agents.ts` y `telegram-main.ts`: composición, fingerprints,
  apertura y cierre. Bot normal con agentes activos exige `JARVIS_STATE_FILE`;
  las demos/adaptadores programáticos sin almacén siguen explícitamente en memoria.
- `src/app/state-main.ts`, scripts `state:init`/`state:compact`, `.env.example`
  y `.gitignore`: inicialización exclusiva, revisión/compactación y rutas privadas.
- `src/app/agent-read.ts`: explica un completed conocido cuyo contenido ya no se
  conserva, sin reejecución o falsa incertidumbre sobre su estado terminal.
- Tests nuevos de SQLite, Gateway durable, Telegram durable, CLI y caídas reales;
  fixture de proceso aislado y limpieza de archivos temporales verificada.
- Arquitectura, protocolo, runtime, Telegram, roadmap, README e instrucciones:
  describen el alcance implementado y Fase 1E.2 pendiente. PRODUCT_RULES solo
  añade el estado de Fase 1E.1 en ORC-12; no cambia restricciones financieras.

## Estado y garantías

SQLite local mantiene tablas `executions`, `actions`, `offsets`, `bindings`,
`audit` y `schema_migrations`. Clave y comando se reservan de forma única antes
del primer efecto. Propietario y transiciones se verifican de manera transaccional.
Dos callers idénticos del proceso comparten el flight existente; otra conexión
o proceso encuentra la misma reserva y no adquiere permiso para despachar otra.
Reutilizar clave con comando distinto da conflicto, también tras compactación.

El hash del comando se protege con HMAC; se guardan contexto opaco, request,
correlation, operation y tiempos, **sin input, output, mensajes, secretos o IDs
Telegram en claro**. La cache transitoria del Gateway continúa en memoria y con
TTL explícito. Tras reapertura, completed sin output devuelve
`RESULT_EXPIRED/completed`; failed conserva código seguro. No inventar un output
ni volver a ejecutar para reconstruirlo.

Reserved/started anteriores son evidencia insuficiente y se rechazan como
inciertos. Un pending conserva contexto y plazo original, sin renovar 24 h ni
restaurar el índice privado del transporte HTTPS. Su consulta recuperada devuelve
estado local o timeout incierto; no hace GET remoto o nueva ejecución automática.
La conciliación remota recuperable queda pendiente de un incremento explícito.

El observador de resultado persiste la transición antes de devolver éxito. Un
fallo del almacén bloquea la ruta y no habilita fallback a memoria o éxito cacheado.
Cancelar un follower no cierra el ledger mientras otro caller espera. Al cancelar
el último después del dispatch se conserva incertidumbre y se ignoran resultados
tardíos. Un timeout nunca demuestra que el efecto externo no se ejecutó.

Telegram reserva un HMAC por acción autenticada antes del Core. Fases:
reserved, result-confirmed, delivery-pending, delivery-started, delivered,
delivery-rejected o delivery-uncertain. **Result-confirmed solo indica presentación
local preparada**, incluso si esa presentación es un error/timeout; el ledger de
ejecución es la autoridad del resultado remoto. Antes de cada send se confirma
delivery-started; solo un429 explícito permite reintentar la entrega.

Tras reiniciar, una acción existente no vuelve a ejecutar ni reenviar, incluso
si quedó pendiente. No se persiste una outbox de mensajes privados para reenvío;
puede perderse una respuesta. Se carga el offset durable al iniciar polling y se
avanza después del handler; un fallo al persistirlo detiene el flujo. El offset
numérico no es identidad personal; namespace de bot y acciones son HMAC. Cambios
de clave/instancia/bindings/bot exigen migración/conciliación, no otra DB silenciosa.

## Pruebas de reinicio y fallos

Las pruebas usan archivos temporales reales y Node separado, sin Docker, AWS,
token real o llamadas públicas. Se verifican:

- Cierre/reapertura de resultados terminales, pendientes y claves de acción.
- Seis procesos de SQLite compitiendo por una reserva y dos coordinadores sobre
  el mismo archivo; solo una reserva obtiene ownership para efectos.
- Caída forzada de un proceso tras reservar, al entrar al transporte, al recibir
  un resultado falso antes del commit y después del commit confirmado. El padre
  reabre WAL y prueba duplicados concurrentes sin autorizar otro dispatch.
  El efecto remoto de esas cuatro fronteras está **simulado**; la caída de proceso
  y los archivos son reales. No equivalen a pérdida física de energía o de disco.
- Telegram simulado → Core/Gateway → Echo HTTPS independiente real, seguido de
  reapertura; sin segunda consulta ni segunda entrega, incluidos429 e incertidumbre.
- Bot normal ejecutado en dos procesos, con Telegram simulado: recupera offset
  antes de getUpdates. Arranque sin DB o DB perdida falla antes de llamar Telegram.
- Fallos antes del dispatch, al confirmar resultado, antes/después del envío y
  al avanzar offset; ninguna ruta reconstruye historia mediante efectos remotos.
- Locks, corrupción, esquema futuro/incompatible, sustitución de archivo,
  permisos POSIX, compactación y metadatos pending con expiración no renovable.

## Comandos ejecutables y resultados

Desde la raíz, con Node 24.22.1+ de la rama 24:

```powershell
npm.cmd ci
npm.cmd run format
npm.cmd run check
node --test tests/sqlite-state-store.test.ts tests/durable-gateway.test.ts tests/durable-crash.test.ts tests/durable-telegram.test.ts tests/durable-cli.test.ts
npm.cmd run agents:telegram:demo
npm.cmd run agents:https:demo
npm.cmd run agents:demo
```

Estos tests proporcionan el procedimiento local reproducible de reinicios sin
credenciales. Las demos previas son memoria explícita y no demuestran durabilidad.
Para el bot normal, preparar directorio privado e inicializar exclusivamente según
[runtime](AGENT_RUNTIME.md#estado-durable-opcional-de-fase-1e1) antes de activar agentes.
`state:init` no lee `.env` ni crea servicios; rechaza un archivo existente. No
borrar una DB o usar create para resolver corrupción/pérdida de historia.

| Verificación    | Resultado local final                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| `npm ci`        | Correcto, 102 paquetes auditados, cero vulnerabilidades conocidas                   |
| `npm run check` | Correcto: formato, lint sin warnings, typecheck, tests y build                      |
| Pruebas         | **391/391**, sin fallos, omitidas o canceladas                                      |
| Regresión       | Las 343 pruebas anteriores permanecen intactas y pasan                              |
| Nuevas          | 20 SQLite, 9 Gateway durable, 4 caídas reales, 11 Telegram durable y 4 CLI/arranque |
| Documentación   | Seis tests de enlaces/anchors y conservación financiera incluidos y correctos       |
| Demos           | Telegram simulado + HTTPS, HTTPS aislado, fake TS y JS compilado: correctas         |

Entorno efectivo: Node **24.22.1**, SQLite **3.53.4** y npm **11.17.0**. Se usó
`.tools/package/bin/node.exe` y `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`,
anteponiendo el directorio portable al PATH del proceso, sin cambiar Node global.
También se ejecutó `git diff --check`. La revisión independiente de seguridad
no identificó bloqueos materiales en la versión final. Se revisan secretos y
artefactos privados del índice completo antes de publicar.

Durante verificación se corrigieron un import/variable de test observado por
lint, el mensaje fijo de configuración para mantener compatibilidad y limpieza
temporal de Windows con reintentos acotados tras cerrar handles. Se repitió la
secuencia conjunta con éxito. No se modificaron pruebas previas para ocultar fallos.
La CI Windows/Linux se verifica en el PR antes de dar por terminada la entrega;
no se infiere del éxito local. El PR queda abierto sin merge o auto-merge.

## Seguridad, retención y límites

Directorios privados y archivo creado exclusivamente 0600 en POSIX. Se rechazan
links, cambios de identidad del archivo abierto y sidecars inseguros; no se reparan
o sustituyen datos de forma automática. Windows requiere ACL privadas verificadas
por el operador: no se afirma que chmod pruebe aislamiento. SQLite no cifra datos;
proteger disco, cuenta y futuros backups. No habilitar tracing SQL con parámetros.

PRAGMA WAL, FULL y versión/checksum/estructura/quick_check se verifican. Busy timeout
250 ms por defecto, hasta1000 ms: las transacciones cortas síncronas pueden pausar
el event loop durante locks. No usar filesystem de red. La durabilidad depende de
fsync, SO y hardware; no se prometen exactly-once, recuperación de datos perdidos,
protección frente a rollback de backups o aislamiento multihost.

`state:compact` es manual y exige al menos siete días para detalles terminales.
Redacta contexto elegible y auditoría antigua; **conserva tombstones de claves,
hash y fase**. Pending/inciertos no se eliminan automáticamente. Cupos llenos
fallan cerrado sin expulsar claves. No existe borrado completo seguro ni limpieza
programada. La recuperación de backups antiguos exige conciliación antes de tráfico.

No habilita escritura de negocio, pagos, transferencias, IA, eventos externos,
scheduler, MCP, colas, microservicios o repositorios nuevos. No se modifican reglas
financieras, snapshot, configuración HTTPS, TLS/SSRF o perfil no-paid-services.
No se leyó `.env` del operador ni se probó su bot real; esa aceptación sigue separada.

## Siguiente incremento recomendado

Fase **1E.2**: Docker Compose local, backups coherentes de SQLite/WAL, restauración,
permisos/secretos/redes/TLS, rollback, reinicios y recuperación del host. Probar
restauración aislada y conciliación de operaciones inciertas antes de reabrir
tráfico; medir RPO/RTO. No desplegar AWS ni habilitar efectos sensibles por disponer
de persistencia. Lightsail sigue siendo proveedor principal previsto, sujeto a
revisión de Billing, créditos y autorización concreta de recursos.

Prompt sugerido: «Continúa desde main solo tras verificar el merge de Fase1E.1.
Implementa Fase1E.2: Compose y recuperación locales, backup coherente y restore
aislado del ledger sin repetir solicitudes/entregas inciertas. Conserva todos los
tests, lectura y no-paid-services. No despliegues AWS, no añadas dominios o pagos;
abre PR y verifica Windows/Linux sin merge ni auto-merge».

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/09/11/12:
fronteras de dominio, autorización, privacidad, no costos, incertidumbre, metadatos
mínimos, contratos, deduplicación, ausencia de notificaciones nuevas y portabilidad.
