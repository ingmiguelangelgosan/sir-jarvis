# Primer prompt para pegar en Codex (VS Code)

> Copia el texto de abajo en una nueva conversación de Codex, con la carpeta raíz abierta.

---

Quiero comenzar a implementar **Jarvis**, un asistente personal open source y self-hosted.

1. Lee `AGENTS.md` y revisa `docs/ARCHITECTURE.md`, `docs/PRODUCT_RULES.md` y `docs/ROADMAP.md` **solo en las partes necesarias para la Fase 0 y el primer flujo de la Fase 1**. No asumas que ya existe código funcional.
2. Propón en pocas líneas la estructura mínima de Node.js + TypeScript, las dependencias actuales con versiones comprobables, las capas del sistema y cómo ejecutar pruebas locales sin API keys.
3. Implementa **solamente la Fase 0**: bootstrap reproducible, configuración validada, estructura modular mínima, formato/lint/typecheck, tests de ejemplo, `.gitignore`, `.env.example` sin secretos y README actualizado con comandos reales.
4. No crees microservicios, frontend, Calendar, MCP, integración bancaria ni funcionalidades financieras completas todavía.
5. Considera si hay dos tareas independientes para subagentes: por ejemplo, revisión de riesgos de configuración y diseño de tests. Úsalos solo si hay beneficio claro, evitando que dos agentes editen los mismos archivos. Respeta máximo tres subagentes y valida que la versión de Codex soporte la función.
6. Ejecuta los comandos reales que estén disponibles. Reporta exactamente cuáles pasaron, cuáles fallaron y qué no pudiste verificar.
7. No conectes proveedores de pago, no generes facturación de API y no despliegues recursos en la nube sin mi autorización.
8. Deja un resumen final con cambios, comandos de ejecución, pruebas y el siguiente paso propuesto para el flujo «pagué la cuota del iPhone».

La privacidad de datos financieros, la idempotencia de movimientos, el control de gasto de IA y el aislamiento de credenciales son requisitos obligatorios desde el diseño.
