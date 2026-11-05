# Validación Fase 1G — política de egreso del piloto

## Prerrequisito y alcance

Se verificó el [PR #9](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/9)
fusionado en `main` el `2026-11-03T21:58:51Z`, commit
`765b697b27beac5f6966cb685902d882a327590b`. Se actualizó `main`, se comprobó
el estado local y se creó `feat/pilot-egress-policy` antes de implementar.

La fase prepara scripts operativos, unidades, comprobaciones y documentación.
**No se accede ni modifica la VPS**, no se crean recursos AWS, no se consulta
Billing y no se habilita el bot ni agentes externos. Se conservan el Core,
contrato, perfil `no-paid-services` y reglas financieras preservadas.

## Evidencia reportada por el operador

El 2026-11-05 el operador confirmó Ubuntu 24.04, Docker 29.9.3, Compose v5.7.0,
iptables-nft con backend Docker iptables, UFW activo, red `172.30.78.0/28`, Jarvis
`172.30.78.2` y resolver host `172.26.0.2`. La cadena `DOCKER-USER` bloquea esa
subred; se comprobó HTTPS a `api.telegram.org` en `149.154.166.110:443` únicamente
con una excepción temporal y bloqueo efectivo a `1.1.1.1:443`. DNS integrado
funcionaba y no había ruta IPv6 en la red ensayada. El servicio manual
`jarvis-egress-deny.service` restaura DROP tras reiniciar Docker y Ubuntu.

Ese reporte acredita el punto de partida; **no prueba la instalación de los
artefactos nuevos** ni autoriza reutilizar la IP como permanente. Los detalles
de integración y el procedimiento del operador están en
[EGRESS_POLICY](EGRESS_POLICY.md).

## Resultados de la implementación

Se ejecutó en Windows con Node **24.22.1**, Docker Desktop **29.8.0** y kernel
WSL2 **6.18.33.2-microsoft-standard-WSL2**. El laboratorio usa Ubuntu **24.04**,
iptables **1.8.10 (nf_tables)**, Node **24.22.1** y systemd **255**; la diferencia
frente a Docker 29.9.3/Compose 5.7.0 del host objetivo no se oculta.

| Comprobación                        | Resultado real                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run check`                     | **459/459**; formato, lint, typecheck, pruebas y build correctos, sin omitidas o canceladas    |
| Regresión                           | Los archivos de las **440 pruebas anteriores** permanecen intactos                             |
| Nuevas unitarias                    | **12** validación/política y **7** fallos del CLI en procesos simulados                        |
| Documentación                       | Seis pruebas de enlaces/anchors y conservación financiera correctas                            |
| Kernel Linux aislado                | **12 escenarios**, dos boots del contenedor, **79.236 s**                                      |
| Gate y unidades                     | **4 escenarios**, **4.774 s**; proceso hijo ficticio, nunca el bot real                        |
| Regresión Compose mínimo            | **11 escenarios**, **11.721 s**, con Telegram simulado y nuevo DNS/restart del manifiesto base |
| VPS, Docker/Ubuntu restart del host | **No ejecutados**; instalación/aceptación pendientes del operador                              |
| CI Windows/Linux                    | Se verifica en el PR, sin inferir éxito de las pruebas locales                                 |

El laboratorio `jarvis-egress-lab-27e1a90fa87b` ejecutó el plan generado por
`deploy/egress/policy.mjs` sobre iptables/ipset reales en namespaces privados.
Direcciones con apariencia pública se asignaron solo a peers internos del lab;
no hubo consultas a Telegram/AWS o conexiones HTTPS públicas. Se verificó:

- TLS positivo contra un servidor local con CA efímera y nombre `api.telegram.org`.
- DROP previo, permiso exclusivo HTTPS, otros orígenes de la subred bloqueados,
  metadata/link-local/destinos no aprobados y puerto incorrecto bloqueados.
- Cadenas SSH/UFW simuladas del router de prueba y tráfico ajeno a la subred
  intactos; tres aplicaciones de la política sin vaciar cadenas globales.
- `raw OUTPUT` antes del DNAT del resolver Docker, bloqueo IPv6 incluso de una
  ruta loopback que era alcanzable antes de la barrera.
- Timeout de ipset tanto en host como namespace, cada uno cortando una conexión
  HTTPS ya establecida sin depender de un watchdog.
- DNS integrado: **2 consultas** observadas antes de la barrera, **0** después;
  se probaron UDP/TCP integrado y directo al fixture DNS local.
- Reinicio real del contenedor del laboratorio: namespace nuevo y reaplicación
  completa, sin reutilizar excepciones del arranque anterior.

El laboratorio privilegiado tiene PID/red/montajes privados, no usa host network,
host PID, socket Docker ni credenciales del operador. El runner solo acepta un
Docker local (`unix`/`npipe`), no un daemon remoto. No cambia el firewall del host.
Los contenedores y red creados por él se eliminan por sus nombres únicos al cerrar.

El laboratorio de controles usa contenedores **sin capabilities**, sin red y sin
un bot real. Confirmó que un challenge anterior no libera el hijo ficticio, que
la caducidad y la eliminación del permiso lo detienen sin reintento, y que
`systemd-analyze verify` acepta las unidades/drop-in en systemd 255. Las unidades
Docker/legacy de esa comprobación son stubs de dependencia: no prueba la
integración con los bytes del servicio real ni un arranque completo del host.

La primera comprobación conjunta detectó imports de timers faltantes y una
intercepción de archivos del test simulado que también bloqueaba lecturas del
loader de Node. Se corrigieron el import y el aislamiento de los mocks; las
pruebas anteriores no se modificaron. El test del gate usa publicación atómica
del permiso, igual que la operación, para escribir sobre un permiso previo 0444
sin conceder capabilities al contenedor.

## Repetir la evidencia local

También se ejecutó `npm ci`: 102 paquetes auditados y cero vulnerabilidades
conocidas. La revisión de los **162 archivos del índice** no detectó credenciales
reales o artefactos privados versionados; los canarios de Telegram preexistentes
están identificados. Se comprobó ausencia de cambios en Core, protocolo,
migraciones, dependencias, workflow y snapshot financiero. Solo se modificaron
artefactos operativos, el manifiesto del piloto y documentación.

Desde la raíz con Node 24 y Docker local:

```sh
npm ci
npm run check
node --test tests/egress-policy.test.ts tests/egress-host.test.ts
node tests/egress-kernel-lab.mjs
```

El último comando publica su nombre de proyecto/imagen local en el reporte.
Para validar también gate/unidades con esa imagen, resolver su ID local y pasar
el ID, no una referencia remota:

```powershell
$egressLabImage = docker image inspect sir-jarvis-egress-lab:<proyecto-devuelto> --format '{{.Id}}'
node tests/egress-control-lab.mjs $egressLabImage
```

Los logs efectivos locales están ignorados en `.tools/phase1g-check.log`,
`.tools/phase1g-kernel-lab.log`, `.tools/phase1g-control-lab.log` y
`.tools/phase1g-pilot-regression.log`.

La regresión del Compose de Fase 1F pasó con `restart: 'no'` y upstream DNS
loopback: arranque simulado, allowlist/chat privado, backup activo, reinicios y
restauración bloqueada, sin llamadas AWS. Observación breve: Jarvis 28,07 MiB,
backup 53.529 B / 43 ms y restore bloqueado 46 ms. Ese ensayo no instala la
política del host ni acredita el egreso de la VPS.

## Condiciones de aceptación en Lightsail

El operador debe repetir en su host la instalación conservando el servicio
manual, la precedencia de firewall, DNS e IPv6, cambios de IP, caducidad, pruebas
positivas/negativas, Docker restart y Ubuntu reboot. Estas acciones no se ejecutan
desde la sesión de desarrollo. No basta que una unidad pase validación sintáctica
o que un test de comandos simule iptables.

Si falla una resolución o validación TLS, cambia la identidad del namespace,
vence el permiso o no se puede demostrar el orden de arranque, mantener DROP y
el proceso del bot sin liberar. Ninguna de estas condiciones autoriza ampliar
destinos, habilitar DNS general, quitar UFW o activar el bot automáticamente.

La salud local no equivale a conectividad Telegram, y el piloto con agentes
apagados sigue sin conectar el journal durable de diagnósticos. No se promete
exactly-once ni recuperación del consumo de mensajes tras una caída.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/07/08/11/12.
