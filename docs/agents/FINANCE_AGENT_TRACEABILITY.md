# Finance Agent — trazabilidad de requisitos

## Fuente preservada y criterio de equivalencia

Fuente: [PRODUCT_RULES_FINANCE_V0.1.md](../history/PRODUCT_RULES_FINANCE_V0.1.md),
copia exacta guardada antes de reorganizar las reglas generales, commit `25c53ba`.
SHA-256: `5c033df0f76911740a1605fa8e468c81e90bb6a0cb8f3aa1110c4be59a27500c`.

Destino: [FINANCE_AGENT_SPEC.md](FINANCE_AGENT_SPEC.md#finance-original).
El destino contiene el archivo original completo literalmente, incluidos sus
14 encabezados de sección, 80 bullets, condiciones y excepciones. La equivalencia
se comprueba por inclusión exacta del snapshot, no solo por el conteo o esta tabla.

`Fss.bb` identifica el bullet `bb`, contando desde 1 dentro de la sección `ss`
original. Un bullet puede contener varias condiciones: su identificador las cubre
todas y no las reemplaza por el título resumido de la tabla. Las líneas de ejemplo
y las prohibiciones forman parte del requisito que las contiene.

## Matriz de conservación de las reglas originales

| Origen y destino literal                                                                                   | Identificadores                | Bullets | Condiciones y excepciones conservadas                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [§1 Perfil e interacción](FINANCE_AGENT_SPEC.md#1-perfil-e-interacción)                                    | F01.01–F01.06                  | 6       | Interfaz, evolución multimodal, configuración conversacional, personalidad, mismo canal para confirmaciones y BYOK. La nueva frontera de proyectos está explicada antes del bloque literal.                                     |
| [§2 Categorías, gastos e ingresos](FINANCE_AGENT_SPEC.md#2-categorías-gastos-e-ingresos-ordinarios)        | F02.01–F02.06                  | 6       | Integridad histórica de categorías, aprendizaje, confianza/ambigüedad, ingresos ordinarios, caja frente a ingreso ganado y cuotas sin doble consumo.                                                                            |
| [§3 Presupuestos](FINANCE_AGENT_SPEC.md#3-presupuestos-por-categoría)                                      | F03.01–F03.06                  | 6       | Sin arrastre de saldo, revisión y copia del último importe, históricos, 80/100 una vez, salto directo al 100 y porcentajes futuros configurables.                                                                               |
| [§4 Deudas y cuotas](FINANCE_AGENT_SPEC.md#4-deudas-de-compras-financiadas-y-cuotas)                       | F04.01–F04.07                  | 7       | Tasa opcional, modos informado/simplificado, capital e intereses, estimación frente a extracto, resumen inicial sin gasto retroactivo, confirmación y pago parcial/total, movimiento único y ausencia de avisos de vencimiento. |
| [§5 Facturas y gastos fijos](FINANCE_AGENT_SPEC.md#5-facturas-y-gastos-fijos)                              | F05.01–F05.05                  | 5       | Obligación pendiente, último pago como estimado, periodos independientes, desambiguación, pago completo de servicios y ausencia de recordatorios.                                                                               |
| [§6 Salario y empleador](FINANCE_AGENT_SPEC.md#6-salario-neto-cuentas-por-cobrar-de-empleador)             | F06.01–F06.06                  | 6       | Neto versionado, pendientes por mes, cierre trabajado y días 5/6, parciales FIFO, excedentes por confirmar, devengado no disponible y respuesta breve sin saldo no solicitado.                                                  |
| [§7 Préstamos](FINANCE_AGENT_SPEC.md#7-préstamos-entre-personas)                                           | F07.01–F07.06                  | 6       | Ambas direcciones, contraparte configurable, saldo agregado con movimientos, parciales, capital sin ingreso/consumo y consulta ante ambigüedad.                                                                                 |
| [§8 Suscripciones](FINANCE_AGENT_SPEC.md#8-suscripciones-personales-y-compartidas)                         | F08.01–F08.08                  | 8       | Confirmación del pago, reparto igual, salida total frente a gasto propio, cuentas por cobrar, participantes futuros, FIFO, reembolso sin ingreso y sin mensajes de cobro a terceros.                                            |
| [§9 Comprobantes](FINANCE_AGENT_SPEC.md#9-comprobantes-e-imágenes)                                         | F09.01–F09.06                  | 6       | Solo archivos enviados, contexto/confirmación, borrador ilegible, búsqueda y original, privacidad, revisión semestral, backup y eliminación únicamente confirmada conservando el movimiento.                                    |
| [§10 Apuestas](FINANCE_AGENT_SPEC.md#10-ingresos-extraordinarios-de-apuestas)                              | F10.01–F10.04                  | 4       | Registro agregado, neto estimado con omisiones explícitas, recarga vinculada sin duplicación y ninguna estrategia ni estímulo.                                                                                                  |
| [§11 Divisas](FINANCE_AGENT_SPEC.md#11-divisas-y-tasas-de-cambio)                                          | F11.01–F11.05                  | 5       | COP por defecto, moneda original, tasa histórica/fuente/fecha, cargo real prevalente, sin recálculo retroactivo, tasa faltante explícita y precisión/redondeo.                                                                  |
| [§12 IA, privacidad y presupuesto](FINANCE_AGENT_SPEC.md#12-proveedores-de-ia-privacidad-y-presupuesto)    | F12.01–F12.06                  | 6       | Sin modelos locales, APIs sujetas a términos actuales, gratuitas solo elegibles, filtro de privacidad, pago autorizado y presupuestado, límites estimados, cierre seguro y backend determinista.                                |
| [§13 Notificaciones](FINANCE_AGENT_SPEC.md#13-reglas-de-notificación-y-preferencias)                       | F13.01–F13.03                  | 3       | Defaults mensuales/80–100/semestrales, sin avisos de deudas/facturas/salarios vencidos y tono breve configurable.                                                                                                               |
| [§14 Exclusiones y pendientes](FINANCE_AGENT_SPEC.md#14-fuera-de-alcance-inicial-y-pendientes-de-decisión) | F14.01–F14.06                  | 6       | Sin importación histórica, banca, pagos reales, apuestas automáticas ni entrenamiento privado; sin promesas de exactitud/OCR; decisiones pendientes preservadas.                                                                |
| **Total**                                                                                                  | **F01.01–F14.06, por sección** | **80**  | **14 bloques trasladados íntegros, ninguna condición eliminada.**                                                                                                                                                               |

## Requisitos técnicos complementarios preservados

Estos requisitos estaban fuera de `PRODUCT_RULES.md`; se trasladan para conservar
la precisión y los límites que ya acompañaban al diseño financiero. Las fuentes
son los archivos del commit inmutable
[`1d9c1c503882699152818fa108bd8c2031fd5666`](https://github.com/ingmiguelangelgosan/sir-jarvis/tree/1d9c1c503882699152818fa108bd8c2031fd5666).

| Fuente histórica                    | Destino literal                                     | Conservación y frontera                                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` §4           | [S-A4](FINANCE_AGENT_SPEC.md#supplement-a4)         | Modelo financiero recomendado, aislamiento, trazabilidad, decimal/unidades menores, UTC, migraciones y constraints. Propuesta para el futuro agente, no tablas nuevas de Jarvis.                                           |
| `docs/ARCHITECTURE.md` §5           | [S-A5](FINANCE_AGENT_SPEC.md#supplement-a5)         | Caja, obligación, aplicación FIFO, consumo, conciliación sin borrar historia y un movimiento por cuota.                                                                                                                    |
| `docs/ARCHITECTURE.md` §7           | [S-A7](FINANCE_AGENT_SPEC.md#supplement-a7)         | Clave `channel + externalMessageId + actionKey`, índices únicos/transacciones, almacenamiento privado, secretos, confirmaciones, prohibición de SQL arbitrario, auditoría y revisión de aislamiento antes de multiusuario. |
| `docs/ARCHITECTURE.md` §9           | [S-A9](FINANCE_AGENT_SPEC.md#supplement-a9)         | Diez casos prioritarios: duplicados, FIFO, periodos, préstamos, suscripción compartida, umbrales, imágenes, elegibilidad, presupuesto y FX histórico.                                                                      |
| `docs/AGENTS.md`, restricciones 1–9 | [S-C1–S-C9](FINANCE_AGENT_SPEC.md#supplement-codex) | Privacidad, costo, credenciales, ISO 4217 y no float, confirmaciones, notificaciones, aprendizaje, auditoría y recursos propios.                                                                                           |

## Qué cambia y qué sigue pendiente

La única decisión funcional de esta separación es la nueva frontera solicitada:
Finance Agent será independiente y Jarvis coordinará su integración. El texto
histórico se conserva para evitar que ese cambio de arquitectura reinterprete las
reglas financieras. No se implementó ninguna de ellas en esta fase.

El [roadmap financiero](FINANCE_AGENT_ROADMAP.md) corresponde al agente futuro.
El [roadmap de Jarvis](../ROADMAP.md) se limita a la orquestación. Una prueba del
contrato entre aplicaciones no certificará por sí sola saldos, cálculos, FIFO o
idempotencia del dominio; esas pruebas deberán existir dentro de Finance Agent.
