# Jarvis — roadmap y cortes del MVP

**Principio:** preferir ciclos cortos verificables; cada fase termina con demo local, pruebas y documentación actualizada. No considerar estos hitos ya implementados.

## Fase 0 — base del repositorio

**Estado local (2026-11-01):** implementada y verificada en Windows con Node 24.22.1: 20 tests, formato, lint, typecheck, build y diagnóstico aprobados. Workflow de GitHub preparado; ejecución remota y Linux aún no verificados. Comandos, incidencias y límites en [docs/PHASE_0_VALIDATION.md](PHASE_0_VALIDATION.md).

- Crear Node.js/TypeScript, formateo, lint, tests, `.env.example`, `.gitignore`, scripts y CI de GitHub.
- Configuración validada y separación de adaptadores, aplicación, dominio, infraestructura.
- Prueba de health/check o comando local de diagnóstico; sin credenciales reales en tests.

**Listo cuando:** levantar proyecto local tiene pasos reproducibles y los tests de ejemplo pasan.

## Fase 1 — primer flujo de finanzas por Telegram (MVP mínimo)

### Corte 1A — transporte Telegram

Implementado en `feat/telegram-integration`: texto por long polling, allowlist de IDs y chats privados, `/start`, `/status`, respuesta a funciones pendientes, errores sanitizados, límites y deduplicación en memoria. IA deshabilitada. Pruebas con API simulada; prueba manual con bot propio pendiente. Guía: [TELEGRAM.md](TELEGRAM.md). Verificación: [PHASE_1A_VALIDATION.md](PHASE_1A_VALIDATION.md).

El resto de Fase 1 sigue pendiente: todavía no se registra dinero ni hay DB, deuda, interpretación IA o idempotencia persistente. Este corte no cumple aún el caso de aceptación financiero de abajo.

- Restricción de un propietario Telegram, entrada de texto y confirmación breve.
- PostgreSQL con migraciones e idempotencia.
- Crear deuda inicial de iPhone (datos ficticios en tests), registrar pago de cuota, asignación a deuda y reporte de caja mensual.
- Interpretación IA vía **adaptador intercambiable**; proveedor falso en pruebas. Una API real se integra solo cuando se verifican privacidad/costo.

**Caso de aceptación:** «pagué 250.000 de iPhone» crea un movimiento, actualiza obligación/deuda y figura una vez en la salida de caja mensual. Si se reenvía, no se duplica.

## Fase 2 — finanzas personales utilizables

- Categorías configurables y aprendizaje de preferencias; gastos e ingresos simples.
- Presupuestos mensuales, arrastre de último límite (no del saldo), revisión mensual, alertas limitadas 80/100.
- Gastos fijos, estimaciones por último pago y facturas separadas por período.
- Salario neto por mes, atrasos y abonos FIFO; préstamos entre personas y préstamos otorgados.
- Suscripciones propias/compartidas y reembolsos FIFO.

**Listo cuando:** pruebas de montos y reportes de caja vs consumo son consistentes.

## Fase 3 — multimodal y documentos

- Notas de voz: transcripción, interpretación y respuesta opcional por audio.
- Imágenes de recibos: confirmación de contexto; borradores ilegibles; Storage privado.
- Búsqueda de comprobantes, backup ZIP + CSV y revisión semestral sin borrado automático.
- Onboarding conversacional con imagen de deuda existente y resumen de pagos históricos.

**Listo cuando:** el usuario puede enviar comprobante, vincularlo y recuperarlo por monto/persona/fecha.

## Fase 4 — calidad y extensibilidad

- Múltiples proveedores con ranking por tarea, privacidad obligatoria, fallback y topes de gasto.
- Multidivisa con tasa histórica, fuente y conciliación con cargo real.
- Observabilidad no sensible, restauración, documentación de despliegue y contribución.
- Google Calendar bajo autorización y herramientas adicionales tras revisar permisos.

## Fase 5 — interfaz web y comunidad

- Next.js/PWA: chat, panel de gastos, voz interactiva y configuración.
- Demo con datos ficticios y tutorial BYOK/Supabase.
- Documentación y despliegue reproducible; licencia aprobada; publicación pública.

## Fuera de alcance del primer corte

App Store/Play Store, WhatsApp, agentes autónomos con acceso ilimitado, conectores bancarios, apuestas automáticas, modelos locales, pagos reales, multiusuario alojado centralmente, soporte total de calendarios y conversación de voz continua.
