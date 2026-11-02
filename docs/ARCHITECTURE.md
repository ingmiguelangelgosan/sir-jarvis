# Jarvis — arquitectura propuesta del MVP

**Estado:** diseño objetivo del MVP. Fase 0 y transporte Telegram de Fase 1A implementados; dominio financiero, DB e IA pendientes. La verificación con Telegram real sigue pendiente de credenciales propias. Evolucionar mediante ADRs cuando se prueben alternativas. No comenzar con microservicios.

## 1. Objetivos de arquitectura

1. Usar Telegram inmediatamente y poder sumar web/PWA sin reescribir lógica.
2. Reglas financieras deterministas y auditables; la IA interpreta mensajes y solicita herramientas, **no es la fuente de verdad contable**.
3. Proveedores de IA intercambiables; privacidad antes que costo y costo antes que rendimiento cuando ambos cumplen el nivel funcional mínimo.
4. Despliegue autogestionado con recursos/keys por instalación, sin depender del presupuesto del mantenedor.
5. Hacer posible prototipar en localhost con adaptadores falsos (sin consumir IA real).

## 2. Capas y responsabilidades

```text
                  Telegram ──► Adapter ──┐
                                          │
           Futuro: Web/PWA ──► Adapter ────┤
                                          ▼
                                  Application Layer
                           Parse intent / authorize / use-case
                                /                     \
                               ▼                       ▼
                      AI Gateway               Domain Finance
                 policy -> router          rules + ledger + reports
                 -> API providers                 │
                               \                    /
                                ▼                  ▼
                             Persistence / Postgres
                                + receipt storage
```

- **Channels**: recibir actualizaciones, validar origen, traducir a objetos de dominio, responder; sin SQL ni reglas financieras de negocio.
- **Application**: orquestar conversación; resolver intención; pedir confirmación cuando falten datos; permisos; idempotencia.
- **AI**: proveedor, modelos, capacidad, privacidad, política de fallback, medición de tokens/costo; transcripción/visión posteriormente.
- **Finance domain**: movimientos (ledger), deudas, cuentas por cobrar, presupuestos, salarios, facturas, suscripciones, divisas y consultas.
- **Infrastructure**: PostgreSQL, migrations, Telegram client, storage privado, scheduler para presupuestos/revisión semestral.

## 3. Contratos principales (conceptuales)

El corte 1A concreta un núcleo determinista (`src/app/assistant.ts`), composición explícita (`src/app/telegram-main.ts`), contrato `TelegramApi` y handler independiente del polling en `src/channels/telegram/`. El cliente HTTP usa `fetch` nativo con errores sanitizados y el handler autoriza antes de invocar el núcleo. Las credenciales Telegram se validan por separado y no entran al diagnóstico local. No hay nuevos SDKs, DB ni reglas financieras. El polling es secuencial; la deduplicación es temporal y no sirve como idempotencia financiera. Detalles y límites en [TELEGRAM.md](TELEGRAM.md).

- `ChannelAdapter.receive(message) -> InboundMessage` (`channel`, `externalMessageId`, `senderId`, `timestamp`, `text`, `attachments`).
- `IntentInterpreter.interpret(context) -> ProposedAction` (acción + datos + `confidence`, sin efectos persistentes).
- `FinancialCommandHandler.execute(command, idempotencyKey) -> Result` (validación dominio + transacción DB).
- `AIProvider.generate(request, privacyRequirements, taskCapabilities) -> AIResult`.
- `ModelRouter.choose(task, policy, budgetState) -> EligibleProviderRoute`.
- `ReceiptStore.put/get/delete(userScope, key)` con URLs temporales y permisos.
- `FxRateProvider.getHistoricalRate(from, to, date) -> RateResult`.

No hacer depender el dominio de una API SDK específica. Los contratos se concretan cuando Codex implemente el primer flujo.

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

## 5. Modelo semántico financiero

- **Movimiento de caja:** cuánto entró/salió de verdad en cierta fecha.
- **Obligación/cuenta por cobrar:** monto esperado, no es movimiento de caja realizado.
- **Aplicación de pago:** vínculo de movimiento contra obligación; una sola transferencia puede pagar varios meses (FIFO).
- **Gasto de consumo vs salida de caja:** los préstamos y reembolsos modifican caja pero no necesariamente ingresos/gastos económicos. Reportes explican cuál métrica presentan.
- **Ajuste/conciliación:** si llega extracto con saldo real, actualizar referencia sin borrar el historial previo.

En la primera prueba «pagué cuota iPhone», se crea **un** movimiento y se aplica a una obligación/cuota, actualizando deuda y reportes de caja.

## 6. IA: elegibilidad, enrutamiento y gastos

Flujo:

1. Determinar tarea: texto/tool-calling, imagen, voz transcrita.
2. Filtrar **primero** por políticas aceptadas, privacidad contractual real, permisos, capacidad multimodal y estado de presupuesto.
3. Ordenar modelos elegibles por calidad comprobada en pruebas del proyecto; preferir gratuitos cuando la calidad es suficiente.
4. Al límite/error transitorio, fallback solo a otro modelo elegible. No romper políticas por disponibilidad.
5. Antes de modelos de pago: exigir activación expresa + saldo presupuestario estimado; registrar uso y, si se puede, usar topes del proveedor.
6. Si no hay ruta elegible, responder con error claro, conservando como borrador la operación pendiente cuando sea seguro hacerlo.

**Importante:** una barrera local de presupuesto no garantiza un tope de facturación estricto si existen solicitudes concurrentes, precios variables, registros atrasados o cargos externos. Controles de presupuesto por proveedor son deseables. No aceptar términos de «no entrenamiento» sin verificar políticas específicas, plan y ruta.

Utilizar SQL para sumas y operaciones exactas; enviar a LLM solo datos agregados/reducidos necesarios. No mandar imágenes completas al LLM si el caso puede resolverse localmente con campos que el usuario entregó.

## 7. Seguridad, privacidad y auditoría

- Telegram: verificar ID de usuario/chat permitido y autenticidad del webhook si se usa; no usar el nombre de usuario como identidad confiable.
- Idempotencia por `channel + externalMessageId + actionKey`; índices únicos y transacciones DB para que un retry no duplique gasto.
- Archivos: almacenamiento privado, cifrado en tránsito y en reposo según servicio, URLs temporales, políticas de acceso, back-ups explícitos y borrado confirmado.
- Secretos server-only, nunca log de tokens o payloads financieros completos. `.env` excluido del repositorio.
- Confirmar fechas/montos ambiguos; control de acceso por herramienta. No permitir que IA ejecute SQL arbitrario.
- Pago real y acciones externas (transferencias, e-mails) **no** son función del MVP.
- Seguimiento de cambios relevante: ID de evento, actor, origen, timestamp, anterior/nuevo cuando aplique, sin exponer contenido sensible.
- Si se habilita uso por múltiples personas en una sola instancia, diseñar RLS, segmentación y amenazas **antes** de abrir ese acceso.

## 8. Despliegue progresivo

- **Local:** bot Telegram por long polling + Postgres local o Supabase remoto; un solo operador permitido.
- **Producción personal:** backend de proceso persistente o servicio compatible, HTTPS/webhook Telegram opcional, scheduler fiable para acciones mensuales, base de datos protegida.
- **Distribución:** documentar proyecto Supabase por usuario, migration scripts, variables server-only y procedimiento de backup/restauración.
- **Futuro:** web/PWA Next.js, OAuth para Calendar, MCP detrás de permisos y allowlists. No abrir puertos MCP ni conectar Gmail de manera implícita.

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
