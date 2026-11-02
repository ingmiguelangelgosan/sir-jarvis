# Finance Agent — especificación funcional preservada

**Estado:** especificación para una aplicación independiente futura. No existe un
Finance Agent implementado, conectado o desplegado por esta fase. Este documento
no crea su repositorio ni autoriza contratar servicios.

## Frontera del proyecto

Finance Agent será propietario del dominio financiero, sus reglas deterministas,
sus migraciones, su base de datos, comprobantes, cálculos, auditoría y pruebas.
Podrá ejecutarse y probarse sin Jarvis, con repositorio, lenguaje y alojamiento
propios. Jarvis será el canal y coordinador opcional: autentica al usuario,
aplica permisos y políticas, transmite solicitudes y presenta resultados.
Jarvis no calculará saldos ni conservará una copia del libro financiero del agente.
La integración futura usará [el protocolo de agentes](../AGENT_PROTOCOL.md).

La decisión de Fase 1A.5 cambia **la ubicación y responsabilidad del dominio**.
No cambia categorías, importes, FIFO, confirmaciones, excepciones, avisos,
retención ni el significado de las reglas originales. Dentro del bloque literal
conservado abajo, las referencias históricas a «Jarvis» describen la experiencia
financiera del usuario a través del agente y, cuando corresponda, de su canal.
La afirmación histórica de que finanzas era la primera habilidad no obliga al
orquestador a contener ese dominio; el usuario decidió expresamente separarlo.

Los requisitos de interfaz son requisitos de la experiencia integrada: las
preguntas de confirmación vuelven al canal originario mediante Jarvis. Esa frontera
no autoriza a Finance Agent a asumir que un reenvío, un modelo o un evento equivale
a confirmación del usuario. La operación financiera y su idempotencia siguen
validándose dentro del agente. Las políticas generales del orquestador están en
[PRODUCT_RULES.md](../PRODUCT_RULES.md); las reglas específicas de finanzas
permanecen en esta especificación.

## Integridad y procedencia

Antes de reorganizar el producto se guardó una copia versionada exacta en
[PRODUCT_RULES_FINANCE_V0.1.md](../history/PRODUCT_RULES_FINANCE_V0.1.md), commit
`25c53ba`. Su SHA-256 es
`5c033df0f76911740a1605fa8e468c81e90bb6a0cb8f3aa1110c4be59a27500c`.

El bloque siguiente contiene **el archivo original completo, literalmente**:
14 secciones y 80 bullets. Se mantienen el encabezado, la fecha de levantamiento,
las condiciones compuestas y todas las excepciones. No es un resumen sustituto.
La [tabla de trazabilidad](FINANCE_AGENT_TRACEABILITY.md) identifica cada bloque
y los suplementos técnicos históricos. El [roadmap independiente](FINANCE_AGENT_ROADMAP.md)
ordena el trabajo futuro sin modificar estas decisiones.

<a id="finance-original"></a>

# Jarvis — reglas funcionales consensuadas (v0.1)

**Estado:** decisiones de levantamiento de requisitos, 2026-11-01. Fuente de verdad del comportamiento esperado; **no equivalen a funcionalidades implementadas**. Cuando haya ambigüedad, preferir no duplicar ni inventar operaciones y pedir confirmación.

## 1. Perfil e interacción

- Jarvis es un asistente personal general, cuya **primera habilidad** es finanzas. Debe permitir agregar herramientas con el tiempo (Calendar, MCP, web/PWA).
- Interfaz inicial: Telegram. Recibe texto; posteriormente notas de voz, imágenes y responde audio generado. Conversación en voz en tiempo real queda para la web/PWA futura.
- Configuración por conversación, sin depender de formularios o Excel. Se puede enviar factura o imagen + una explicación hablada para crear deudas existentes.
- Personalidad: cercana, con humor opcional, consejos útiles y nunca humillación. Personalización por instalación.
- Confirmaciones de seguridad, presupuesto y operaciones ambiguas en el mismo chat de origen.
- Modelo de instalación: self-hosted / BYOK; cada persona instala recursos y claves propias.

