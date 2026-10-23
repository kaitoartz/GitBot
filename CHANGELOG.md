# Changelog — fork local

Cambios de este fork sobre `gitbot-hq/GitBot` 0.0.9. El upstream no se toca: `main` queda como espejo.

## [Unreleased] — rama `feat/panel`

### Fase 0 — Higiene y línea base

**Agregado**

- `npm run typecheck` (`tsc --noEmit`) y `npm run check` (`typecheck` + `build:ui`).
- `docs/DEV.md`: ciclo de trabajo, versiones pinneadas, datos/backups, reglas del fork, problemas comunes.
- `docs/MASTERPLAN.md` corregido con los hallazgos de los spikes S0/S2.
- `scripts/spikes/opencode-events.mjs`: vuelca eventos crudos del server de OpenCode a `.spike-opencode/` (ignorado por git) para inspeccionar tokens, partes y subagentes sin pasar por la UI.

**Corregido**

- Arranque del server de OpenCode en Windows: el SDK lanzaba un `spawn("opencode")` pelado, que falla con `ENOENT` cuando `opencode` es un shim `.cmd`, y además ahora apunta a la CLI 2.x (API incompatible). GitBot resuelve un binario **1.x** (`GITBOT_OPENCODE_BIN`, o los `opencode` del PATH resolviendo el `.cmd` a su `.exe`, descartando 2.x) y lo arranca él mismo. Nuevo `GITBOT_OPENCODE_URL` para mover el server (default `http://127.0.0.1:4096`).

**Notas**

- El server v1 en uso es 1.19.3; la CLI v2.0.29 del PATH no es compatible y no debe usarse.
- `variant` (razonamiento por mensaje) sí existe en el body de `promptAsync` del server v1 aunque el SDK 1.2.15 no lo tipe; Fase 4 lo aprovecha.

### Pendiente

- Fase 1: tokens/costo/contexto en la UI.
- Fase 2: adjuntar archivos desde el panel.
- Fase 3: subagentes en vivo.
- Fase 4: variante de razonamiento por mensaje.
- Fase 5 (opcional): orquestador que delega a otros bots.
