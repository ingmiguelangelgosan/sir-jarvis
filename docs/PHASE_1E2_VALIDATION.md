# Validación Fase 1E.2 — Compose, backups y recuperación local

## Prerrequisito y alcance

Se verificó el PR [#7](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/7)
fusionado en `main`, con commit `d6ec97eef48d146dae28e3656a1dd0b986cedc63` y
`mergedAt=2026-11-03T18:01:16Z`. Se actualizó `main` y se creó la rama
`feat/local-compose-backup-recovery` con árbol limpio antes de implementar.

Fase 1E.2 añade ejecución y recuperación **locales**. Conserva Jarvis como monolito
modular, agentes independientes, HTTPS/JSON, SQLite WAL, Telegram opcional,
capacidades de lectura y perfil `no-paid-services`. No despliega AWS ni accede a
Billing, contrata servicios, habilita IA o añade dominios externos. Los contratos
de Registry/Gateway y las reglas financieras preservadas mantienen su alcance.

## Diseño verificable

- Imagen multietapa de Node 24 fijada; dependencias desde `npm ci`, runtime sin
  herramientas exclusivas de desarrollo y usuario sin privilegios.
- Compose local con Echo separado, secretos montados, TLS validado, autorización
  de IP privada exacta y protección SSRF conservada.
- Locks SQLite separados para exclusión de runtime/consumidor; no mantener el
  lock de proceso sobre la DB de estado ni usar TTL para relevar un proceso vivo.
- Backup coherente por la API SQLite, verificación, cifrado autenticado y claves
  separadas, publicación exclusiva y retención controlada.
- Restore exclusivamente en destino nuevo, con bloqueo dentro de la DB hasta
  conciliación y autorización del operador; reservas existentes no se liberan.

Procedimientos de operación en [LOCAL_DEPLOYMENT](LOCAL_DEPLOYMENT.md) y
[BACKUP_RESTORE](BACKUP_RESTORE.md). La persistencia previa se describe en el
[ADR SQLite](adr/0001-durable-state-sqlite.md) y la
[validación 1E.1](PHASE_1E1_VALIDATION.md).

## Resultados de ejecución

Entorno local: Windows con Docker Desktop y contenedores Linux; Node **24.22.1**,
SQLite **3.53.4**, npm **11.17.0**. Se conservaron los archivos de las **391 pruebas
anteriores**, sin modificarlos para adaptar expectativas. Los nuevos casos usan
claves generadas de prueba, Telegram simulado, archivos temporales y Echo local;
no token real, AWS, credenciales del operador o APIs comerciales.

| Verificación ejecutada                               | Resultado observado                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`, secuencia completa final            | **429/429**, formato, lint sin warnings, typecheck, pruebas y build correctos                                                              |
| `node --test tests/state-backup.test.ts`             | **14/14**, incluidos rollback/RPO-RTO, pérdida HTTPS posterior a aceptación y protección del heartbeat                                     |
| Documentación                                        | **6/6**: enlaces, anchors, hash e inclusión íntegra del snapshot financiero                                                                |
| Build Docker                                         | Ejecutado realmente con Node 24 fijado, runtime compilado y solo dependencias productivas                                                  |
| `node deploy/compose-check.mjs <directorio-privado>` | **12 escenarios correctos**, **42.695 s**, incluidos backup/verify en línea y restauración anterior bloqueada                              |
| CI Windows/Linux del push                            | Ambos checks correctos en [Actions 41693799909](https://github.com/ingmiguelangelgosan/sir-jarvis/actions/runs/41693799909) para `5a9e44e` |

También se ejecutaron `npm ci` (102 paquetes auditados, cero vulnerabilidades
conocidas), diagnóstico y entrada compilada. La revisión de los 135 archivos del
índice no encontró credenciales reales ni artefactos privados; identificó los dos
canarios ficticios deliberados de Telegram. No se modificaron el workflow, el
lockfile, las pruebas anteriores o los documentos financieros preservados.

## Publicación y revisión manual

La rama `feat/local-compose-backup-recovery` está publicada y el
[PR #8](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/8) está abierto hacia
`main`, sin merge ni auto-merge. El primer intento usó una cuenta de GitHub CLI
con permiso `READ` y fue rechazado. A petición del operador se activó la sesión
ya guardada de `ingmiguelangelgosan` mediante `gh auth switch`; se comprobó
`viewerPermission: ADMIN` y se creó el PR. No fue necesario iniciar otro flujo
en Chrome ni extraer credenciales. La descripción completa permanece en
`.tools/phase1e2-pr-body.md`. Comandos ejecutados:

```sh
gh auth switch --hostname github.com --user ingmiguelangelgosan
gh pr create --repo ingmiguelangelgosan/sir-jarvis --base main --head feat/local-compose-backup-recovery --title 'feat: contenedores locales y recuperación segura de SQLite' --body-file .tools/phase1e2-pr-body.md
```

El PR ejecuta nuevamente CI para el evento `pull_request`; sus resultados se
verifican antes de la entrega. Los checks de la tabla anterior corresponden al
primer `push` y se conservan como evidencia independiente. La revisión y el merge
quedan a cargo del propietario.

Las 391 pruebas previas permanecen independientes de los nuevos casos. La CI
habitual no necesita Docker, credenciales Telegram o AWS. Docker estaba instalado
pero su motor no estaba activo al iniciar; se arrancó y las verificaciones de
contenedores se ejecutaron realmente. No se marcaron como aprobadas por omisión.

Se añaden **38 pruebas**: 14 de backup/recuperación, 8 de seguridad, 7 de locks,
6 de secretos montados y 3 de setup/red Compose. Las seis pruebas documentales
forman parte de la suite conservada. No se reescriben casos anteriores ni se
requiere Docker en el check habitual.

Comandos desde la raíz, con Node 24.22.1+ de la rama 24:

```powershell
npm.cmd run format
npm.cmd run check
node --test tests/state-backup.test.ts tests/runtime-lock.test.ts tests/recovery-security.test.ts tests/file-secrets.test.ts tests/compose-config.test.ts
node deploy/setup-local.mjs <directorio-absoluto-nuevo-privado>
node deploy/compose-check.mjs <directorio-absoluto-privado-de-prueba>
```

El setup requiere que el padre exista y rechaza un destino ya creado. El probe de
Compose utiliza material ficticio y un proyecto con nombre único, sin arrancar
el bot del operador. Su cierre elimina contenedores/redes del proyecto de prueba
y **conserva los volúmenes**. Si hay otro demo con la misma subred fija, detenerlo
primero; no cambiar la política SSRF para resolver la colisión.

## Escenarios de recuperación comprobados

Las pruebas SQLite usan procesos y archivos reales para verificar cierre normal,
locks concurrentes, muerte forzada, crash en una transacción, backup durante
escrituras y recuperación del WAL. La suite previa conserva las fronteras de
caída antes/después de dispatch y confirmación, cancelación, duplicados y estados
inciertos del Gateway/Telegram.

Los casos nuevos verifican autenticación cifrada, copia válida/corrupta, versión
incompatible, permisos, falta de espacio simulada y limpieza de temporales,
retención explícita sin sobrescribir artefactos, restore aislado bloqueado,
autorización revisada y rechazo de consumidores concurrentes. Una prueba lee
directamente el archivo SQLite final publicado y confirma que incluye el marcador
de recuperación, evitando publicar únicamente un archivo principal cuyo bloqueo
todavía estuviera en WAL.

En el caso HTTPS, un servidor independiente recibe el POST y pierde la conexión
sin confirmar respuesta. El Gateway conserva incertidumbre; el backup/restore
mantiene la recuperación bloqueada y no vuelve a enviar para inferir el resultado.
La aceptación de la solicitud en el servidor no se confunde con finalización de
un efecto de negocio. Echo no implementa finanzas ni escritura comercial.

La prueba real entre contenedores recorrió Telegram simulado → Core → Gateway →
Echo HTTPS independiente → Telegram simulado. Ocho entradas concurrentes idénticas
produjeron una consulta y una entrega; reapertura y nuevo arranque tras caída
produjeron **cero** consultas/entregas nuevas para esa acción. También se probaron
`SIGTERM` y `SIGKILL` de Echo, el entrypoint normal de Telegram con API simulada,
health check y segundo consumidor. El duplicado terminó con código **1**, sin
timeout; `SIGTERM` terminó con **0** y `SIGKILL` con **137**, seguido de arranque
controlado. No se infiere exclusión por el hecho de que un proceso no responda.

La ejecución final usó el proyecto aislado
`jarvis-recovery-check-3e97d8e8f832`. Creó un backup mientras el bot simulado
seguía activo, lo verificó y confirmó otra acción lógica posterior. La copia
recuperada conservó una entrega; la DB original conservó dos. Arrancar el
entrypoint normal sobre la restauración terminó bloqueado, antes de cualquier
llamada a la API simulada; el contador fue **0**. Se conservaron intactos el
original y los volúmenes de prueba al cerrar, sin eliminación de volúmenes.

La comprobación dentro de la imagen final confirmó UID **1000**, dependencias
productivas limitadas a Zod, directorios de datos en modo **0700** y ausencia de
`src`, `tests`, `deploy`, TypeScript, ESLint y `@types` en el runtime. Los hooks
de prueba se montan solo en perfiles explícitos; no se distribuyen dentro de la
imagen operativa. El registro local de la última ejecución quedó en
`.tools/phase1e2-compose.log`, ignorado por Git.

## Recursos y tiempos medidos localmente

| Escenario                                                 | Medición real                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Recorrido inicial de contenedor                           | **127 ms**, DB **53 248 B**, WAL **135 992 B**, RSS del probe **79 347 712 B**                                              |
| Reapertura del mismo volumen                              | **32 ms**, cero reejecuciones o entregas                                                                                    |
| Reapertura tras `SIGKILL`/arranque                        | **35 ms**, cero reejecuciones o entregas                                                                                    |
| Snapshot con 4 000 registros y escritor en otro proceso   | Copia reportada de **549 146 B** en **91 ms**; restauración **69 ms**                                                       |
| Ensayo de rollback anterior a una operación conocida      | **1** operación conocida ausente en la copia; ventana RPO del ensayo **50 ms**                                              |
| Restauración técnica del ensayo de rollback               | **38 ms**                                                                                                                   |
| Restauración, revisión sintética y reanudación del ensayo | **61 ms**, RSS del proceso **98 680 832 B**; revisión del operador **simulada**                                             |
| Backup en línea entre contenedores                        | **53 529 B**, **37 ms** totales; intervalo de snapshot **18 ms**                                                            |
| Restauración aislada entre contenedores                   | **88 ms**, bloqueada; **1** acción conocida ausente respecto al original, **0** llamadas externas mientras estaba bloqueada |
| Snapshot Docker de Jarvis con API simulada                | **27.98 MiB / 384 MiB**, CPU **0.28%**, **8** procesos/hilos reportados por Docker                                          |
| Snapshot Docker de Echo                                   | **15.13 MiB / 128 MiB**, CPU **0.00%**, **8** procesos/hilos reportados por Docker                                          |
| Reinicios automáticos en el ensayo                        | **0**; los stop/start y kill/start fueron acciones explícitas del probe                                                     |
| Imagen Jarvis, tamaño no comprimido                       | **340 456 329 B**                                                                                                           |
| Imagen Echo, tamaño no comprimido                         | **330 401 681 B**                                                                                                           |

Las cifras de CPU/memoria son una observación breve durante una ráfaga de prueba,
no un benchmark sostenido. El probe no representa toda la memoria del host,
Docker Desktop o Windows. Los límites son 384 MiB para Jarvis y 128 MiB para Echo;
el servicio de mantenimiento tiene **768 MiB** por el procesamiento acotado de
copias de hasta 128 MiB. Revisar RSS real al aumentar el tamaño: no garantiza
capacidad suficiente en un futuro Lightsail de 2 GB.

Las dos imágenes comparten capas; **no sumar** sus tamaños no comprimidos como
ocupación efectiva del disco Docker. Incluir además volúmenes, capas de escritura,
backups y logs al dimensionar espacio real del host. Las medidas corresponden a
los escenarios explícitos, no a una carga sostenida o pérdida física del host.

La ventana RPO y el tiempo de 61 ms pertenecen a un ensayo sintético: se conoce
qué operación falta y la revisión se fabrica dentro de la prueba. **No son un
RTO de revisión humana**, no prueban recuperación de datos externos perdidos y no
se extrapolan a caída de AWS. Una restauración que permanece bloqueada todavía
no ha recuperado servicio externo. Los fallos de backup/restore se observan con
código de salida y mensaje fijo; no se añade un servicio comercial de métricas.

## Archivos de la entrega

- Contenedores: `Dockerfile`, `.dockerignore`, `compose.yaml` y `deploy/` con Echo
  independiente, material local de prueba, health check, smoke, prueba de fallos
  y overlay explícito de recuperación.
- Infraestructura: `state-backup.ts`, `runtime-lock.ts`, `file-secrets.ts` y
  extensiones controladas del adaptador `sqlite-state-store.ts`.
- Composición: CLI `backup-main.ts`, scripts `state:*`, arranque Telegram y
  comprobaciones de bloqueo en el almacén/Gateway; sin cambiar el wire protocol.
- Nuevas pruebas: `state-backup.test.ts`, `runtime-lock.test.ts`,
  `recovery-security.test.ts`, `file-secrets.test.ts` y `compose-config.test.ts`.
- Guías nuevas: este registro, [LOCAL_DEPLOYMENT](LOCAL_DEPLOYMENT.md) y
  [BACKUP_RESTORE](BACKUP_RESTORE.md). Se actualizaron README, índice documental,
  arquitectura, runtime, Telegram, roadmap, instrucciones Codex, estrategia y ADR.

No se modifican dependencias del lockfile, workflow de CI, snapshot/reglas
financieras ni protección de `main`. El PR se crea hacia `main` y se deja sin
merge ni auto-merge; su enlace y checks definitivos se registran en la entrega.

La consulta con la cuenta correcta confirmó la protección clásica de `main`:
PR obligatorio, checks `check (ubuntu-latest)` y `check (windows-latest)`, rama
actualizada (`strict: true`), administradores incluidos, cero aprobaciones y
force push/eliminación bloqueados. La lectura inicial con la otra cuenta había
respondido 404; el cambio de sesión permitió verificar los detalles sin modificar
las reglas.

## Riesgos y límites

Un backup íntegro puede ser anterior a efectos ya ejecutados. Sin un registro
externo independiente, SQLite no detecta toda la historia perdida. Toda
restauración bloquea nuevas ejecuciones hasta la decisión explícita del operador;
esa decisión no demuestra exactamente-una-vez ni elimina por sí sola el riesgo
de repetir una solicitud ausente de la copia.

No se guardan mensajes o outputs completos para reconstruir entregas. Una
respuesta puede perderse. Los locks son locales a host/directorio compartido;
no ofrecen exclusión distribuida. El cifrado de copias no cifra la DB activa y
Compose no cifra automáticamente los archivos secretos. ACL, custodia de claves,
disco y backups fuera del host requieren disciplina operativa.

Las mediciones de pruebas locales no acreditan RPO/RTO ante una caída completa
de AWS ni capacidad suficiente en Lightsail de 2 GB. No habilitan efectos sensibles.
Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12.

## Próximo incremento recomendado

Solo tras fusionar esta fase y resolver pendientes locales: preparar un piloto
AWS Lightsail sin ejecutar contratación o despliegue hasta la autorización
concreta. Revisar versión/digest, restauración y conciliación, custodia de claves,
registro externo de operaciones, métricas, RPO/RTO, egreso y TLS. Verificar Billing,
créditos, región, presupuesto y cotización antes de pedir aprobación de recursos.
Mantener lectura, `no-paid-services`, IA apagada y agentes de dominio externos.

Prompt recomendado:

> Continúa Sir Jarvis desde main actualizado solo después de verificar que el PR
> de Fase 1E.2 esté fusionado. Lee las instrucciones y validaciones vigentes.
> Prepara el piloto AWS Lightsail, conservando Node 24, Compose, HTTPS validado,
> lectura y no-paid-services. Repite localmente backup cifrado, restore aislado,
> bloqueo por rollback, conciliación y exclusión de consumidores. Resuelve los
> pendientes documentados antes de proponer recursos. Define imagen/digest,
> permisos, egreso, custodia de claves, copia fuera del host, alertas y un plan
> de operación con RPO/RTO y capacidad medidos. Prepara una cotización concreta
> y los pasos de revisión de Billing/créditos, sin acceder a la cuenta ni crear
> recursos todavía. Entrega los artefactos y un plan revisable antes de solicitar
> autorización de contratación o despliegue. No habilites IA, agentes de dominio,
> escrituras, servicios pagos, auto-merge ni cambios de protección. Abre PR y
> verifica CI Windows/Linux, sin fusionar.
