# Validación Fase 1F — preparación del piloto Lightsail

## Prerrequisito y alcance

Se verificó el [PR #8](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/8)
fusionado el `2026-11-03T19:04:31Z`, commit
`fcbe50f2c59f3f1266a02f4b4ec609924d90af9d`. Se actualizó `main`, se comprobó
árbol limpio y se creó `feat/aws-lightsail-pilot-readiness`.

La entrega prepara un piloto, **sin desplegarlo**. No se accedió a AWS, Billing,
credenciales AWS o cuentas de backup, ni se crearon recursos, buckets, presupuestos
o gastos. Las consultas de precios son públicas y se citan en el
[plan](AWS_DEPLOYMENT_PLAN.md). Las reglas financieras, el Core, el protocolo,
dependencias y migraciones conservan su implementación anterior.

## Artefactos

- [Runbook](AWS_PILOT_RUNBOOK.md): Ubuntu 24.04 LTS, SSH, Docker, release e imagen
  concretos, egreso, secretos, arranque, actualización, incidentes y salida.
- [Checklist privado de autorización](AWS_PILOT_CHECKLIST.md): región, créditos,
  costos, permisos, backup fuera del host y aprobación expresa pendiente.
- [Compose piloto](../deploy/compose.pilot.yaml): configuración independiente de
  la demo, Jarvis sin puertos publicados, agentes apagados, sin Echo, secretos
  mínimos y mantenimiento sin red. Misma imagen y almacenamiento SQLite existentes.
- [Preflight](../deploy/pilot-preflight.mjs): exige ID local exacto `sha256`,
  verifica la imagen cargada y rechaza configuración incompatible. No despliega,
  no concede autorización ni prueba el firewall de Ubuntu.
- [Inspección](../deploy/pilot-inspect.mjs): campos Docker seleccionados, CPU/RAM,
  disco/SQLite/WAL, conteos de estado y agregados de eventos fijos. No emite
  entorno, credenciales, logs crudos o referencias de actor/solicitud.
- [Ensayo local](../deploy/pilot-check.mjs): proyecto aislado, secretos ficticios,
  Telegram simulado y red interna sin egreso público; arranque normal, límites,
  salud, reinicios, copia cifrada y recuperación bloqueada.

La primera etapa del piloto requiere solo `/start`, `/status` y fallback para el
operador autorizado; no conecta un agente de negocio ni publica Echo. El Gateway
HTTPS permanece disponible en el proyecto, con sus pruebas existentes. Habilitar
un agente independiente requiere otra configuración y autorización explícitas.

## Comandos de validación

Desde la raíz, Node 24.22.1 de la rama 24 y Docker local activo:

```powershell
npm.cmd ci
npm.cmd run format
npm.cmd run check
node --test tests/pilot-preflight.test.ts tests/pilot-inspect.test.ts
node deploy/pilot-check.mjs <directorio-padre-absoluto-privado-existente>
node deploy/setup-local.mjs <directorio-nuevo-absoluto-para-demo>
node deploy/compose-check.mjs <directorio-de-demo-del-comando-anterior>
```

El probe piloto crea su propio subdirectorio y proyecto. El probe anterior
requiere el material ficticio de `setup-local`. Ambos dejan los volúmenes para
inspección y detienen sus contenedores/redes, sin `down -v`. No arrancan el bot
real del operador. Las pruebas de CI siguen sin depender de Docker o AWS.

## Resultados

Entorno efectivo: Windows, Node **24.22.1**, SQLite **3.53.4**, npm **11.17.0**,
Docker Desktop/Engine **29.8.0** con contenedores Linux. Se utilizaron el Node
portable `.tools/package/bin/node.exe` y el CLI npm del sistema, con PATH local
del proceso; no se cambiaron versiones globales.

| Verificación                    | Resultado real                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm ci`                        | 102 paquetes auditados; cero vulnerabilidades conocidas                                                 |
| `npm run check`                 | **440/440**, sin fallos, omitidas o canceladas; formato, lint sin warnings, typecheck y build correctos |
| Regresión                       | Las **429 pruebas anteriores** y sus archivos permanecen intactos                                       |
| Nuevas                          | **11**: cuatro preflight, siete métricas/privacidad                                                     |
| Documentación                   | Seis pruebas de enlaces/anchors y preservación financiera correctas                                     |
| Compose piloto mínimo           | **11 escenarios locales correctos**, proyecto `jarvis-pilot-check-0f52c7c3c7d2`, **16.529 s**           |
| Compose anterior con Echo HTTPS | **12 escenarios correctos**, proyecto `jarvis-recovery-check-884bc9c989c0`, **37.003 s**                |
| AWS/Billing/backup externo      | **No ejecutados**: sin cuenta, recursos, gastos, upload o restauración remota                           |
| CI Windows/Linux                | Se verifica en el PR antes de la entrega; no se infiere del resultado local                             |

El piloto mínimo recorrió el entrypoint normal con Telegram simulado, allowlist y
chat privado; imagen fijada, secretos montados, ningún puerto público, salud,
inspección, backup/verify mientras estaba activo, SIGTERM/arranque,
SIGKILL/arranque y restauración bloqueada antes de cualquier llamada de API.
El Compose anterior repitió Telegram simulado → Core → Gateway → Echo HTTPS
independiente → Telegram simulado, ocho duplicados concurrentes, exclusión del
segundo consumidor y rollback de una copia con una acción frente a dos en el
original, con cero llamadas externas durante el bloqueo.

| Medición puntual       | Piloto mínimo                 | Regresión con Echo            |
| ---------------------- | ----------------------------- | ----------------------------- |
| Jarvis RAM / límite    | 27,76 MiB / 384 MiB           | 27,86 MiB / 384 MiB           |
| Jarvis CPU             | 1,37%                         | 0,15%                         |
| Echo RAM / CPU         | No existe en ese manifiesto   | 15,14 MiB / 0,00%             |
| DB / WAL en la lectura | 53.248 B / 0 B                | Inicial: 53.248 B / 135.992 B |
| Backup cifrado         | 53.529 B / 72 ms              | 53.529 B / 81 ms              |
| Restore aislado        | 69 ms, bloqueado, cero API    | 53 ms, bloqueado, cero API    |
| Reinicios automáticos  | 0; acciones de fallo manuales | 0; acciones de fallo manuales |

Los conteos cero de ejecución/acción en el piloto mínimo corresponden a agentes
apagados y journal no conectado, **no** a instrumentación de todas las entregas
Telegram. El estado Docker de salud todavía figuraba `starting` al tomar su
snapshot; el mismo probe de heartbeat ejecutado directamente pasó. Las cifras son
observaciones breves, sin representar memoria completa del host o carga sostenida.
La duración de restore es tiempo técnico local, no RTO humano o de pérdida de VPS.
La cuota de disco disponible pertenece a Docker Desktop, no al SSD Lightsail.

Dos builds con la receta/base fijadas y caché produjeron las mismas capas rootfs,
pero **IDs OCI distintos**: BuildKit volvió a emitir atestaciones de provenance.
No se desactivaron esas atestaciones ni se afirmó reproducibilidad binaria
independiente. Cada release debe registrar y verificar su ID cargado exacto;
un SHA de fuente o una etiqueta por sí solos no fijan el artefacto desplegado.

La primera pasada de lint encontró temporales `.local/` generados por el ensayo
y un import faltante/sobrante del script nuevo. Se excluyó ese directorio privado
de ESLint/Prettier y se corrigieron los imports, sin cambiar tests previos. El
primer ensayo rechazó el ID diferente del segundo build; se investigó y se
comprobó igualdad de capas con atestaciones distintas, conservando la restricción
de ID exacto del artefacto usado. La secuencia conjunta posterior pasó.

Logs locales ignorados: `.tools/phase1f-check.log`, `.tools/phase1f-pilot.log` y
`.tools/phase1f-compose-regression.log`. Los contenedores/redes de ensayo quedaron
detenidos y sus volúmenes se conservaron; no hubo limpieza de datos del operador.

La revisión del índice completo abarcó **144 archivos**, sin patrones de
credenciales reales, archivos SQLite, claves privadas o artefactos de backup
versionados. Se identificaron los dos canarios ficticios preexistentes. Se
comprobó `git diff --check` y ausencia de cambios en `src/`, migraciones, lockfile,
workflow y documentos financieros preservados. La revisión independiente de
seguridad no identificó bloqueadores en el alcance local; mantiene los pendientes
del host y la autorización que se detallan más abajo.

## Métricas y límites observables

`node deploy/pilot-inspect.mjs sir-jarvis-pilot` requiere permisos administrativos
locales de Docker y un único contenedor Jarvis del proyecto. Solo consulta el
proyecto indicado, no credenciales de proveedores. Su consulta SQLite usa
`readOnly: true`, `query_only=ON` y conteos; no ejecuta migraciones ni checkpoint.

El heartbeat mide vida/frescura local. Se renueva incluso durante backoff de
Telegram y **no prueba conectividad actual**. La prueba manual `/start` y `/status`
con allowlist/chat privado sigue siendo necesaria. Los eventos son una ventana
de hasta 60 minutos/1.000 líneas; no son contadores históricos ni distinguen todas
las causas de error. No se implementan latencias o contadores globales del Gateway
en esta fase; con agentes apagados su conectividad es no aplicable. Duración de
backup/restore y resultado de verificación provienen de los CLI existentes.
Billing, crédito aplicado y gasto neto necesitan revisión privada autorizada.

## Pendientes que impiden desplegar

1. Autorización expresa del operador con región, release/imagen, recursos y costo.
2. Verificación privada de saldo, elegibilidad, exclusiones, vencimientos y
   cotización: AWS Paid Plan y hasta USD 200 nominales no garantizan cobertura.
3. SSH, Ubuntu, Docker Engine, firewall IPv4/IPv6 y egreso del bridge comprobados
   realmente en el entorno objetivo. Compose no implementa allowlist de egreso.
4. Destino externo de backup aprobado, credenciales separadas, retención y
   descarga/restauración real verificadas. El procedimiento es diseño, no un
   bucket creado o un uploader integrado.
5. Medición representativa sobre los 2 GB: memoria del host/Docker, escritura,
   mantenimiento, disco, RPO y RTO con revisión humana. Los ensayos locales no
   prueban capacidad de Lightsail ni recuperación ante pérdida completa de AWS.

El journal durable está conectado al flujo de agentes habilitados. En este piloto
con agentes apagados, el bot comprueba el gate de recuperación pero conserva
deduplicación/offset de diagnósticos en memoria; puede responder de nuevo a un
diagnóstico tras reiniciar. El floor de autorización de restore no filtra ese
flujo. Conciliar y aceptar esa limitación antes de reabrir tráfico; no habilitar
efectos sensibles ni presentar estos controles como exactly-once distribuido.

## Siguiente prompt recomendado

> Continúa desde main solo tras verificar el merge de Fase 1F. Lee el runbook,
> checklist, reglas y validaciones. Prepara el registro concreto de autorización
> del piloto con región, blueprint, bundle, release SHA/imagen, USD 25 mensuales
> brutos de referencia, extras, plazo, egreso, secretos, backup externo y salida.
> Solicita por separado autorización para revisar Billing/créditos y para crear
> los recursos exactos; no deduzcas permisos de este prompt ni del plan anterior.
> Antes de cualquier creación, presenta evidencia y cotización revisables y espera
> aprobación expresa. Con ella, ejecuta únicamente las acciones autorizadas,
> registra costos y valida SSH/egreso, un consumidor, Telegram real y recuperación
> externa bloqueada hasta conciliación. Si falta una aprobación o condición,
> completa lo independiente y detén la acción dependiente. No habilites IA, agentes
> de negocio, escritura financiera, auto-merge o cambios de protección. Distingue
> pruebas AWS reales, simuladas y pendientes; abre PR sin fusionar.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12.
