# ADR 0001 — SQLite WAL para el estado durable local

Estado: decisión implementada en Fase 1E.1, sujeta a las verificaciones de
[entrega](../PHASE_1E1_VALIDATION.md). No autoriza efectos sensibles o despliegue.

## Contexto

Jarvis empieza como una instalación de un operador y un proceso modular en una
VPS prevista de 2 GB. Perder reservas al reiniciar puede convertir un reintento
en una nueva ejecución. El registro, permisos y secretos siguen siendo configuración
local del operador; esta decisión persiste estados mínimos del orquestador, sin
datos internos de Finance Agent u otros dominios.

## Decisión y comparación

Usar SQLite en archivo local con WAL, `synchronous=FULL`, transacciones explícitas
`BEGIN IMMEDIATE` y restricciones de unicidad. El adaptador implementa
[DurableStateStore](../../src/agents/state-store.ts), separado del Core y del wire
protocol. Se utiliza `node:sqlite` de Node 24, sin ORM, daemon o nuevas dependencias.
La implementación es síncrona: las transacciones son cortas y no abarcan esperas
de red. `busy_timeout` es 250 ms por defecto y se limita a 1000 ms; un lock o
fallo que impida confirmar una transición bloquea la operación.

| Alternativa | Ventaja en este contexto                                                                     | Costo o límite                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| SQLite WAL  | Base embebida, sin proceso servidor ni conexiones de red; transacciones y unicidad locales   | Un escritor por vez, filesystem local y llamadas síncronas; no aporta alta disponibilidad       |
| PostgreSQL  | Servidor transaccional adecuado para varios clientes/hosts y concurrencia de escritura mayor | Más operación: proceso, configuración, acceso, backups y recursos propios; no se despliega aquí |

La elección de menor complejidad es una inferencia del alcance, no un benchmark
de memoria o capacidad. Medir latencia de commits, espera de locks, tamaño WAL y
carga antes de ampliar. El puerto permite otro adaptador PostgreSQL en el futuro;
no basta traducir SQL: deben conservarse reservas, CAS, transiciones y pruebas.

Fuentes: [WAL de SQLite](https://sqlite.org/wal.html),
[synchronous](https://sqlite.org/pragma.html#pragma_synchronous) y
[WAL de PostgreSQL](https://www.postgresql.org/docs/current/wal-intro.html).
WAL permite lecturas concurrentes con escritura, pero requiere que los procesos
compartan host; no usar NFS o filesystem de red para el archivo.

## Compatibilidad y migraciones

Se comprobó localmente Node 24.22.1 con SQLite 3.53.4. La API `node:sqlite` tiene
estabilidad **1.2, release candidate** en la rama 24: no se presenta como API
estable y exige regresiones al actualizar Node.
[Documentación oficial Node 24](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

La migración [001_durable_state.sql](../../migrations/001_durable_state.sql) crea
tablas STRICT, claves únicas, estados permitidos, `application_id` y `user_version=1`.
Se aplica una sola vez durante inicialización explícita de archivo nuevo. Se
verifica checksum, versión, estructura y `quick_check` al abrir; no se reparan
tablas ni se ignoran versiones futuras ni se recrea historia automáticamente.
La carpeta `migrations/` debe distribuirse junto a `dist/` en la raíz del proyecto.

## Garantías locales

La reserva transaccional precede al transporte; la marca `started` se confirma
antes del envío. Un observador interno del Gateway persiste resultado o error
antes de entregar el estado al caller. Una reserva existente de otro arranque no
concede permiso para reejecutar, aunque no pueda probarse que alcanzó la red.
Concurrentes idénticos comparten operación lógica; comando distinto con la misma
clave produce conflicto. No hay exactly-once distribuido ni idempotencia de negocio.

No se almacenan inputs, outputs, mensajes, tokens o IDs Telegram en claro. Se
guardan hashes/HMAC, contexto opaco de protocolo, estados, timestamps y referencias
pending. El éxito conocido permanece como metadato: tras reiniciar, sin output
persistido, se devuelve `RESULT_EXPIRED/completed` sin ejecutar otra vez.

Los estados reserved/started recuperados se consideran inciertos. Pending conserva
su contexto y plazo original; no se restaura el mapa privado del transporte HTTPS
ni se hace polling remoto automático para reconstruir historia. Un fallo de
almacenamiento no habilita fallback a memoria cuando la DB está configurada.

## Retención y eliminación

Retener detalles terminales al menos siete días y conservar pending/inciertos.
La compactación explícita elimina contexto detallado de ejecuciones terminales
y auditoría antigua elegible, pero conserva clave, hash y estado de bloqueo.
Las acciones Telegram retienen sus claves/metadatos mínimos y pierden auditoría
antigua terminal elegible. No se expulsan tombstones para admitir nuevas acciones.
Esto limita el borrado: liberar totalmente una clave permitiría repetirla.

Hay cupos de registros y auditoría acotada por registro; al agotarse, fallar cerrado.
No existe limpieza programada, borrado completo o política de reinicialización
automática. Borrar o restaurar una DB antigua requiere conciliación y un plan
explícito; `state:init` no es un procedimiento de recuperación de historia perdida.

## Archivos, fallos y operación

El directorio debe existir y ser privado; archivo nuevo exclusivo con modo 0600
y directorio sin acceso de grupo/otros en POSIX. Se rechazan symlinks, hardlinks,
reemplazo del archivo abierto e inconsistencias de identidad. Se revisan también
sidecars WAL/SHM. En Windows, estos controles no sustituyen una ACL privada:
el operador debe verificarla. SQLite no cifra archivos; proteger disco, cuenta,
backups y claves por separado. No habilitar logging SQL con parámetros privados.

`FULL` solicita sincronización durable, pero depende del SO, filesystem y hardware.
Pruebas de cierre/caída de proceso no demuestran inmunidad a pérdida física,
fallos de disco o rollback de un backup. Un archivo ausente, corrupto o incompatible
se rechaza sin crear otro ni ejecutar efectos para reconstruirlo.

Se conserva el modo memoria en demos/adaptadores programáticos sin almacén, para
compatibilidad; **ese modo no tiene las garantías de este ADR**. El bot normal
exige `JARVIS_STATE_FILE` si se activan comandos de agentes: la apertura debe
funcionar antes del polling. Clave HMAC,
instancia, bindings y bot se vinculan por fingerprint; cambios requieren migración
administrada en vez de borrar la DB para ocultar el conflicto.

Backups coherentes, restauración y Docker Compose local son el siguiente corte,
Fase 1E.2. No copiar solo el archivo principal mientras WAL pueda contener commits
no checkpointados. No se implementan ni se certifican backups en este ADR.
Aplican [PRODUCT_RULES](../PRODUCT_RULES.md) ORC-02/03/05/06/07/08/11/12.
