# Sir Jarvis

Un orquestador personal de agentes de inteligencia artificial, open source, modular
y autogestionado, que permite conectar, controlar y recibir información de agentes
independientes mediante una interfaz conversacional.

**Estado:** bootstrap y Telegram implementados. La aceptación con Telegram real
fue reportada como exitosa por el operador el 2026-11-02. La Fase 1A.5 define la
arquitectura, el protocolo y tipos puros; todavía no hay agentes externos
conectados, Registry/Gateway funcionales, IA ni persistencia del orquestador.
La licencia definitiva sigue pendiente.

Jarvis centraliza permisos, conversaciones, coordinación y notificaciones.
Cada agente conserva su lógica, datos, repositorio, lenguaje y despliegue; puede
funcionar sin Jarvis. Las conexiones usarán contratos versionados. Privacidad,
seguridad y costos bajos son requisitos; ningún gasto se habilita por registrar
un agente o por este diseño.

- [Arranque y documentación](docs/README.md)
- [Reglas generales](docs/PRODUCT_RULES.md)
- [Arquitectura y diagrama](docs/ARCHITECTURE.md)
- [Protocolo de agentes v1](docs/AGENT_PROTOCOL.md)
- [Infraestructura y estimaciones](docs/DEPLOYMENT_STRATEGY.md)
- [Roadmap de Jarvis](docs/ROADMAP.md)
- [Telegram](docs/TELEGRAM.md)
- [Finance Agent independiente](docs/agents/FINANCE_AGENT_SPEC.md)
- [Trazabilidad financiera](docs/agents/FINANCE_AGENT_TRACEABILITY.md)
- [Validación de esta fase](docs/PHASE_1A5_VALIDATION.md)
- [Prompt recomendado para Fase 1B](docs/prompts/PHASE_1B_PROMPT.md)
- [Git, protección de main y PR](docs/GIT_WORKFLOW.md)

Para colaborar con Codex, consulta [AGENTS.md](AGENTS.md).
