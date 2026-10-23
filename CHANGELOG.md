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

### Fase 1 — Tokens, costo y contexto

**Agregado**

- `src/usage.ts`: normalizador de uso, caché de límites de contexto (`config.providers()` al arrancar) y acumulado en dos capas — histórico sembrado por hilo desde `session.messages` (una vez por proceso; reiniciar no lo pierde) + deltas en vivo por sesión, con dedupe por `messageID` y exclusión de solapes al sembrar a mitad de turno.
- Evento SSE `usage` (scope `turn` al llegar el snapshot real por mensaje; scope `session` al cerrar el turno, con total combinado y ventana resuelta).
- `GET /threads/:id/usage`: reporte de uso del hilo, `null` para agentes que no son OpenCode.
- UI: `ui/app/components/usage-bar.tsx` — barra fina sobre el composer con `contexto % · used/limit` coloreada por umbral (verde <60%, ámbar <85%, rojo ≥85%), costo del turno y del hilo, tokens in/out, y desglose expandible (input, output, reasoning, cache read/write, costos).
- `scripts/smoke-usage.mjs`: smoke test end-to-end del pipeline con un turno real.

**Notas**

- Los tokens no llegan en streaming: OpenCode abre cada mensaje con un snapshot en cero y entrega los reales en step-finish; el snapshot en cero no se emite y el real pasa exactamente una vez.
- La ventana de contexto es el footprint del último mensaje assistant (`input + cacheRead + cacheWrite`), no el sumatorio de turnos: cada turno relee el cache y el sumatorio no representa el estado de la ventana.
- El costo refleja lo reporte el proveedor; varios devuelven `0`.

### Fase 2 — Adjuntar archivos

**Agregado**

- `src/attachments.ts`: validación y normalización de adjuntos antes de arrancar el turno. `kind:"path"` → mención `@ruta` en el texto (OpenCode la resuelve); `kind:"image"` → `FilePartInput` real con data URL. Solo imágenes y PDF, 10 MB, rutas confinadas al repo.
- `GET /files/search?repoPath=&q=` (búsqueda difusa vía `client.find.files`) y `GET /models/capabilities?model=` (imagen/PDF/variantes/límites).
- UI del composer: clip, drag-drop, paste de imágenes, chips con nombre/tamaño/quitar y autocomplete `@` con teclado. El clip se deshabilita si el modelo no declara imagen ni PDF.
- Burbujas e historial renderizan los adjuntos (`image_url` / `file`), releídos del transcript de OpenCode.
- `scripts/spikes/opencode-file-parts.mjs` (S1), `scripts/attachments.test.mjs`, `ui/scripts/attachments.test.mjs` y `scripts/smoke-attachments.mjs`.

**Notas**

- `FilePartInput` exige `url`; `source` sin `url` da 400 y una ruta Windows pelada cuelga el turno. El server siempre arma el data URL.
- El evento `user_prompt` lleva metadatos, nunca los bytes: los adjuntos viven en memoria del store durante el turno.
- Con un turno corriendo, adjuntar pide esperar: la cola sigue siendo solo texto y no debe perder archivos en silencio.

### Corregido

- **Thinking infinito tras responder (R7).** El turno nunca recibía `done` cuando se perdía `session.idle` en el stream global de eventos (no hay replay). Ahora `GET /sessions/:id/status` reconcilia contra `session.status` de OpenCode: si el server dice idle, cierra el turno (`usage` + `done`) al instante. La UI además sondea ese endpoint cada 4 s mientras cree que hay un turno vivo. Nunca reconcilia turnos de menos de 5 s ni turnos esperando aprobación.

### Fase 3 - Subagentes en vivo

**Agregado**

- `src/start-opencode.ts`: vínculo exacto `task` → sesión hija usando `state.metadata.sessionId` (S3). Evento SSE `subagent` con `started` / `finished` / `error`, agente y título. `assistant`, `tool_use` y `usage` de hijos llevan `parent_tool_use_id` real.
- Uso del hijo: suma al total del turno, no a la ventana de contexto del padre. El evento `usage` del hijo lleva `parent_tool_use_id`.
- Historial: el `tool_use` de un `task` incluye `tool_use_id` y `subagent { childSessionId, agent, title, status }`; el transcript se lee por `GET /sessions/:child/history`.
- UI: tarjeta colapsable por subagente (estado con color, texto y tools en vivo, costo/tokens) y panel lateral "View transcript". En hilos reabiertos las tarjetas salen del historial.
- `scripts/smoke-subagents.mjs` (10 checks).

**Notas**

- Nada nuevo se persiste: todo se reconstruye desde OpenCode.
- `ReasoningPart` plegable quedó fuera de alcance (opcional del plan).

### Fase 4 - Razonamiento por mensaje\n\n**Agregado**\n\n- Backend: `POST /chat` acepta `variant` (OpenCode). Se valida contra las variantes que declara el modelo (`400` con la lista si no existe), vive en `SessionStore` y se envía en `promptAsync` sólo si el modelo lo declara. Aplica por mensaje: omitirlo o `null` vuelve al default.\n- `GET /sessions/:id/config` expone `variant`; el evento `user_prompt` lo incluye.\n- UI: selector \"Thinking\" junto a permisos, visible sólo si el modelo declara variantes. Etiqueta \"aplica al próximo mensaje\"; con turno corriendo ofrece \"Restart this turn with …\" (aborta y relanza el mismo prompt, attachments incluidos). La variante activa se muestra en la cabecera.\n- `scripts/smoke-variant.mjs` (13 checks) y `scripts/spikes/opencode-variant.mjs`.\n\n**Notas**\n\n- S4: el hijo de un `task` hereda la variante del padre.\n- Perfiles (`rapido`, `normal`, …) no implementados: no hay config de workspace que los declare; sin variantes el selector no aparece y todo queda como antes.\n\n### Pendiente

- Aceptación manual de la barra de uso en el navegador (colores, conectividad en vivo).
- Aceptación manual de Fase 2 en el navegador (clip, drag-drop, `@`).
- Aceptación manual de Fase 3 en el navegador (dos tarjetas en vivo, subagente fallido en rojo, transcript).
- Aceptación manual de Fase 4 en el navegador (selector Thinking, restart con turno activo).
- Fase 5 (opcional): orquestador que delega a otros bots.
