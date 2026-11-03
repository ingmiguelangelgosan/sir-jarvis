# Sir Jarvis — roadmap del orquestador

Cada fase termina con evidencia local, tests y PR con CI Windows/Linux. El estado
documental no equivale a implementación funcional. Las fases de Finance Agent
pertenecen a [su roadmap independiente](agents/FINANCE_AGENT_ROADMAP.md).

## Fase 0 — bootstrap: COMPLETADA

Node/TypeScript, configuración, diagnóstico, formato, lint, tests y CI. Integrada
mediante PR #1. El registro de verificación original permanece en
[PHASE_0_VALIDATION](PHASE_0_VALIDATION.md); sus pendientes se interpretan a la
fecha de esa entrega, no como estado actual.

## Fase 1A — Telegram: IMPLEMENTADA

PR #2 fusionado en main, verificado mediante GitHub. Texto por long polling,
allowlist numérica/chat privado, /start, /status, fallback, errores sanitizados,
límites, cancelación y deduplicación temporal. CI Windows/Linux aprobada en ese PR.
[Implementación y pruebas](PHASE_1A_VALIDATION.md), [guía](TELEGRAM.md).

**Aceptación real:** el operador reportó el 2026-11-02 que las pruebas de Telegram
salieron correctamente. Es evidencia de uso reportada por el usuario, separada
de los 104 tests automatizados de Fase 1A. No se inventan resultados por caso,
carga, retención o agentes externos que aún no se probaron.

## Fase 1A.5 — arquitectura de orquestador: FUSIONADA

Entrega documental fusionada mediante PR #3: identidad, fronteras de proyectos, protocolo v1,
estrategia de infraestructura, tipos puros y conservación financiera verificable.
[Copia original](history/PRODUCT_RULES_FINANCE_V0.1.md),
[trazabilidad](agents/FINANCE_AGENT_TRACEABILITY.md) y
[validación](PHASE_1A5_VALIDATION.md).

Listo cuando todas las reglas financieras están preservadas sin cambios, los
documentos/tipos son coherentes, enlaces y tests pasan, Telegram conserva su
comportamiento y el PR queda para revisión manual. No hay Registry/Gateway
funcionales, conexiones a agentes, DB nueva, MCP, IA ni infraestructura desplegada.

## Fase 1B — primer Registry y Gateway: FUSIONADA, CON FAKE

PR #4 fusionado en main, verificado antes de iniciar Fase 1C.
Registro local administrado, habilitación y permisos por sujeto/capacidad;
manifest/schema versionados y rechazo por defecto. Gateway orquestado mediante
un transporte falso inyectado, correlación, estados, deadline e idempotencia
en memoria con límites explícitos. Sin agente de dominio ni HTTP real.

La implementación se ejecuta mediante `npm run agents:demo` y un caso de uso
programático independiente de Telegram. Incluye validación runtime, single-flight
concurrente, cancelación por caller, plazos, cooldown, pending y tombstones inciertos.
La caché de outputs tiene retención explícita y las reservas no se expulsan para
permitir nuevos efectos. Al reiniciar se pierde la protección en memoria.
[Guía y límites](AGENT_RUNTIME.md), [validación](PHASE_1B_VALIDATION.md).

Aceptación: un usuario permitido solicita una capacidad ficticia registrada y
recibe resultado simulado correcto; desconocidos, deshabilitados, versión/schema
inválidos, permisos insuficientes, deadline y duplicados se prueban sin red ni
cargos. No interpretar memoria como protección durable de producción.
[Prompt recomendado](prompts/PHASE_1B_PROMPT.md).

## Fase 1C — agente ficticio independiente y HTTPS: FUSIONADA

PR #5 fusionado en main, verificado antes de iniciar Fase 1D.
Transporte HTTPS real con Bearer server-only, TLS, allowlist, DNS/IP fijada,
rechazo de SSRF/redirects y validación estricta. Demo `agents:https:demo` contra
un fixture independiente ejecutado como otro proceso, sin imports de Jarvis ni
nuevo repositorio. Conserva idempotencia concurrente, cancelación e incertidumbre
de Fase 1B, con resultados síncronos o polling autorizado. No hay notificaciones
externas, agentes de dominio o despliegue. [Validación](PHASE_1C_VALIDATION.md).

AWS/Lightsail sustituye la preferencia anterior por DigitalOcean, solo como
decisión documental. [Estrategia](DEPLOYMENT_STRATEGY.md) y [plan AWS](AWS_DEPLOYMENT_PLAN.md)
separan costo bruto, créditos y neto; cuenta/créditos aún no verificados.

Aceptación: compatibilidad comprobada entre procesos y versiones, sin importar
código interno del otro proyecto. Cualquier creación de repositorio o alojamiento
se autoriza por separado. Mantener fixtures, mocks y tests sin credenciales.

## Fase 1D — Telegram con Registry/Gateway: IMPLEMENTADA LOCALMENTE

Integración opcional y deshabilitada por defecto del adaptador Telegram existente
con `AgentExecutionService`, Registry, Gateway y transporte HTTPS de Fase 1C.
Comandos `/agents` y `/agent` deterministas, bindings de identidad internos,
permisos por sujeto/capacidad, perfil `no-paid-services` y rechazo de escrituras.
El primer contrato conversacional soportado es `echo.reply` 1.0 de lectura;
otras capacidades requieren adaptación explícita, no descubrimiento automático.
`/start`, `/status` y los comportamientos sin integración se conservan.