## 2. Categorías, gastos e ingresos ordinarios

- Puede comenzar con categorías/subcategorías predeterminadas **o** crearlas desde cero durante el onboarding. Se pueden editar, ampliar o borrar posteriormente, preservando integridad histórica.
- Jarvis aprende clasificaciones por correcciones y preferencias persistidas. Los gastos expresados claramente por texto/audio se registran sin confirmación cuando haya suficiente confianza; ante ambigüedad pregunta.
- Ej.: «Gasté $3.200 en la buseta» → Transporte / transporte público, una vez aprendida la categoría.
- Ingresos variables (trabajo adicional, ganancias extraordinarias) y gastos cotidianos se registran individualmente.
- **No todo dinero entrante es ingreso ganado.** Préstamos recibidos y reembolsos no deben inflar ingresos.
- Pagos de deudas cuentan como **salidas mensuales de dinero**, pero NO deben duplicarse como compra original + todas las cuotas en un mismo indicador de consumo. Ofrecer vistas claras de flujo de caja y consumo.

## 3. Presupuestos por categoría

- Presupuestos **mensuales**, sin arrastre de saldo restante al mes siguiente.
- Al inicio de cada mes, un solo mensaje pregunta si se quieren ajustar categorías y montos. Si no hay respuesta, se copian los últimos importes confirmados, reiniciando gasto acumulado a cero.
- En el mismo chat se pueden reajustar presupuestos, sin reescribir meses históricos.
- Alerta al cruzar **80 %** y otra al alcanzar/superar **100 %**, máximo una de cada umbral por categoría y periodo. Si un gasto pasa de golpe al 100 %, emitir solo la del 100 % en ese evento. Se reinician avisos el siguiente mes.
- Avisos amistosos y breves, sin recordatorios diarios ni repeticiones.
- Los porcentajes deben poder configurarse en el futuro; 80 y 100 son defaults.

## 4. Deudas de compras financiadas y cuotas

- Onboarding de deuda: pedir valor financiado, número de cuotas, valor de cuota, tasa de interés E.A. cuando se conozca, fecha y saldo inicial conocido; la falta de tasa no bloquea el alta.
- **Modo informado:** si hay tasa, plazo y condiciones suficientes, calcular amortización estimada y separar capital/intereses; recalcular o conciliar con extracto real. No prometer exactitud si hay comisiones/seguros/cambios de tasa.
- **Modo simplificado:** descontar pagos registrados del saldo de referencia como **estimación**, indicando que parte del pago puede corresponder a intereses. No etiquetar el resultado como saldo bancario exacto.
- Si deuda precede a Jarvis, guardar **resumen inicial** de cantidad de cuotas históricas pagadas y dinero desembolsado, sin reconstruirlas una a una. No cargar esas cuotas como gasto del mes de alta.
- Solo los pagos efectivamente **confirmados** reducen deuda. Admitir pago parcial o total y conservar el movimiento con fecha.
- Cada cuota pagada es un movimiento de caja único; se refleja también en informes de pagos del mes sin duplicación.
- No emitir notificaciones proactivas de vencimientos de deuda.

## 5. Facturas y gastos fijos

- Generar automáticamente una obligación mensual **pendiente** por cada concepto recurrente (internet, energía, arriendo, etc.). No marcarla pagada en fecha presumida.
- Gastos variables recurrentes: estimación inicial = **último valor efectivamente pagado**. Mostrar claramente que es estimado y actualizar a importe real al confirmar.
- Cada periodo tiene su propia obligación: noviembre impago y diciembre pendiente coexisten; total pendiente suma ambas. Al pagar, asociar mes concreto, preguntando si es ambiguo.
- Para **facturas de servicios**, la primera versión soporta pago completo (no parcial). Los préstamos/deudas personales sí admiten abonos parciales.
- No generar recordatorios de facturas pendientes, por petición explícita; sí permitir consultas a demanda.

## 6. Salario neto, cuentas por cobrar de empleador

