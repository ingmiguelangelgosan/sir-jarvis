# Registry y Gateway — Fases 1B, 1C y 1D

Registry/Gateway funcionales en memoria con transporte falso o HTTPS inyectado.
HTTPS se verifica contra un proceso de testing independiente. Fase 1D conecta
Telegram al Core/Gateway mediante comandos opcionales de lectura; no hay agentes
de dominio, DB ni IA. La integración está deshabilitada por defecto.
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
   ni referencias de secretos. Fase 1C puede inyectar el adaptador HTTPS.

Fase 1D adapta `/agents` y `/agent` de Telegram a un caso de uso determinista de
lectura, sin cambiar `/start` o `/status`. Los alias de sujeto son contexto interno, no
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
presente en la lista permitida. El transporte HTTPS añade validación DNS/IP,
TLS y autenticación descritas abajo. El Gateway conserva sus garantías al ser
invocado desde la nueva integración opcional de Telegram.

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
Los datos y reglas de agentes siguen fuera de Jarvis. Eventos autenticados,
replay y persistencia durable esperan Fase 3.

## Integración opcional de Telegram de Fase 1D

El flujo conectado es Telegram autenticado → comandos deterministas →
[AgentReadService](../src/app/agent-read.ts) →
[AgentExecutionService](../src/app/agent-execution.ts) → Registry/Gateway →
`HttpsAgentTransport` → agente independiente → respuesta de Telegram.
[Guía operativa y prueba manual](TELEGRAM.md#prueba-manual-con-telegram-real-y-echo-local).
No se crea otro Gateway ni un servicio de agente dentro del Core.

`telegram-main.ts` instala la integración solo con
`JARVIS_TELEGRAM_AGENTS_ENABLED=true`; sin ella no lee configuración de agentes y
conserva el comportamiento anterior. Un registro vacío también es válido. Cuando
está activa, el JSON local administrado configura instalación, bindings Telegram
→ `subject_ref`, registros, permisos, orígenes, referencias de variables y retención.
La [plantilla](../config/agents.example.json) usa datos ficticios, agente apagado y
destino `.invalid`. Configuración privada en `.local/`, excluida de Git.

El handler existente autentica persona de allowlist y chat privado antes de la
adaptación; los bindings internos solo aceptan IDs ya permitidos y aliases únicos
no numéricos. Un mensaje nunca proporciona el actor, registra agentes o amplía
permisos. `/agents` presenta solo agente/capacidad/versión autorizados, habilitados,
disponibles y soportados por este corte; no envía solicitudes al agente ni revela
URLs, referencias, descripciones libres o secretos.

`/agent <agente> <capacidad> <texto>` solo permite `echo.reply` 1.0 de lectura con
schemas locales `demo.input.v1`/`demo.output.v1`. No habilita automáticamente otras
capacidades de lectura registradas. Valida texto simple de 1 a 128 unidades de
cadena, sin caracteres de control o formato invisibles; no interpreta campos de configuración.
No hay interpretación de lenguaje natural. Core y Gateway comprueban de nuevo
instancia, sujeto y permisos; siempre se envía `cost_policy: no-paid-services`.
Se muestran únicamente salidas válidas que reflejen exactamente el input aprobado
de Echo. Pending y fallos se convierten en mensajes locales breves, sin IDs técnicos;
pending no inicia polling automático o notificaciones. Timeout no confirma fallo
remoto ni permite repetir a ciegas.

La clave privada `JARVIS_TELEGRAM_AGENT_KEY`, distinta de Bearer y token Telegram,
deriva IDs opacos HMAC por bot autenticado, instalación, sujeto y chat/mensaje.
No se envían IDs Telegram al agente. No se incluyen datos del comando en la clave
de la acción. El handler no vuelve a procesar el mismo chat/mensaje; dentro del
mismo scope de agente/capacidad, cambiar el comando conservando la clave produce
conflicto del Gateway.
La clave debe permanecer estable entre arranques; cambiarla, o cambiar instalación/
binding, cambia el namespace y requiere revisar pendientes. El polling suministra
el ID del bot; un adaptador directo que no lo proporcione usa username y debe
mantenerlo estable. La clave no representa persistencia de reservas o resultados.

El adaptador reserva hasta 1024 acciones de agentes por handler antes del primer
`await`, sin expulsar las activas o inciertas; lleno falla cerrado con un código
de log fijo. Mantiene separado el cache legacy de 1024 mensajes. Admite hasta ocho
invocaciones de lectura simultáneas y una cola acotada de 32 respuestas; los envíos
se serializan y comparten ritmo/cooldown de Telegram. Un 429 de entrega reintenta
solo el envío, nunca vuelve a invocar al agente. El Gateway conserva sus propias
reservas de 256 y retención de outputs explícita. Todos son límites en memoria,
sin garantía exactamente-una-vez tras reinicio.

```sh
npm run agents:telegram:demo
node --test tests/telegram-agents.e2e.test.ts
```

La demo automática usa Telegram simulado y Echo HTTPS real como otro proceso,
sin token propio, `.env`, llamadas públicas o cargos:

```json
{
  "mode": "telegram-simulated-https-local",
  "status": "completed",
  "executions": 1,
  "replies": 1
}
```

`npm run telegram:agents:demo` es un supervisor **manual** separado, fuera de CI
y del build, para usar el bot real con exactamente un propietario autorizado.
Genera CA, Bearer, clave HMAC y registro temporales en memoria; requiere integración
explícita y entorno development/test. Solo ese supervisor de testing inyecta la
política loopback exacta; el bot normal mantiene la política HTTPS de Fase 1C.
La aceptación nueva con Telegram real está pendiente del operador, no se infiere
del éxito de la prueba simulada. Ver [validación](PHASE_1D_VALIDATION.md).

Antes de desplegar con efectos sensibles, Fase 1E debe resolver persistencia
durable, Compose y recuperación locales; siguen pendientes y no se añaden aquí.
AWS/Lightsail permanece como proveedor previsto, sin despliegue ni facturación.

## Transporte HTTPS de Fase 1C

[HttpsAgentTransport](../src/agents/https-transport.ts) implementa el mismo puerto;
el caso de uso y Gateway permanecen iguales. Composición servidor local explícita:

```ts
// registry/catalog deben incluir registro, schemas y permisos aprobados.
const network = new HttpsEndpointPolicy([
  { origin: 'https://echo.example.invalid' },
]);
const credentials = new EnvironmentAgentCredentials({
  'echo-request': 'JARVIS_ECHO_BEARER',
});
const transport = new HttpsAgentTransport(
  registry,
  catalog,
  network,
  credentials,
);
const gateway = new InMemoryAgentGateway(registry, catalog, transport, {
  resultCacheMs: 60_000,
});
const core = new AgentExecutionService(registry, gateway);
// finally: gateway.close(); transport.close();
```

Los constructores están en `src/agents/` y `AgentExecutionService` en `src/app/`.
El ejemplo es composición, no un comando de producción o endpoint activo.
`request_credential_ref` del registro debe ser `echo-request`. El operador inyecta
su propio `JARVIS_ECHO_BEARER` en el proceso servidor por un mecanismo seguro; no
se imprime ni se escribe un token en comandos/documentación. La clase no lee `.env`,
no descubre variables, no guarda el token y vuelve a resolverlo en cada intento
para permitir rotación. Admite otro resolver server-only sin SDK en el Core.

Seguridad implementada:

- Solo orígenes HTTPS exactos en Registry y en `HttpsEndpointPolicy`, sin rutas,
  credenciales, query, fragmentos, aliases localhost o metadata. Paths fijos:
  `POST /v1/execute` y `GET /v1/operations/{id}`; no se toma destino del mensaje.
- Resolver DNS en cada intento, validar **todas** sus respuestas y fijar una IP
  en el lookup de la conexión. Una respuesta mixta pública/privada no autorizada
  se rechaza. No hay fallback a otra dirección, segundo lookup, pool compartido,
  proxies ambientales o redirects. El socket debe coincidir en IP y puerto.
- Negar loopback, link-local, metadata cloud y rangos especiales IPv4/IPv6; IPv6
  solo unicast global no especial por defecto. `privateAddresses` permite solo IPs
  RFC1918/ULA **exactas por origen**, administradas explícitamente. Metadata IPv6
  de AWS/EKS y Google nunca es excepción. No admite rangos ni una bandera genérica
  para desactivar SSRF. Las listas son conservadoras y requieren mantenimiento.
- TLS mínimo 1.2, verificación de cadena y nombre original siempre activas.
  Puede configurarse una CA privada, no opciones TLS arbitrarias. Headers Bearer
  y cuerpo se envían solo después de verificar `secureConnect` y peer. `NODE_DEBUG`
  no vacío o tracing http/https/tls habilitado hace fallar la composición para no
  exponer headers mediante diagnóstico nativo. No activar tracing de tráfico/TLS.
- Headers limitados a 16 KiB; respuesta máxima 64 KiB incluso chunked; UTF-8 fatal,
  JSON sin claves repetidas, Content-Type JSON, sin compresión y framing completo.
  Validar envelope, versión, campos, schema/contexto y coherencia status HTTP antes
  de aceptar output. Errores remotos/raw no se imprimen ni conservan.
- Un 429/503 crudo no autoriza retries. Se exige `failed` válido y contextualizado;
  `Retry-After` positivo en segundos o fecha HTTP se combina con el body tomando
  el máximo. Inválido o mayor a 24 h se rechaza; nunca acortar por el deadline.
  Solo el Gateway aplica los reintentos seguros de Fase 1B.

Límites adicionales: timeout total del transporte de hasta 10 s, incluida resolución
DNS/credenciales/TLS/cuerpo; respeta deadline y AbortSignal. Máximo 32 conexiones
activas y resoluciones subyacentes por defecto, configurable hasta 256. Un lookup
del SO puede continuar tras cancelación: conserva su cupo hasta finalizar, y no
despacha después. Índice de pending máximo 256 por defecto (hasta 4096), contexto
original y autorización revalidados al consultar; no acepta IDs arbitrarios ni
renueva las 24 h. Si se llena, falla cerrado sin expulsar inciertos. Se vacía al
cerrar. No conserva inputs/outputs en ese índice ni registra referencias sensibles.

El transporte distingue `not-started` antes de enviar y `uncertain` después.
El Gateway ya marca un posible efecto al invocar el puerto: conserva su clasificación
**conservadora**, incluso si el timeout ocurrió durante DNS o TLS. Ninguno de estos
estados demuestra fallo/cancelación remota. No cambia idempotencia por esta diferencia.

Fuentes técnicas: [HTTPS de Node 24](https://nodejs.org/docs/latest-v24.x/api/https.html),
[TLS de Node 24](https://nodejs.org/docs/latest-v24.x/api/tls.html),
[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/),
[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/).

## Agente HTTPS independiente de prueba

```sh
npm ci
npm run agents:https:demo
node --test tests/agent-https.test.ts tests/agent-network.test.ts
```

En PowerShell usa `npm.cmd` si corresponde. La demo responde:

```json
{ "mode": "https-local-test", "status": "completed", "executions": 1 }
```

[run-agent-https-demo.ts](../tests/run-agent-https-demo.ts) inicia por IPC un **proceso
Node separado** con [echo-agent.mjs](../tests/fixtures/echo-agent.mjs). El servidor
solo usa builtins y bytes del protocolo, sin imports de Jarvis, de su dominio o Zod;
puede iniciarse independientemente por un supervisor IPC. Para probarlo sin Core ni
Gateway, importar `startEchoAgent` de [https-process.ts](../tests/https-process.ts),
que devuelve origen/CA/token en memoria, `stats()`, `diagnosticsBytes()` y `close()`;
un cliente HTTPS independiente puede usar esos valores sin importaciones de `src/`.
La fixture exige `jarvis-demo`/`demo.echo`/`owner-demo` y `echo.reply` versión 1.0.

El helper genera CA y certificado ECDSA efímeros con `node:crypto`, sin OpenSSL CLI,
archivos de claves ni credenciales versionadas. El hijo recibe un entorno mínimo,
sin tokens del operador o flags de diagnóstico. La política de loopback es un objeto
definido **solo en tests**, para `echo.test`/puerto exacto/127.0.0.1. Esa composición,
PKI y fixture quedan fuera de `dist/`; no hay flags/env de bypass en producción.
No se desactiva TLS ni la validación de hostname para ejecutar la demo.

El servidor valida Bearer, envelope/input antes del efecto y reserva claves
concurrentes en memoria; es un echo de lectura, sin dominio. Su retención y estado
temporal no demuestran una implementación de agente durable. Se apaga y descarta
al finalizar. Las pruebas inyectan fallos y comparan contadores, sin red pública,
credenciales reales, repositorios nuevos, contenedores o servicios comerciales.
No es una aplicación de producción ni un deployment AWS.
