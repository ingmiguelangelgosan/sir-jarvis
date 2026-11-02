# Instrucciones para Codex — Sir Jarvis

Lee y aplica [docs/AGENTS.md](docs/AGENTS.md) antes de trabajar.
Las rutas de implementación se interpretan desde la raíz.

- Reglas generales del orquestador: [PRODUCT_RULES](docs/PRODUCT_RULES.md).
- Fronteras y seguridad: [ARCHITECTURE](docs/ARCHITECTURE.md).
- Contrato versionado: [AGENT_PROTOCOL](docs/AGENT_PROTOCOL.md).
- Entregas: [ROADMAP](docs/ROADMAP.md).
- Git, PR y CI: [GIT_WORKFLOW](docs/GIT_WORKFLOW.md).
- Dominio financiero **externo**: [Finance Agent](docs/agents/FINANCE_AGENT_SPEC.md).

Los subagentes de desarrollo de Codex ayudan a trabajar en el repositorio.
Los agentes conectados a Jarvis son aplicaciones independientes en ejecución.
No implementar sus dominios en el núcleo. Mantén aquí el punto de entrada;
las instrucciones completas viven en `docs/`.
