# Telegram — Fase 1A

Jarvis recibe texto y responde `/start`, `/status` o una explicación breve de que
la función solicitada sigue pendiente. No interpreta pagos, no guarda operaciones,
no usa IA y no envía recordatorios. Las pruebas automáticas simulan Telegram;
el operador reportó aceptación con Telegram real exitosa el 2026-11-02.
Esta fase conserva el comportamiento; no repite pruebas con sus credenciales.

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
```

Los dos últimos valores son marcadores que debes reemplazar; no son credenciales
funcionales. El token y la allowlist vacíos o inválidos impiden iniciar Telegram.
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
enviar de nuevo el comando; no hay efectos financieros en esta fase.

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

La memoria y el offset no persisten: tras reiniciar, una actualización todavía no
confirmada en Telegram puede reaparecer. No hay garantía de entrega exactamente
una vez ni de idempotencia financiera. El futuro Finance Agent independiente
requerirá claves únicas y transacciones propias antes de registrar dinero; Jarvis
no incorporará su libro financiero.

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
