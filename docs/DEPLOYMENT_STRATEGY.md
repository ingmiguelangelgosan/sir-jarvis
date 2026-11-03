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

## Capacidad y precios de referencia

Referencia pública consultada el **2026-11-02**, Linux/Unix de propósito general
con IPv4 pública. No se aplica una promoción ni se infiere disponibilidad regional:

| Uso propuesto                               | RAM  | vCPU | SSD   | Referencia base mensual |
| ------------------------------------------- | ---- | ---- | ----- | ----------------------- |
| Inicio                                      | 2 GB | 2    | 60 GB | USD 12                  |
| Ampliación solo con métricas y autorización | 4 GB | 2    | 80 GB | USD 24                  |

Son precios del bundle, no del sistema completo. La transferencia incluida y sus
condiciones dependen de región; confirmar plan, moneda, impuestos y tarifa en la
cotización final. [Precios oficiales](https://aws.amazon.com/lightsail/pricing/) y
[especificaciones de bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html).

## Proyección ilustrativa de seis meses

| Periodo                             | Hipótesis de VPS                                                 | Bruto base del periodo |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Meses 1–2                           | 2 GB, USD 12/mes                                                 | USD 24                 |
| Meses 3–4                           | 2 GB, USD 12/mes                                                 | USD 24                 |
| Meses 5–6                           | Evaluar 4 GB; escenario de USD 24/mes                            | USD 48                 |
| Total VPS del escenario             | Cuatro meses a 12 y dos a 24                                     | **USD 96**             |
| Margen de planificación para extras | Backups, transferencia, almacenamiento, impuestos y contingencia | **USD 54**             |
| Presupuesto total de planificación  | VPS más margen, sin contratación                                 | **USD 150**            |
| Reserva nominal fuera del plan      | 200 nominales menos 150 planificados                             | **USD 50**             |

Subir a 4 GB no está programado: exige mediciones y aprobación. Si se mantienen
2 GB los seis meses, el VPS base sería USD 72. Los USD 54 son margen, no una
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

El diseño futuro usa imágenes fijadas, usuario sin privilegios, límites de CPU/RAM,
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
antes de contratar; no hay redes AWS o Compose desplegados.
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

Backups cifrados, restauración medida, secretos por integración y exportación de
configuración se detallan en el [plan AWS](AWS_DEPLOYMENT_PLAN.md). Ni backup ni
reinicio convierten la deduplicación actual en persistencia durable: conciliar
efectos inciertos antes de reanudar tráfico.

Esta decisión aplica [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/03/04/06/07/08/11/12.
