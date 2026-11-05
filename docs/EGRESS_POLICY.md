# Política de egreso del piloto — Fase 1G

Este procedimiento prepara controles versionados para el host del piloto. El
desarrollo de Fase 1G **no modifica la VPS**, no accede a AWS, no crea recursos y
no inicia el bot. La instalación y cada habilitación posterior son operaciones
explícitas del operador. Si una prueba no puede demostrar un control, conservar
el bloqueo y registrar el resultado como pendiente, nunca como PASS.

## Contexto y frontera de evidencia

El operador reportó como validados el 2026-11-05:

| Elemento            | Evidencia reportada                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| Host                | Ubuntu 24.04, Docker 29.9.3 y Compose v5.7.0                                                              |
| Firewall            | iptables-nft, backend Docker iptables y UFW activo                                                        |
| Red piloto          | `172.30.78.0/28`; Jarvis `172.30.78.2`                                                                    |
| Resolver del host   | `172.26.0.2`                                                                                              |
| Estado previo       | `DOCKER-USER` bloquea la subred                                                                           |
| Prueba HTTPS        | `api.telegram.org`, `149.154.166.110:443`, solo con una excepción temporal                                |
| Prueba negativa     | `1.1.1.1:443` efectivamente bloqueado                                                                     |
| DNS / IPv6          | DNS integrado funcional y sin ruta IPv6 en la red ensayada                                                |
| Persistencia previa | `jarvis-egress-deny.service`, instalado manualmente, restablece DROP después de reiniciar Docker y Ubuntu |

Esta tabla conserva el reporte del operador; no implica acceso del agente al
host ni prueba de las unidades nuevas. La dirección `149.154.166.110` es evidencia
histórica, **no una allowlist permanente**. Las pruebas locales y sus límites
figuran en [PHASE_1G_VALIDATION](PHASE_1G_VALIDATION.md).

## Diseño de las barreras

El manifiesto base del piloto también cambia a `restart: 'no'` y upstream DNS
`127.0.0.1`; no debe reenviar DNS mediante el host incluso antes de aplicar el
override. Ese manifiesto por sí solo no autoriza iniciar Jarvis ni sustituye el
gate: todas las sesiones operativas deben usar la unidad manual de esta guía.

La configuración de Fase 1F no filtra por sí sola el egreso. Fase 1G añade una
política específica para el piloto y conserva los controles de TLS, autorización
y SSRF del proyecto. El dominio aprobado es únicamente `api.telegram.org` y el
transporte permitido es HTTPS/TCP 443 hacia direcciones IPv4 públicas verificadas
por el procedimiento del host. No autoriza destinos de agentes externos.
La selección IPv4 es explícita: un registro AAAA no crea una excepción IPv6 ni
habilita fallback. El proceso de resolución debe dejar claro qué conjunto de
registros valida; no esconder una respuesta IPv4 privada dentro de una lista
que también contenga una dirección pública.

El resolver integrado de redes Docker personalizadas puede reenviar consultas
externas por rutas que no pasan por `DOCKER-USER`. Por eso permitir DNS arbitrario
al contenedor y filtrar solo su bridge no satisface la política. El bot usa
direcciones aprobadas por `/etc/hosts`, mantiene el nombre original para TLS y
no necesita DNS externo durante su ejecución. La configuración de DNS del
contenedor y las reglas dentro de su namespace deben verificarse antes de liberar
el proceso de Jarvis. El resolver `172.26.0.2` pertenece al procedimiento de
resolución del **host**, no a una excepción de DNS para el bot.

