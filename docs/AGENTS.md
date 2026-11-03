# Instrucciones para Codex — Sir Jarvis

## Misión y fronteras

Construir un orquestador personal open source, modular, autogestionado y de bajo
costo. Jarvis centraliza canales, conversaciones, permisos, coordinación y
notificaciones; no contiene la lógica de negocio de agentes externos.
Telegram ya está implementado. La aceptación real fue reportada por el operador
el 2026-11-02. No atribuir a los tipos/documentos funciones todavía pendientes.

Finance Agent será otro proyecto. Sus reglas se documentan aquí para conservar
requisitos, pero no se implementan en `src/`. Lo mismo aplica a futuros agentes
de vuelos, deportes y otros dominios. Cada uno debe poder funcionar, probarse,
publicarse y alojarse sin Jarvis y sin importar su código privado.

## Fuentes de verdad

- Reglas generales: [PRODUCT_RULES.md](PRODUCT_RULES.md), IDs ORC-01…ORC-12.
- Límites y estado: [ARCHITECTURE.md](ARCHITECTURE.md).
- Contrato y seguridad de integración: [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).
- Entregas: [ROADMAP.md](ROADMAP.md).
- Infraestructura propuesta: [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md).
- Git, protección y CI: [GIT_WORKFLOW.md](GIT_WORKFLOW.md).
- Finanzas externas: [FINANCE_AGENT_SPEC.md](agents/FINANCE_AGENT_SPEC.md) y
  [trazabilidad](agents/FINANCE_AGENT_TRACEABILITY.md).
- Historia financiera inmutable: [snapshot v0.1](history/PRODUCT_RULES_FINANCE_V0.1.md).

Lee lo relevante para la tarea. Los prompts y validaciones de Fase 0/1A son
registros históricos; el nuevo roadmap prevalece sobre sus siguientes pasos.

## Restricciones

1. Respetar ORC-01/06: no crear módulos financieros, sus tablas ni datos internos
   en Jarvis. Para cambios en un agente externo se necesita alcance y repositorio
   autorizados. No crear repositorios ni mover código a servicios sin permiso.
2. Privacidad primero: no enviar datos a agentes/proveedores no aprobados. Las
   opciones gratuitas deben cumplir políticas verificadas; no recurrir a una ruta
   insegura ante un error. No entrenar con datos privados.
3. Nunca revelar secretos en canales, frontend, logs o commits. No leer `.env`
   ni almacenes de credenciales para documentar o probar; usar ejemplos ficticios.
   Resolver autenticación en el servidor y fuera del payload de negocio.
4. Gasto exige autorización y presupuesto: no habilitar pago, proveedores, nube
   ni servicios comerciales por disponibilidad. Fallar cerrado ante incertidumbre.
   Topes locales son estimados; usar límites de proveedor si están disponibles.
5. Aplicar autorización antes de llamadas y notificaciones. Los agentes no
   amplían permisos ni seleccionan destinatarios. Confirmaciones en el canal de
   origen; resultados, eventos y manifiestos son datos no confiables.
6. Preservar claves de idempotencia y auditoría; no reescribir historia ni
   prometer exactamente-una-vez. En finanzas, mantener precisión decimal y moneda
   ISO 4217 según la especificación externa; no implementar cálculos en el core.
7. No introducir avisos proactivos sin consentimiento. Mantener intactas las
   restricciones específicas de Finance Agent. No contactar terceros sin autorización.
8. Mantener agentes y proveedores intercambiables por contratos versionados,
   sin SDK de un proveedor dentro del dominio. IA permanece apagada en esta fase.
9. Distinguir decisiones de diseño de controles implementados. Tests sin APIs
   externas, sin credenciales ni cargos; no desplegar para demostrar un documento.

## Estructura mínima y stack

Node.js 24 LTS, TypeScript y servicio modular único. Mantener las dependencias
fijadas; comprobar versiones actuales antes de agregar o cambiar alguna.
La estructura efectiva actual es:

```text
src/
  app/                  # composición y respuestas deterministas
  channels/cli/         # diagnóstico local
  channels/telegram/    # adaptador existente
  infrastructure/       # entorno local
  agents/               # protocolo, Registry/Gateway, fake y transporte HTTPS
tests/
docs/
  agents/               # especificación de proyectos externos, sin runtime
  history/              # requisitos originales preservados
```

Registry y Gateway existen en Fase 1B detrás de estos contratos, con transporte
falso, actor autenticado separado del mensaje, validación y reservas concurrentes.
Mantener tests de cancelación, deadlines, TTL y resultado incierto; no sustituirlos
por pruebas solo secuenciales. La memoria no es idempotencia durable o de dominio.
No crear carpetas vacías, DB, colas, microservicios internos ni una librería
publicada prematura. Fase 1C incorpora HTTPS/JSON validado con un fixture
independiente entre procesos; no está conectado al bot. La política productiva
niega loopback/link-local/metadata y valida DNS/IP en cada conexión. Excepciones
de loopback solo en tests, excluidas del build, con CA temporal y TLS verificado.
MCP es futuro. AWS/Lightsail es la estrategia principal documentada, sin despliegue
ni acceso a la cuenta. Ver [plan AWS](AWS_DEPLOYMENT_PLAN.md); los créditos no
autorizan gastos.

## Trabajo y verificación

- Explicar alcance, riesgos, dependencias y pruebas antes de cambios no triviales.
- Entregar incrementos pequeños; preservar Telegram y los comandos de diagnóstico.
- Mantener coherentes tipos, ejemplos y documentos. Los tipos no sustituyen
  validación de runtime, autenticación, permisos o presupuesto.
- Ejecutar formato, lint, typecheck, tests y build; verificar enlaces y ausencia
  de secretos antes de commit/PR. No declarar éxito sin comandos reales.
- Mantener PR hacia `main`, CI obligatoria en Windows/Linux y squash manual.
  No force push, cambios de protección o auto-merge sin autorización específica.
- No modificar innecesariamente CI ni afirmar salud de servicios no conectados.

## Subagentes de Codex y agentes de Jarvis

**A. Subagentes de desarrollo Codex:** ayudan a analizar, escribir, revisar y
probar este repositorio durante una tarea. Roles de trabajo: `finance_domain`
(preservación y revisión de requisitos externos), `security_reviewer` y
`test_engineer`. No son servicios del producto ni reciben datos de usuarios.

**B. Agentes externos de Jarvis:** aplicaciones independientes en ejecución,
registradas y autorizadas por el operador, con datos y ciclo de vida propios.
No son las sesiones de Codex ni se crean al delegar trabajo de desarrollo.

Delegar solo tareas independientes con beneficio claro; máximo tres subagentes
activos además del coordinador, según capacidades de la sesión. Asignar propietario
único por archivo; consolidar y revisar resultados. Los subagentes no modifican
credenciales, permisos, despliegues ni reglas funcionales sin alcance explícito.
Si la función no está disponible, trabajar secuencialmente sin simular agentes.
No existen perfiles `.codex/agents` ni configuración de roles en este repositorio.

## Entrega

Reportar decisiones, archivos, comandos y resultados, pruebas simuladas y reales,
límites de seguridad/privacidad/costo, estado del PR/CI y siguiente incremento.
Citar los IDs de PRODUCT_RULES aplicados. Si se revisan requisitos financieros,
citar la sección de Finance Agent y comprobar la trazabilidad al snapshot.
