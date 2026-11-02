# Fase 1A.5 — decisiones y verificación

Fecha de decisión: **2026-11-02**, America/Bogota. Rama:
`refactor/agent-orchestrator-architecture`. Esta entrega redefine fronteras y
contratos; no implementa Registry/Gateway funcionales ni agentes externos.

## Prerrequisitos y conservación

Se comprobó mediante GitHub que el [PR #2](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/2)
está MERGED en main, commit `1d9c1c503882699152818fa108bd8c2031fd5666`.
Se actualizó main por fast-forward y se creó la rama antes de editar documentos.
La aceptación real de Telegram fue reportada por el operador el 2026-11-02;
esta fase no volvió a contactar el bot ni leyó sus credenciales.

Antes de reorganizar PRODUCT_RULES se hizo el commit `25c53ba`, que contiene una
copia exacta en [PRODUCT_RULES_FINANCE_V0.1.md](history/PRODUCT_RULES_FINANCE_V0.1.md).
SHA-256: `5c033df0f76911740a1605fa8e468c81e90bb6a0cb8f3aa1110c4be59a27500c`.
El hash coincide tanto en el working tree como en el objeto de Git.

[Finance Agent](agents/FINANCE_AGENT_SPEC.md) incluye el snapshot completo,
literalmente: **14 secciones y 80 bullets**, incluidas condiciones y excepciones.
También preserva extractos financieros de arquitectura y las nueve restricciones
originales de implementación. La [matriz](agents/FINANCE_AGENT_TRACEABILITY.md)
identifica cada bloque/bullet y sus fuentes. No se resumió ninguna regla como
sustituto ni se implementó DB o lógica financiera.

## Decisiones y archivos

- `README.md`, `docs/README.md`, `AGENTS.md`, `docs/AGENTS.md`: identidad de
  orquestador, límites entre proyectos y distinción entre subagentes Codex y
  aplicaciones externas en ejecución.
- `docs/PRODUCT_RULES.md`: reglas generales ORC-01…ORC-12; las finanzas pasan a su
  especificación externa por decisión explícita del operador.
- `docs/ARCHITECTURE.md`: siete componentes y diagrama objetivo, con estado real
  separado del diseño; Jarvis sigue siendo un único servicio modular.
- `docs/AGENT_PROTOCOL.md` y `src/agents/protocol.ts`: borrador HTTPS/JSON 1.0,
  patrones solicitado/autónomo, identidad, permisos, correlación, pendientes,
  errores, idempotencia, autenticación/replay y puertos puros sin transporte.
- `docs/DEPLOYMENT_STRATEGY.md`: Ubuntu/Droplet/Compose propuestos, objetivo
  inicial USD 25, métricas, secretos, recuperación, red y opción Cloud Run bajo
  demanda. Estimaciones contrastadas con fuentes oficiales, sin contratar nada.
- `docs/ROADMAP.md`: fases de Jarvis separadas de
  `docs/agents/FINANCE_AGENT_ROADMAP.md`.
- `docs/agents/FINANCE_AGENT_SPEC.md`, `FINANCE_AGENT_TRACEABILITY.md` y
  `FINANCE_AGENT_ROADMAP.md`: requisitos externos preservados, no servicios nuevos.
- `docs/prompts/PHASE_1B_PROMPT.md`: siguiente incremento funcional, inicialmente
  con adaptador falso y sin conexiones HTTP reales.
- `docs/TELEGRAM.md`, `docs/GIT_WORKFLOW.md`, validaciones históricas y prompt
  inicial: referencias actualizadas sin reescribir resultados históricos.
- `tests/documentation.test.ts`: conservación literal, hash, separación de reglas
  y enlaces locales. `tests/agent-protocol.types.ts`: fixtures y rechazos estáticos.
- `.prettierignore`: excluir solo bloque normativo/snapshot de Prettier para
  mantener sus bytes; la documentación general nueva sí se formatea.

## Validación ejecutada

Se ejecutaron formato, lint, typecheck, tests y build con Node 24.22.1 y npm 11.17.0
locales, sin API keys. Los fixtures de contrato son ficticios y se comprueban
en typecheck; no son pruebas HTTP, criptográficas o de permisos en producción.
Se conservan todos los tests de Fase 1A sin cambiar el comportamiento del bot.

| Comando/control                   | Resultado local                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `npm ci`                          | Correcto; lockfile sin cambios, 0 vulnerabilidades en la auditoría de instalación |
| `npm run format` / `format:check` | Correctos; snapshot y normativa literal excluidos deliberadamente                 |
| `npm run lint`                    | Correcto; cero warnings                                                           |
| `npm run typecheck`               | Correcto; fixtures y seis rechazos estáticos del protocolo comprobados            |
| `npm test`                        | **110/110** pruebas de runtime: las 104 anteriores y 6 documentales               |
| `npm run build`                   | Correcto; tipos/puertos sin conexión al bot                                       |
| `npm run check`                   | Correcto; ejecutó la secuencia completa anterior                                  |
| Snapshot y reglas                 | Hash exacto, 14 bloques/80 bullets preservados literalmente                       |
| Enlaces                           | Destinos locales y fragments/IDs HTML verificados, incluida la matriz financiera  |
| Telegram real                     | Aceptación previa reportada por el operador; no repetida en esta entrega          |
| Migraciones/despliegue            | No aplican; no se crean recursos o DB                                             |

Los tests documentales iniciales comprobaron hash, inclusión y separación; el
check de enlaces señaló documentos todavía en preparación. Se completan antes
del check final, sin ignorar esos destinos. El resultado final fue correcto.
Los checks remotos Windows/Linux se consultan en el PR de entrega después de
publicarlo; no se declara CI remota aprobada solo por el resultado local.

## Seguridad, costos y pendientes

Rigen PRODUCT_RULES ORC-01/03/04/06/07/08/09/12. No se agrega DB, transporte a
agentes, MCP, cola, IA, nuevos repositorios ni recursos desplegados. Los IDs,
schemas, HMAC, permisos y deduplicación durable del protocolo están diseñados,
no implementados; compilar tipos no valida JSON ni aplica esas políticas.

La revisión de seguridad pidió acotar también `occurred_at` futuro: máximo reloj
del receptor +300 s y antigüedad de 24 h. Se incorporó para que una fecha futura
no extienda el horizonte más allá de la deduplicación. No cambia código de Telegram.
Se precisó la excepción de autenticación oficial de Telegram y el registro atómico
de evento/entrega antes de confirmar duplicados. Revisión final sin hallazgos pendientes.

Los subagentes de Codex trabajaron con propiedad única: `finance_domain` en tres
documentos financieros, `test_engineer` en dos archivos de pruebas y
`security_reviewer` en revisión de solo lectura. No son agentes de producto ni
recibieron datos privados del operador.

Pendiente implementar y probar controles de runtime en Fase 1B y transporte real
en Fase 1C. Eventos durables esperan Fase 3. El despliegue no está dimensionado
con carga real; USD 15–25 iniciales son una estimación, no un tope garantizado.
La licencia y publicación definitiva siguen pendientes. La rama se entrega por
PR hacia main con CI Windows/Linux y sin merge automático.
