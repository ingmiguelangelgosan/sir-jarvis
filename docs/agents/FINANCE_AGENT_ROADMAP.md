# Finance Agent — roadmap independiente propuesto

**Estado:** planificación preservada; ningún hito financiero está implementado
en Jarvis ni se crea un repositorio externo en esta fase. El agente futuro debe
poder funcionar, probarse y publicarse sin Jarvis. Su integración con el orquestador
es una superficie adicional, no el lugar donde residirá su negocio.

Fuente funcional: [FINANCE_AGENT_SPEC.md](FINANCE_AGENT_SPEC.md), que conserva las
14 secciones y 80 bullets originales. Procedencia y equivalencia:
[FINANCE_AGENT_TRACEABILITY.md](FINANCE_AGENT_TRACEABILITY.md). Este orden recupera
los cortes financieros del
[roadmap anterior a la separación](https://github.com/ingmiguelangelgosan/sir-jarvis/blob/1d9c1c503882699152818fa108bd8c2031fd5666/docs/ROADMAP.md),
sin cambiar condiciones ni convertir los cortes en funciones existentes.

## FA-0 — proyecto y controles propios

Preparar, cuando se autorice crear el proyecto independiente, su configuración,
pruebas locales con datos ficticios, contrato versionado y controles de privacidad.
Resolver su licencia, lenguaje, almacenamiento y alojamiento por separado; los
servicios comerciales requieren autorización y presupuesto propios.

Definir las fronteras entre autorización de la integración y autorización del
comando financiero. La identidad recibida del canal no reemplaza la validación
del agente. Sin credenciales, permisos o privacidad admisibles, fallar cerrado.

## FA-1 — primer pago confirmado e idempotente

Crear deuda inicial ficticia y registrar un pago parcial o completo de cuota,
confirmado por el usuario. Aplicar dinero decimal exacto y moneda ISO 4217,
transacción, constraints y clave de idempotencia. Mantener un movimiento de caja
vinculado a la obligación/cuota y al cambio de saldo de referencia.

Caso de aceptación: «pagué 250.000 de iPhone» genera una única salida de caja y
actualiza deuda y obligación sin duplicar consumo. Repetir el evento no registra
otro pago. El modo simplificado sigue siendo estimado; el modo informado separa
capital e intereses solo con datos suficientes y se concilia con extracto real.
El resumen inicial no carga cuotas históricas al mes del alta.

Pruebas: confirmación, permisos, pagos duplicados, redondeo, deuda parcial/total,
capital/intereses o estimación explícita y auditoría. La interfaz inicial de este
proyecto debe permitir probar el caso sin depender de Telegram o Jarvis.

## FA-2 — finanzas personales utilizables

- Categorías configurables y preferencias aprendidas conservando históricos;
  gastos e ingresos ordinarios, con caja separada de ingreso ganado y consumo.
- Presupuestos mensuales sin arrastre de saldo, revisión y copia del último límite,
  avisos 80/100 una vez y excepción de salto directo al 100.
- Facturas pendientes independientes por periodo y estimación por último pago;
  pago completo de servicios y ausencia de recordatorios de pendientes.
- Salario neto versionado, devengado/recibido/pendiente/vencido, días 5/6, abonos
  FIFO, excedentes consultados y respuesta breve sin revelar saldo no solicitado.
- Préstamos en ambas direcciones con libro individual, saldo por contraparte,
  parciales y capital sin ingreso/consumo nuevo.
- Suscripciones propias/compartidas, reparto igual, participantes futuros,
  reembolsos FIFO y ningún doble conteo ni cobro automático a terceros.
- Ingresos extraordinarios de apuestas como registro agregado, neto estimado y
  recarga vinculada, sin estrategias ni estímulo.

Cada punto remite a las condiciones completas de la especificación; estos rótulos
organizan implementación y no las sustituyen. Verificar límites presupuestarios,
FIFO, movimientos duplicados y reportes de caja frente a consumo.

## FA-3 — documentos y experiencia multimodal

Comprobantes opcionales enviados por el usuario, contexto y confirmación para
imágenes, borradores privados ilegibles, búsqueda y devolución del original.
Almacenamiento privado, backup ZIP/CSV y revisión semestral con eliminación solo
confirmada sin borrar movimientos. Incorporar voz y onboarding con documentos
conforme a los permisos, capacidades y privacidad realmente verificados.

La recepción/presentación puede pasar por Jarvis. El agente conserva las reglas
de vinculación, el estado borrador/confirmado y la custodia financiera del archivo;
el orquestador no se convierte en su almacén financiero.

## FA-4 — divisas, conciliación y calidad

Conservar moneda original y tasa histórica con fuente/fecha; COP por defecto,
redondeo preciso y cargo real prevalente sin reescribir tipos históricos.
Verificar las alternativas de proveedores por capacidad, privacidad efectiva y
presupuesto antes de habilitar APIs reales. Sin modelos locales en el alcance
inicial ni fallback a rutas inseguras; los límites locales no garantizan un tope
de facturación duro. Añadir restauración, observabilidad sin datos privados y
procedimientos operativos propios.

## FA-5 — integración y distribución independientes

Conectar el agente mediante [AGENT_PROTOCOL.md](../AGENT_PROTOCOL.md) cuando su
implementación y las fases del orquestador lo permitan. Probar solicitudes,
resultados pendientes, errores, eventos autenticados y deduplicación a ambos
lados. La notificación a través de Jarvis debe respetar exactamente los defaults
y exclusiones financieros de §13; conectarlo no activa avisos de pagos vencidos.

Documentar ejecución y publicación por separado, uso con credenciales propias,
backup/restauración y límites de privacidad/costo. No comprometer saldos exactos,
OCR perfecto ni autenticación multiusuario antes de implementarlos y probarlos.

## Separación del calendario de Jarvis

Las fases 1B/1C de [Jarvis](../ROADMAP.md) preparan Registry/Gateway y la conexión
con un agente ficticio. No implementan FA-1 ni habilitan automáticamente Finance
Agent. Las funciones de Calendar, web/PWA y otros dominios del orquestador no se
convierten en tareas financieras. La planificación de este archivo no autoriza
crear recursos, APIs de pago ni un nuevo repositorio.
