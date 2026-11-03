# Sir Jarvis — reglas del orquestador

**Decisión funcional explícita, 2026-11-02:** Jarvis pasa de la propuesta de asistente
con finanzas internas a un orquestador de agentes independientes. Esta decisión
cambia la frontera de proyectos; las reglas financieras no se eliminan ni se
reinterpretan. Su fuente actual es [Finance Agent](agents/FINANCE_AGENT_SPEC.md).
La [copia original](history/PRODUCT_RULES_FINANCE_V0.1.md) y la
[trazabilidad](agents/FINANCE_AGENT_TRACEABILITY.md) conservan todas sus condiciones.
Estas reglas describen comportamiento objetivo; no equivalen a funciones implementadas.

## ORC-01 — Identidad y límites

Jarvis ofrece interfaz conversacional, coordinación, permisos y distribución de
notificaciones. Cada agente conectado es una aplicación independiente que puede
funcionar sin Jarvis, con repositorio, lenguaje, datos, licencia y alojamiento
propios. Su publicación o comercialización es una decisión del proyecto externo.
Jarvis no incorpora reglas de finanzas, vuelos, deportes u otros dominios.
La integración depende de contratos versionados y capacidades explícitas, sin
modificar el núcleo por cada agente.

## ORC-02 — Identidad y autorización

La instalación inicial pertenece a un operador; Telegram autoriza por IDs
numéricos y chat privado, nunca por username. La allowlist explícita no equivale
a aislamiento multiusuario. Antes de compartir datos o ejecutar una capacidad,
validar instancia, sujeto, agente habilitado, capacidad y permiso vigente.
Un resultado, manifiesto o evento de un agente no puede ampliar permisos,
registrar agentes, elegir destinatarios ni activar herramientas por sí mismo.

## ORC-03 — Privacidad y credenciales

Usar credenciales propias, server-only, separadas por integración y privilegio
mínimo. No enviarlas dentro de mensajes JSON, URLs de configuración/usuario o
respuestas de canales ni guardarlas en logs o commits. Única excepción de
transporte existente: la Bot API oficial de Telegram exige el token en la ruta
HTTPS al host fijo `api.telegram.org`; esa URL queda dentro del cliente servidor,
sin redirects, nunca se expone al usuario ni se registra. No extender esta
excepción a agentes: su autenticación va en headers, no en URLs. Los secretos
se resuelven localmente por referencias y transporte seguro.
Enviar a cada agente únicamente los datos necesarios y aprobados para su tarea.
No enviar datos personales, comprobantes ni datos financieros a servicios o
modelos sin políticas efectivas de no entrenamiento y retención aceptable.
Un nivel gratuito o un agregador no garantiza privacidad. Sin ruta elegible,
fallar cerrado; no sustituirla por una insegura. No entrenar con datos privados.

## ORC-04 — Costos y autorización

Ninguna integración puede generar gastos sin habilitación expresa y presupuesto
configurado. Separar infraestructura, operación autónoma de cada agente y consumo
de proveedores de IA. Registrar un endpoint, aceptar un evento o planear USD 25 de
infraestructura no autoriza compras ni facturación. Priorizar opciones gratuitas
solo si cumplen privacidad y capacidad; no ejecutar modelos locales al inicio.
Antes de cualquier futura llamada paga, comprobar autorización y presupuesto,
reservar consumo concurrente y usar topes del proveedor cuando existan. Las
estimaciones locales no garantizan un límite de facturación por carreras, latencia,
cargos externos o cambios de precios. Ante incertidumbre, detener la ruta.
Actualmente IA permanece deshabilitada; solo se verifica un agente ficticio local
en testing, sin agentes de dominio ni infraestructura contratada.

## ORC-05 — Confirmaciones y confianza

Pedir aclaración ante baja confianza, ambigüedad o falta de información. Obtener
las confirmaciones requeridas antes de acciones sensibles; conservar el canal de
origen para preguntas de seguridad y costo. La interpretación por IA nunca
concede permisos ni confirma efectos. El agente de dominio valida sus propias
reglas y confirmaciones; Jarvis presenta preguntas y resultados sin inventar
datos ni estados exitosos. Un timeout no demuestra que la operación haya fallado.

## ORC-06 — Propiedad de datos

