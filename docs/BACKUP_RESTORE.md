# Backups y recuperación local de Sir Jarvis

La copia y la restauración protegen el estado mínimo del orquestador: reservas,
claves/hash de idempotencia, estados, referencias pendientes, acciones Telegram,
offsets y auditoría. No incluyen las bases de dominio de agentes, los secretos ni
la configuración privada. Conservar esos materiales por separado y mantener la
clave HMAC, instancia y bindings originales.

Esta guía corresponde a Fase 1E.2, sin AWS, S3, servicios comerciales o efectos de
escritura de negocio. La [validación](PHASE_1E2_VALIDATION.md) distingue pruebas
ejecutadas de pendientes. Para preparar los contenedores y sus volúmenes, consultar
[LOCAL_DEPLOYMENT](LOCAL_DEPLOYMENT.md).

## Qué garantiza una copia

SQLite usa WAL: una copia aislada del archivo principal puede omitir transacciones
confirmadas todavía presentes en `-wal`. El procedimiento usa la API de backup de
`node:sqlite`, que obtiene una instantánea coherente a través de SQLite, y comprueba
integridad y compatibilidad antes de publicarla. No se usa una copia de archivos
del volumen activo como sustituto del backup.

La copia se cifra con AES-256-GCM y nonce aleatorio; la autenticación vincula el
contenido a sus metadatos versionados. La clave de backup se administra fuera del
directorio de copias y del volumen activo. No reutilizar el token Telegram, el
Bearer del agente o la clave HMAC de acciones como clave de backup. El cifrado de
la copia no cifra el archivo SQLite activo ni transforma los secretos de Compose
en un almacén cifrado.

Se crean archivos nuevos exclusivamente: no sobrescribir una copia válida para
publicar otra. Los temporales quedan en directorios privados y deben eliminarse
al terminar o fallar. Los límites de espacio y permisos se comprueban; una copia
fallida no se anuncia como válida. La retención se aplica solo a copias terminadas
del conjunto administrado, nunca a la DB activa ni a archivos arbitrarios.

## Comandos locales

Desde la raíz, después de `npm ci`, con directorios privados ya preparados:

```powershell
npm.cmd run state:backup -- .local/state/jarvis.sqlite .local/backups .local/keys/backup.key
npm.cmd run state:verify -- .local/backups/<archivo-backup> .local/keys/backup.key
npm.cmd run state:inspect -- .local/state/jarvis.sqlite
```

Reemplazar `<archivo-backup>` por el nombre devuelto al crear la copia. El destino
de copias debe estar fuera del volumen activo. La clave es un archivo privado con
32 bytes aleatorios codificados en base64url canónico sin padding: 43 caracteres,
con salto final opcional. No usar una frase memorizable ni almacenar su copia
junto a los backups. Los argumentos contienen rutas, nunca el valor de la clave.

Para aplicar una retención explícita, conservando por ejemplo las cinco copias
válidas más recientes del conjunto:

```powershell
npm.cmd run state:prune -- .local/backups .local/keys/backup.key 5
```

Esta limpieza es una operación administrada sobre las copias, no un scheduler.
Revisar destino y retención antes de ejecutarla; no usarla para borrar evidencia
de un incidente. No elimina estados pending/uncertain de la DB activa.

`state:inspect` muestra versión de esquema, estado de recuperación, conteos por
fase y listas acotadas de hasta 100 ejecuciones y 100 acciones con referencias
opacas para revisión local. No incluye mensajes, inputs, outputs, tokens o URLs.
Si indica truncamiento, completar la revisión administrada: la lista acotada no
es toda la historia. No pegar esa salida en conversaciones públicas.

El formato de copia es `1`, esquema `1`, y el nombre es `backup-<UUID>.jvb`.
Los metadatos autenticados incluyen inicio/fin del snapshot, tamaño y SHA256;
el tiempo del snapshot no demuestra completitud de efectos externos. El límite
de snapshot es 128 MiB y verificar/restaurar puede mantener varias copias
acotadas en memoria. Medir el máximo RSS con el tamaño real antes de aprobar
un host pequeño. No hay compresión ni streaming completo al descifrar.

## Restauración aislada y bloqueo obligatorio

