# Fase 1A — entrega y verificación

Rama: `feat/telegram-integration`, desde `main` después del PR #1. Alcance:
protección de `main` y transporte Telegram; sin lógica financiera, IA ni despliegue.

## Protección de main

Se comprobó mediante GitHub API que el repositorio es público, la cuenta tiene
permisos de administración, no había rulesets y la rama no estaba protegida.
Los dos checks existentes se identificaron sobre `main` y ambos habían pasado.
Squash merge ya estaba habilitado y se conservó.

Se aplicó protección clásica y se volvió a consultar el resultado:

| Regla                                    | Resultado                                 |
| ---------------------------------------- | ----------------------------------------- |
| Integración mediante PR                  | Obligatoria, también para administradores |
| `check (ubuntu-latest)`                  | Obligatorio, app GitHub Actions `15368`   |
| `check (windows-latest)`                 | Obligatorio, app GitHub Actions `15368`   |
| Rama del PR actualizada                  | Obligatoria (`strict: true`)              |
| Aprobaciones                             | `0`                                       |
| Aprobación del último push / Code Owners | No exigida                                |
| Force push / eliminación de main         | Deshabilitados                            |
| Squash merge                             | Habilitado                                |

La regla permite al único mantenedor integrar su propio PR después de los checks.
No se ejecutó un merge ni se probó un push prohibido para verificarlo. El estado
de merge y los checks se consultan en el PR final, que se deja abierto para revisión.
No se cambió el workflow de CI. Véase [GIT_WORKFLOW.md](GIT_WORKFLOW.md).

## Implementación y archivos

- `src/app/assistant.ts`: respuestas deterministas de bienvenida, estado y función
  pendiente, sin dependencias Telegram ni efectos de negocio.
- `src/app/telegram-config.ts`: token y allowlist numérica validados por separado;
  errores sin valores privados y rechazo de configuración incompleta.
- `src/app/telegram-main.ts`: composición del bot, validación de IA deshabilitada,
  señales de parada y salida de errores sanitizados.
- `src/channels/telegram/api.ts`: contrato de cliente, actualizaciones y errores.
- `src/channels/telegram/http-api.ts`: Bot API con fetch nativo, validación de
  respuestas, timeouts, cancelación, redirecciones bloqueadas y paid broadcasts off.
- `src/channels/telegram/handler.ts`: autorización antes del núcleo, comandos,
  deduplicación, ritmo de envío y reintentos seguros de 429.
- `src/channels/telegram/polling.ts` y `runtime.ts`: offset, backoff, cancelación y
  códigos de evento sin payloads, IDs o tokens.
- `src/app/diagnostics.ts` y `tests/bootstrap.test.ts`: estado Fase 1A; el diagnóstico
  informa adaptador disponible sin afirmar conexión a Telegram.
- `tests/telegram-api.test.ts`, `tests/telegram-config.test.ts` y
  `tests/telegram.test.ts`: transporte, configuración, comandos, permisos,
  duplicados, errores, límites, entrega incierta y cancelación simulados.
- `.env.example`, `package.json`: variables opcionales para el diagnóstico y dos
  comandos explícitos para Telegram. **No se agregaron dependencias** ni se cambió
  la resolución del lockfile.
- `README.md`, `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`,
  `docs/GIT_WORKFLOW.md`, esta validación y `docs/TELEGRAM.md`: estado, decisiones,
  configuración con BotFather, ejecución y límites. `PRODUCT_RULES.md` no se modificó.

## Verificación local ejecutada

Windows/PowerShell, **Node 24.22.1** portable dentro de `.tools/`, npm **11.17.0**.
El Node global sigue siendo 24.19.0: no se reemplazó. Se usó el prefijo local
documentado en [PHASE_0_VALIDATION.md](PHASE_0_VALIDATION.md) para que npm y sus
subprocesos ejecutaran la versión requerida.

| Comando            | Resultado final                                              |
| ------------------ | ------------------------------------------------------------ |
| `npm ci`           | Correcto; instalación reproducible, sin scripts de terceros  |
| `npm run format`   | Correcto                                                     |
| `npm run check`    | Correcto: formato, lint sin warnings, tipos, tests y build   |
| `npm test`         | **104/104** pruebas; cero fallos, omitidas o llamadas reales |
| `npm run diagnose` | Código 0; adaptador disponible, sin conexión ni secretos     |
| `npm run dev`      | Código 0; diagnóstico desde TypeScript                       |
| `npm start`        | Código 0; diagnóstico compilado                              |
| `npm audit`        | Código 0; cero vulnerabilidades conocidas al verificar       |
| Bot real           | No ejecutado; requiere configuración privada del operador    |
| Migraciones        | No aplican en Fase 1A                                        |

Los tests de proceso comprueban además que el arranque Telegram sin credenciales
o con argumentos desconocidos termina con código 1 antes de hacer peticiones.
El resultado de CI remota se comprueba después de abrir el PR; consultar sus
checks de Windows y Linux para el estado actual y el resumen final de la entrega.

Incidencias corregidas: el primer check completo falló en un mock que intentaba
asignar `Response.json`, declarado readonly; se sustituyó por `Object.defineProperty`
y se repitió `check` completo con éxito. Se corrigió también la clasificación de
fallos de lectura del cuerpo HTTP frente a JSON inválido.

La revisión de seguridad detectó un plazo de espera perdido después del tercer 429. Se conserva ahora para el siguiente mensaje, con regresión que verifica
intentos a 0, 60, 120 y 180 segundos usando reloj simulado. Revisión final sin
hallazgos pendientes. Los subagentes `security_reviewer` y `test_engineer` trabajaron
en revisión y un único archivo de tests, respectivamente, sin editar las mismas
rutas ni acceder a credenciales o settings de GitHub.

## Privacidad y límites

Antes del commit se revisan los archivos staged, las exclusiones `.env`/artefactos
y patrones de credenciales, sin imprimir valores. Solo se versiona `.env.example`
vacío de secretos; los tokens de pruebas son canarios explícitamente ficticios.

Se aplican [PRODUCT_RULES.md](PRODUCT_RULES.md) **§1** (Telegram y credenciales
propias), **§12** (IA apagada, sin proveedores o compras automáticas), **§13**
(respuestas breves sin recordatorios) y **§14** (sin banca, pagos, modelos locales
ni entrenamiento). No se cambia ninguna regla financiera. No se habilitó
facturación ni se desplegó infraestructura.

La deduplicación es en memoria (1024 mensajes y offset temporal). Un reinicio puede
repetir una actualización no confirmada; una entrega incierta no se reenvía, por
lo que alguna respuesta puede perderse. Esto no equivale a idempotencia financiera.
Webhooks, persistencia, aislamiento multiusuario, IA y finanzas siguen pendientes.
La allowlist plural es explícita, con recomendación de un propietario por instancia.

Siguiente incremento: validar manualmente el bot propio y después diseñar Fase 1B,
con deuda inicial ficticia, migración, importes decimales, confirmación y una sola
salida de caja por pago según §2/§4, con constraints y transacciones idempotentes.
