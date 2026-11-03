# Telegram — texto y agentes de lectura

Jarvis recibe texto y responde `/start`, `/status` o una explicación breve de que
la función solicitada sigue pendiente. No interpreta pagos, no guarda operaciones,
no usa IA y no envía recordatorios. Las pruebas automáticas simulan Telegram;
el operador reportó aceptación con Telegram real exitosa el 2026-11-02.
Fase 1D conserva esas respuestas y añade, de manera opcional, `/agents` y `/agent`
para capacidades de lectura autorizadas. La integración se inicia deshabilitada.
Sus pruebas automáticas conectan Telegram simulado con Core, Gateway y Echo HTTPS
real como otro proceso; no se repiten pruebas con credenciales del operador.

## Crear el bot y preparar el acceso

1. Abre [@BotFather](https://t.me/BotFather), el bot oficial de Telegram. Envía
   `/newbot`, elige nombre y un username disponible que termine en `bot`.
2. Guarda el token generado directamente en tu `.env` local. No lo pegues en
   conversaciones de asistencia, issues, URLs del navegador, logs ni commits.
   Si se expone, revócalo y genera otro desde BotFather.
3. Obtén **tu ID numérico de usuario**, que es distinto del username y del ID del
   bot. Una opción sin bots de terceros es Telegram Desktop: Ajustes → Avanzados →
   Exportar datos de Telegram, seleccionando información de cuenta y formato JSON.
   Consulta localmente `personal_information.user_id` en el resultado. No compartas
   el archivo exportado ni lo guardes dentro del repositorio. Telegram documenta
   [la exportación](https://telegram.org/blog/export-and-more) y su
   [formato JSON](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/export/output/export_output_json.cpp).
4. Opcionalmente usa `/setcommands` en BotFather para registrar este menú:

   ```text
   start - Bienvenida
   status - Estado de Jarvis
   ```

No se necesitan pagos, Telegram Stars, claves de IA ni una base de datos. No
habilites paid broadcasts ni añadas el bot a grupos: esta fase solo admite chats
privados. [Guía oficial de creación de bots](https://core.telegram.org/bots/features#botfather).

Cuando actives agentes puedes añadir al menú `agents - Agentes disponibles` y
`agent - Consultar una capacidad de lectura`. El menú no concede permisos ni
habilita la integración; los comandos también funcionan sin registrarlo.

## Variables y ejecución local

Requisitos: Node 24.22.1+ de la rama 24 LTS y npm 11 o 12. Desde la raíz, en
PowerShell:

```powershell
npm.cmd ci
Copy-Item -LiteralPath .env.example -Destination .env
```

La copia se hace solo si todavía no tienes `.env`. Edítalo con tus valores:

```dotenv
NODE_ENV=development
JARVIS_TIMEZONE=America/Bogota
JARVIS_AI_MODE=disabled
TELEGRAM_BOT_TOKEN=PEGA_AQUI_EL_TOKEN_DE_BOTFATHER
TELEGRAM_ALLOWED_USER_IDS=TU_ID_NUMERICO
JARVIS_TELEGRAM_AGENTS_ENABLED=false
```

`PEGA_AQUI_EL_TOKEN_DE_BOTFATHER` y `TU_ID_NUMERICO` son marcadores que debes
reemplazar; no son credenciales funcionales. Conserva el flag de agentes en
`false` para el comportamiento anterior. El token y la allowlist vacíos o inválidos impiden iniciar Telegram.
La allowlist acepta enteros positivos seguros separados por comas, sin usernames
ni IDs de chats grupales. Solo los IDs enumerados pueden llegar al núcleo. Se
recomienda **un propietario por instalación**; permitir otros IDs no crea perfiles,
sesiones financieras ni aislamiento entre usuarios.

Las variables del proceso prevalecen sobre `.env`. El archivo se lee desde el
directorio de trabajo; ejecuta desde la raíz. `JARVIS_AI_MODE` únicamente admite
`disabled`. No se aceptan rutas a proveedores ni se habilita facturación.

```powershell
npm.cmd run check
npm.cmd run telegram
```

En Linux/macOS usa `npm` y `cp .env.example .env`. Alternativa compilada:

```powershell
npm.cmd run build
npm.cmd run telegram:start
```

`npm start`, `npm run dev` y `npm run diagnose` conservan el diagnóstico sin red;
**no inician el bot** y no requieren credenciales. El diagnóstico indica que el
adaptador Telegram está disponible, sin afirmar que hay conexión o token válido.

Para usarlo, abre un chat privado con tu bot, pulsa Iniciar y envía `/start`,
`/status`, un texto o un comando desconocido. Detén el proceso con **Ctrl+C**.
Solo debe ejecutarse una instancia de polling por token.

## Acceso, errores y privacidad

- Se valida `from.id`, que sea una persona y que el chat sea privado con
  `chat.id === from.id`. No se autoriza por username. Un origen ajeno se descarta
  sin responder y antes de ejecutar el núcleo.
- No se procesan grupos, canales, mensajes editados, callbacks ni archivos. Los
  comandos dirigidos explícitamente a otro bot se ignoran.
- El cliente usa HTTPS al host fijo `api.telegram.org`, sin seguir redirecciones.
  Recibe solo eventos `message`; no descarga adjuntos. El contenido pasa por
  Telegram como parte del canal solicitado, pero no por proveedores de IA.
- Solo se imprimen códigos de evento y mensajes de error controlados. No se
  registran IDs, nombres, texto, payloads, tokens, URLs privadas ni errores crudos.
- `/status` muestra capacidades generales, sin configuración ni secretos. Los
  textos desconocidos no se repiten ni se presentan como operaciones registradas.

Polling mantiene la conexión hasta 25 segundos por consulta y utiliza timeout HTTP
de 35 segundos. Ante fallos de red/servidor al consultar, espera progresivamente
hasta 30 segundos. Para `429` respeta `retry_after`; un valor inválido o superior
a un día detiene la consulta en lugar de reducir arbitrariamente la espera. En
envíos, ese fallo abandona el mensaje con una advertencia genérica.

Las respuestas salen secuencialmente, como máximo una por segundo. Un envío
rechazado explícitamente con `429` se intenta hasta tres veces, conservando el
plazo de espera también para el siguiente mensaje. `allow_paid_broadcast` está
fijado a `false`. Ante un timeout, error de red, respuesta inválida o error 5xx de
envío, la entrega puede ser incierta: se registra un código genérico y no se
reenvía automáticamente para evitar duplicados. Si no recibes respuesta, puedes
enviar de nuevo `/start` o `/status`. Para una consulta de agentes incierta,
revisa primero el estado: otro mensaje es una acción lógica nueva. No hay efectos
financieros o de escritura permitidos en esta fase.

Un `401/403` al consultar detiene el proceso: revisa o renueva el token. Un `409`
indica conflicto: detén otras instancias o revisa un webhook anterior. Jarvis no
elimina webhooks ni descarta actualizaciones automáticamente. Los errores 4xx
permanentes y respuestas de API inválidas detienen el polling sin reintentos
infinitos. Ctrl+C cancela tanto peticiones como esperas.
[Referencia de Bot API](https://core.telegram.org/bots/api#getupdates) y
[límites de envío](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).

## Duplicados y límites de esta entrega

Se conserva el offset de actualizaciones durante el proceso y una memoria acotada
de los últimos 1024 pares chat/mensaje. Se reserva el mensaje antes del envío y
se avanza el offset incluso si es ajeno, no soportado o su respuesta falla.
Esto evita repetir respuestas durante la ejecución a costa de poder perder una
respuesta fallida. No guarda el contenido del mensaje.

En el modo memoria, el estado y el offset no persisten: tras reiniciar, una actualización todavía no
confirmada en Telegram puede reaparecer. No hay garantía de entrega exactamente
una vez ni de idempotencia financiera. El futuro Finance Agent independiente
requerirá claves únicas y transacciones propias antes de registrar dinero; Jarvis
no incorporará su libro financiero.

Con la integración activa, los mensajes `/agents` y `/agent` usan además un índice
separado de hasta **1024 acciones por handler**, reservado antes de esperar al
agente y sin expulsar acciones activas o inciertas para admitir otras. Al llenarse,
no admite más comandos de agentes y registra solo `telegram-agent-capacity`;
`/start`, `/status` y el flujo anterior siguen disponibles. Hay como máximo ocho
invocaciones de lectura simultáneas y 32 respuestas esperando entrega; la cola
comparte el ritmo y cooldown de Telegram. El Gateway admite hasta 256 reservas
por defecto, un límite independiente que también falla cerrado. No reinicies
para repetir una acción incierta. El modo SQLite opcional de Fase 1E.1 conserva
metadatos y claves, pero no habilita repetir ni garantiza entregar respuestas.

`TelegramApi`, el handler de actualizaciones y el núcleo determinista permiten
cambiar el transporte después. No existe servidor webhook todavía; antes de
añadirlo harán falta autenticación del webhook y control de concurrencia.

Prueba manual sugerida: dos mensajes conocidos desde el propietario, texto y
comando desconocidos, otra cuenta fuera de la allowlist sin respuesta, cancelación
y reinicio. No fuerces límites reales: 429, duplicados y errores ya se simulan.

Se aplican [PRODUCT_RULES.md](PRODUCT_RULES.md) ORC-02/03/04/09/12: autorización,
credenciales propias, IA apagada, sin avisos nuevos ni compras automáticas y
separación del diseño futuro. Las reglas financieras se conservan en
[Finance Agent](agents/FINANCE_AGENT_SPEC.md), no en el núcleo.

## Comandos de agentes

Solo se procesan después de autenticar la allowlist y el chat privado. `/start`,
`/status`, los comandos ajenos y el fallback conservan sus textos. Si la integración
está apagada, `/agents` y `/agent` reciben ese fallback sin consultar ningún agente.

```text
Operador: /agents
Jarvis: Agentes y capacidades de lectura disponibles:
        demo.echo · echo.reply (1.0)

Operador: /agent demo.echo echo.reply Hola Jarvis
Jarvis: Respuesta del agente: Hola Jarvis
```

`/agents` muestra únicamente IDs públicos de agentes habilitados, disponibles y
capacidades que el sujeto tiene autorizadas. En este corte solo está adaptado
`echo.reply` versión `1.0`, de lectura, con schemas locales `demo.input.v1` y
`demo.output.v1`; registrar otra capacidad de lectura no crea automáticamente su
intérprete ni formatter. No muestra nombres/descripciones libres, URLs internas,
referencias de secretos, claves o configuración privada. La lista se acota para
caber en un mensaje. Un registro vacío o sin permisos devuelve una explicación breve.

`/agent <agente> <capacidad> <texto>` conserva esa sintaxis determinista. Admite
IDs del protocolo y texto simple de 1 a 128 unidades de cadena, no vacío, sin
caracteres de control, formato invisible, bidi o surrogates aislados. No interpreta
JSON, IDs de sujeto, URLs como destinos ni lenguaje natural. No admite escritura,
pagos, transferencias u otras capacidades sensibles, aunque aparezcan registradas.
La política de costo enviada siempre es `no-paid-services`.

El Core vuelve a validar instancia, sujeto, agente, capacidad y permiso antes del
Gateway. La respuesta completada solo presenta el texto validado si coincide
exactamente con el input aprobado de Echo; un resultado arbitrario no se muestra
como instrucciones o configuración. Telegram recibe texto plano, sin parse_mode
ni previews. No envíes secretos o información privada para probar Echo.

| Situación                                         | Respuesta y conducta                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Completada                                        | `Respuesta del agente: ...`, solo después de validar el resultado                             |
| Pendiente                                         | Informa que fue aceptada y sigue pendiente; no afirma finalización ni hace polling automático |
| Agente desconocido, deshabilitado o no disponible | Mensaje genérico de disponibilidad, sin conexión no autorizada                                |
| Capacidad sin permiso o de escritura              | Rechazo de acceso a esa capacidad de lectura antes del Gateway                                |
| Formato o tamaño inválido                         | Ayuda breve, sin invocación externa                                                           |
| Timeout o resultado incierto                      | Informa que no pudo confirmar el resultado y no repite automáticamente                        |
| Cancelación                                       | Cancela espera/envío local; no afirma cancelación remota                                      |
| Error o servicio temporalmente indisponible       | Mensaje local sanitizado; no revela errores, cuerpos o credenciales remotos                   |

No hay comando de registro, cambio de permisos o consulta de operation IDs.
Un `pending` no genera notificaciones, sondeo automático ni una nueva ejecución.

## Prueba automática del recorrido completo

Desde la raíz, sin token, `.env`, cuentas AWS o servicios públicos:

```powershell
npm.cmd ci
npm.cmd run agents:telegram:demo
node --test tests/telegram-agents.e2e.test.ts
```

La demo ejecuta el polling y envío de Telegram simulados contra el Core y Gateway
reales, usando HTTPS real hasta el proceso Echo independiente. Resultado:

```json
{
  "mode": "telegram-simulated-https-local",
  "status": "completed",
  "executions": 1,
  "replies": 1
}
```

No es evidencia de una prueba nueva con Telegram real. Resultados y comandos
completos en [PHASE_1D_VALIDATION](PHASE_1D_VALIDATION.md).

## Prueba manual con Telegram real y Echo local

Este supervisor de testing permite repetir el flujo con tu bot sin desplegar
infraestructura ni preparar DNS público. No se ejecuta en CI ni entra en `dist/`.
Se reutiliza la integración real; solamente la política de red de testing permite
el loopback exacto, con CA y certificado temporales válidos. No desactiva TLS.

1. Conserva tu `.env` propio y el bot de BotFather. Comprueba privadamente token y
   **exactamente un ID** permitido en `TELEGRAM_ALLOWED_USER_IDS`. No compartas
   sus valores. El supervisor asigna a ese propietario el alias `owner-demo`.
2. Detén manualmente el otro proceso de polling de ese bot antes de probar, para
   evitar un conflicto 409. No se cambia ni elimina un webhook automáticamente;
   si el bot tiene uno, resuelve esa configuración por separado.
3. Abre una terminal dedicada en la raíz y ejecuta:

   ```powershell
   npm.cmd ci
   $env:NODE_ENV = 'development'
   $env:JARVIS_TELEGRAM_AGENTS_ENABLED = 'true'
   npm.cmd run telegram:agents:demo
   ```

   En Linux/macOS, tras `npm ci`:

   ```sh
   NODE_ENV=development JARVIS_TELEGRAM_AGENTS_ENABLED=true npm run telegram:agents:demo
   ```

4. Espera `telegram-started`. En el chat privado envía `/start`, `/status`,
   `/agents` y `/agent demo.echo echo.reply Hola Jarvis`. Comprueba la lista y
   `Respuesta del agente: Hola Jarvis`. Un texto o comando desconocido conserva
   el fallback. Una cuenta fuera de la allowlist y un grupo no reciben respuesta.
5. Detén con **Ctrl+C**, comprueba la salida del supervisor y cierra la terminal
   dedicada para no conservar su habilitación temporal. Después puedes iniciar
   el bot normal con la integración apagada o con configuración administrada.

El supervisor [run-telegram-agents-live.ts](../tests/run-telegram-agents-live.ts)
lee `.env` solo al ejecutarlo el operador, genera registro, CA, Bearer y clave HMAC
efímeros en memoria, y arranca/cierra Echo como proceso separado. No requiere
`JARVIS_AGENTS_CONFIG_FILE`, `JARVIS_TELEGRAM_AGENT_KEY` o Bearer propios de agentes.
Rechaza `NODE_ENV=production`, integración apagada y allowlist plural.
El token Telegram solo llega al cliente oficial de Telegram, no a Echo ni al hijo.
El registro y clave efímeros de esta demo no ofrecen continuidad entre reinicios;
no son la configuración productiva descrita debajo. No uses datos sensibles ni
intentes forzar 429 reales. La aceptación del nuevo recorrido real queda pendiente
de que el operador la ejecute y reporte; Codex no ha leído su `.env` ni usado su bot.

## Configuración administrada de agentes

El bot normal (`telegram` o `telegram:start`) usa por defecto
`JARVIS_TELEGRAM_AGENTS_ENABLED=false`, y puede iniciar sin agentes/configuración.
Para una integración aprobada fuera del supervisor temporal:

1. Crea `.local/` y copia [config/agents.example.json](../config/agents.example.json)
   a `.local/agents.json`. Esa carpeta está excluida de Git. El `42` es ficticio:
   sustitúyelo localmente por tu ID ya incluido en la allowlist. Mantén un alias
   `subject_ref` opaco, no numérico y sin datos personales. Bindings y aliases deben
   ser únicos; no hay binding implícito para todo usuario permitido.
2. Revisa `instance_id`, permisos y registro. La plantilla trae agente deshabilitado,
   disponibilidad `unknown` y un origen `.invalid`, para evitar conexiones accidentales.
   Solo habilítalo y marca `available` cuando el endpoint y contrato estén verificados.
   `available` es configuración local, no un health check remoto.
3. Configura en `allowed_endpoints` el origen HTTPS exacto aprobado y el mismo
   `connection.base_url`. Conserva TLS válido y la protección de red de Fase 1C.
   Una IP RFC1918/ULA necesita `private_addresses` exactas por origen; localhost,
   loopback, link-local y metadata siguen prohibidos en el bot normal. Una CA
   privada puede indicarse con `ca_file`, relativa al JSON. No introduzcas claves
   privadas en ese archivo ni desactives validación TLS.
4. En tu configuración privada, establece `JARVIS_TELEGRAM_AGENTS_ENABLED=true`,
   `JARVIS_AGENTS_CONFIG_FILE=.local/agents.json` y una
   `JARVIS_TELEGRAM_AGENT_KEY` propia, aleatoria y estable de 32–64 bytes codificados
   en base64url sin padding. Genera/guarda esa clave en tu mecanismo seguro local
   y reutilízala al reiniciar; no la pegues en comandos públicos o conversaciones.
5. `credential_variables` mapea una referencia local a una variable server-only,
   por ejemplo `echo-request` → `JARVIS_ECHO_BEARER`. Inyecta el Bearer propio por ese
   mecanismo seguro. Referencia y token no van en mensajes de Telegram ni payloads.
   No reutilices la clave HMAC o el token del bot como Bearer; esos nombres están
   reservados y también se impide enviar como Bearer el mismo valor de la clave HMAC.
6. Antes de iniciar el bot normal con agentes, prepara la DB y `JARVIS_STATE_FILE`
   siguiendo [Persistencia opcional y reinicios](#persistencia-opcional-y-reinicios).
   Ejecuta `npm.cmd run check` y `npm.cmd run telegram`, o compila y usa
   `npm.cmd run telegram:start`. Los cambios de archivo/variables requieren reinicio.
   Configuración activa inválida falla antes de iniciar polling y sin mostrar valores.

Puedes usar `agents: []`, `allowed_endpoints: []` y `credential_variables: {}` para
una instalación activa sin agentes; `/agents` responderá que no hay disponibles.
El archivo admite como máximo 64 KiB y se valida con schemas locales. No se carga
un manifiesto remoto para registrar o conceder permisos. Las referencias de eventos
del contrato permanecen sin resolver: no existe Dispatcher externo en esta fase.

Los IDs de solicitud, correlación e idempotencia se derivan con HMAC de la
identidad de bot autenticada, instalación, sujeto y par chat/mensaje. Los IDs
Telegram quedan dentro del adaptador, no se envían ni se derivan con hashes
públicos reversibles por enumeración. Los datos del comando no determinan la clave
de la acción. El handler no vuelve a procesar el mismo chat/mensaje; dentro del
mismo scope de agente/capacidad, el Gateway detecta la clave con comando distinto.
Mantener clave e identidad local estables conserva IDs, pero **no conserva por sí
solo las reservas, resultados u offset en memoria**. Rotar clave, instalación o bindings
modifica ese namespace y exige revisar pendientes antes de reanudar. El polling
usa el ID autenticado del bot; adaptadores directos sin ese ID usan su username
como fallback y deben mantenerlo estable.

Aplican ORC-01/02/03/04/05/06/07/08/12. Fase 1E.1 añade el almacén opcional siguiente.
Fase 1E.2 completará Docker Compose, backups, restauración y recuperación **local**,
antes de AWS o efectos sensibles.

## Persistencia opcional y reinicios

La integración de agentes sigue deshabilitada por defecto. Al activarla en el
bot normal, `JARVIS_STATE_FILE` es obligatoria; el modo memoria queda disponible
en demos/adaptadores programáticos, sin atribuirle durabilidad.
Para el bot normal con configuración de agentes aprobada, preparar un directorio
privado y una DB nueva mediante la [guía de runtime](AGENT_RUNTIME.md#estado-durable-opcional-de-fase-1e1),
y configurar su ruta local:

```dotenv
JARVIS_STATE_FILE=.local/state/jarvis.sqlite
```

Comandos de mantenimiento, sin credenciales o conexiones externas:

```powershell
npm.cmd run state:init -- .local/state/jarvis.sqlite
npm.cmd run state:compact -- .local/state/jarvis.sqlite
```

`init` solo crea un archivo nuevo si el directorio privado ya existe. No ejecutarlo
para reemplazar una DB perdida o dañada: una historia ausente requiere detener y
conciliar. Windows necesita ACL privada revisada por el operador; POSIX exige modo
privado de directorio/archivos. Una DB configurada ausente, inválida o incompatible
impide arrancar, sin fallback a memoria. No cambiar ruta para saltar un bloqueo.

El journal almacena claves y hashes HMAC, fases y tiempos, no mensajes, outputs o
IDs Telegram en claro. El offset monotónico usa namespace HMAC de bot, se recupera
antes del polling y se confirma tras el handler. Clave, instancia, bindings y bot
se vinculan con la DB: cambios inesperados fallan cerrados, no crean otro historial.

Las fases de entrega distinguen acción reservada, resultado local preparado,
entrega pendiente, envío iniciado y entrega confirmada/incierta. El resultado local
preparado puede ser un mensaje de timeout; no significa éxito del agente. La marca
de inicio se confirma antes de enviar a Telegram. Un429 explícito puede reintentar
solo la entrega; un error o caída con resultado incierto no autoriza reenviarla.

Al reabrir, una acción existente no vuelve a ejecutar el Core **ni a enviar una
respuesta**, incluso si quedó como entrega pendiente. No hay outbox con textos
privados para reconstruirla: alguna respuesta puede perderse. Si se recibe un
mensaje nuevo, su acción lógica es distinta; no usarlo para ocultar incertidumbre.
La reserva de agente también se conserva: completed sin output persistido queda
como estado conocido; pending recuperado no añade polling remoto automático.

Conservar archivo y sidecars según la estrategia de respaldo futura. No borrar
reservas, resetear offset o restaurar una copia antigua para forzar reenvíos.
La compactación tras siete días redacta detalle terminal elegible, conserva
tombstones y no elimina pending/inciertos. [Esquema y límites](AGENT_RUNTIME.md#estado-durable-opcional-de-fase-1e1),
[ADR](adr/0001-durable-state-sqlite.md), [pruebas de recuperación](PHASE_1E1_VALIDATION.md).
El supervisor `telegram:agents:demo` sigue siendo temporal y usa claves efímeras:
no prueba continuidad de la instalación del operador entre sus ejecuciones.
