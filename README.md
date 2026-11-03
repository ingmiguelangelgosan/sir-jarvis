# Sir Jarvis

Un orquestador personal de agentes de inteligencia artificial, open source, modular
y autogestionado, que permite conectar, controlar y recibir información de agentes
independientes mediante una interfaz conversacional.

**Estado:** bootstrap y Telegram implementados. La aceptación con Telegram real
fue reportada como exitosa por el operador el 2026-11-02. Fase 1B implementa
Registry/Gateway en memoria, validación y autorización. Fase 1C añade transporte
HTTPS real, verificado contra un proceso de prueba independiente. No hay agentes
de dominio conectados, IA, despliegue ni persistencia durable.
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
- [Registry/Gateway, HTTPS y demos locales](docs/AGENT_RUNTIME.md)
- [Infraestructura y estimaciones](docs/DEPLOYMENT_STRATEGY.md)
- [Plan AWS sin desplegar](docs/AWS_DEPLOYMENT_PLAN.md)
- [Roadmap de Jarvis](docs/ROADMAP.md)
- [Telegram](docs/TELEGRAM.md)
- [Finance Agent independiente](docs/agents/FINANCE_AGENT_SPEC.md)
- [Trazabilidad financiera](docs/agents/FINANCE_AGENT_TRACEABILITY.md)
- [Validación de Fase 1C](docs/PHASE_1C_VALIDATION.md)
- [Git, protección de main y PR](docs/GIT_WORKFLOW.md)

Para colaborar con Codex, consulta [AGENTS.md](AGENTS.md).

Con Node 24.22.1+ de la rama 24, desde la raíz:

```sh
npm ci
npm run agents:https:demo
```

Arranca un agente HTTPS independiente temporal, ejecuta `echo.reply` desde el Core
y cierra ambos lados. No requiere credenciales propias ni usa infraestructura pública.
Telegram conserva su comportamiento. AWS/Lightsail es la estrategia principal;
el saldo, la elegibilidad y el vencimiento de créditos siguen sin verificar.
