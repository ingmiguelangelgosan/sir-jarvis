# Prompt recomendado — Fase 1B

Continúa Sir Jarvis desde `main` actualizado **solo después de verificar que el
PR de Fase 1A.5 esté fusionado**. Si no está, informa esa condición y detén la
implementación. Lee AGENTS.md, docs/AGENTS.md, PRODUCT_RULES, ARCHITECTURE,
AGENT_PROTOCOL, ROADMAP y PHASE_1A5_VALIDATION en sus rutas reales.

Implementa el primer Agent Registry y Agent Gateway funcionales detrás de los
puertos puros de `src/agents/protocol.ts`. Mantén Node 24/TypeScript, Telegram,
configuración segura y los comandos actuales. No cambies respuestas o flujos de
Telegram para demostrar una integración que no está conectada.

Alcance:

1. Registry en memoria desde configuración local explícita, sin auto-discovery,
   con IDs únicos por instancia, versiones, capacidades, schemas, conexión
   permitida, habilitación y disponibilidad. No loguear referencias sensibles.
2. Validación de runtime para envelopes y datos de capacidades ficticias conforme
   al protocolo. Los tipos no bastan para JSON no confiable. Rechazar versiones,
   entradas/respuestas cruzadas y campos no permitidos antes de efectos.
3. Un caso de uso del Core que compruebe sujeto, instancia, agente y capacidad
   autorizados antes de invocar el Gateway. Fallar cerrado por defecto; un
   manifiesto o resultado nunca concede permisos.
4. Gateway con **transporte falso inyectado**, sin HTTP real. Respuestas completed,
   pending y failed, IDs de correlación, deadlines/cancelación y errores seguros.
   No crear un servicio de agente ficticio dentro del repositorio.
5. Reserva y deduplicación en memoria de solicitudes, mismo resultado para retries
   de la misma clave y 409 si cambia el comando. Documentar reinicios/efectos
   inciertos; no presentarlo como persistencia o idempotencia de negocio.
6. Perfil `no-paid-services` obligatorio. Sin proveedores de IA, presupuestos pagos
   activados, facturación ni llamadas de servicios comerciales.
7. Tests ficticios de registro duplicado, agentes desconocidos/deshabilitados,
   sujetos y capacidades no autorizados, schemas/versiones inválidos, respuesta
   cruzada, timeout/abort, 429, reintento seguro y duplicados. Conservar todos los
   tests anteriores y las verificaciones del snapshot financiero.

No implementar HTTP con agentes, webhooks externos, Dispatcher, scheduler,
MCP, nueva DB, finanzas, vuelos o deportes. No crear repositorios de agentes ni
contratar/desplegar infraestructura. La conexión a un agente ficticio independiente
será Fase 1C; la autenticación/replay de eventos reales y persistencia durable,
Fase 3. Finance Agent conserva su propio roadmap y datos.

Propón primero un incremento pequeño, sus límites y tests; delega revisión o
tests independientes solo si aportan valor y con propietario único por archivo.
Trabaja en `feat/agent-registry-gateway` desde main, sin force push o cambios de
protección. Ejecuta formato, lint, typecheck, tests, build, enlaces y revisión de
secretos. Abre PR hacia main y verifica CI Windows/Linux. No fusionar ni activar
auto-merge. Entrega resumen, comandos reales, resultados, limitaciones y siguiente
corte recomendado, citando ORC-01…ORC-12 según aplique.
