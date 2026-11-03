# Estrategia de infraestructura — AWS, sin desplegar

**Decisión del operador, Fase 1C (2026-11-02): AWS es el proveedor principal
durante la etapa inicial.** Amazon Lightsail con Ubuntu LTS, Docker y Docker
Compose es la propuesta inicial. Sustituye la preferencia anterior por
DigitalOcean; no cambia el Core ni autoriza compras, despliegues o facturación.
No se ha accedido a la cuenta AWS ni creado recursos, presupuestos o IaC.

El operador reporta una cuenta **AWS Paid Plan**, créditos promocionales nominales
de **hasta USD 200** y un horizonte de planificación de **seis meses**. Saldo
activo, productos elegibles y vencimientos reales siguen **sin verificar**:
deben comprobarse en AWS Billing antes de cualquier despliegue. El horizonte del
proyecto no es la fecha de vencimiento de un crédito. Una cuenta Paid Plan puede
generar cargos de bolsillo cuando el crédito no cubre el consumo.

El [plan operativo AWS](AWS_DEPLOYMENT_PLAN.md) contiene los requisitos de cuenta,
región, seguridad, presupuesto, recuperación, migración y autorización previa.
Fase 1F añade el [runbook del piloto](AWS_PILOT_RUNBOOK.md) y su
[checklist de autorización](AWS_PILOT_CHECKLIST.md), sin crear recursos. La
operación local validada de Fase 1E.2 es la base; su validación no equivale a
ejecutar el piloto en AWS.

## Capacidad y precios de referencia

Referencia pública consultada el **2026-11-03**, Linux/Unix de propósito general
con IPv4 pública. No se aplica una promoción ni se infiere disponibilidad regional:

| Uso propuesto                               | RAM  | vCPU | SSD   | Referencia base mensual |
| ------------------------------------------- | ---- | ---- | ----- | ----------------------- |
| Inicio                                      | 2 GB | 2    | 60 GB | USD 12                  |
| Ampliación solo con métricas y autorización | 4 GB | 2    | 80 GB | USD 24                  |

