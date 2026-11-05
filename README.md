# Sir Jarvis

Un orquestador personal de agentes de inteligencia artificial, open source, modular
y autogestionado, que permite conectar, controlar y recibir información de agentes
independientes mediante una interfaz conversacional.

**Estado:** bootstrap y Telegram implementados. La aceptación con Telegram real
fue reportada como exitosa por el operador el 2026-11-02. Fase 1B implementa
Registry/Gateway en memoria, validación y autorización. Fase 1C añade transporte
HTTPS real, verificado contra un proceso de prueba independiente. No hay agentes
de dominio conectados, IA o despliegue. Fase 1D conecta
Telegram con el Core y ese Gateway mediante comandos opcionales de lectura,
deshabilitados por defecto; el recorrido completo se prueba con Telegram simulado
y Echo HTTPS independiente. La nueva aceptación con Telegram real queda para el operador.
Fase 1E.1 añade estado durable opcional en SQLite WAL para reservas, acciones y
offsets, con recuperación conservadora y sin guardar mensajes u outputs completos.
Fase 1E.2 añade contenedorización local, backups cifrados coherentes con WAL y
restauración aislada bloqueada hasta conciliación. Su evidencia se distingue de
un despliegue AWS o de una garantía exactamente-una-vez.
La licencia definitiva sigue pendiente.

Fase 1F prepara el piloto Lightsail con un Compose mínimo, preflight, métricas
locales, runbook y checklist de costos/seguridad. **No despliega AWS** ni confirma
créditos activos; requiere autorización expresa antes de crear recursos.

Jarvis centraliza permisos, conversaciones, coordinación y notificaciones.
Cada agente conserva su lógica, datos, repositorio, lenguaje y despliegue; puede
funcionar sin Jarvis. Las conexiones usarán contratos versionados. Privacidad,
seguridad y costos bajos son requisitos; ningún gasto se habilita por registrar
un agente o por este diseño.

- [Arranque y documentación](docs/README.md)
- [Reglas generales](docs/PRODUCT_RULES.md)
- [Arquitectura y diagrama](docs/ARCHITECTURE.md)
- [Protocolo de agentes v1](docs/AGENT_PROTOCOL.md)
- [Registry/Gateway, HTTPS y demos locales](docs/AGENT_RUNTIME.md)
- [Infraestructura y estimaciones](docs/DEPLOYMENT_STRATEGY.md)
- [Plan AWS sin desplegar](docs/AWS_DEPLOYMENT_PLAN.md)
- [Runbook del piloto Lightsail](docs/AWS_PILOT_RUNBOOK.md)
- [Checklist previo de autorización](docs/AWS_PILOT_CHECKLIST.md)
- [Validación local de Fase 1F](docs/PHASE_1F_VALIDATION.md)
- [Egreso seguro del piloto e integración con el bloqueo existente](docs/EGRESS_POLICY.md)
- [Evidencia y pendientes de Fase 1G](docs/PHASE_1G_VALIDATION.md)
- [Roadmap de Jarvis](docs/ROADMAP.md)
- [Telegram](docs/TELEGRAM.md)
- [Finance Agent independiente](docs/agents/FINANCE_AGENT_SPEC.md)
- [Trazabilidad financiera](docs/agents/FINANCE_AGENT_TRACEABILITY.md)
- [Validación de Fase 1E.1](docs/PHASE_1E1_VALIDATION.md)
- [Ejecución local con Docker Compose](docs/LOCAL_DEPLOYMENT.md)
- [Backups y restauración segura](docs/BACKUP_RESTORE.md)
- [Validación de Fase 1E.2](docs/PHASE_1E2_VALIDATION.md)
- [Decisión SQLite WAL](docs/adr/0001-durable-state-sqlite.md)
- [Git, protección de main y PR](docs/GIT_WORKFLOW.md)

Para colaborar con Codex, consulta [AGENTS.md](AGENTS.md).

Con Node 24.22.1+ de la rama 24, desde la raíz:

```sh
npm ci
npm run agents:telegram:demo
```

Simula Telegram, recorre Core → Gateway → Echo HTTPS independiente y comprueba
la respuesta antes de cerrar. No requiere credenciales ni infraestructura pública.
Para probar `/agents` y `/agent demo.echo echo.reply Hola Jarvis` con tu bot real,
sigue la [guía manual](docs/TELEGRAM.md#prueba-manual-con-telegram-real-y-echo-local).
`/start`, `/status` y el comportamiento sin integración se conservan.
AWS/Lightsail es la estrategia principal;
el saldo, la elegibilidad y el vencimiento de créditos siguen sin verificar.

La durabilidad se activa con `JARVIS_STATE_FILE` tras inicializar explícitamente
un archivo privado. El bot normal exige esa DB cuando se activan los comandos de
agentes; las demos/adaptadores programáticos pueden seguir usando memoria, sin
garantías durables. Una DB configurada ausente o inválida detiene el arranque, sin
recrearla. [Preparación y reinicios](docs/AGENT_RUNTIME.md#estado-durable-opcional-de-fase-1e1).