Aceptación automatizada: Telegram simulado → Core → Gateway → Echo HTTPS
independiente → respuesta de Telegram simulada, incluyendo autenticación,
permisos, duplicados concurrentes, errores seguros, cancelación y timeout.
Una prueba de piezas aisladas no satisface esta fase. Demo:
`npm run agents:telegram:demo`. La [guía manual](TELEGRAM.md#prueba-manual-con-telegram-real-y-echo-local)
permite al operador probar su bot real con un supervisor temporal; su nueva
aceptación real está pendiente y no se infiere de la evidencia simulada.
[Resultados y límites](PHASE_1D_VALIDATION.md).

Claves HMAC estables por acción, sin enviar IDs Telegram al agente; reservas,
offset, resultados y pending siguen en memoria y se pierden al reiniciar.
Solo lectura en este corte: no se habilitan efectos sensibles, IA, eventos,
DB, nuevos repositorios o infraestructura AWS.

## Fase 1E — persistencia durable, Compose y recuperación local: SIGUIENTE

Elegir almacenamiento mínimo para configuración, permisos, estados, claves de
deduplicación y auditoría mínima, sin copiar datos de dominio. Implementar y
probar transiciones durables, arranque y cierre, expiración/retención, reinicios,
conciliación de operaciones inciertas y recuperación sin repetir efectos a ciegas.
No basta con restaurar un snapshot de disco: debe preservarse la semántica de
solicitudes pendientes y claves antes de reabrir tráfico.

Preparar Docker Compose local con imágenes reproducibles, secretos separados,
redes/egreso y TLS sin bypass, límites de recursos, salud y rollback. Probar backup
y restauración aislados, pérdida de proceso/host y un único consumidor Telegram.
Medir recuperación y documentar RPO/RTO antes de prometerlos.

Aceptación: pruebas de reinicio/duplicados concurrentes, corte de red y recuperación,
más Compose ejecutado localmente y restauración comprobada. Sigue pendiente;
no se introduce DB o Compose para anticiparla durante Fase 1D. Esta entrega es
requisito previo a AWS con efectos sensibles, no autorización de despliegue.
Lightsail permanece como proveedor principal previsto; presupuesto, créditos,
región y recursos exactos requieren revisión y aprobación separadas.

## Fase 2 — primer agente real externo

Elegir un agente, comprobar que funciona por sí solo, sus términos de privacidad,
permisos, compatibilidad y presupuesto. Finance Agent es candidato, no módulo de
Jarvis ni dependencia obligatoria. Ninguna integración paga se activa por defecto.
La aceptación pertenece a ambos proyectos y sus fuentes de verdad.
Antes de permitir efectos sensibles, completar la recuperación durable de Fase 1E
y las confirmaciones/idempotencia propias del agente externo.

## Fase 3 — eventos, notificaciones y autonomía

Sobre la base durable de Fase 1E: Dispatcher, autenticación/replay, inbox/outbox
durable, consentimiento revocable,
correlación de operaciones pendientes y deduplicación antes de efectos. Elegir y
probar persistencia mínima, recuperación y límites. Autonomía/scheduler en el
agente; Jarvis centraliza solo notificaciones permitidas y estados necesarios.
Demostrar reinicios, duplicados y revocación sin avisos no solicitados.

## Fase 4 — IA y políticas de consumo

Varias APIs intercambiables, elegibilidad por privacidad/capacidad, evaluación,
fallback seguro, activación paga explícita, reservas de presupuesto, medición y
topes de proveedor. No modelos locales iniciales ni entrenamiento privado.
Sin proveedor apto o presupuesto, falla cerrado. Pruebas con adaptadores falsos.

## Fase 5 — despliegue, monitoreo y escalabilidad

Implementar y probar Docker/Compose, secretos, TLS/red, backups/restauración,
reinicio y métricas; luego dimensionar según consumo. AWS/Lightsail es la propuesta
principal; EC2/Lambda y DigitalOcean/Cloud Run son alternativas documentadas,
sin recursos contratados. Revisar costos y solicitar
autorización concreta antes de cualquier contratación o activación de facturación.
La preparación local empieza en Fase 1E; esta fase exige además validar el entorno
objetivo y una autorización concreta, sin saltar recuperación o controles de costo.

## Fase 6 — web y funciones adicionales

Interfaz web/PWA, otros canales y herramientas autorizadas. Evaluar MCP como
adaptador posterior, conservando permisos y límites. Licencia, distribución,
contribuciones y publicación requieren decisiones explícitas; no prometer un
producto público alojado o comercialización antes de resolverlas.

## Fuera de este repositorio y de esta fase

Lógica financiera, vuelos, deportes, sus tablas y schedulers específicos, creación
de repositorios externos, banca/transferencias, pago de APIs, modelos locales,
colas distribuidas y microservicios internos. No se reanuda el antiguo flujo de
cuota del iPhone dentro de Jarvis: sus requisitos se conservan para Finance Agent.
