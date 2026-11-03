# Checklist privado de autorización — piloto AWS Lightsail

Fase 1F prepara el piloto y **no autoriza ni ejecuta** compras, acceso a Billing,
creación de recursos, SSH a AWS o transferencia de datos privados. Copiar esta
plantilla a un registro privado fuera del repositorio. No rellenar aquí IDs de
cuenta, direcciones del operador, facturas, secretos, bucket real o evidencias
privadas. Las casillas empiezan pendientes y no se aprueban por existir el plan.

Fuentes: [runbook reproducible](AWS_PILOT_RUNBOOK.md),
[plan/costos/backups](AWS_DEPLOYMENT_PLAN.md), [estrategia](DEPLOYMENT_STRATEGY.md)
y [recuperación implementada](BACKUP_RESTORE.md).

## Alcance e identidad de la decisión

- [ ] PR de preparación fusionado y commit exacto de despliegue identificado;
      CI Windows/Linux correcta y artefacto verificado.
- [ ] Responsable, fecha, ventana del piloto y vencimiento de la autorización
      documentados en privado; revisión inicial de 7 días propuesta, sin renovación
      de alcance implícita.
- [ ] Cuenta AWS prevista y plan reportado Paid Plan identificados por el operador;
      esta fase no comprobó esa cuenta ni sus créditos.
- [ ] Autorización **separada** para consultar Billing/Créditos, con alcance de
      solo lectura y responsable; no confundirla con permiso para crear recursos.
- [ ] Autorización expresa para los recursos finales solo después de cotización,
      checklist técnico completo y procedimiento de salida revisado.
- [ ] Un solo consumidor de Telegram autorizado; detener el bot local antes del
      corte. No permitir que dos hosts compartan un token activo al mismo tiempo.
- [ ] Capacidades de lectura, IA apagada y `no-paid-services`; ningún agente de
      dominio, escritura de negocio, Dispatcher, webhook público o servicio pago
      de IA está incluido en el piloto.

## Créditos y costo bruto, aplicado y neto

Con autorización de lectura, revisar en la consola privada **Billing → Credits**
y **Bills**. La documentación oficial explica la diferencia entre saldo del
último ciclo y estimación actual; no asumir que un crédito nominal cubre consumo
actual. [Créditos AWS](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/useconsolidatedbilling-credits.html).

- [ ] Registrar por crédito estado, saldo real/estimado, inicio, vencimiento y
      productos aplicables con evidencia fechada. Hasta USD 200 nominales no es
      un saldo disponible ni una garantía de seis meses.
