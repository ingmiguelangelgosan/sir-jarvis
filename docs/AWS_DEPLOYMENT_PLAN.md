# Plan de despliegue AWS — preparación documental

**Estado, Fase 1F (2026-11-03): preparación del piloto, sin despliegue,
contratación, acceso a la cuenta ni creación de presupuestos.** Fase 1E.2 ya
verificó Compose, SQLite WAL, backups cifrados y recuperación locales. La VPS AWS,
sus controles y los backups remotos siguen pendientes. El [runbook](AWS_PILOT_RUNBOOK.md)
y el [checklist privado](AWS_PILOT_CHECKLIST.md) concretan el trabajo posterior a
una autorización expresa; este documento no concede esa autorización.
Ver [estrategia y proyección](DEPLOYMENT_STRATEGY.md).

## Cuenta, créditos y autorización

El operador reporta AWS Paid Plan y hasta USD 200 nominales en créditos. No se
verificó la cuenta. Los seis meses son horizonte de planificación, no una promesa
de vigencia de créditos ni de ausencia de cargos.

Antes de contratar, el operador debe revisar **Billing and Cost Management →
Credits**, abrir cada crédito y comprobar estado activo, importe restante/estimado,
fecha inicial, vencimiento y productos aplicables. Contrastar con **Bills** el
consumo del ciclo actual y los créditos realmente aplicados; un saldo mostrado
para un ciclo anterior no basta. Guardar evidencia privada fechada, sin copiar
identificadores de cuenta o facturas al repositorio público. [Gestión oficial de créditos](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/useconsolidatedbilling-credits.html).

