# Fase 1B — entrega y verificación

Rama `feat/agent-registry-gateway`. Se verificó que el
[PR #3](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/3) está MERGED en main,
commit `d96ae46788bdfeda0b0634dd1c7ddc462897dfb1`. Se actualizó main por fast-forward
y se creó la rama antes de modificar código. No se cambian protecciones.

## Alcance implementado

- `src/agents/registry.ts`: configuración local explícita, IDs por instancia,
  conexión permitida, capabilities/grants/schemas coherentes y snapshots inmutables.
- `src/agents/validation.ts` y `json.ts`: JSON acotado, envelopes estrictos, versión,
  perfil sin pago, schemas síncronos, canonicalización y hash de comandos.
- `src/agents/gateway.ts`: reservas en memoria, single-flight, caché transitoria,
  pending/polling, timeout/abort, reintentos y cooldown con límites de capacidad.
- `src/agents/errors.ts` y `transport.ts`: errores locales seguros y puerto de
  transporte inyectado. No hay cliente HTTP o servicio de agente ficticio.
- `src/app/agent-execution.ts`: actor autenticado separado del payload, coherencia
  y permisos antes de Gateway. El adaptador debe autenticar al actor; no es un
  servicio nuevo de autenticación ni está conectado a Telegram.
- `src/app/agent-demo.ts` y script `agents:demo` en `package.json`: composición
  simulada sin .env/red/secretos que imprime `mode: simulated` y termina.
- `tests/agent-gateway.test.ts`, `agent-registry.test.ts`, `agent-execution.test.ts`
  y `agent-runtime.fixtures.ts`: fixtures y pruebas de integración/seguridad de
  runtime. Se conservan los tests previos y el snapshot financiero.
- Documentación de estado, [guía operativa](AGENT_RUNTIME.md), arquitectura,
  protocolo y roadmap actualizados. En `protocol.ts` solo cambia el comentario
  de estado de los puertos, sin modificar el wire contract.

## Semántica verificada

La reserva precede al primer await. Duplicados concurrentes comparten trabajo;
una clave con comando distinto da conflicto409. Cancelación de un caller no
cancela otros; la del último registra tombstone antes de abortar, incluso ante
callbacks reentrantes. Timeout/abort después del dispatch produce resultado
incierto, no prueba de que el agente no ejecutó. No se acepta una respuesta tardía
ni se reejecuta la clave automáticamente.

Plazos de intento, compartido y caller se comprueban con reloj, además de timers.
TTL elimina activamente outputs y comprueba expiración al acceder; quedan solo
metadatos. Pending caduca a 24 h sin renovarse por polling. Reservas, índices,
cooldowns y joins acumulativos están acotados y no se expulsan claves inciertas
para admitir nuevas operaciones. Todo se pierde al cerrar/reiniciar.

## Validación ejecutada

Se usaron Node 24.22.1 y npm 11.17.0 del entorno local preparado, sin cambiar la
instalación global ni leer .env. Los tests siempre usan funciones falsas y datos
ficticios, sin APIs externas.

| Comando/control                   | Resultado local final                                                    |
| --------------------------------- | ------------------------------------------------------------------------ |
| `npm ci`                          | Correcto; misma resolución de dependencias, auditoría 0 vulnerabilidades |
| `npm run format` / `format:check` | Correctos                                                                |
| `npm run lint`                    | Correcto; cero warnings                                                  |
| `npm run typecheck`               | Correcto; incluye los contratos estáticos previos                        |
| `npm test`                        | **185/185**; 110 previas y 75 nuevas, sin omitidas ni fallos             |
| `npm run build`                   | Correcto                                                                 |
| `npm run check`                   | Correcto; ejecutó formato, lint, tipos, tests y build                    |
| `npm run agents:demo`             | Código 0, modo simulated y status completed                              |
| `node dist/app/agent-demo.js`     | Código 0, mismo resultado simulado                                       |
| Enlaces/snapshot                  | Incluidos en los tests: destinos/fragments y hash/literalidad financiera |

Las 75 nuevas pruebas se distribuyen en 48 de Gateway y 27 de Registry, schemas y
Core. El primer check completo se detuvo por cuatro observaciones de lint
(imports de tipo y declaraciones const); se corrigieron y se repitió la secuencia
completa con éxito. La CI remota se verifica después de abrir el PR; consultar sus
checks Windows/Linux para el estado actual, sin inferirlo del éxito local.

Se ejecutaron durante el desarrollo los tests independientes de Gateway y los
de Registry/Core, además de typecheck. Se encontraron y corrigieron carreras de
cooldown ampliado por otro flight, plazos vencidos antes de ejecutar timers,
TTL retrasado y callbacks acumulados por abort/rejoin. Se añadieron regresiones,
incluida configuración accidental de parser asíncrono sin unhandledRejection.
La revisión de seguridad final no tiene bloqueos pendientes en el alcance simulado.

## Límites y siguiente corte

No cambian Telegram, su flujo/respuestas o comandos existentes. Solo se añade la
demo explícita. Sin nuevas dependencias, DB, Dispatcher, scheduler, MCP, IA,
finanzas, vuelos, deportes, repositorios externos, facturación o despliegue.
La ventana de caché de outputs se configura explícitamente y no equivale a archivo
permanente. No hay idempotencia de negocio ni garantía exactamente-una-vez.

Rigen [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/12: separación
de dominios, autorización, secretos, perfil no-paid-services, incertidumbre,
minimización, contratos, idempotencia y estados honestos de implementación.
La autenticación HTTPS real, DNS/IP/TLS y conexión con un agente ficticio
independiente corresponden a Fase 1C. Replay/eventos y persistencia durable,
a Fase 3. El PR se deja abierto para revisión y merge manual, sin auto-merge.