Docker documenta el DNS integrado, la semántica del upstream loopback y la
configuración de hosts en [Networking](https://docs.docker.com/engine/network/).
Las cadenas de DNS del namespace y la precedencia de `DOCKER-USER` se describen
en [Docker con iptables](https://docs.docker.com/engine/network/firewall-iptables/).

La barrera de host debe negar el resto de la subred, tráfico al propio host y
metadata/link-local/destinos privados no aprobados. No modificar reglas SSH, las
políticas globales de INPUT/FORWARD/OUTPUT o las cadenas administradas por UFW.
Las excepciones HTTPS deben ser más específicas que el bloqueo de la subred;
el final de la política sigue siendo DROP. No usar un ACCEPT general de
ESTABLISHED que conserve conexiones hacia destinos retirados de la allowlist.

IPv6 necesita una barrera explícita además de `enable_ipv6: false`: la ausencia
de una ruta durante una prueba no garantiza que no aparezca otra. La liberación
del proceso exige comprobar la configuración y el bloqueo de su namespace. No
habilitar una salida IPv6 para resolver un fallo de conectividad IPv4.

## Integración con el bloqueo instalado

Antes de instalar o cambiar unidades, abrir una segunda sesión SSH verificada
y mantener la sesión actual. El objetivo es conservar la denegación existente
durante toda la transición. Revisar privadamente:

```sh
sudo systemctl status jarvis-egress-deny.service --no-pager
sudo systemctl cat jarvis-egress-deny.service
sudo systemctl cat docker.service
sudo systemctl list-dependencies docker.service
sudo iptables --version
sudo iptables -S DOCKER-USER
sudo iptables -S INPUT
sudo ufw status verbose
docker version
docker compose version
```

No publicar esos inventarios completos: pueden contener rutas, usuarios y
configuración administrativa. Examinar los `ExecStart`, `ExecStop`, dependencias
y drop-ins reales del servicio manual antes de elegir la integración. Esta fase
no conoce sus bytes y **no autoriza sobrescribirlos**. Si ejecuta un flush global,
elimina reglas ajenas o su orden compite con el nuevo mecanismo, detenerse y
preparar una adaptación revisada; no deshabilitarlo a ciegas.

Registrar las reglas y la versión previa en un expediente privado. Revisar
que la subred no colisione con otra instalación y que ningún consumidor del bot
esté activo. No hacer pruebas de caída sobre mensajes reales o secretos.

## Procedimiento operativo

El CLI privilegiado de la release es:

```sh
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs deny
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs candidate
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs approve --sha256 <huella-exacta-revisada>
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs stop
```

Las comparaciones de `iptables -S`/`iptables-save` interpretan argumentos con
comillas y escapes mediante `deploy/egress/iptables.mjs`, sin evaluar un shell.
El contenido de comentarios permanece literal; solo se normalizan `/32` en
operandos de dirección y el módulo TCP redundante. `deny` repetido conserva una
sola copia de cada hook propio, primera en su cadena, y elimina duplicados
anteriores sin vaciar cadenas globales. Ejecutar las operaciones administrativas
secuencialmente, sin cambios concurrentes del firewall: `-w` protege cada comando,
no toda la secuencia de inspección y eliminación por índice. Esto no ofrece
coordinación con otros administradores que editen reglas simultáneamente.

`candidate` propone, `approve` registra el manifiesto concreto y **ninguno inicia
el bot o abre tráfico**. `deny`/`stop` revocan el permiso y vacían los conjuntos
privados de destinos; no vacían cadenas globales. `start` es una operación manual
utilizada por la unidad del bot, que mantiene el supervisor en primer plano;
no es un comando de instalación o de renovación automática.
`verify` comprueba una sesión activa, con la identidad de su namespace; antes
de crear esa sesión, la comprobación de denegación es la inspección de reglas
y las pruebas negativas de esta guía, no un supuesto PASS de `verify`.

Al iniciar una nueva propuesta o aprobación se elimina la aprobación anterior:
un fallo de DNS, TLS o revisión no permite volver a abrir tráfico usando una
aprobación vieja todavía dentro de su plazo. Resolver la causa y revisar otra
propuesta; no restaurar `approved.json` desde una copia.

La configuración privada de root se ubica en `/etc/jarvis-egress/config.json`:

```json
{
  "version": 1,
  "project": "sir-jarvis-pilot",
  "releaseDirectory": "/opt/sir-jarvis",
  "image": "sha256:<64-hex-del-ID-local-revisado>",
  "privateDirectory": "/srv/jarvis-pilot/private"
}
```

El valor ilustrativo de `image` debe reemplazarse por el ID completo obtenido y
verificado según el [runbook](AWS_PILOT_RUNBOOK.md#release-e-imagen-concretos).
No es una referencia válida de despliegue. La configuración contiene rutas e
identidad de release, no tokens. Candidato y aprobación viven en
`/etc/jarvis-egress/candidate.json` y `approved.json`, archivos root 0600 en un
directorio privado. No editarlos para extender un vencimiento; generar y revisar
un candidato nuevo. La huella debe corresponder a los bytes/datos del candidato
que el CLI acepta, no a un archivo distinto ni a una IP histórica.

La release necesita Node 24.22.1+ de la rama 24, herramientas iptables-nft,
ip6tables, `nsenter` e **ipset con soporte `xt_set` y timeout en kernel**. No
añadir capabilities al contenedor para instalar reglas: la administración del
namespace la realiza el host. Confirmar la disponibilidad de las herramientas
antes de iniciar la instalación; instalar paquetes exige una operación aprobada
del operador, no una descarga ejecutada por el bot.
Revisar también el reloj/NTP del host: los timestamps de revisión usan UTC;
las entradas ipset usan un plazo relativo del kernel. Una hora incoherente no
justifica ampliar una aprobación ni reutilizar un manifiesto expirado.

### Instalación que ejecuta el operador

Partir de la release aprobada y fijada por SHA, instalada en `/opt/sir-jarvis`
según el [runbook](AWS_PILOT_RUNBOOK.md#release-e-imagen-concretos). Todo el árbol
de scripts que ejecuta root y sus directorios deben pertenecer a root y no ser
escribibles por grupo/otros. No ejecutar código privilegiado desde un checkout
editable por el usuario del contenedor. Registrar hashes de `host.mjs`,
`policy.mjs`, `iptables.mjs`, `gate.mjs`, Compose y las unidades. El sistema no descarga ni
instala estos archivos por sí solo.

Con Jarvis detenido y después de inspeccionar el servicio manual:

```sh
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs deny
sudo iptables -S DOCKER-USER
sudo iptables -S INPUT
sudo install -d -o root -g root -m 0700 /etc/jarvis-egress
sudo test ! -e /etc/jarvis-egress/config.json && sudo install -o root -g root -m 0600 /opt/sir-jarvis/deploy/egress/config.example.json /etc/jarvis-egress/config.json
sudoedit /etc/jarvis-egress/config.json
```

El comando `install` de configuración es para una instalación nueva: **si ya
existe `config.json`, no sobrescribirlo**. Comparar la release, conservar la
versión privada anterior y editarla de forma revisada. Rellenar el ID real de
imagen y las rutas verificadas; el ejemplo deliberadamente no es ejecutable con
su valor de imagen ilustrativo. Node debe estar disponible en `/usr/bin/node`
con la versión exigida. Si ese binario o las rutas no son los del host revisado,
adaptar la release y las unidades mediante revisión, no un alias de shell.

Los archivos versionados son:

- [jarvis-egress-policy.service](../deploy/egress/systemd/jarvis-egress-policy.service):
  baseline de denegación al boot, ordenada después de Docker y del servicio manual.
- [docker-egress.conf](../deploy/egress/systemd/docker-egress.conf): hooks
  `ExecStartPre`/`ExecStartPost` que únicamente deniegan y revocan permisos.
- [jarvis-pilot.service](../deploy/egress/systemd/jarvis-pilot.service): sesión
  manual con lock, supervisor y cierre denegado; no tiene sección `[Install]`.

No instalar un drop-in que reemplace los `ExecStart` existentes de Docker. El
archivo añade hooks, sin vaciar listas previas. Si el servicio manual modifica
estas mismas cadenas o tiene una dependencia incompatible, la integración queda
bloqueada hasta revisar el orden real. La regla propia permitida usa ACCEPT solo
para TCP 443 a las IPs temporales aprobadas; eso omite el DROP legado que quede
después. Un DROP legado reinsertado por delante debe cerrar la sesión en vez de
eliminarse automáticamente para recuperar conectividad.

Instalación de unidades nuevas, después de confirmar que los destinos no
contienen versiones anteriores o personalizaciones que haya que preservar:

```sh
sudo install -d -o root -g root -m 0755 /etc/systemd/system/docker.service.d
sudo test ! -e /etc/systemd/system/jarvis-egress-policy.service && sudo install -o root -g root -m 0644 /opt/sir-jarvis/deploy/egress/systemd/jarvis-egress-policy.service /etc/systemd/system/jarvis-egress-policy.service
sudo test ! -e /etc/systemd/system/jarvis-pilot.service && sudo install -o root -g root -m 0644 /opt/sir-jarvis/deploy/egress/systemd/jarvis-pilot.service /etc/systemd/system/jarvis-pilot.service
sudo test ! -e /etc/systemd/system/docker.service.d/50-jarvis-egress.conf && sudo install -o root -g root -m 0644 /opt/sir-jarvis/deploy/egress/systemd/docker-egress.conf /etc/systemd/system/docker.service.d/50-jarvis-egress.conf
sudo systemd-analyze verify /etc/systemd/system/jarvis-egress-policy.service /etc/systemd/system/jarvis-pilot.service
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-egress-policy.service
sudo systemctl is-active jarvis-egress-deny.service jarvis-egress-policy.service
sudo systemctl cat docker.service
sudo systemctl is-enabled jarvis-pilot.service
```

El servicio manual se conserva habilitado. Solo se habilita la unidad de
denegación; **no ejecutar `systemctl enable jarvis-pilot.service`**, añadir un
`WantedBy` o crear otro supervisor que arranque el bot. Revisar que la unidad
manual sea estática, no esté activa y no sea arrastrada por dependencias ajenas.
`daemon-reload` no reemplaza la prueba de reinicio Docker/Ubuntu posterior.
Si Docker estuviera detenido, activar la unidad de denegación puede arrancar
su dependencia Docker: revisar ese estado antes de ejecutar el bloque.

### Generar, revisar y habilitar una sesión

El flujo obligatorio es:

1. Instalar una release revisada de scripts/unidades y configuración privada con
   propietario root, sin permitir que el usuario del contenedor reescriba los
   controles. Verificar hash e imagen exacta antes de usar scripts privilegiados.
2. Aplicar y verificar denegación específica conservando el servicio manual.
   Instalar la precedencia sobre Docker/arranque sin habilitar el bot al boot.
3. Con Jarvis detenido, resolver desde el host con el resolver aprobado. Validar
   todas las respuestas, su carácter público y TLS para `api.telegram.org` antes
   de proponer una lista acotada. Una resolución vacía, inconsistente o fallida
   no permite conservar una excepción indefinida ni abrir DNS/Internet general.
   Se aceptan hasta ocho direcciones A y la vigencia se limita al menor plazo
   resultante del DNS y **900 segundos**. Cada dirección se valida mediante TLS
   con el nombre `api.telegram.org`. La aprobación vuelve a resolver y comprobar
   TLS; una diferencia con el candidato exige una propuesta nueva.
   El plazo se calcula desde la recepción DNS, antes de las comprobaciones TLS:
   la verificación no renueva ni prolonga el TTL recibido. Para `/etc/hosts` se
   fija únicamente la primera IPv4 validada del orden normalizado; la lista
   completa aprobada limita los conjuntos del firewall. No se presupone que un
   mapa Compose acepte varios valores del mismo hostname ni se habilita un
   fallback DNS si esa primera dirección deja de estar disponible.
4. Revisar el candidato y aprobar su manifiesto concreto, con huella, plazo y
   direcciones. No aprobar solo un nombre de archivo que pueda cambiar después.
5. Crear/iniciar únicamente el contenedor de espera, verificar su identidad,
   red, dirección, configuración de DNS y namespace. Aplicar y comprobar las
   barreras de DNS e IPv6 antes de liberar el proceso de Jarvis.
6. Probar HTTPS positivo sin token y negativos hacia destinos no aprobados,
   metadata/link-local, DNS integrado/directo e IPv6. Un fallo mantiene DROP.
7. Liberar Jarvis solamente mediante la acción manual documentada, después de
   superar los controles. No equivale a habilitar una unidad en el arranque.
8. Al vencer la autorización, fallar una comprobación, cambiar el namespace o
   reiniciar Docker/Ubuntu, revocar permiso y restablecer la denegación. El
   watchdog no convierte direcciones nuevas en autorizadas ni vuelve a iniciar
   el bot. Renovar exige una revisión y habilitación nuevas.

Comandos de una sesión manual, ejecutados por el operador después de que la
instalación de denegación haya quedado verificada:

```sh
sudo systemctl stop jarvis-pilot.service
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs deny
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs candidate
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs approve --sha256 <sha256-devuelto-y-revisado>
sudo systemctl start jarvis-pilot.service
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs verify
sudo systemctl status jarvis-pilot.service --no-pager
```

La salida de `candidate` es JSON con `candidate`, `sha256`, estado de tráfico
denegado y revisión requerida. Revisar hostname, resolver, todas las direcciones,
`createdAt`/`expiresAt` y la huella antes de pasarla a `approve`. Si faltó tiempo
para la revisión o cambió DNS, crear otro candidato; no editar el plazo. El
operador debe ejecutar el `start` para cada sesión aprobada. El repositorio no
ejecuta ese bloque ni el bot se libera por haber instalado unidades.

`start` verifica la plataforma esperada —Ubuntu 24.04, Docker 29.9.3, Compose
5.7.0, iptables-nft, UFW activo y live restore deshabilitado— antes de continuar.
Otra versión o configuración queda bloqueada para una revisión específica,
incluida una futura actualización de Docker. El contenedor usa `restart: no`.
También exige que el backend de firewall informado por Docker sea `iptables` y
que el primer salto de FORWARD sea el paso a `DOCKER-USER`. Si el host presenta
otro orden, no lo reordena a ciegas ni mueve reglas globales de UFW: conserva
denegación y requiere una revisión específica.
No activar Docker live restore: la política de identidad y arranque fue diseñada
para que Docker detenido retire su consumidor y cualquier permiso de namespace.

Los permisos de IP existen también como entradas temporales en ipset, tanto en
el host como en el namespace. El kernel deja de reconocerlas al expirar; el
watchdog revoca el permiso del proceso y vuelve a denegación. No se depende solo
de que una tarea de limpieza de usuarios llegue a ejecutarse. El ensayo debe
probar también una conexión ya establecida: no permitir un ACCEPT general de
conntrack que sobreviva a la retirada o caducidad del destino.

## Verificación y fallos

La verificación requiere evidencia de reglas y tráfico real, sin token Telegram:

| Prueba                                                   | Resultado requerido                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| HTTPS al nombre aprobado con una IP del manifiesto       | TLS válido y conexión por TCP 443                                      |
| HTTPS a `1.1.1.1` u otro destino no aprobado             | Bloqueo atribuible a la política, no solo a un fallo remoto            |
| Metadata/link-local y destinos privados no aprobados     | Bloqueo                                                                |
| Consulta DNS por UDP y TCP a `127.0.0.11`                | Sin salida externa; la barrera del namespace debe demostrar denegación |
| DNS directo al resolver del host y a un resolver público | Bloqueo desde el contenedor                                            |
| IPv6 hacia destino externo                               | Bloqueo o ausencia de ruta comprobada junto con la barrera explícita   |
| Falla DNS, nueva IP no revisada o manifiesto expirado    | Denegación; bot sin liberar                                            |
| Segunda aplicación de reglas                             | Misma política efectiva, sin reglas duplicadas ni cambios SSH/UFW      |
| Docker restart / Ubuntu reboot                           | DROP restaurado antes del bot; bot permanece sin arranque automático   |
| Cambio de IP, de contenedor o de namespace               | Permiso anterior inválido; nueva comprobación obligatoria              |

Guardar únicamente IDs opacos de prueba, huellas de política, timestamps y
resultados agregados. No usar URLs de la Bot API con token ni archivar cuerpos
de conversación, certificados privados o el entorno del proceso. La verificación
positiva de TLS sin token no prueba recepción de mensajes del bot.
Para metadata/link-local, comprobar solo la conexión TCP sin enviar una petición
HTTP o leer cuerpos. Si una regla falla, la prueba tampoco debe recolectar datos
de identidad o credenciales del endpoint.

Una negativa requiere diferenciar timeout de red de denegación por reglas:
correlacionar contadores o trazas del laboratorio/host revisadas. No convertir
un timeout en evidencia suficiente de bloqueo ni reintentar operaciones de
negocio inciertas para medir conectividad.

## Actualización y rollback

Para una actualización de direcciones o versión, detener la ruta del bot,
restablecer denegación y revisar un candidato nuevo. No ampliar la lista
automáticamente después de un error DNS/TLS. Un cambio de IP verificado no
concede autorización para otra región, endpoint, puerto o agente.

Rollback significa volver a **denegación**, no volver a una IP histórica.

Para cerrar una sesión sin quitar las barreras:

```sh
sudo systemctl stop jarvis-pilot.service
sudo /usr/bin/node /opt/sir-jarvis/deploy/egress/host.mjs deny
sudo iptables -S DOCKER-USER
sudo systemctl is-active jarvis-egress-deny.service jarvis-egress-policy.service
```

No reiniciar el bot como parte del rollback. Si la release nueva no funciona,
conservar estas reglas DROP y el servicio manual mientras se revisa una corrección.
Detener la unidad del bot, revocar cualquier permiso del proceso de espera y
comprobar DROP. Mantener el servicio manual y el firewall del host. Retirar
solamente reglas/drop-ins/unidades de esta release que se hayan identificado
por nombre y propietario; no usar `iptables -F`, `iptables-restore` de un dump
global, `ufw reset`, un cambio global de política o `docker compose down -v`.

Si no se puede demostrar precedencia, DNS, IPv6, caducidad o convivencia con
`jarvis-egress-deny.service`, conservar el estado **DESPLIEGUE BLOQUEADO** y
documentar la condición. Un operador con root o acceso al socket Docker puede
cambiar estas barreras; no se ofrece aislamiento frente al administrador del
host. Los locks y el journal conservan sus límites de Fase 1F: con agentes
apagados, los diagnósticos aún pueden responder de nuevo después de reiniciar.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/07/08/11/12.
