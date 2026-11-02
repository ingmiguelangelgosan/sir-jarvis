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

## Fase 1A.5 — arquitectura de orquestador

Entrega documental de esta rama: identidad, fronteras de proyectos, protocolo v1,
estrategia de infraestructura, tipos puros y conservación financiera verificable.
[Copia original](history/PRODUCT_RULES_FINANCE_V0.1.md),
[trazabilidad](agents/FINANCE_AGENT_TRACEABILITY.md) y
[validación](PHASE_1A5_VALIDATION.md).

Listo cuando todas las reglas financieras están preservadas sin cambios, los
documentos/tipos son coherentes, enlaces y tests pasan, Telegram conserva su
comportamiento y el PR queda para revisión manual. No hay Registry/Gateway
funcionales, conexiones a agentes, DB nueva, MCP, IA ni infraestructura desplegada.

## Fase 1B — primer Registry y Gateway funcionales

Registro local administrado, habilitación y permisos por sujeto/capacidad;
manifest/schema versionados y rechazo por defecto. Gateway orquestado mediante
un transporte falso inyectado, correlación, estados, deadline e idempotencia
en memoria con límites explícitos. Sin agente de dominio ni HTTP real.

Aceptación: un usuario permitido solicita una capacidad ficticia registrada y
recibe resultado simulado correcto; desconocidos, deshabilitados, versión/schema
inválidos, permisos insuficientes, deadline y duplicados se prueban sin red ni
cargos. No interpretar memoria como protección durable de producción.
[Prompt recomendado](prompts/PHASE_1B_PROMPT.md).

## Fase 1C — agente ficticio independiente y HTTPS

Probar el contrato contra una aplicación ficticia que arranque y se pruebe sin
Jarvis, en un proyecto independiente autorizado. Agregar el transporte HTTPS,
autenticación, validación real de schemas/respuestas, timeout, cancelación y
reintentos seguros. Solo resultados síncronos o polling autorizado de operaciones
en este corte; no abrir aún notificaciones externas sin persistencia durable.

Aceptación: compatibilidad comprobada entre procesos y versiones, sin importar
código interno del otro proyecto. Cualquier creación de repositorio o alojamiento
se autoriza por separado. Mantener fixtures, mocks y tests sin credenciales.

## Fase 2 — primer agente real externo

Elegir un agente, comprobar que funciona por sí solo, sus términos de privacidad,
permisos, compatibilidad y presupuesto. Finance Agent es candidato, no módulo de
Jarvis ni dependencia obligatoria. Ninguna integración paga se activa por defecto.
La aceptación pertenece a ambos proyectos y sus fuentes de verdad.

## Fase 3 — eventos, notificaciones y autonomía

Dispatcher, autenticación/replay, inbox/outbox durable, consentimiento revocable,
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
reinicio y métricas; luego dimensionar según consumo. DigitalOcean/Cloud Run
son opciones documentadas, no recursos ya contratados. Revisar costos y solicitar
autorización concreta antes de cualquier contratación o activación de facturación.

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
