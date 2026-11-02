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

## Protección de main aplicada para Fase 1A

En `ingmiguelangelgosan/sir-jarvis`, la protección clásica de `main` exige PR y
estos checks, vinculados a la aplicación GitHub Actions:

- `check (ubuntu-latest)`
- `check (windows-latest)`

La rama del PR debe estar actualizada con `main` (`strict: true`). Se aplica
también a administradores. Force push y eliminación están bloqueados. Squash merge
está habilitado; no se cambiaron los demás métodos de merge.

Se requieren **cero aprobaciones**: el propietario puede integrar su propio PR
cuando ambos checks pasen. No se exige aprobación del último push ni de Code
Owners. Si `main` avanza, actualizar la rama antes de esperar los checks finales.
Esto no autoriza pushes directos ni bypass de la protección. Esta entrega se deja
abierta para revisión manual, sin ejecutar merge para probar la regla.

La configuración se aplicó y volvió a leer mediante GitHub REST API. Se puede
inspeccionar desde Settings → Branches → regla `main` o con:

```sh
gh api repos/ingmiguelangelgosan/sir-jarvis/branches/main/protection
gh api repos/ingmiguelangelgosan/sir-jarvis --jq .allow_squash_merge
```

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