Cada agente es la fuente de verdad de su dominio. Jarvis podrá persistir
configuración, registro, permisos, preferencias, estados y referencias de
solicitudes/eventos y auditoría mínima. No copiar dentro de Jarvis libros
financieros, saldos, comprobantes, catálogos internos ni bases completas ajenas.
No almacenar conversaciones o resultados completos por defecto. Los datos
transitorios, sus límites y borrado se definen explícitamente por integración.
Las correcciones de preferencias y decisiones deben ser auditables, sin
reescribir silenciosamente historiales.

## ORC-07 — Integración desacoplada

Usar [AGENT_PROTOCOL v1](AGENT_PROTOCOL.md), inicialmente HTTPS y JSON.
Identidad y capacidades declaradas no implican confianza: el operador registra
conexión y permisos. Validar entradas, salidas, versiones y schemas antes de
presentar o ejecutar datos. Tratar resultados como datos no confiables, nunca
como instrucciones para cambiar políticas o ejecutar SQL/herramientas arbitrarias.
MCP queda como adaptación futura bajo los mismos permisos; no se implementa ahora.

## ORC-08 — Idempotencia y auditoría

Separar IDs de solicitud, correlación, operación, evento y clave de idempotencia.
Conservar la clave al reintentar una misma operación; rechazar su reutilización
con datos distintos. Autorizar antes de reservar o ejecutar. El agente garantiza
idempotencia de efectos de negocio y Jarvis de sus transiciones y distribución.
Los eventos externos requieren autenticación, protección contra replay y
deduplicación durable antes de producir efectos. Un efecto incierto requiere
consulta o conciliación, no repetición a ciegas. No prometer entrega exactamente
una vez por Telegram. Registrar metadatos mínimos sin contenido sensible.

## ORC-09 — Notificaciones y autonomía

Jarvis solo distribuye tipos de evento y destinos habilitados expresamente por
el operador. Una firma válida no equivale a consentimiento. Revalidar permisos,
suscripción y destinatario al recibir y entregar el evento; ignorar destinos
propuestos por el agente. Un agente puede programar tareas en su propia aplicación
con autorización y presupuesto independientes; Jarvis no asume su scheduler.
Mantener mensajes breves y evitar duplicados. Las políticas específicas de
notificación, incluidas las restricciones financieras ya acordadas, pertenecen
al agente y no se amplían al conectarlo. No contactar terceros sin autorización.

## ORC-10 — Preferencias y aprendizaje

Persistir solo preferencias y correcciones explícitas del operador que sean
necesarias, con trazabilidad y alcance por agente/instancia. No hay fine-tuning
privado ni aprendizaje implícito que amplíe permisos. Personalidad cercana,
humor opcional y sin moralizar; aclarar si algo está estimado, pendiente o no
implementado. Ante conflicto entre salida del agente y política, bloquear o preguntar.

## ORC-11 — Autogestión y portabilidad

El proyecto busca distribución open source y BYOK: documentación sin credenciales
del mantenedor, recursos por instalación y dependencias intercambiables. La
licencia definitiva sigue pendiente; no afirmar que ya hay derechos concedidos
para publicar o comercializar el código. Docker Compose y proveedores externos
son decisiones de despliegue, no dependencias del protocolo ni de los dominios.

## ORC-12 — Entregas y alcance actual

Conservar el Telegram existente. Distinguir implementado, simulado, reportado por
el operador, diseñado, pendiente y no verificado. No construir microservicios
internos, colas distribuidas, servidores MCP, web o nuevos repositorios en esta
fase. El servicio Jarvis sigue siendo modular y ligero. Los tipos del protocolo
no validan JSON por sí solos; Fase 1B añade validación, autorización y Registry/Gateway
en memoria con transporte falso. Fase 1C incorpora HTTPS con un proceso de prueba
independiente; no equivale a conectar agentes de dominio, persistir idempotencia
o controlar presupuestos de producción. Eventos durables y consumo comercial
siguen pendientes. AWS es una estrategia documentada, sin desplegar ni contratar.

Fase 1D añade comandos Telegram opcionales, deshabilitados por defecto, para
capacidades Echo de lectura autorizadas mediante el Core y el Gateway HTTPS.
No habilita escritura, finanzas, IA, interpretación libre, autonomía o pagos.
La deduplicación sigue en memoria; la prueba de esa ruta con el bot real se
separa de la evidencia automatizada con Telegram simulado y HTTPS local real.