La restauración crea un destino nuevo; no sustituye la DB del operador. Valida el
contenedor cifrado, la integridad SQLite, la versión de esquema y su estructura.
Antes de publicar el destino incorpora un marcador de recuperación en la propia
DB. El destino permanece **bloqueado para nuevas ejecuciones externas** hasta
conciliación y autorización explícita del operador.

El bloqueo no depende únicamente de una variable de entorno o un archivo lateral.
Se comprueba al arrancar el bot y antes de las transiciones que pueden habilitar
un efecto. Una restauración válida no autoriza por sí misma polling, llamadas a
agentes o entregas Telegram. La autorización requiere el identificador concreto
de restauración y una referencia verificable a la conciliación; queda auditada.

La exclusión del proceso Jarvis se implementa con un lock SQLite separado de la
DB de estado. El sistema operativo libera ese lock al morir el proceso, incluso
si no ejecutó su cierre ordenado. La autorización y las tareas que exigen parar
el runtime deben adquirir el mismo lock. No mantener la transacción de lock
abierta sobre la DB de estado: impediría su escritura y el backup concurrente.

## Procedimiento de restauración y conciliación

1. Detener el consumidor Jarvis de esta instalación. Conservar la DB original,
   sus sidecars y los registros autorizados de agentes; no sobrescribirlos.
2. Verificar la copia y restaurarla en un directorio nuevo, cuyo padre ya exista
   y sea privado:

   ```powershell
   npm.cmd run state:verify -- .local/backups/<archivo-backup> .local/keys/backup.key
   npm.cmd run state:restore -- .local/backups/<archivo-backup> .local/recovery/restore-01 .local/keys/backup.key
   npm.cmd run state:inspect -- .local/recovery/restore-01/state.sqlite
   ```

3. Registrar el identificador de restauración devuelto y los estados recuperados.
   Conciliar con fuentes independientes el intervalo entre el backup y el fallo,
   las operaciones pendientes/inciertas y las posibles entregas Telegram. No
   arrancar el bot para averiguar esos estados mediante reejecuciones.
4. Preparar un archivo JSON privado de revisión. Sustituir ambos hashes por los
   valores reales y el offset por el siguiente update autorizado, determinado
   con evidencia independiente. El número del ejemplo expresa el tipo, no un
   offset operativo recomendado:

   ```json
   {
     "restore_id": "<64 caracteres hex del identificador de restauración>",
     "external_evidence_sha256": "<SHA256 de la evidencia externa de conciliación>",
     "telegram_next_offset": 1,
     "decision": "allow-read-only",
     "pending_and_uncertain": "reviewed",
     "backup_rollback": "reviewed"
   }
   ```

5. Autorizar solo tras completar esa revisión y asumir explícitamente el riesgo
   residual de rollback:

   ```powershell
   npm.cmd run state:authorize -- .local/recovery/restore-01/state.sqlite <restore-id> .local/recovery/review.json --acknowledge-backup-rollback
   npm.cmd run state:inspect -- .local/recovery/restore-01/state.sqlite
   ```

6. Seleccionar administradamente la DB recuperada, conservando identidad, clave
   HMAC, permisos y bindings. Mantener los originales intactos y un solo consumidor.
   Reiniciar primero con capacidades de lectura y comprobar estado y logs seguros.

El piso de offset autorizado se aplica dentro del estado durable para descartar
updates anteriores a la revisión; no es un dato que deba adivinarse ni tomar de
una copia vieja. La revisión registra su hash, no el contenido privado completo.
No modifica ni resuelve automáticamente registros pending/uncertain. Restaurar
una copia de una DB ya autorizada vuelve a crear un bloqueo e identificador nuevos.

### Autorización desde Compose

Los backups y restauraciones viven en volúmenes separados del estado activo.
Con Jarvis detenido y una revisión JSON compacta privada de hasta 4096 bytes,
montarla en lectura en la ruta reservada:

```sh
docker compose --profile tools run --rm -v <ruta-absoluta-review>:/run/secrets/recovery_review:ro maintenance authorize /recovery/restore-01/state.sqlite <restore-id> /run/secrets/recovery_review --acknowledge-backup-rollback
docker compose --profile tools run --rm maintenance inspect /recovery/restore-01/state.sqlite
```

