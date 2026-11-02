# Flujo de trabajo con Git

## Ramas y revisiones

- `main` contiene cambios verificados e integrados mediante pull request.
- Crea ramas cortas desde `main` actualizado: `feat/…`, `fix/…`, `docs/…` o `chore/…`.
- Haz commits pequeños con mensajes que expliquen el propósito del cambio.
- Antes de subir, revisa `git diff --cached` y ejecuta `npm run check`.
- Sube la rama con `git push -u origin <rama>` y abre un pull request hacia `main`.
- Describe el cambio, las pruebas y los límites pendientes. Espera los checks de CI
  en Windows y Linux antes del merge; utiliza squash para integrar cada incremento.
- Sincroniza `main` después del merge y elimina la rama integrada cuando corresponda.
- Evita pushes directos a `main` y no reescribas historial compartido con force push.

Estas son convenciones de colaboración; su cumplimiento automático depende de las
reglas de protección configuradas en GitHub.

## Primer import

El remoto comenzó vacío. Un commit vacío crea la base `main` necesaria para abrir
el primer pull request. El contenido inicial se entrega en `chore/initial-import`,
con comprobaciones locales y CI antes de integrarlo.

## Privacidad

Usa credenciales propias guardadas en el almacén del sistema y una identidad de
Git local por proyecto. Revisa siempre los archivos staged: `.env`, keys, logs,
comprobantes, backups, dependencias y compilación deben quedar fuera. Solo se
publica `.env.example`, sin secretos. El repositorio es público.

Las reglas financieras de [PRODUCT_RULES.md](PRODUCT_RULES.md) se mantienen;
este flujo no habilita integraciones, proveedores de IA ni facturación.
