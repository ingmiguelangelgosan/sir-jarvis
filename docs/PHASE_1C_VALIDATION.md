# Fase 1C — HTTPS independiente y estrategia AWS

Rama `feat/agent-http-aws-strategy` creada desde main actualizado y árbol limpio.
Se verificó por GitHub que [PR #4](https://github.com/ingmiguelangelgosan/sir-jarvis/pull/4)
está MERGED, commit `cbedfcebc2f3edb50074ff6a0eee3e1e238bb334`, antes de implementar.
No se cambian protección, CI, dependencias o lockfile. No hay auto-merge.

## Arquitectura y archivos

- `src/agents/https-transport.ts`: puerto HTTPS real detrás del Gateway existente,
  Bearer resuelto server-only, TLS, conexión fijada, límites HTTP/JSON, validación
  de schemas/contexto/estado, abort y polling vinculado al pending original.
- `src/agents/network-policy.ts`: allowlist por origen, DNS revalidado, prohibición
  de rangos especiales/metadata y permisos privados exactos administrados.
- `src/agents/credentials.ts`: contrato de resolución e implementación de mapeo
  explícito referencia → variable del proceso, sin leer `.env` o loguear secretos.
- `src/agents/protocol.ts` y `transport.ts`: solo comentarios de estado;
  contrato wire y puertos conservados. `gateway.ts` permanece sin cambios.
- `tests/fixtures/echo-agent.mjs`: servidor independiente, builtins y bytes del
  protocolo, sin importar Jarvis. Valida Bearer y datos antes del echo de lectura.
- `tests/https-certificates.ts` y `https-process.ts`: CA/certificado/token generados
  en memoria y proceso temporal por IPC con entorno mínimo y limpieza.
- `tests/agent-https-fixtures.ts`, `agent-https.test.ts`, `agent-network.test.ts`,
  `echo-agent.test.ts` y `run-agent-https-demo.ts`: composición de testing aislada,
  regresiones y cliente independiente. `package.json` añade `agents:https:demo`.
- README, índice documental, instrucciones, arquitectura, protocolo, runtime y
  roadmap reflejan el alcance real. PRODUCT_RULES solo actualiza el estado de
  ORC-04/12; sus restricciones y los requisitos financieros no se alteran.
- `docs/DEPLOYMENT_STRATEGY.md` y `AWS_DEPLOYMENT_PLAN.md`: decisión AWS/Lightsail,
  costos, créditos, controles, seguridad, recuperación y migración sin ejecutar.

## Controles y aceptación

El Gateway mantiene la reserva síncrona y el single-flight de Fase 1B, incluso
en red real: cincuenta duplicados concurrentes producen una ejecución remota y
un comando diferente en la misma clave da409. Cada caller cancela su espera;
el último conserva incertidumbre después del dispatch. Timeout no prueba que
el proceso remoto no ejecutó, y su respuesta tardía no autoriza otra ejecución.

La política productiva bloquea loopback, link-local, metadata IPv4/IPv6, destinos
especiales y respuestas DNS mixtas no autorizadas. IP privada solo exacta por
origen; no hay bypass TLS/SSRF por env. Antes de enviar headers/cuerpo se verifica
cadena TLS, nombre original y peer fijado. Sin redirects, proxy ambiental o
headers de mensaje. NODE_DEBUG/tracing de HTTP/TLS bloquea composición.

El transporte valida respuestas JSON/UTF-8 con límites y sin claves repetidas;
se rechazan versión, schema, contexto, framing o status cruzados. HTTP429/503
crudo no habilita retries. Retry-After válido no se reduce; solo el Gateway
aplica retries de rechazos explícitos o efectos seguros. Los errores no conservan
URLs, tokens, payloads o excepciones originales.

La excepción loopback existe solo en un objeto de testing para origen/puerto
exactos, con CA efímera y TLS válido. Tests, PKI y fixture no entran en `dist/`.
El hijo usa entorno mínimo sin credenciales reales o flags del operador, y su
salida se cuenta sin guardar contenido para comprobar ausencia de logs.

## Comandos y evidencia

Entorno usado: Node 24.22.1 y npm 11.17.0 locales. No se leyó `.env`, no se usó
la cuenta AWS y las pruebas no necesitan Internet o credenciales reales.

```powershell
npm.cmd ci
npm.cmd run format
npm.cmd run check
npm.cmd run agents:demo
npm.cmd run agents:https:demo
node dist/app/agent-demo.js
```

La demo HTTPS inicia el agente separado y recorre Core → Gateway → HTTPS → echo.
Resultado observado: `{"mode":"https-local-test","status":"completed","executions":1}`.
El [cliente independiente](../tests/echo-agent.test.ts), sin imports de `src/`,
prueba arranque, autenticación, echo, concurrencia y conflicto del servicio.
Para ejecutar solo ese cliente: `node --test tests/echo-agent.test.ts`.

| Verificación              | Resultado local                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- |
| `npm ci`                  | Correcto; auditoría de 102 paquetes, 0 vulnerabilidades conocidas               |
| Formato, lint y typecheck | Correctos; cero warnings de lint                                                |
| `npm run check`           | Correcto, incluye todas las pruebas y build                                     |
| `npm test`                | **285/285**, sin fallos, omitidas ni canceladas                                 |
| Pruebas previas           | Las 185 permanecen intactas; Gateway conserva su implementación                 |
| Nuevas pruebas            | 50 HTTPS, 47 red/credenciales y 3 cliente independiente                         |
| Demos                     | Fake TS/JS y HTTPS entre procesos: correctas, código 0                          |
| Enlaces y finanzas        | 6 tests documentales, incluidos anchors y hash/inclusión financiera             |
| Build                     | Correcto; `dist/` no contiene fixture, PKI, helper o política loopback de tests |

Se ejecutó con `.tools/package/bin/node.exe` y
`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`, anteponiendo
`.tools/package/bin` al PATH de ese proceso; sin cambiar Node global. Con una
instalación de Node 24.22.1+ los comandos anteriores son equivalentes.
También se ejecutó `git diff --check`. La revisión independiente de seguridad
no identificó bloqueos pendientes en el alcance implementado. La revisión de
secretos se aplica al índice completo antes de publicar; no incluye `.env` privado.
La CI remota Windows/Linux se verifica en el PR y se documenta allí; el éxito
local no sustituye esa evidencia. El PR debe permanecer abierto sin auto-merge.

## AWS: decisión, supuestos y límites

AWS/Lightsail es el principal documentado. Bundle Linux/IPv4 de referencia:
2 GB/2 vCPU/60 GB USD12/mes; evaluar 4 GB/2 vCPU/80 GB USD24 solo con métricas.
Cuatro meses a12 y dos a24 dan USD96 VPS; margen54 suma USD150 de planificación,
con USD50 de reserva respecto a200 **nominales**, no saldo comprobado.
Precios públicos y fuentes en la [estrategia](DEPLOYMENT_STRATEGY.md).

Cuenta Paid Plan y créditos son reportados por el operador. No se verificaron
saldo, elegibilidad o vencimiento en Billing. El neto no se garantiza: bruto
menos crédito realmente aplicado, más cargos no previstos/no cubiertos.
Plan Budgets25 bruto mensual,50/80/100% y forecast; alertas no son topes.
El [plan AWS](AWS_DEPLOYMENT_PLAN.md) exige autorización concreta antes de contratar,
crear budgets o tocar recursos. No se creó IaC, Dockerfile, despliegue o facturación.

## Pendientes y siguiente corte

Memoria se pierde al reiniciar; ningún backup de disco captura reservas activas.
El transporte no añade idempotencia de dominio, siete días de retención durable
o exactamente-una-vez. Pending, cupos, timeouts y TTL son límites locales, sin
cancelación remota demostrada. DNS del SO puede continuar, pero su cupo queda
ocupado hasta resolver y nunca genera un envío tardío tras abort. Las políticas
de rangos especiales requieren revisión al evolucionar redes/proveedores.

No se conecta Telegram al Gateway ni se cambian sus comandos/respuestas. Sin
IA, finanzas, eventos externos, scheduler, webhooks, MCP, DB nueva, repositorios
externos, recursos o cargos. La fixture no es un producto desplegado.

Siguiente corte: revisión manual/merge y preparación de despliegue local reproducible,
secretos/TLS/egreso y recuperación con métricas. Antes de AWS, resolver los límites
de reinicio/operaciones inciertas y revisar privadamente Billing, región, costos y
autorización de recursos exactos; no ejecutar el plan por este documento.
Un agente de dominio real requiere aceptación independiente en su propio proyecto.
Eventos autenticados/replay y persistencia durable siguen en Fase3.

Aplican [PRODUCT_RULES](PRODUCT_RULES.md) ORC-01/02/03/04/05/06/07/08/11/12:
fronteras, autorización, secretos, no-paid-services, incertidumbre, minimización,
contratos, deduplicación, portabilidad y estado honesto. Snapshot y trazabilidad
financiera se conservan íntegros; no se implementa su dominio aquí.