El montaje debe ser de solo lectura y el archivo regular, sin links. En Windows
proteger además el archivo fuente con ACL. El montaje no cifra el JSON ni valida
por sí mismo que la conciliación humana sea correcta. La aplicación registra el
SHA256 del archivo revisado y exige que su identificador coincida con el destino.
La selección del destino para reanudar se documenta en
[LOCAL_DEPLOYMENT](LOCAL_DEPLOYMENT.md); no se reemplaza la DB original.

## El rollback no se detecta solo con SQLite

Una copia anterior puede no contener una solicitud que el agente ejecutó después
del punto de backup. `integrity_check` confirma coherencia de la DB recuperada;
no demuestra que incluya toda la historia del mundo externo. Sin un registro
independiente, no se pueden descubrir todas las operaciones ausentes ni demostrar
que una petición desconocida nunca llegó al agente.

Por eso **toda restauración** comienza bloqueada, aunque no contenga registros
pending o uncertain. Comparar el punto de backup con la instalación original y
los registros autorizados de los agentes. Revisar también acciones Telegram y el
offset recuperado: Telegram puede volver a entregar actualizaciones posteriores
al backup que la copia no conoce. No reabrir tráfico únicamente porque el conteo
de operaciones inciertas sea cero.

Conciliar significa determinar el estado real de las operaciones conocidas,
documentar el intervalo perdido y decidir cómo impedir repeticiones de las que
no están en la copia. No borrar reservas, cambiar clave HMAC, reinicializar DB o
rotar la instancia para aparentar que una acción es nueva. Si no puede resolverse
la incertidumbre, mantener la instalación bloqueada. La autorización del operador
es una decisión explícita, no una prueba automática de que ya no existe riesgo.

## Estados que deben revisarse

| Estado                                | Interpretación conservadora                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `reserved` / `started`                | No demuestra ausencia de envío; no reejecutar automáticamente                 |
| `uncertain`                           | Requiere conciliación; timeout no prueba fallo remoto                         |
| `pending`                             | Conservar referencia y plazo original; no crear otra ejecución                |
| `completed`                           | Resultado conocido; output no persistido y no se reconstruye con otra llamada |
| `failed` / `not-started`              | Conservar clave y estado; una restauración no vuelve a liberarlos             |
| Entrega Telegram pendiente o iniciada | Puede haberse enviado; no reenviar automáticamente                            |

Las reservas y tombstones presentes conservan su protección tras restaurar. No
hay garantía de exactly-once entre Jarvis, Telegram y agentes independientes ni
idempotencia de negocio aportada por una DB local. Esta fase conserva únicamente
capacidades de lectura y perfil `no-paid-services`.

## Cómo medir RPO y RTO

Para un ensayo controlado, registrar el inicio/fin del snapshot, la hora del
incidente simulado, las claves ejecutadas antes y después de la copia, el tiempo
de restauración y el momento de autorización/reanudación. Comparar las claves
ausentes de la copia con la evidencia independiente del ensayo; un conteo cero
en la DB restaurada no demuestra RPO cero.

La ventana desde el inicio del snapshot hasta el incidente es una referencia
conservadora del intervalo que exige conciliación. La duración del comando
`restore` es tiempo técnico de restauración, **no el RTO completo**: faltan revisión
humana, conciliación, autorización y validación de tráfico. Si la instalación
sigue bloqueada, no declarar servicio recuperado ni medir RTO como si estuviera
operativa. Registrar ambos tiempos por separado y el tamaño/carga del ensayo.

Los resultados de [PHASE_1E2_VALIDATION](PHASE_1E2_VALIDATION.md) solo describen
sus escenarios locales. No extrapolarlos a pérdida física de disco, backups
fuera del host, indisponibilidad regional o caída completa de AWS.

## Pérdida de claves, permisos y soporte

Una clave de backup perdida impide recuperar su contenido. Una clave filtrada
exige investigar copias accesibles y planear rotación; no borrar evidencia para
resolver un incidente. Proteger la cuenta y el disco del host, las ACL en Windows
y los modos privados en Linux/WSL2. Docker Compose monta secretos en archivos;
no los cifra automáticamente.

No usar filesystem de red para SQLite WAL. No montar el socket Docker ni hacer
backups en el volumen activo como única copia. Una copia local en otro directorio
sigue expuesta a la pérdida del host: la replicación fuera del host, su cifrado,
retención y custodia de claves requieren un procedimiento adicional autorizado.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12.
