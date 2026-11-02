# Instrucciones para Codex — Jarvis

## Misión

Construir un asistente personal **open source, self-hosted y de bajo costo**. Primero Telegram + gestión financiera conversacional; después audio/imágenes, Calendar y web/PWA. Este repositorio parte de **documentación**, no de código funcional. No afirmes que una función existe hasta implementarla y probarla.

## Fuentes de verdad, por contexto

- **Reglas de negocio:** `docs/PRODUCT_RULES.md`. Leer antes de cambiar flujos financieros.
- **Límites entre módulos, seguridad e IA:** `docs/ARCHITECTURE.md`. Leer al diseñar contratos, DB e integraciones.
- **Entregas y criterios de aceptación:** `docs/ROADMAP.md`. Leer al iniciar una fase.
- **Cómo delegar:** sección «Paralelismo / subagentes Codex» de este archivo. `CODEX_WORKFLOW.md`, `.codex/config.toml` y `.codex/agents/*.toml` no están incluidos actualmente.
- No leas toda la documentación obligatoriamente por un cambio menor; consulta lo relevante.

## Restricciones de producto que NO puedes alterar silenciosamente

1. **Privacidad por defecto:** prohibido enviar comprobantes, nombres o datos financieros a un proveedor no aprobado bajo política de no entrenamiento y tratamiento/retención aceptables. Nada de cambiar a modelos inseguros para resolver un fallo. No afirmar que cualquier nivel gratuito garantiza privacidad.
2. **Costos:** proveedores de IA intercambiables por API, sin ejecución local de modelos en la primera versión; priorizar los elegibles gratuitos. Fallback por calidad y capacidad; **nunca activar cobros o sobrepasar presupuesto deliberadamente**. Los topes locales son estimados: usar límites de proveedor cuando estén disponibles y hacer *fail closed* ante incertidumbre.
3. **Datos:** no exponer API keys en frontend, respuestas de Telegram, logs ni commits. Una instancia independiente por usuario/operador en la fase inicial, con control de acceso de Telegram.
4. **Dinero:** usar decimal preciso y moneda ISO 4217; no `float` para cantidades. Registrar dinero recibido vs ingresos ganados, salidas de caja vs consumo, deuda de capital vs intereses, y pagos confirmados vs obligaciones pendientes. Evitar doble conteo.
5. **Confirmaciones:** una imagen suelta requiere identificación y confirmación; el material ilegible queda como borrador. Pagos/deudas solo se marcan pagados tras confirmación del usuario. Las preguntas de seguridad/costo se realizan en el canal originario.
6. **Notificaciones:** sin recordatorios automáticos de pagos vencidos. Solo revisión mensual de presupuestos, alertas de presupuesto limitadas, revisión semestral de comprobantes y otras que el usuario habilite expresamente.
7. **Aprendizaje:** persistir reglas y correcciones del usuario; no entrenar modelos con información privada. Ante baja confianza, preguntar.
8. **Historial:** las correcciones deben ser auditables. No reescribir periodos anteriores silenciosamente.
9. **Open source:** documentación que enseñe a usar credenciales propias, no las del mantenedor.

## Stack de inicio — propuesto

Node.js LTS + TypeScript, PostgreSQL/Supabase, Telegram Bot API, integraciones de IA vía adaptadores. Monolito modular, repositorio inicialmente único. No crear microservicios, colas, servicios de pago, web o MCP antes de que la fase lo exija. Valida versiones actuales antes de fijar dependencias.

## Estructura esperada cuando se implemente

```text
src/
  app/              # composición, configuración, bootstrap
  channels/telegram/ # adaptador Telegram; nunca reglas financieras aquí
  ai/               # contratos de proveedores, enrutamiento y evaluación
  modules/
    transactions/
    categories/
    budgets/
    debts/
    obligations/
    incomes/
    lending/
    subscriptions/
    receipts/
    fx/
  shared/           # tipos comunes, errores, seguridad y utilidades
migrations/         # SQL versionado
 tests/             # unit, integration, e2e, fixtures
```

Esta estructura es una guía; refinarla **antes de crear carpetas vacías en masa**.

## Trabajo paso a paso

- Entrega incrementos pequeños, verticales y verificables.
- Antes de un cambio no trivial: explicar el alcance, riesgos, dependencias y pruebas. No pedir confirmaciones triviales que bloqueen una tarea autorizada.
- Cada funcionalidad financiera: tipos + migración + servicio + tests + adaptación de canal cuando corresponda.
- Distingue siempre **implementado**, **simulado**, **pendiente** y **no verificado**.
- Agrega tests para abonos FIFO, pagos duplicados, redondeo, límites presupuestarios, conversión FX y permisos según el alcance.
- No hacer llamadas reales a APIs externas en tests unitarios; usar adaptadores falsos y fixtures.
- Registrar qué se ejecutó: typecheck, lint, tests, migraciones. No declarar éxito sin correr comandos.

## Paralelismo / subagentes Codex

Delegar solo tareas **independientes** que realmente ahorren trabajo; máximo 3 subagentes activos además del coordinador, según las capacidades de Codex instalado y `.codex/config.toml` cuando exista.

Roles disponibles: `finance_domain`, `security_reviewer` y `test_engineer`.

El coordinador:
- Decide particiones de trabajo con límites de archivos (propietario único por archivo).
- Delega **análisis, revisión o tests** en paralelo si no hay dependencias.
- Evita que dos agentes editen las mismas rutas y consolida los resultados.
- No autoriza a subagentes a modificar credenciales, ampliar permisos, desplegar o alterar reglas de producto.
- Si la función multiagente no está disponible, continúa secuencialmente sin fingir subagentes.

## Terminar cada tarea reportando

Qué cambió, archivos tocados, cómo verificar, pruebas ejecutadas y pendientes, advertencias de seguridad/privacidad/costo, y siguiente incremento sugerido. Citar explícitamente las decisiones funcionales de `docs/PRODUCT_RULES.md` que se aplicaron.