Son precios del bundle, no del sistema completo. La transferencia incluida y sus
condiciones dependen de región; confirmar plan, moneda, impuestos y tarifa en la
cotización final. [Precios oficiales](https://aws.amazon.com/lightsail/pricing/) y
[especificaciones de bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html).

El piloto propone Ubuntu 24.04 LTS, disponible y soportado en la región
seleccionada; comprobar el blueprint antes de contratar. Jarvis usa long polling,
sin puerto HTTP público del Gateway, balanceador ni DB administrada. El bundle
de 2 GB es una hipótesis a medir, no capacidad certificada. La referencia local
de Fase 1E.2 fue Jarvis 27,98 MiB y Echo 15,13 MiB en un snapshot de prueba;
no contempla toda la carga ni demuestra suficiencia del host AWS.
[Ciclo Ubuntu](https://ubuntu.com/about/release-cycle),
[mediciones y límites](PHASE_1E2_VALIDATION.md).

## Proyección ilustrativa de seis meses

| Periodo                             | Hipótesis de VPS                                                 | Bruto base del periodo |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Meses 1–2                           | 2 GB, USD 12/mes                                                 | USD 24                 |
| Meses 3–4                           | 2 GB, USD 12/mes                                                 | USD 24                 |
| Meses 5–6                           | Mantener 2 GB si las métricas lo permiten, USD 12/mes            | USD 24                 |
| Total VPS del escenario             | Seis meses a 12                                                  | **USD 72**             |
| Margen de planificación para extras | Backups, transferencia, almacenamiento, impuestos y contingencia | **USD 78**             |
| Presupuesto total de planificación  | VPS más margen, sin contratación                                 | **USD 150**            |
| Reserva nominal fuera del plan      | 200 nominales menos 150 planificados                             | **USD 50**             |

El escenario anterior de Fase 1C incluía dos meses hipotéticos a 4 GB; se sustituye
por un piloto de 2 GB sin ampliación programada para respetar el control mensual.
Subir a 4 GB exige mediciones y aprobación. Los USD 78 son margen, no una
cotización ni capacidad de crédito confirmada. APIs de IA y otros consumos de
agentes no están autorizados por este plan.

Separar en el seguimiento **costo bruto**, **crédito efectivamente aplicado** y
**gasto neto de bolsillo**. Para USD 150 brutos, si Billing aplicase 150 de crédito
elegible y vigente el neto sería 0; si solo aplicase 100, sería 50; sin cobertura,
sería 150. Son escenarios aritméticos, no predicción de factura. Cargos fuera de
la estimación o no elegibles se suman. La reserva nominal de 50 no se considera
dinero disponible hasta verificar cada crédito en Billing.

## Independencia, contenedores y red

Jarvis sigue siendo un monolito modular. Cada agente conserva aplicación, imagen,
repositorio, pruebas, datos, permisos y ciclo de vida propios, aunque comparta host.
No dividir Registry/Gateway/Core en microservicios. No compartir bases de dominio,
volúmenes o credenciales entre proyectos ni añadir SDK AWS al Core.

La preparación local de Fase 1E.2 usa imágenes fijadas, usuario sin privilegios, límites de CPU/RAM,
volúmenes separados y redes por integración. No montar el socket Docker ni
directorios completos del host. Telegram mantiene long polling saliente, sin
puerto público de bot. No abrir DB, Dispatcher o webhooks de agentes en esta fase.
Los agentes se comunican por HTTPS/JSON versionado con autenticación y allowlist.

La colocación privada requiere diseñar egreso y DNS junto con la protección SSRF.
El transporte permite al operador registrar IP RFC1918/ULA **exactas por origen**;
su opción predeterminada admite solo destinos públicos validados. No se permiten
rangos privados generales, loopback, link-local o metadata en producción. Mantener
TLS válido para el nombre original incluso en red privada. La excepción de
loopback de tests no se hereda a producción. Probar esta composición en el host
antes de contratar; no hay redes AWS desplegadas. La configuración Compose local,
sus secretos, límites y comprobaciones se documentan en
[LOCAL_DEPLOYMENT](LOCAL_DEPLOYMENT.md), con evidencia en
[PHASE_1E2_VALIDATION](PHASE_1E2_VALIDATION.md).
[Compose en producción](https://docs.docker.com/compose/how-tos/production/).

## Dimensionamiento medido

El número de agentes no determina la capacidad. Reservar memoria para Ubuntu,
Docker, Jarvis, TLS y buffers antes de asignar carga. OCR, navegadores, DB o trabajos
intensivos necesitan mediciones propias; no ejecutar modelos locales al inicio.

| Métrica      | Señal orientativa de revisión                  | Primera respuesta                          |
| ------------ | ---------------------------------------------- | ------------------------------------------ |
| CPU          | p95 superior a 70% en ventanas de 15 min       | Perfilar y limitar concurrencia            |
| RAM          | Más de 80% sostenido, OOM o reinicios          | Medir working set y límites por proceso    |
| Disco        | Crecimiento sin retención o poco espacio libre | Acotar logs/cachés y revisar retención     |
| Latencia     | p95 supera el objetivo por capacidad           | Separar espera remota de cómputo           |
| Concurrencia | Conexiones exceden capacidad                   | Limitar admisión antes de ampliar          |
| Costo        | Consumo fuera de lo planificado                | Suspender rutas variables y revisar causas |

Son umbrales propuestos, no benchmarks ni automatizaciones. Medir un ciclo
representativo; optimizar o separar un agente pesado antes de ampliar todo el host.

## Control financiero propuesto

Distribución mensual propuesta dentro de USD 25 brutos: VPS **12**, snapshots
opcionales **hasta 3**, copias externas **hasta 2** y margen para cargos
adicionales/impuestos **8**. Los tres últimos son reservas de planificación,
no recursos contratados ni topes automáticos del proveedor. Cotizar el conjunto
completo; si no cabe, detener y revisar. No activar un servicio solo porque
quepa en una reserva. Ver [costos y backups externos](AWS_DEPLOYMENT_PLAN.md).

Preparar, tras autorización futura, un presupuesto mensual **bruto de USD 25**
con alertas reales al 50%, 80% y 100%, y previsión superior al 100%. Excluir créditos
y reembolsos del cálculo bruto para que no oculten consumo. Revisar por separado
créditos, vencimientos, servicio y región. El escenario de 4 GB deja solo USD 1
de margen mensual: revisar el presupuesto antes de aprobarlo; el total de 150 no
autoriza superar el control mensual. [Opciones de AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html).

Las alertas **no son topes duros**: la información de facturación y las notificaciones
pueden retrasarse. No prometen detener cargos. [Limitaciones de actualización](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
No crear presupuestos reales, acciones automáticas, SNS ni reportes pagos ahora.

Evitar inicialmente NAT Gateway, balanceadores innecesarios, RDS administrado,
direcciones IP o recursos públicos sin uso, almacenamiento sin retención, logging
pago sin límites y servicios de IA de pago, incluido Bedrock. No activar servicios
para obtener créditos adicionales.

## Alternativas y portabilidad

| Proveedor/servicio | Cuándo evaluarlo                                      | Condición                                                                  |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| AWS EC2            | Red, cómputo o control que Lightsail no resuelva      | Cotizar cómputo, discos, IP y transferencia por separado                   |
| AWS Lambda         | Agentes stateless con ejecuciones breves bajo demanda | Evaluar límites, arranques, red y costo; no alojar polling continuo        |
| DigitalOcean       | Migración futura a un VPS equivalente                 | Imágenes y volúmenes portables; nueva cotización                           |
| Google Cloud Run   | Agentes con carga intermitente y HTTPS                | Concurrencia e instancias máximas; escalado a cero no garantiza costo cero |

Las alternativas no son integraciones activas. El Core y el protocolo permanecen
ajenos a AWS. [EC2](https://aws.amazon.com/ec2/pricing/),
[Lambda](https://aws.amazon.com/lambda/pricing/),
[Droplets](https://www.digitalocean.com/pricing/droplets) y
[Cloud Run](https://cloud.google.com/run/pricing) requieren revisar sus condiciones
cuando se elijan. El long polling de Telegram no equivale a una petición bajo demanda.

Backups cifrados y recuperación local se detallan en
[BACKUP_RESTORE](BACKUP_RESTORE.md); su adaptación al entorno objetivo sigue en el
[plan AWS](AWS_DEPLOYMENT_PLAN.md). SQLite aporta estado durable local, no
idempotencia de negocio ni detección completa de rollback. Toda restauración queda
bloqueada hasta conciliar y autorizar tráfico. Las mediciones locales no acreditan
capacidad suficiente para Lightsail de 2 GB ni RPO/RTO de una pérdida del host AWS.

La copia externa propuesta es un bucket B2 privado independiente; S3 Standard
privado es la alternativa AWS. La comparación, costos, credenciales separadas,
retención protegida y procedimiento manual están en
[AWS_DEPLOYMENT_PLAN](AWS_DEPLOYMENT_PLAN.md#copia-externa-propuesta). Ninguno
está configurado o contratado. No hace falta añadir SDK AWS al Core ni un
uploader a Jarvis para conservar el formato `.jvb` portable.

Esta decisión aplica [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/03/04/06/07/08/11/12.