- Usar **salario neto**, configurable y versionado por vigencia para no modificar historiales.
- Cargar en onboarding solo periodos recientes impagos, **desglosados por mes**, no importar Excel ni reconstruir todo el pasado.
- Al **cierre del mes trabajado**, generar salario esperado pendiente por cobrar; fecha habitual límite de pago configurada, por defecto **día 5 del mes siguiente**; desde el día 6, saldo no recibido es vencido.
- Los pagos pueden ser parciales e irregulares en varios días. Cada abono es dinero realmente recibido y se imputa automáticamente **FIFO al periodo salarial más antiguo**, pudiendo cubrir más de un periodo. Si supera todo lo pendiente, preguntar cómo tratar el excedente.
- No añadir el salario devengado como dinero disponible; diferenciar devengado, recibido, pendiente y vencido.
- Al registrar abonos, contestar **solo confirmación breve**, no anunciar espontáneamente cuánto sigue debiendo el empleador. Saldo se revela a solicitud.

## 7. Préstamos entre personas

- Permitir **dinero que pido prestado** y **dinero que presto a otros** con cualquier persona, no codificar «hermano» o «mamá».
- Mantener **un saldo agregado por contraparte y dirección** (me debe / le debo), con libro de movimientos individuales y fechas. No perder trazabilidad al acumular.
- Admitir desembolsos múltiples, abonos parciales y liquidación total.
- Dinero tomado prestado es entrada de caja + pasivo, **no ingreso ganado**. Devolver capital es salida de caja + reducción de pasivo, **no consumo nuevo**.
- Dinero prestado a terceros es salida de caja + cuenta por cobrar, **no gasto de consumo**. Devolución es entrada de caja + reducción de cuenta por cobrar, **no ingreso ganado**.
- Ante ambigüedad de persona/dirección, preguntar.

## 8. Suscripciones personales y compartidas

- Todas las suscripciones mensuales generan obligación **pendiente** y solo se marcan pagadas por confirmación (no asumir cobro por tarjeta).
- Suscripción personal: el importe confirmado es gasto personal.
- Suscripción compartida: cuando se **confirma que el usuario pagó** el total, dividir en partes iguales entre participantes incluyendo al titular cuando corresponda. Registrar la salida de caja total, su participación como gasto personal y cuentas por cobrar de los demás, **sin doble conteo**.
- El reparto equitativo es la regla definida; no implementar montos personalizados salvo nueva decisión.
- Agregar o retirar participantes con efecto hacia **futuros periodos**, sin alterar deudas de periodos pasados.
- Si alguien debe varias mensualidades y envía abono, aplicar FIFO a la más antigua; conservar saldo por periodo y consolidado por persona.
- Reembolso recibido reduce cuenta por cobrar; no es nuevo ingreso ganado.
- No enviar recordatorios automáticos de cobro a otras personas; no se ha solicitado mensajería hacia terceros.

## 9. Comprobantes e imágenes

- Comprobantes opcionales para cualquier movimiento. **Almacenar solo archivos enviados por el usuario**, no generar ni exigir recibos para todo gasto.
- Si llega imagen **sin contexto**, analizar y preguntar qué significa antes de crear/relacionar movimiento. Si llega con explicación, usarla, pero confirmar identificación y vinculación antes de operaciones delicadas.
- Si la imagen es borrosa/incompleta, guardarla como **borrador privado pendiente de confirmación** y solicitar los datos faltantes; no registrar movimiento definitivo a partir de datos inventados.
- Buscar archivos por fecha, monto, persona, deuda, categoría o descripción. Si hay varios coincidentes, pedir desambiguación. Entregar el **archivo original** cuando el usuario lo solicite.
- Guardar de forma privada (bucket privado, control de acceso, URLs firmadas temporales) y vínculo a movimiento. Evitar volcar datos en logs o IA cuando no hagan falta.
- **Cada seis meses**, emitir una revisión de almacenamiento: ofrecer backup ZIP + índice CSV y opciones conservar/eliminar algunos/todos. **Nunca eliminar automáticamente** sin confirmación expresa; preservar registro del movimiento aunque se borre archivo.