Confirmar específicamente cobertura de Lightsail y extras. Las condiciones
promocionales contienen exclusiones; no inferir que un dominio, Marketplace,
soporte o impuestos quedan cubiertos. Revalidar el programa aplicable a la cuenta,
sin realizar actividades pagas para ganar crédito. [Condiciones de créditos](https://aws.amazon.com/awscredits/).

La autorización futura debe indicar región, bundle, recursos accesorios,
presupuesto bruto, máximo neto de bolsillo aceptado, retención y responsable de
apagado/migración. Si cobertura, privacidad o costo son inciertos, detener la
contratación. No reutilizar este documento como autorización implícita.

## Región y cotización previa

Evaluar primero `us-east-1` como **candidata**, comparando latencia desde el operador
y agentes, disponibilidad del bundle/Ubuntu, normativa, ubicación de datos y
transferencia. No se ha medido latencia ni seleccionado región definitiva.
No elegir una región solo por una suposición de cercanía o crédito.

La referencia pública consultada el **2026-11-03** es Lightsail Linux/Unix con IPv4
pública: 2 GB RAM, 2 vCPU, 60 GB SSD y 3 TB de transferencia publicados por
**USD 12/mes**. Las condiciones y la transferencia dependen de la región. La
tarifa de snapshots de instancia/disco es **USD 0,05 por GB-mes almacenado**;
no asumir que conservar una copia diaria equivale siempre a 60 GB totales.
[Precios oficiales Lightsail](https://aws.amazon.com/lightsail/pricing/).

Proponer Ubuntu **24.04 LTS** soportado, sujeto a disponibilidad del blueprint
en la región elegida y compatibilidad con Docker. No seleccionar automáticamente
otra versión ni pagar Ubuntu Pro como efecto lateral.
[Ciclo oficial Ubuntu](https://ubuntu.com/about/release-cycle).

El presupuesto de referencia mensual es **USD 25 brutos para todo el piloto**:

| Partida                                             | Reserva mensual de planificación | Condición                                                                         |
| --------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| VPS 2 GB/2 vCPU/60 GB con IPv4                      | USD 12                           | Revalidar región, tarifa y bundle al autorizar                                    |
| Snapshots opcionales                                | Hasta USD 3                      | Equivale a 60 GB-mes a la tarifa publicada; no activar sin inventario y retención |
| Backups externos cifrados                           | Hasta USD 2                      | Destino, peticiones, descarga y transferencia cotizados antes de activar          |
| Margen para impuestos, transferencia y otros cargos | USD 8                            | No equivale a permiso para contratar servicios adicionales                        |
| Total de referencia                                 | **USD 25**                       | Si la cotización completa excede 25, detener y solicitar revisión                 |

Los márgenes son decisiones de planificación, no precios de servicios. Para el
piloto no se prevén discos adicionales, dominio, balanceador, RDS, NAT Gateway,
servicios de IA ni monitoreo comercial. Recontar imágenes, logs, DB/WAL y copias
locales dentro del SSD; medir espacio antes de aceptar la capacidad. Una
ampliación a 4 GB requiere nueva cotización y autorización, no es un paso automático.

La [proyección de seis meses](DEPLOYMENT_STRATEGY.md#proyección-ilustrativa-de-seis-meses)
mantiene 2 GB y estima USD 72 de VPS, hasta USD 78 de margen y USD 150 de
planificación; los USD 50 restantes son una resta nominal frente a 200, no saldo.
Costos brutos, crédito aplicado y neto deben figurar como columnas
separadas en el registro privado; cubrir el bruto con crédito no reduce el consumo.
No se adquieren Reserved Instances, Savings Plans ni compromisos.

## Diseño de host, contenedores y redes

Composición local existente que debe volver a verificarse en la VPS autorizada:

- Ubuntu LTS soportado, actualizaciones de seguridad, Docker/Compose soportados y
  versiones de imágenes fijadas. Jarvis permanece un único contenedor modular;
  cada agente usa imagen y proceso independientes, sin importar código interno.
- Usuario sin root en contenedores, filesystem de aplicación de solo lectura
  cuando sea posible, límites de RAM/CPU/procesos, privilegios/capabilities mínimos.
  No montar Docker socket, claves AWS ni carpetas completas del host.
- Una red por integración y volúmenes separados por propietario. Un agente no
  accede a DB, secretos o red de otro. No abrir DB a Internet. Sin RDS inicial.
- Firewall del proveedor y del host con acceso mínimo. Telegram mantiene egreso
  al endpoint oficial por long polling; no necesita ingreso público del bot.
  No publicar Gateway, Event Dispatcher o webhooks en el piloto.
- Para HTTPS de agentes, usar nombres y certificados válidos, destinos registrados,
  Bearer por integración, redirects bloqueados y política de egreso por allowlist.
  Los destinos públicos se validan por defecto; una IP privada RFC1918/ULA requiere
  autorización local **exacta por origen**, sin abrir rangos completos. Loopback,
  link-local y metadata siguen prohibidos en producción incluso si se registran.
  El certificado debe validar el nombre original; no relajar TLS/SSRF para Docker.
  La excepción de loopback de pruebas nunca se hereda a producción.
- Sin NAT Gateway ni balanceadores por defecto. Un solo host no ofrece alta
  disponibilidad; asumir mantenimiento y una falla común de host.

No hay asignación garantizada de agentes por cantidad: medir RAM/CPU/latencia,
errores, reinicios y disco bajo carga representativa. Reservar capacidad para SO,
Docker y TLS. En un host de 2 GB, evitar OCR/navegadores o modelos locales sin
evaluación independiente. [Prácticas de Compose](https://docs.docker.com/compose/how-tos/production/).

## Cuenta, SSH y secretos

Preparar MFA de la cuenta, acceso administrativo individual con privilegio mínimo
y revisión de contactos/recuperación. No usar root ni claves AWS dentro de Jarvis
para la operación cotidiana. El Core no necesita SDK AWS para hablar HTTPS.

SSH por clave individual protegida y fuente de red autorizada, sin password ni
login root remoto. Verificar huella del host por un canal independiente, mantener
una segunda sesión al cambiar reglas y comprobar recuperación antes de cerrar la
sesión existente. No abrir SSH a todo Internet como configuración permanente.
Mantener SO/paquetes actualizados y revisar permisos/usuarios del grupo Docker.

Credenciales propias server-only por agente, con rotación y revocación. No incluir
tokens en imágenes, URLs, comandos visibles, logs, respaldos sin cifrar o el PR.
Inyectarlos por el mecanismo local documentado para cada proceso; no leer `.env`
del operador para preparar ejemplos. Compose ya permite secretos como archivos
montados con permisos por servicio y soporte de lectura probado localmente; Compose
no cifra automáticamente los archivos del host. [Secrets de Compose](https://docs.docker.com/compose/how-tos/use-secrets/).

No añadir un gestor de secretos pago por anticipación. Si se elige uno, cotizarlo,
autorizarlo e integrarlo fuera del dominio. Probar token inválido/rotado y TLS
inválido sin revelar material secreto ni crear bucles de reinicio silenciosos.

## Backups y restauración

El estado mínimo de solicitudes/acciones/offsets reside en SQLite WAL. El CLI
existente produce snapshots coherentes con la API SQLite, cifra con AES-256-GCM
y restaura a un destino nuevo bloqueado. No copiar solo el archivo principal
con WAL activo ni presentar snapshots Lightsail como sustituto del procedimiento.
Inventariar versión de imagen, esquema, configuración privada, permisos y claves
necesarias por separado. No importar datos de dominio de agentes.
[Procedimiento implementado](BACKUP_RESTORE.md).

### Copia externa propuesta

Para el primer piloto, proponer **Backblaze B2 privado** como copia independiente
de AWS, sujeto a aceptación de privacidad, región, precio y cuenta. **S3 Standard
privado** es la alternativa dentro de AWS si la elegibilidad y el costo la hacen
preferible. No crear cuentas/buckets ni configurar clientes remotos en esta fase.
La copia es un objeto opaco `.jvb`: ningún destino necesita descifrarlo ni recibir
la clave HMAC, el token Telegram, el Bearer o la base sin cifrar.

| Destino evaluado         | Precio público de referencia, consultado 2026-11-03                                                                            | Ventaja y límite                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| S3 Standard, `us-east-1` | USD 0,023/GB-mes inicial; PUT USD 0,005/1000; GET USD 0,0004/1000                                                              | Control de acceso, versionado y Object Lock; misma cuenta/proveedor implica riesgo común de acceso/facturación       |
| Backblaze B2             | Desde USD 6,95/TB-mes; egreso incluido hasta 3 veces el almacenamiento medio y exceso USD 0,01/GB; revisar transacciones/clase | Cuenta y proveedor independientes; nueva evaluación de privacidad, región, credenciales y pago fuera de créditos AWS |

Las tarifas S3 se contrastaron con el
[catálogo público oficial de `us-east-1`](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json)
y [precios S3](https://aws.amazon.com/s3/pricing/). La oferta B2 publica 10 GB
iniciales sin cargo, pero el presupuesto no depende de promociones ni de un
supuesto saldo gratuito. Sus clases A/B/C y D tienen condiciones distintas.
[Precios B2](https://www.backblaze.com/cloud-storage/pricing).

Ejemplo aritmético deliberadamente conservador, **5 GB-mes** de objetos totales
incluyendo versiones/retención y 100 PUT + 100 GET: S3 daría **USD 0,11554** antes
de transferencia, impuestos y extras. Con 1 TB decimal = 1000 GB, la referencia
B2 para 5 GB sería **USD 0,03475** antes de egreso, transacciones aplicables e
impuestos, sin descontar su nivel gratuito. Son ejemplos de cálculo, no una
cotización regional ni garantía de la reserva mensual de USD 2. La salida desde
Lightsail, el tráfico de restauración y cualquier versión retenida cuentan aparte.

Operación propuesta, manual y fuera del Core:

1. El operador crea y verifica cada día un `.jvb` con el CLI existente. No se
   incorpora scheduler ni uploader a Jarvis. Si no se cumple la rutina, registrar
   el intervalo real; RPO 24 h deja de ser un objetivo alcanzado.
2. Extraer **solo el objeto cifrado** desde el volumen de copias mediante el
   procedimiento local y un canal SSH verificado al equipo del operador. La
   clave de descifrado se custodia además fuera de la VPS y fuera del bucket,
   con copia de recuperación offline y acceso separado. La VPS la necesita para
   producir el backup; no afirmar que cifrar protege frente a un host comprometido.
3. En ese equipo, verificar SHA256, ejecutar `state:verify` y conservar en un
   catálogo privado el nombre UUID, hash, inicio/fin de snapshot, esquema, versión
   de imagen, clave de backup por alias, versión remota y retención. El catálogo
   incluye la evidencia conocida posterior al backup; no se almacena junto al
   único original ni contiene secretos o conversaciones.
4. Subir desde el equipo del operador con un cliente/API oficial revisado y
   credencial dedicada al bucket/prefijo; las credenciales remotas no entran en
   el contenedor Jarvis ni en la VPS. Verificar identidad de destino, TLS, tamaño,
   checksum descargado y lectura con una credencial separada antes de contar la
   copia como recuperable. No ejecutar cargas para probar este documento.
5. Usar nombres únicos `jarvis/<instalacion-opaca>/YYYY-MM-DD/backup-<UUID>.jvb`,
   versionado y retención protegida **35 días** propuestos. En S3 exigir creación
   condicional `If-None-Match: *`; una colisión falla. Object Lock protege versiones,
   pero no prohíbe por sí solo crear otra versión con el mismo nombre. En B2,
   no asumir que omitir `deleteFiles` impide ocultar/borrar por nombre: comprobar
   los permisos efectivos del cliente y retener las versiones bloqueadas.
6. Mantener al menos siete puntos diarios y cuatro semanales verificables; con
   bloqueo de 35 días pueden coexistir **más de 11 objetos**. A 128 MiB por copia,
   35 copias suman aproximadamente 4,375 GiB más metadatos/versiones. Supervisar
   el total frente a la hipótesis de 5 GB; no aumentar frecuencia/retención sin
   recalcular. No borrar ni sobrescribir una copia válida al subir la siguiente.
7. Proponer modo governance sin permiso de bypass para la credencial de carga;
   una credencial administrativa separada custodia la política. Probar carga
   duplicada, borrado denegado, expiración y recuperación tras perder la VPS antes
   de aprobar el destino. La retención puede mantener costos tras cerrar el piloto;
   compliance irreversible necesita una aprobación distinta y no se activa aquí.

Fuentes de controles:
[S3 escrituras condicionales](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html),
[B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock) y
[permisos B2](https://www.backblaze.com/docs/cloud-storage-map-iam-policies-and-s3-acls-to-backblaze-b2-access-controls).

Rotar claves de autenticación remota con verificación de lectura y revocación de
la anterior. La clave AES simétrica del backup **no** se recupera del objeto:
retener todas las claves antiguas requeridas por copias vigentes, separar alias
del valor, registrar corte y crear/verificar una copia nueva tras rotar. No
destruir claves previas hasta que expire toda su retención y se valide otra copia.
La pérdida de la VPS exige recuperar también configuración y claves privadas de
su custodia independiente; la DB sola no reconstruye identidad o permisos.

Objetivos iniciales para el piloto, **aún no medidos en AWS**: RPO 24 h desde la
última copia externa verificada y RTO 4 h incluyendo revisión humana y conciliación.
Probar restauración en un host aislado autorizado, verificar integridad, permisos,
secretos y TLS, y registrar tiempos/costos. Antes de habilitar tráfico, conciliar
operaciones inciertas: reiniciar o restaurar un backup antiguo no autoriza
repetir solicitudes ni notificaciones. Cada agente prueba sus propias copias.
El borrado de originales requiere una decisión separada y una restauración válida.
La pérdida de conectividad no autoriza retries ciegos. Antes de reabrir tráfico,
usar `state:inspect`, evidencia externa y `state:authorize` con el identificador
concreto y un floor de updates Telegram verificado; no retirar el bloqueo a mano.
El floor se consume mediante el journal durable del flujo de agentes. En el
piloto inicial con agentes apagados ese journal no se conecta: no afirmar que el
floor descarta automáticamente diagnósticos previos ni que la deduplicación de
esas respuestas sobreviva a reinicios. Revisar mensajes anteriores y la posibilidad
de respuestas repetidas antes de reanudar; no activar agentes para ocultar el límite.
Incluso cero pendientes en la copia puede ocultar solicitudes posteriores al
backup. Si no puede conciliarse, mantener el destino bloqueado.

## Métricas y observabilidad

Empezar con métricas locales acotadas: CPU, RAM, disco, reinicios, latencia p95,
errores por código, timeouts, 429, pendientes y duplicados. No registrar cuerpos,
Bearer, referencias sensibles, nombres o IDs de Telegram. Health checks sin
secretos; control de acceso a métricas y rotación de logs.

Esa lista define las necesidades del piloto; no toda ella está instrumentada.
Los procedimientos disponibles deben declarar qué miden y qué permanece pendiente;
no inventar p95, timeouts o conectividad a partir de ausencia de eventos. Con los
agentes apagados, la conectividad y los errores del Gateway son **no aplicables**.
La salud local indica proceso/heartbeat, no prueba una llamada reciente a Telegram.

Proponer para aprobación logs locales rotados, límite de tamaño por servicio y
retención corta explícita; medir volumen antes de elegir cifras finales. No
activar logging/telemetría paga sin límite. Métricas futuras de inbox/outbox solo
cuando exista Dispatcher; no se presentan como instrumentación disponible.
Los umbrales de la [estrategia](DEPLOYMENT_STRATEGY.md#dimensionamiento-medido)
disparan revisión humana, no ampliación automática.

## AWS Budgets y seguimiento de créditos

Plan manual para configurar **solo después de autorización**, sin ejecutarlo ahora:

1. En Billing → Budgets, proponer presupuesto de costo mensual recurrente fijo de
   **USD 25**, alcance de toda la cuenta y regiones para detectar recursos olvidados.
   Usar costo bruto antes de créditos/reembolsos: excluirlos del cálculo; revisar
   los demás componentes (impuestos, soporte y fees) para no ocultar cargos.
2. Alertas de costo real: **50% = USD 12,50**, **80% = USD 20**,
   **100% = USD 25**; alerta de previsión al superar el 100%. Destino: correo privado
   del operador comprobado, sin incorporarlo a documentación pública. No enviar
   mensajes desde Codex ni conectar SNS/acciones automáticas en esta tarea.
3. Verificar que el cálculo bruto no quede en cero por los créditos y que las
   notificaciones lleguen. El forecast requiere suficiente historial; hasta
   entonces usar costo real y revisión manual. AWS documenta aproximadamente
   cinco semanas para previsiones. [Opciones y frecuencia de Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html).
4. Mantener seguimiento separado del crédito por saldo estimado, consumido,
   producto elegible y fecha de vencimiento; revisar semanalmente y a diario
   cerca de agotamiento/vencimiento. Conciliar Bills al cierre. Los USD 200
   nominales no son el saldo disponible ni una cuenta prepaga.
5. Revisar costo por servicio/región y recursos existentes tras cada cambio.
   Antes de considerar 4 GB (USD 24 base), revisar extras: USD 25 mensual deja
   apenas USD 1 de margen. No elevar presupuesto ni superar el plan sin permiso.

Las alertas no son un tope duro ni garantizan cortar cargos: hay demora entre uso,
facturación y aviso. [Advertencia oficial](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
El monitoreo/notificación básico de Budgets se publica sin costo; reportes y
ciertas acciones tienen tarifas, por lo que no se activan por defecto.
[Precios de Budgets](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/).

## Costos inesperados y salida antes de agotar crédito

Evitar inicialmente NAT Gateway, load balancers innecesarios, RDS, IP sin uso,
almacenamiento sin retención, logs pagos sin límite y proveedores de IA pagos,
incluido Bedrock. No crear recursos para probar la estrategia.

Si se detecta un desvío: identificar servicio, región y recurso, detener nuevas
ejecuciones variables, limitar concurrencia y exportar evidencia sin datos
sensibles. Evaluar optimización o reversión con autorización; no borrar datos ni
revocar recursos indiscriminadamente. Una alerta no ejecuta estas acciones.

Definir una fecha de decisión al menos 30 días antes del vencimiento real más
próximo o cuando la previsión consuma el margen aprobado. Revisar a 14 y 7 días;
son revisiones del operador, no un scheduler implementado ni alertas de Jarvis.
Si no hay presupuesto neto autorizado, planear migración o cierre con margen
para backup/restauración y transferencia.

**Apagar el SO o usar Stop no detiene el cobro de una instancia Lightsail.**
El cese de la instancia requiere eliminarla, tras backup/restauración y autorización
expresa. [Facturación de instancias detenidas](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html).
Snapshots, discos e IP y otros recursos pueden permanecer y facturarse después;
inventariarlos y obtener permiso para eliminarlos o mantenerlos con costo/retención
aprobados. [Eliminación y remanentes](https://docs.aws.amazon.com/lightsail/latest/userguide/delete-an-amazon-lightsail-instance.html).
Comprobar Billing después del cierre y durante el siguiente ciclo: no prometer
gasto cero inmediato.

## Migración fuera de AWS

Exportar configuración sin secretos, imágenes/versiones y volúmenes por propietario
en formatos portables. Elegir destino (por ejemplo VPS DigitalOcean) con cotización,
privacidad, región y presupuesto autorizados. Restaurar en paralelo con egreso
bloqueado; verificar HTTPS, permisos, aislamiento, datos y observabilidad.

Congelar nuevos efectos durante el corte, conciliar pendientes/inciertos y mover
un solo consumidor de Telegram a la vez para evitar dos pollers activos. Rotar
credenciales, actualizar DNS/allowlist únicamente a destinos aprobados y probar
antes de reanudar tráfico. No reejecutar claves perdidas por reinicio como si no
hubiesen existido. Guardar opción de rollback sin dos ejecutores de efectos.
Eliminar recursos AWS remanentes solo tras aceptación, restauración comprobada
y autorización explícita; verificar cargos posteriores. Cada agente tiene su
propio responsable y procedimiento, sin dependencias obligatorias de AWS.

## Checklist previo a contratar recursos

- [ ] PR/CI aceptados; revisión del transporte y requisitos de producción completos.
- [ ] Cuenta/plan, MFA, permisos y contactos de recuperación comprobados privadamente.
- [ ] Créditos activos, saldo, elegibilidad Lightsail/extras y vencimientos verificados.
- [ ] Región, Ubuntu soportado, bundle y cotización completa fechados.
- [ ] Presupuesto bruto, neto máximo, gastos accesorios y margen autorizados.
- [ ] Budgets/alertas propuestos y responsable de revisar costo/crédito definidos.
- [ ] Host, imágenes, redes/egreso, TLS y SSH diseñados y probados sin relajar SSRF.
- [ ] Secretos propios, distribución/rotación y política de logs/retención probados.
- [ ] Backups, restauración, operaciones inciertas y límites de memoria resueltos.
- [ ] Plan de corte/rollback y migración o eliminación antes de agotar crédito acordados.
- [ ] Autorización expresa del operador para los recursos concretos y acciones finales.

Ninguna casilla se marca por existir este documento. Completar privadamente el
[checklist detallado](AWS_PILOT_CHECKLIST.md) y el [runbook](AWS_PILOT_RUNBOOK.md).
Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12. Las
pruebas locales de Fase 1E.2 no verifican cuenta, despliegue, transferencia,
restauración externa, créditos o costo AWS.
