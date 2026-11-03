# Plan de despliegue AWS — preparación documental

**Estado:** diseño de Fase 1C, sin despliegue, contratación, acceso a la cuenta ni
creación de presupuestos. La decisión autorizada es documentar AWS como proveedor
principal; cualquier acción que cree, cambie o elimine recursos necesita alcance
y autorización expresos. No hay IaC ejecutable ni Compose AWS operativo aquí.
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

Cotizar Lightsail Linux/Unix con IPv4 pública: 2 GB RAM, 2 vCPU y 60 GB SSD por
USD 12/mes de referencia. Revisar transferencia, moneda, impuestos, snapshots,
discos, IP, DNS/dominio y cualquier monitoreo adicional. El upgrade propuesto a
4 GB/2 vCPU/80 GB, USD 24/mes, requiere métricas y aprobación nuevas.
[Bundles oficiales](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html).

La [proyección de seis meses](DEPLOYMENT_STRATEGY.md#proyección-ilustrativa-de-seis-meses)
estima USD 96 de VPS, USD 54 de margen, USD 150 de planificación y USD 50 de
reserva nominal. Costos brutos, crédito aplicado y neto deben figurar como columnas
separadas en el registro privado; cubrir el bruto con crédito no reduce el consumo.
No se adquieren Reserved Instances, Savings Plans ni compromisos.

## Diseño de host, contenedores y redes

Diseño pendiente de implementar y validar en una fase de despliegue:

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
  No publicar Event Dispatcher ni webhooks en Fase 1C.
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
del operador para preparar ejemplos. Para Compose futuro, evaluar secretos como
archivos montados con permisos por servicio y soporte de lectura probado; Compose
no cifra automáticamente los archivos del host. [Secrets de Compose](https://docs.docker.com/compose/how-tos/use-secrets/).

No añadir un gestor de secretos pago por anticipación. Si se elige uno, cotizarlo,
autorizarlo e integrarlo fuera del dominio. Probar token inválido/rotado y TLS
inválido sin revelar material secreto ni crear bucles de reinicio silenciosos.

## Backups y restauración

Inventariar configuración, permisos, versión de imágenes, claves necesarias y
datos durables realmente existentes. Los estados actuales del Gateway son **solo
memoria**: un snapshot de disco no captura ni restaura su deduplicación activa.
Persistencia durable y recuperación de operaciones requieren su fase y pruebas.
Nunca importar el libro financiero de un agente como base de datos de Jarvis.

Propuesta previa a aprobación: copias diarias cifradas, siete diarias y cuatro
semanales, al menos una copia fuera del host, claves de descifrado separadas y
acceso mínimo. Cotizar almacenamiento, snapshots y transferencia antes de activar;
retención y destino deben aprobarse. Una snapshot puede contener secretos:
protegerla con el mismo cuidado que el host. No publicar backups o claves.

Objetivos iniciales no medidos: RPO 24 h y RTO 4 h para datos durables aprobados.
Probar restauración en un host aislado autorizado, verificar integridad, permisos,
secretos y TLS, y registrar tiempos/costos. Antes de habilitar tráfico, conciliar
operaciones inciertas: reiniciar o restaurar un backup antiguo no autoriza
repetir solicitudes ni notificaciones. Cada agente prueba sus propias copias.
El borrado de originales requiere una decisión separada y una restauración válida.

## Métricas y observabilidad

Empezar con métricas locales acotadas: CPU, RAM, disco, reinicios, latencia p95,
errores por código, timeouts, 429, pendientes y duplicados. No registrar cuerpos,
Bearer, referencias sensibles, nombres o IDs de Telegram. Health checks sin
secretos; control de acceso a métricas y rotación de logs.

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

Ninguna casilla se marca por existir este documento. Aplican
[PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/03/04/06/07/08/11/12. La demostración local
de Fase 1C no verifica una cuenta, despliegue, restauración o costo AWS.
