# Protocolo de agentes — borrador 1.0

**Estado:** contrato propuesto en Fase 1A.5, sin transporte de agentes implementado.
Los [tipos TypeScript](../src/agents/protocol.ts) son puertos y datos puros, no
validadores, autenticación ni controles de gasto. La especificación es independiente
del lenguaje; un agente no necesita importar Jarvis, su SDK o su base de datos.

## 1. Perfil, identidad y registro

Primer transporte: **HTTPS + JSON UTF-8**, `Content-Type: application/json`.
Versión de mensajes `protocol_version: "1.0"`; endpoints bajo `/v1/`.
Rechazar versiones no soportadas con `UNSUPPORTED_PROTOCOL`: no degradar seguridad
ni interpretar silenciosamente un major desconocido. Añadir capacidades o schemas
requiere versionarlos y negociar soporte explícito; los tipos actuales solo admiten 1.0.

El operador registra cada agente manualmente con ID estable, versión, capacidades
y schemas de entrada/salida. Cada capacidad declara nombre, versión, efecto
`read`/`write` e idempotencia. El manifiesto informativo puede exponerse después
como `GET /v1/manifest`; su recepción nunca concede permisos ni instala código.

La conexión se configura **localmente** con `base_url`, referencias de secretos
`request_credential_ref`/`event_key_ref`, estado habilitado, disponibilidad observada
y permisos por sujeto/capacidad. No enviar esa configuración como payload de negocio.
`unknown` no significa saludable; deshabilitado impide invocar y notificar.

IDs opacos: 1–128 caracteres ASCII alfanuméricos, punto, guion o guion bajo;
comienzan con alfanumérico, no contienen rutas ni secretos. `agent_id` es único
por instancia y debe coincidir con el registrado. `subject_ref` es un alias
opaco local, no un ID de Telegram ni un dato de dominio. `instance_id` impide
mezclar instalaciones. Cada instancia mantiene su correspondencia privada con el usuario.

`base_url` es un origen HTTPS sin ruta distinta de `/`, userinfo, query o
fragmentos; por ejemplo `https://echo.example.invalid`. Gateway añade las rutas
`/v1/...` fijas y valida host/puerto permitidos por el operador, sin redirecciones.
Prohibir destinos arbitrarios del mensaje,
metadata cloud y redes privadas por defecto. Un despliegue privado puede permitir
un host/IP exacto administrado, con TLS válido, mediante configuración explícita;
validar DNS/IP también al conectar para evitar SSRF/rebinding. No desactivar TLS.

## 2. IDs y estructuras

| Campo             | Semántica                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| `request_id`      | Solicitud lógica; estable en retries de la misma ejecución             |
| `correlation_id`  | Flujo que agrupa solicitudes/respuestas/eventos                        |
| `idempotency_key` | Efecto lógico; conservar al reintentar, no sustituir por un UUID nuevo |
| `operation_id`    | Trabajo aceptado pendiente, emitido por el agente                      |
| `event_id`        | Evento estable para todas sus retransmisiones                          |
| `subscription_id` | Consentimiento autónomo configurado previamente en Jarvis              |

Todos los mensajes llevan `protocol_version`, `instance_id`, `agent_id`,
`subject_ref` y `correlation_id`. Las capacidades tienen su propia versión,
separada del protocolo. Fechas son RFC 3339 UTC; números JSON son finitos y no
representan dinero binario: los agentes que manejan dinero usan decimal como
cadena y moneda ISO 4217 según su schema de dominio.

Límite inicial de cuerpo: 64 KiB, incluidos resultados/eventos. Validar envelope,
tipo, longitudes, JSON y schema de capacidad en ambas fronteras antes de efectos.
Los tipos estáticos no cubren estos controles. No incluir tokens, claves,
contraseñas, headers de autenticación, destinos de chat o URLs de callback en los
mensajes; el schema de cada capacidad limita los datos, no acepta objetos arbitrarios
como instrucciones. Un resultado es información no confiable, nunca una orden.