## 10. Ingresos extraordinarios de apuestas

- Registro simple, **sin registrar cada apuesta**: usuario comunica cuánto retiró y cuánto recargó asociado.
- Registrar retiro como entrada de dinero y, cuando se conozca la recarga, calcular **ganancia neta estimada** = retiro − recarga vinculada, sujeto a que no existan recargas/retiros omitidos.
- Si la recarga ya estaba registrada, vincularla en vez de repetir gasto. Evitar que mover fondos de una plataforma a cuenta propia se cuente dos veces como ingreso.
- No proponer estrategias de apuesta ni estimular más apuestas.

## 11. Divisas y tasas de cambio

- Moneda principal por instancia elegible durante onboarding; **COP por defecto**. Otras divisas ISO 4217 según soporte del proveedor de tasas.
- Para movimiento en moneda extranjera: conservar monto y moneda original, fecha, tasa histórica consultada para ese día, fuente, fecha efectiva de la tasa y valor estimado convertido a moneda base.
- Tasas pueden ser históricas/oficiales de referencia y **no necesariamente coinciden con cargo bancario**. Si el usuario comunica el valor real cobrado, este prevalece en estadísticas y se guarda referencia al estimado original.
- No recalcular historiales por cambios diarios de tasa; distinguir cotización histórica no disponible y preguntar/usar tasa conocida explicitando su naturaleza.
- Elegir reglas de redondeo por moneda y fuente; usar precisión decimal exacta.

## 12. Proveedores de IA, privacidad y presupuesto

- **No Ollama/modelos locales** en alcance inicial. Varias APIs configurables (ej.: OpenRouter, Gemini, Groq y OpenAI), sujetas a verificación actual de compatibilidad y términos.
- Ordenar modelos permitidos por calidad/capacidad por tipo de tarea (texto, imagen, herramientas); usar primero opciones gratuitas **elegibles por privacidad**. Al alcanzar cupos/fallar, fallback al siguiente elegible.
- La privacidad es criterio eliminatorio: sin entrenamiento con datos financieros ni retención incompatible según **contratos efectivos del proveedor y del modelo/ruta**, no asumir que el agregador lo garantiza para todos. Limitar payload y enmascarar identificadores cuando sea posible.
- Si las opciones gratuitas seguras se agotan, pasar a pago **solo si el usuario lo habilitó** y hay presupuesto mensual restante. Implementar límite local y preferir también topes duros ofrecidos por proveedor; no garantizar que estimación local evita todo cargo por carreras/latencia.
- Si no existe proveedor apto o presupuesto, fallar con mensaje claro, sin recurrir a proveedor inseguro ni hacer compras automáticas.
- Operaciones financieras deterministas en backend; el LLM interpreta intención pero no modifica SQL directamente. Persistir auditoría sin datos sensibles innecesarios.

## 13. Reglas de notificación y preferencias

- Permitidos por defecto: un mensaje al inicio de mes para revisar presupuestos; alertas presupuesto al 80 % y 100 % una vez por periodo/categoría; revisión de comprobantes semestral.
- **No** recordatorios automáticos de deudas, facturas o salarios atrasados.
- Respuestas de registros breves. Humor ligero configurable; sin moralizar, alarmismo ni presión.

## 14. Fuera de alcance inicial y pendientes de decisión

- No importación de gastos históricos desde Excel en MVP; solo saldo inicial y detalles relevantes.
- No sincronización bancaria, transferencias reales, pagos, apuestas automáticas ni acceso a cuentas de terceros.
- No aplicación nativa inmediata; no WhatsApp como interfaz inicial.
- No autoentrenamiento ni fine-tuning con datos privados.
- No prometer OCR perfecto, saldos bancarios exactos o actualización automática de estados sin confirmación.
- PENDIENTE: licencia definitiva, alojamiento elegido, modelos y proveedores concretos, coste real por función, retención de datos en proveedor, implementación de voz, arquitectura de autenticación cuando haya varios usuarios por instancia.


