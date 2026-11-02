# Estrategia de infraestructura — propuesta sin desplegar

Decisión inicial: **DigitalOcean Droplet con Ubuntu LTS y Docker Compose**,
2 GB de RAM y 1 vCPU como punto de partida para Jarvis y hasta dos agentes
ligeros. Objetivo de infraestructura básica: **USD 25/mes**. Son capacidad y
presupuesto propuestos, no contratación, autorización para facturar ni rendimiento
medido. No se crean cuentas, VMs, Dockerfiles, despliegues o recursos en esta fase.

## Independencia y colocación

Jarvis sigue siendo un servicio modular; no se divide su Core, Registry y Gateway
en microservicios. Compose podrá colocar en el mismo host contenedores de agentes
con repositorio, imagen, pruebas, versión y ciclo de vida propios. No compartir
código interno, credenciales ni volúmenes de dominio. Cada agente puede migrar a
otro proveedor sin cambiar el contrato de Jarvis.

La persistencia se elegirá según consumo y garantías necesarias. Una instancia
pequeña puede evaluar almacenamiento local; concurrencia y durabilidad pueden
justificar PostgreSQL. Las bases de cada agente siguen aisladas y gestionadas por
ese proyecto, aunque eventualmente compartan un servidor con usuarios separados.
No se añade DB a Jarvis para anticipar la futura de Finance Agent.

## Costos orientativos y autorizaciones