- [ ] Confirmar explícitamente elegibilidad de Lightsail, snapshots, transferencia
      y S3 si se eligiera; revisar exclusiones, Marketplace, soporte, impuestos y
      reglas del programa. [Condiciones promocionales](https://aws.amazon.com/awscredits/).
- [ ] Elegir región; `us-east-1` es candidata, no elección ya aprobada. Verificar
      residencia/privacidad, disponibilidad, latencia y precio desde esa región.
- [ ] Cotizar bundle Linux/Unix con IPv4: 2 GB RAM, 2 vCPU, 60 GB SSD; precio
      público de referencia USD 12/mes, consultado 2026-11-03. Confirmar transferencia
      incluida y sobreconsumo regional en [precios Lightsail](https://aws.amazon.com/lightsail/pricing/).
- [ ] Identificar y cotizar snapshot, retención total/versiones, disco adicional,
      IP retenida, dominio/DNS, transferencia, peticiones de backup, impuestos y
      cualquier cargo extra. Nada se autoriza como accesorio invisible.
- [ ] Aprobar presupuesto mensual bruto de referencia USD 25 para todo el piloto:
      12 VPS + hasta 3 snapshots + hasta 2 copias externas + 8 de margen. Si la
      cotización real excede el total, pedir una decisión nueva antes de crear.
- [ ] Registrar máximo **neto de bolsillo** aceptado por el operador y qué hacer
      si no se aplican créditos; no presumir neto cero.
- [ ] Mantener registro privado con columnas: fecha/ciclo, servicio/región,
      unidades, costo bruto, crédito aplicado, cargo neto AWS, cargo externo,
      impuestos y desviación. Una copia B2 no recibe créditos AWS.
- [ ] Aprobar configuración de Budgets bruto USD 25, excluyendo créditos y
      reembolsos del cálculo; alertas de costo real 12,50/20/25 y previsión >25.
      Validar destinatario privado sin publicar su dirección.
- [ ] Tener revisión humana de costo/crédito al menos semanal y diaria cerca del
      vencimiento o agotamiento. Las alertas pueden retrasarse: **no son topes
      duros**. [Limitaciones de Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).
- [ ] No activar acciones automáticas, SNS, logging comercial, reportes pagos,
      Savings Plans ni compromisos para probar el presupuesto.

## Host, acceso y egreso

- [ ] Blueprint Ubuntu 24.04 LTS soportado y disponible, arquitectura e imagen
      exactas documentadas; versión/digest de Node y release de Docker/Compose
      fijados según el runbook. No actualizar automáticamente el release del bot.
- [ ] MFA, usuario administrativo individual, contactos y recuperación de cuenta
      revisados. No usar root de AWS ni claves AWS dentro del Core.
- [ ] SSH solo por clave protegida, usuario administrativo y origen CIDR privado
      autorizado. Host key verificada por un canal independiente; probar segunda
      sesión antes de cerrar la sesión existente o deshabilitar acceso anterior.
- [ ] Firewall Lightsail y firewall local coherentes para IPv4/IPv6: ingreso solo
      SSH desde el origen elegido, sin 80/443 público para Jarvis o Echo.
- [ ] Política de egreso documentada para DNS, hora, actualizaciones/control
      administrativo y HTTPS de Telegram/agentes aprobados. Comprobar firewall
      efectivo del tráfico Docker; una regla de UFW sobre el host no prueba
      automáticamente filtrado de tráfico reenviado de contenedores.
- [ ] Conservar verificación TLS/DNS/IP, redirects bloqueados, allowlist, identidad
      server-only y autorización. No permitir metadata/link-local/loopback ni
      rangos privados amplios para resolver conectividad.
- [ ] Sin Docker socket en contenedores; permisos del daemon restringidos,
      UID/GID esperado, rootfs de solo lectura, capabilities eliminadas, límites
      de CPU/RAM/PID y cierre ordenado comprobados.
- [ ] Volúmenes locales separados del código, permisos privados, SSD local para
      WAL y capacidad libre suficiente; no usar NFS ni restaurar una copia encima
      del volumen activo.
- [ ] Secretos montados por servicio, archivo fuente 0600/directorio 0700 y
      propietario compatible; tokens/HMAC/Bearer/claves TLS separados y copias de
      recuperación custodiadas fuera del host. No logs de SQL, cuerpos o secretos.

## Backups fuera del host y recuperación

- [ ] Elegir B2 privado o S3 privado con aprobación separada de cuenta/proveedor,
      región, privacidad, costo y credenciales. Ningún bucket existe por esta fase.
- [ ] Definir el procedimiento diario manual, responsable y comprobación de copia
      externa; conservar siete puntos diarios y cuatro semanales como mínimo.
      El bloqueo propuesto de 35 días retiene más objetos y debe entrar en costo.
- [ ] Configurar, probar y aprobar versionado/retención protegida y creación de
      objetos por UUID; no sobrescribir copias ni permitir bypass de retención
      al uploader. Documentar las diferencias de permisos S3/B2 del plan.
- [ ] Mantener claves de autenticación del destino en el equipo del operador,
      fuera de VPS/Core; credencial de lectura/recuperación separada. La clave
      AES requerida para crear copias tiene custodia independiente y copia offline.
- [ ] Conservar alias y claves antiguas mientras existan objetos que las requieran;
      probar rotación, revocación y restauración. Perder una clave AES no se
      resuelve recuperando el archivo cifrado del bucket.
- [ ] Catálogo privado independiente con hash, UUID, versión de objeto, esquema,
      release y eventos conocidos posteriores al punto de copia; sin tokens,
      conversaciones ni datos de dominio de agentes.
- [ ] Descargar una copia real del destino autorizado, comprobar hash y
      `state:verify`, restaurar aislada y comprobar bloqueo en DB antes de
      considerar que existe recuperación externa. Esto queda pendiente en Fase 1F.
- [ ] Probar pérdida completa de VPS, configuración y credenciales recuperadas
      desde custodia separada, un solo consumidor y ausencia de retries ciegos.
- [ ] Conciliar pending/uncertain y solicitudes potencialmente ausentes del backup
      con evidencia externa. Fijar floor Telegram confiable y autorizar restore
      explícitamente; si no puede conciliarse, mantener el bloqueo.
      El floor durable del journal se aplica al flujo de agentes habilitado;
      el piloto inicial con agentes apagados no conecta ese journal y puede
      volver a recibir/responder diagnósticos antiguos. Revisar ese riesgo antes
      de aceptar tráfico; no presentar el floor como filtro universal del bot.
- [ ] Medir RPO desde la última copia externa verificada y RTO incluyendo revisión
      humana. Objetivos propuestos 24 h/4 h; las medidas locales sintéticas no los
      certifican en AWS.

## Aceptación y salida

- [ ] Pruebas locales de build, Compose, salud, reinicios, backup/restore y reglas
      aprobadas; evidencia AWS real mantenida como pendiente hasta ejecutarla.
- [ ] Primer acceso Telegram verificado con el operador, privacidad, permisos y
      límites. En el piloto inicial sin agentes, su conectividad y las métricas
      del Gateway son **no aplicables**. Una conexión a un agente independiente
      requiere habilitación, configuración y autorización separadas; Echo no se
      publica como servicio permanente.
- [ ] Medir RAM/CPU, disco/SQLite/WAL, reinicios, errores/timeouts, backup/integridad,
      conectividad Telegram y costo bruto/crédito con retención de evidencia
      acotada. No convertir métricas ausentes en ceros de éxito.
- [ ] Fecha de revisión y salida antes del vencimiento de crédito, máximo de costo
      y responsable de detener tráfico/migrar definidos. Revisiones orientativas
      a 30/14/7 días del vencimiento, sin scheduler implementado.
- [ ] Backup externo y restauración comprobados antes de eliminar originales.
      **Stop no termina el cobro** de Lightsail; eliminar instancia y remanentes
      solo tras autorización específica, inventario y aceptación de recuperación.
      [Facturación oficial](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html).
- [ ] Inventariar snapshots, discos, IPs y copias bloqueadas que sigan generando
      cargos; retención puede impedir borrado inmediato. Revisar Billing después
      del cierre y en el ciclo siguiente, sin prometer cero inmediato.

## Registro privado de aprobación final

Registrar responsable/fecha, release SHA e imagen/digest, región/blueprint/bundle,
fuentes SSH, política de egreso, destino y retención de backup, costo bruto/neto
máximo, créditos verificados/vencimiento, ventana y fecha de salida, responsables
de recuperación y lista exacta de recursos/acciones. Obtener una respuesta expresa
del operador sobre ese registro concreto. No copiar aquí firmas, cuentas o claves.

Una aprobación para consultar costos no autoriza creación. Una aprobación de VPS
no autoriza S3/B2, otros agentes, costos de IA, cambios de permisos o efectos de
negocio. Toda condición no resuelta conserva el estado **NO DESPLEGAR**.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12.