## 3. Patrón A — Jarvis solicita una ejecución

1. Core autentica el origen y comprueba instancia, sujeto, permiso de capacidad,
   confirmaciones y agente habilitado. Si no cumple, no llama al Gateway.
2. Core crea IDs y deadline; reserva idempotencia y política local. El único perfil
   inicial es `cost_policy: "no-paid-services"`. Ni el agente ni un booleano remoto
   pueden autorizar cargos. Un perfil pago requerirá diseño, aprobación expresa,
   presupuesto y topes verificados en una fase posterior.
3. Gateway resuelve exclusivamente la conexión registrada y hace
   `POST /v1/execute` con autenticación en headers. Aplica timeout/deadline y valida
   respuesta antes de devolver datos. El agente vuelve a autorizar y validar su dominio.
4. La respuesta repite exactamente agente, instancia, sujeto, request y correlación.
   No aceptar respuestas cruzadas. Jarvis persiste referencias/estado, no los datos
   internos del agente ni resultados completos por defecto.

Ejemplo ficticio (Eco Demo; no es una aplicación implementada):

```json
{
  "protocol_version": "1.0",
  "kind": "execute",
  "instance_id": "jarvis-demo",
  "agent_id": "demo.echo",
  "subject_ref": "owner-demo",
  "request_id": "req-demo-001",
  "correlation_id": "flow-demo-001",
  "idempotency_key": "effect-demo-001",
  "capability": { "name": "echo.reply", "version": "1.0" },
  "deadline_at": "2026-11-02T23:00:10Z",
  "cost_policy": "no-paid-services",
  "input": { "text": "Texto ficticio" }
}
```

Respuesta completada, HTTP 200:

```json
{
  "protocol_version": "1.0",
  "kind": "execution-result",
  "instance_id": "jarvis-demo",
  "agent_id": "demo.echo",
  "subject_ref": "owner-demo",
  "request_id": "req-demo-001",
  "correlation_id": "flow-demo-001",
  "status": "completed",
  "output": { "text": "Respuesta ficticia" }
}
```

Alternativa HTTP 202: mismo envelope, `status: "pending"`, `operation_id` opaco
y `poll_after_ms` positivo, sin `output` ni `error`. Consultar después
`GET /v1/operations/{operation_id}` con el mismo contexto autorizado o esperar un
evento autenticado. El GET es de lectura, no vuelve a ejecutar la acción.
Una aceptación pendiente no es éxito de negocio. Una expiración del timeout de
Jarvis no cancela efectos del agente ni autoriza crear otra ejecución.