Referencia consultada el **2026-11-02**: la tabla Basic Regular publica 2 GiB/1 vCPU
por USD 12/mes, 4 GiB/2 vCPU por USD 24 y 8 GiB/4 vCPU por USD 48.
Son precios de la VM, no del sistema completo; revisar región, plan y tarifa al
contratar. [Precios oficiales de Droplets](https://www.digitalocean.com/pricing/droplets).

| Etapa propuesta | Carga orientativa                  | Evaluación de host                    | Estimación total de infraestructura         |
| --------------- | ---------------------------------- | ------------------------------------- | ------------------------------------------- |
| 1               | Jarvis + hasta 2 agentes ligeros   | 2 GB / 1 vCPU                         | USD 15–25/mes; objetivo inicial 25          |
| 2               | Jarvis + aproximadamente 4 agentes | Evaluar 4 GB si métricas lo requieren | USD 30–50/mes; requiere nuevo presupuesto   |
| 3               | Jarvis + 6–8 agentes               | Evaluar 8 GB o separar cargas         | Dimensionar con métricas y cotización nueva |

Los totales son estimaciones del proyecto, no precios garantizados. Contemplar
backups, almacenamiento, transferencia, DNS/dominio cuando corresponda, impuestos
y margen. **No incluyen APIs de IA ni otros servicios comerciales de los agentes**;
su autorización y presupuesto son independientes. Las compras o ampliaciones
requieren aprobación concreta, incluso si una métrica supera un umbral.

El objetivo de USD 25 no es un tope duro del proveedor. Alertas de presupuesto no
implican suspensión automática. Reservar gastos previstos, revisar consumo y
topes disponibles y detener nuevas operaciones variables ante incertidumbre;
una VM contratada o almacenamiento retenido puede seguir generando cargos hasta
ser gestionado expresamente. No activar facturación para probar este documento.

## Dimensionamiento medido

El número de agentes no determina los recursos: un proceso que consulta poco
no consume como OCR, scraping con navegador o trabajos intensivos. No ejecutar
modelos locales en el alcance inicial. En 2 GB, reservar primero memoria para
Ubuntu, Docker, Jarvis, TLS y buffers; medir lo restante antes de asignar agentes
y DB. No se garantiza que dos agentes concretos quepan.

| Métrica          | Señal orientativa de revisión              | Respuesta antes de ampliar                          |
| ---------------- | ------------------------------------------ | --------------------------------------------------- |
| CPU              | p95 >70% durante ventanas de 15 min        | Perfilar tareas y limitar concurrencia              |
| Memoria          | >80% sostenida, OOM o reinicios            | Medir working set, buffers y límites por contenedor |
| Frecuencia       | Tareas acumulan ejecuciones                | Espaciar trabajo autorizado y revisar duración      |
| Concurrencia     | Picos superan capacidad o conexiones       | Limitar admisión y presupuestos simultáneos         |
| Latencia         | p95 excede objetivo definido por capacidad | Separar espera remota de CPU local                  |
| Usuarios activos | Más sujetos/sesiones y tráfico             | Diseñar aislamiento antes de ampliar acceso         |
| Proveedores      | Consumo/cargos fuera de lo reservado       | Suspender rutas variables y revisar autorización    |

Son umbrales iniciales de observación, no automatizaciones o benchmarks aprobados.
Registrar al menos un ciclo representativo de carga y el costo real de tareas.
Evaluar optimización, ejecución bajo demanda o separar un agente pesado antes de
subir toda la VM. Revisar backups, restauración y seguridad junto con capacidad.

## Docker Compose futuro

Preparar imágenes por proyecto, versiones fijadas y builds reproducibles. Dar
límites de memoria/CPU y privilegios mínimos, usuario no root cuando sea posible,
health checks locales sin secretos y redes privadas por integración. Los datos
durables usan volúmenes separados; no montar sockets Docker ni carpetas completas
del host en agentes. No abrir la DB a Internet.

Planificar reinicios con backoff, límite de fallos/alerta y parada ordenada. Un
token inválido no debe causar un bucle silencioso; validar configuración antes de
activar el servicio. Probar reinicio del host, caída de red, recuperación y rollback
de imagen sin reejecutar efectos inciertos. Compose no aporta alta disponibilidad
del host ni garantiza consistencia de datos por sí solo.
[Guía de Compose en producción](https://docs.docker.com/compose/how-tos/production/).

No hay un Compose operativo en el repo todavía. Su implementación y prueba
pertenecen a Fase 5, después de verificar las necesidades reales de Registry,
Gateway, agentes y persistencia. No copiar ejemplos como un despliegue ya validado.

## Secretos y red

- Credenciales propias por integración/instancia; permisos mínimos, rotación y
  posibilidad de revocar sin recompilar. No hornear secretos en imágenes o Git.
- En el código actual, variables de entorno server-only y `.env` local excluido
  de Git. Para Compose, evaluar archivos montados como secrets con acceso por
  servicio y permisos del host; no asumir que quedan cifrados automáticamente.
  El soporte de lectura `*_FILE` no existe aún: debe implementarse y probarse
  antes de elegirlo. [Secrets de Compose](https://docs.docker.com/compose/how-tos/use-secrets/).
- Acceso SSH por claves y fuentes autorizadas, actualizaciones de Ubuntu/Docker,
  firewall y separación de redes. Planear TLS en ingress/egress y validar certificados.
- Telegram usa polling saliente y no requiere abrir un puerto de bot. Los futuros
  callbacks HTTPS pasan por ingress limitado, autenticación, replay y cuota;
  ninguna exposición nueva se hace en esta fase.
- Endpoints solo registrados por el operador, sin redirects o destinos del
  mensaje. Agentes externos no reciben IDs de chat ni claves de otros agentes.

## Backups y restauración

Definir inventario de configuración, permisos, suscripciones, estados pendientes,
deduplicación y volúmenes. Separar las copias internas de cada agente y su
responsable. No usar un dump financiero como DB de Jarvis. Cifrar copias privadas,
restringir acceso y guardar una copia fuera del host, con retención y costo
aprobados; no subir secretos a backups sin protección equivalente.

Objetivos iniciales propuestos, no comprobados: RPO 24 h y RTO 4 h, sujetos al
uso real. Probar periódicamente restauración en un entorno aislado autorizado,
incluyendo permisos, claves, pendientes y deduplicación. Antes de reanudar tráfico,
conciliar operaciones y entregas inciertas: un backup antiguo puede haber perdido
IDs recientes y no justifica reenviar pagos o notificaciones automáticamente.
Registrar la prueba y sus tiempos; una copia que nunca se restaura no demuestra
recuperación. No borrar datos originales por hacer backup.

## Observabilidad y portabilidad

Métricas de CPU/RAM/reinicios, latencia y errores por capacidad, tamaño de inbox,
duplicados, entregas inciertas y costos agregados. Logs con códigos y referencias
mínimas, sin cuerpos, credenciales, nombres, IDs de Telegram o datos financieros.
Retención y acceso definidos; evitar agentes de telemetría pagos por defecto.

Exportar configuración no secreta, documentar inyección de secretos y probar
restore en una VM equivalente. Usar imágenes y volúmenes estándar; no acoplar
protocolos a IDs de DigitalOcean, a una DB compartida o a un servicio propietario.
Cada agente conserva su procedimiento independiente de despliegue y recuperación.

## Cloud Run como opción bajo demanda

Evaluar Cloud Run para agentes stateless invocados por HTTPS, con trabajo acotado,
concurrencia y número máximo de instancias definidos. Escalado a cero puede reducir
recursos ociosos, pero arranque, cómputo, solicitudes, red y servicios relacionados
pueden facturarse. No asumir costo cero ni una garantía de privacidad por nivel
gratuito. [Precios oficiales de Cloud Run](https://cloud.google.com/run/pricing).

El modo de facturación y los mínimos de instancias afectan CPU disponible y costo
en reposo; un consumidor continuo o scheduler no equivale a una petición bajo
demanda. No mover el polling continuo de Telegram a un servicio escalado a cero
sin otro diseño. [Facturación](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
y [autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling).

La autenticación, secretos y presupuesto deben verificarse antes de habilitar
cualquier servicio de Google Cloud; no se crea proyecto ni cuenta de facturación.
Para trabajos más largos evaluar alternativas en su fase, sin introducir ahora
una cola distribuida o infraestructura adicional.

Esta estrategia aplica [PRODUCT_RULES](PRODUCT_RULES.md) ORC-03/04/06/11/12.