## Suplementos técnicos preservados

Estos extractos proceden de las fuentes inmutables anteriores a la separación:
[ARCHITECTURE.md en el commit 1d9c1c5](https://github.com/ingmiguelangelgosan/sir-jarvis/blob/1d9c1c503882699152818fa108bd8c2031fd5666/docs/ARCHITECTURE.md)
y [AGENTS.md en ese mismo commit](https://github.com/ingmiguelangelgosan/sir-jarvis/blob/1d9c1c503882699152818fa108bd8c2031fd5666/docs/AGENTS.md).
Conservan precisión, idempotencia, aislamiento, auditoría y criterios de prueba
que complementaban las reglas de producto.

El modelo de datos citado era una recomendación, no una migración existente ni
una obligación de introducir esas tablas en Jarvis. En el nuevo límite, las tablas
y datos financieros corresponden a Finance Agent. Jarvis guarda solo su propia
configuración, permisos y metadatos de coordinación según su arquitectura.
Las preferencias financieras del agente y las preferencias del canal son distintas.
El acceso Telegram corresponde al adaptador de Jarvis y la autorización financiera
también debe verificarse en Finance Agent; no se elimina ninguna de las dos barreras.

<a id="supplement-a4"></a>

### S-A4 — Modelo de datos histórico recomendado

## 4. Modelo de datos mínimo recomendado

**Todas** las tablas con aislamiento por instancia/usuario cuando corresponda y `created_at`, `updated_at`. Para una instancia única, al principio se puede usar `owner_id`/Telegram allowlist; preparar claves foráneas para extensión futura. No habilitar acceso anónimo a Storage.

- `users` / `settings`: moneda base, timezone, personalidad, preferencias de aviso, privacy policy, presupuesto de IA.
- `counterparties`: personas y entidades (empleador, amigo, familiar). Nunca codificar nombres particulares.
- `categories`: padres/hijos y preferencias de clasificación.
- `movements`: entradas y salidas de caja realmente realizadas, moneda/cantidad original, fecha, estado y origen; `idempotency_key` único.
- `movement_allocations`: distribución de un movimiento entre obligaciones, deudas, reembolsos, salario y costos/intereses, para evitar duplicación.
- `obligations`: facturas, compromisos recurrentes, sueldo por cobrar, cuotas; periodo, vencimiento, estimado/real, estado, saldo.
- `debts` + `debt_events`: deuda financiada (valor, tasa, cuotas, saldo estimado/real) y cambios auditablemente registrados.
- `loan_accounts` + `loan_events`: saldo agregado por contraparte y dirección, movimientos individuales.
- `subscriptions`, `subscription_members`, `subscription_periods`: participantes vigentes por periodo; obligaciones y cuentas por cobrar.
- `budgets`, `budget_alert_events`: montos por categoría y mes, umbrales ya notificados.
- `receipts`: referencias a bucket privado, metadatos, estado borrador/confirmado, vínculo opcional al movimiento y política de revisión.
- `exchange_rates`: tasa histórica, fuente, fecha efectiva y trazabilidad; los movimientos también guardan el importe convertido y cualquier cargo real confirmado.
- `conversation_sessions`, `user_preferences`: contexto de corto plazo y reglas explícitas aprendidas; evitar conservar transcripciones sin necesidad.
- `ai_usage_events`: proveedor, modelo, capacidad, tokens aproximados/reales, estimación de costo, sin contenido sensible.

Usar `numeric`/`decimal` o enteros en unidad menor (con escala por moneda) para dinero; evitar `float`. Manejar timestamps en UTC y presentar fechas en zona horaria configurada. Versionar migraciones SQL y constraints de idempotencia.



<a id="supplement-a5"></a>

### S-A5 — Semántica financiera histórica

## 5. Modelo semántico financiero

- **Movimiento de caja:** cuánto entró/salió de verdad en cierta fecha.
- **Obligación/cuenta por cobrar:** monto esperado, no es movimiento de caja realizado.
- **Aplicación de pago:** vínculo de movimiento contra obligación; una sola transferencia puede pagar varios meses (FIFO).
- **Gasto de consumo vs salida de caja:** los préstamos y reembolsos modifican caja pero no necesariamente ingresos/gastos económicos. Reportes explican cuál métrica presentan.
- **Ajuste/conciliación:** si llega extracto con saldo real, actualizar referencia sin borrar el historial previo.

En la primera prueba «pagué cuota iPhone», se crea **un** movimiento y se aplica a una obligación/cuota, actualizando deuda y reportes de caja.



<a id="supplement-a7"></a>

### S-A7 — Seguridad, privacidad, idempotencia y auditoría históricas

## 7. Seguridad, privacidad y auditoría

- Telegram: verificar ID de usuario/chat permitido y autenticidad del webhook si se usa; no usar el nombre de usuario como identidad confiable.
- Idempotencia por `channel + externalMessageId + actionKey`; índices únicos y transacciones DB para que un retry no duplique gasto.
- Archivos: almacenamiento privado, cifrado en tránsito y en reposo según servicio, URLs temporales, políticas de acceso, back-ups explícitos y borrado confirmado.
- Secretos server-only, nunca log de tokens o payloads financieros completos. `.env` excluido del repositorio.
- Confirmar fechas/montos ambiguos; control de acceso por herramienta. No permitir que IA ejecute SQL arbitrario.
- Pago real y acciones externas (transferencias, e-mails) **no** son función del MVP.
- Seguimiento de cambios relevante: ID de evento, actor, origen, timestamp, anterior/nuevo cuando aplique, sin exponer contenido sensible.
- Si se habilita uso por múltiples personas en una sola instancia, diseñar RLS, segmentación y amenazas **antes** de abrir ese acceso.



<a id="supplement-a9"></a>

### S-A9 — Criterios históricos de aceptación financiera

## 9. Pruebas prioritarias

- Al recibir el mismo mensaje 2 veces, se registra 1 solo pago.
- Pagos FIFO de salarios y reembolsos entre períodos.
- Obligaciones estimadas/real y facturas de dos meses independientes.
- Préstamo recibido NO suma al ingreso ganado; devolución NO suma al gasto de consumo.
- Suscripción compartida: salida total 120.000, gasto propio 40.000, cuentas por cobrar 80.000; sin doble conteo.
- Presupuesto cruza 80 % y 100 % con alertas no duplicadas; se reinicia el próximo mes.
- Imagen sin contexto no crea gasto final; recibo borroso sigue en borrador.
- Modelo sin privacidad admisible no recibe datos, aunque todos los modelos aptos estén agotados.
- Sin presupuesto no se solicita modelo pago; suspensión por excedente de estimación.
- FX histórico no cambia retroactivamente; cargo real anula el convertido para caja.


<a id="supplement-codex"></a>

### S-C1 a S-C9 — Restricciones originales de implementación

Las nueve restricciones se preservan como fuente de los requisitos aplicables al
agente. La nueva frontera cambia quién implementa cada control, no permite
relajarlo. La condición histórica de alojar una instancia por usuario/operador
sigue siendo el punto de partida; una allowlist plural de Telegram no implementa
aislamiento financiero multiusuario.

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



## Estado y siguientes decisiones

Todo el dominio descrito está pendiente de implementación en el proyecto
independiente. No hay migraciones, almacenamiento de recibos, modelos locales,
proveedores de IA habilitados ni recursos financieros ejecutables en Jarvis.
Las decisiones pendientes originales de §14 siguen pendientes, con dos precisiones
de alcance: la estrategia propuesta para hospedar Jarvis no contrata ni impone el
alojamiento de Finance Agent, y las licencias/publicaciones de ambos proyectos
deben resolverse por separado antes de distribuirlos.

Cualquier modificación futura de una condición financiera requiere decisión
explícita, actualización de esta especificación y de su trazabilidad y pruebas en
el repositorio del agente. La separación actual no constituye tal modificación.
