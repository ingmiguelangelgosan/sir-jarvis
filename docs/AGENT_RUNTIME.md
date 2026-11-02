# Registry y Gateway — Fase 1B

Implementación local funcional con transporte falso inyectado. No hay HTTP con
agentes, servicio de agente ficticio, integración nueva con Telegram, DB ni IA.
El contrato de mensajes sigue siendo [protocolo 1.0](AGENT_PROTOCOL.md).

## Demo sin credenciales

Desde la raíz, con Node 24.22.1+ de la rama 24 y dependencias instaladas:

```sh
npm ci
npm run agents:demo
```

En PowerShell usa `npm.cmd` si corresponde. Resultado:

```json
{ "mode": "simulated", "status": "completed" }
```

La demo no lee `.env`, inicia Telegram o resuelve referencias de credenciales.
Usa configuración ficticia y un objeto con funciones simuladas en
[agent-demo.ts](../src/app/agent-demo.ts). Para comprobar el build puede ejecutarse
`npm run build` y `node dist/app/agent-demo.js`. `start`, `dev`, `diagnose` y los
comandos Telegram conservan su comportamiento anterior.

## Composición y autorización

1. [CapabilitySchemaCatalog](../src/agents/validation.ts) recibe IDs de schema y
   validadores locales síncronos, por ejemplo `z.strictObject`. No descarga ni
   ejecuta schemas del manifiesto. Rechaza coerción, defaults, transformación o
   descarte silencioso de campos. Parsers/refinamientos asíncronos no están soportados;
   un resultado Promise se rechaza y su rechazo se consume sin divulgarlo.
2. [InMemoryAgentRegistry](../src/agents/registry.ts) recibe un array explícito de
   registros, el catálogo y una lista exacta de orígenes HTTPS permitidos. Comprueba
   unicidad, versiones, capacidades, schemas existentes y grants coherentes, y
   guarda copias profundas inmutables. No hay auto-discovery, endpoints dinámicos,
   recarga, modificación remota o health checks. `available` es estado configurado
   para el fixture; `unknown`, `unavailable` y deshabilitado bloquean invocaciones.
3. [AgentExecutionService](../src/app/agent-execution.ts) recibe el actor separado
   del payload. **El adaptador servidor debe haber autenticado ese actor**: el
   caso de uso no autentica personas ni toma la identidad del mensaje. Valida
   instancia/sujeto y permisos de agente/capacidad antes de llamar al Gateway.
4. [InMemoryAgentGateway](../src/agents/gateway.ts) vuelve a validar permiso,
   envelope y payload antes de reservar o despachar. Las consultas comprueban
   también la capacidad de la operación pendiente original. Solo pasa el mensaje
   validado al [puerto de transporte](../src/agents/transport.ts), sin conexiones
   ni referencias de secretos. En esta fase todas las composiciones usan fakes.

No existe un adaptador Telegram que convierta texto en estas solicitudes; no se
añaden comandos ficticios al bot. Los alias de sujeto son contexto interno, no
IDs de Telegram. Configuración, schemas y transporte son código local de confianza;
resultados y solicitudes son datos no confiables.

## Validación y datos

JSON puro, máximo 64 KiB por registro/mensaje, profundidad 32 y 8192 nodos. Rechazar
ciclos, getters, `toJSON`, prototipos extraños, claves de prototipo, valores no
finitos y campos no permitidos. Se clonan y congelan solicitudes antes del primer
`await`, y también registros/resultados, para impedir cambios entre hash y ejecución
o entre lectores de caché. No se guardan inputs en las reservas después del trabajo.

La versión debe ser 1.0; `cost_policy` solo admite `no-paid-services`. La respuesta
debe coincidir en instancia, agente, sujeto, request y correlación, y respetar su
estado y schema de output. Errores remotos se mapean a mensajes locales seguros;
no se conservan excepciones, cuerpos o URLs en errores. No hay logs de payloads.

La URL configurada es un origen HTTPS sin ruta, query, fragmento o credenciales,
presente en la lista permitida. La validación de DNS/IP al conectar, TLS real,
headers de autenticación y redirects corresponde al futuro transporte de Fase 1C.
No se afirma protección de una conexión que todavía no existe.

## Idempotencia y concurrencia

Scope: instancia + sujeto + agente + capacidad/versión + `idempotency_key`.
Hash SHA-256 del comando canónico, incluidos input, IDs estables y perfil de costo;
el deadline queda fuera. Cambiar orden de propiedades no crea otra operación.
Cambiar el comando dentro del mismo scope/clave produce `IDEMPOTENCY_CONFLICT`,
referencia HTTP 409, antes de invocar el transporte.

