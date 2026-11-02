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