Un fallo usa `status: "failed"` y `error`, sin output. Ejemplo del objeto error:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Faltan datos requeridos para la capacidad.",
  "retryable": false
}
```

No enviar stacks, SQL, URLs privadas, credenciales o datos sensibles en errores.
Jarvis mapea códigos a mensajes locales seguros; no imprime el error remoto crudo.

## 4. Errores, timeouts e idempotencia

| Código                       | HTTP de referencia | Conducta                                           |
| ---------------------------- | ------------------ | -------------------------------------------------- |
| `UNSUPPORTED_PROTOCOL`       | 400                | Detener y revisar compatibilidad                   |
| `UNAUTHORIZED` / `FORBIDDEN` | 401 / 403          | Detener; no ampliar permisos                       |
| `UNKNOWN_CAPABILITY`         | 404                | Detener; revisar registro/schema                   |
| `VALIDATION_FAILED`          | 422                | Pedir corrección; no repetir la misma entrada      |
| `IDEMPOTENCY_CONFLICT`       | 409                | Misma clave con datos distintos; detener           |
| `RATE_LIMITED`               | 429                | Respetar `Retry-After`/`retry_after_ms` válidos    |
| `TIMEOUT`                    | 504                | Resultado posiblemente incierto; consultar estado  |
| `UNAVAILABLE`                | 503                | Reintento solo si es seguro                        |
| `INTERNAL_ERROR`             | 500                | Sin detalles internos; conciliar efectos inciertos |

La señal `retryable` es orientativa; nunca sustituye permiso, presupuesto o
idempotencia. Timeout local inicial 10 s por llamada, deadline local máximo
30 s para intentos de una solicitud. Hasta tres intentos con backoff 1/2 s y jitter,
solo para lecturas o escrituras cuyo agente garantice idempotencia. No reintentar
una escritura de resultado incierto sin esa garantía. Un `Retry-After` que exceda
el deadline deja la operación pendiente/incierta; no acortarlo ni bloquear el core.
Cancelar la espera local no demuestra cancelación remota.

Scope de idempotencia: `(instance_id, subject_ref, agent_id, capability+version,
idempotency_key)`. El agente reserva atómicamente clave y hash canónico del comando
autorizado, devuelve el resultado/operación originales en retries y rechaza datos
distintos con 409. El hash incluye input y contexto estable; excluye deadline,
autenticación y datos variables del intento. Nunca reducir dos efectos distintos
a una sola clave ni usar la correlación como clave de efecto.

Conservar claves mientras el efecto esté pendiente/incierto y al menos siete días
después de resolución. Un dominio puede requerir más. No reintentar automáticamente
una operación caducada con otra clave. Los trabajos pendientes tienen plazo local
máximo inicial de 24 h para conciliación; al agotarse conservar estado incierto y
referencia para revisión, sin afirmar fallo ni volver a ejecutar.

## 5. Patrón B — agente autónomo notifica

El operador configura tarea, permisos y presupuesto **en el agente independiente**;
Jarvis no ejecuta su scheduler. En Jarvis habilita por separado una suscripción
para agente + instancia + sujeto + capacidad + tipo de evento. Puede revocarla.
Recibir un evento no compra servicios ni habilita una tarea nueva.

El agente envía `POST /v1/agent-events`. Ejemplo ficticio de Agenda Demo:

```json
{
  "protocol_version": "1.0",
  "kind": "notification",
  "instance_id": "jarvis-demo",
  "agent_id": "demo.agenda",
  "subject_ref": "owner-demo",
  "correlation_id": "task-demo-run-001",
  "event_id": "event-demo-001",
  "occurred_at": "2026-11-02T23:00:00Z",
  "subscription_id": "subscription-demo-001",
  "capability": { "name": "agenda.summary", "version": "1.0" },
  "event_type": "agenda.summary.ready",
  "payload": { "summary": "Resumen ficticio solicitado por el operador." }
}
```

Una finalización solicitada utiliza `kind: "operation.completed"` o
`"operation.failed"`, además `request_id` y `operation_id`, y respectivamente
`output` o `error`. Debe coincidir con solicitud pendiente y transición terminal
única por agente/instancia/sujeto/request/correlation/operation; un nuevo event_id
no permite volver a finalizar la misma operación ni escoger otro destinatario.

## 6. Autenticación y protección contra replay

Patrón A: `Authorization: Bearer …` sobre HTTPS, credencial distinta por agente e
instancia, scope de capacidades y rotación. Se resuelve en el servidor; nunca
aparece en JSON ni ejemplos. Un esquema futuro mTLS/OAuth debe conservar esos scopes.

Patrón B: HMAC-SHA256 con clave distinta del bearer, por agente e instalación,
rotación por `key_id` y comparación de firmas en tiempo constante. Headers no
secretos: `X-Jarvis-Agent-Id`, `X-Jarvis-Key-Id`, `X-Jarvis-Timestamp` y
`X-Jarvis-Nonce`; firma en `X-Jarvis-Signature` como `sha256=<hex lowercase>`.
El timestamp es Unix UTC en segundos, decimal sin signo; nonce aleatorio de al
menos 128 bits codificado base64url sin padding (22–64 caracteres).

Cadena firmada, UTF-8 con LF, sin LF final:

```text
1.0\nagent_id\nkey_id\ntimestamp\nnonce\nPOST\n/v1/agent-events\nsha256_hex_cuerpo_crudo
```

Los `\n` representan un solo byte LF, no dos caracteres. Firmar **todos** esos
campos; no permitir CR/LF en los headers ni queries, rutas alternativas, body
reserializado o compresión implícita. Hash SHA-256 de los bytes JSON crudos exactos
antes de parsear; límite 64 KiB aplicado antes de reservar memoria sin límite.
Solo resolver claves conocidas del registro local; nunca obtener claves por una URL
enviada por el agente. `agent_id` firmado, header y cuerpo deben coincidir.

Rechazar timestamps fuera de ±300 s, reloj inválido, nonce repetido o firma inválida.
Mantener reloj sincronizado y reserva atómica durable del nonce durante al menos
600 s por agente/key/instancia. Una firma fresca tampoco evita eventos repetidos:
validar permisos y suscripción de nuevo, después reservar `(instance_id, agent_id,
event_id)` y hash del cuerpo en una inbox durable antes de producir efectos.
Evento repetido con mismo hash: confirmar sin notificar otra vez. Con hash distinto:
409 y auditoría mínima. No confiar en el canal, chat o permisos propuestos por el agente.

El evento conserva ID y cuerpo durante retransmisiones, pero cada intento usa
timestamp/nonce/firma nuevos. Horizonte máximo de reintentos de entrega: 24 h desde
`occurred_at`; eventos más antiguos requieren conciliación manual fuera de este
endpoint. Conservar deduplicación de eventos al menos siete días desde aceptación.
Validar también `occurred_at`: no puede superar el reloj del receptor en más de
300 s ni tener más de 24 h de antigüedad. Una fecha futura no amplía el horizonte
de retries ni permite saltarse la retención de deduplicación.
Un callback válido pero sin consentimiento/permisos se rechaza y no llega al canal.

## 7. Persistencia y entrega segura previstas

Confirmar 202 únicamente después de registrar duraderamente el evento y la entrega
pendiente en una misma transacción, o mediante coordinación durable recuperable
que nunca confirme un duplicado sin su entrega registrada. Incluir estado de procesamiento,
hash y metadatos mínimos; no guardar payloads privados completos por defecto.
Un registro transitorio del payload mínimo necesario exige retención explícita,
acceso restringido y borrado tras procesarlo; no copiar datos internos del agente.
Antes de notificar, revalidar consentimiento y propietario y usar el destino local.

Si cae el proceso antes de enviar, recuperar la entrega pendiente; si cae durante
un envío cuyo resultado se desconoce, marcarla incierta y no repetirla ciegamente.
Telegram no garantiza exactamente una vez. La inbox/outbox transaccional futura
no es una cola distribuida. Estos controles deben existir antes de abrir eventos
a agentes reales; la deduplicación actual de Telegram en memoria no los sustituye.

## 8. Evolución y alcance

Fase 1B implementará Registry/Gateway con adaptador falso y tests de permisos,
schemas, deadlines e idempotencia; Fase 1C verificará HTTPS contra una aplicación
ficticia independiente. Eventos públicos y tareas autónomas esperan Fase 3.
Los contratos no están conectados al bot ni habilitan servicios externos.

MCP podrá añadirse como otro adaptador del Gateway, mapeando identidad, permisos,
correlación, límites e idempotencia; no aporta autorización automática ni sustituye
el contrato de dominio. No se implementa MCP aquí. Evaluar una cola distribuida
solo si varias réplicas, volumen/backpressure o duración de trabajos superan la
inbox/outbox local y las métricas justifican su costo y operación.

Políticas vinculantes: [PRODUCT_RULES](PRODUCT_RULES.md) ORC-02…ORC-09.
El código futuro deberá validar estos controles; no se consideran probados por
compilar los tipos o por los ejemplos de este documento.