La reserva se inserta sincrónicamente antes de programar trabajo. Solicitudes
idénticas simultáneas comparten un único trabajo y su promesa; una llamada no
inicia su propio ciclo de reintentos. Los retries del líder, si son seguros,
conservan exactamente request, correlación, input y clave. El deadline inicial
fija el presupuesto compartido: un duplicado no lo amplía.

Cada caller espera de manera independiente. Cancelar uno no cancela a los demás.
Cuando no queda ninguno, se registra el estado antes de abortar el transporte,
incluidos callbacks reentrantes. Antes de dispatch queda `not-started`; después,
`uncertain`. Un transporte que ignore la señal puede seguir trabajando, pero su
resultado tardío no cambia el estado ni repuebla la caché.

Timeout o cancelación local **no prueban que el agente no ejecutó**. Si no se
conoce resultado, se conserva un tombstone y ejecutar otra vez con la misma clave
devuelve ese estado/error, sin otro dispatch. No crear automáticamente una clave
nueva. La conciliación de un efecto incierto sin operation_id sigue pendiente;
se detiene la ruta en vez de inventar éxito o fallo.

## Plazos, límites y reintentos

| Control                | Valor y conducta                                                      |
| ---------------------- | --------------------------------------------------------------------- |
| Timeout por intento    | 10 s por defecto, configurable hacia abajo                            |
| Presupuesto compartido | Máximo 30 s, acotado por el deadline del primer caller                |
| Deadline de caller     | Puede acortar su espera, nunca la de los otros ni ampliar el trabajo  |
| Intentos               | Hasta 3 para rechazo 429 o fallos transitorios seguros                |
| Backoff                | 1/2 s más jitter 0–250 ms, dentro del plazo                           |
| Operación pending      | Hasta 24 h desde primera aceptación; otro pending no renueva el plazo |
| Reservas               | 256 por defecto; al llenarse rechaza sin expulsar claves/inciertos    |
| Waiters por trabajo    | 64 por defecto, límite acumulativo incluso si abortan/reconectan      |
| Output completed       | Retención obligatoria explícita de 1 ms a 15 min; demo usa 60 s       |

Los plazos se comprueban al recibir, validar y entregar resultados, además de
timers. Una respuesta que consume el plazo sin ceder el event loop se rechaza.
Los timers/listeners se limpian al terminar. `close()` cancela, borra cachés y deja
la instancia cerrada; no es un reset que permita volver a ejecutar sus claves.

429 conserva su cooldown por agente/instancia incluso al agotar intentos. Se
recalcula antes de dispatch si otro trabajo amplía la espera. No reducir un
Retry-After que no cabe: devolver límite/estado incierto según lo ocurrido.
`unavailable` explícito solo se reintenta para lecturas o capacidades que declaren
idempotencia; `retryable: false` lo impide. Un error desconocido o timeout no se
reintenta automáticamente. Nunca se deduce seguridad solo del campo remoto retryable.

## Pendientes y caché

`getOperation` solo consulta un pending previamente registrado, con actor/contexto
y operation_id exactos. No crea reservas de ejecución ni permite sondear IDs
arbitrarios. Comparte consultas concurrentes y respeta `poll_after_ms`; un nuevo
operation_id para el mismo pending se rechaza. Un resultado terminal válido
actualiza la reserva original, por lo que `execute` duplicado reutiliza ese resultado.

Un timeout de consulta conserva el pending: no significa que el trabajo remoto
falló. Después de 24 h queda `TIMEOUT/uncertain`, sin consultas automáticas nuevas.
Un terminal cacheado se devuelve sin transporte. Al vencer el output, un timer lo
borra activamente y una comprobación de reloj evita devolverlo si el timer se retrasó.
Solo quedan hash, IDs y estado; `RESULT_EXPIRED` indica resultado conocido pero
contenido eliminado, sin reejecutar. La lectura de caché vuelve a validar permisos.

Las claves/metadatos, índices de pending y cooldowns están acotados por las reservas
y no se expulsan para hacer lugar a otra operación. Los resultados no se guardan
por defecto indefinidamente: la ventana se elige explícitamente al componer el
Gateway. Tras cerrar/reiniciar se pierde **todo** el estado en memoria. Esta fase
no satisface retención durable, idempotencia de dominio ni exactamente-una-vez.

Se aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/12.
Los datos y reglas de agentes siguen fuera de Jarvis. HTTP real espera Fase 1C;
eventos autenticados, replay y persistencia durable, Fase 3.
