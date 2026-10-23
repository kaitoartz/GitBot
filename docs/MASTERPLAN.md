# Masterplan — panel GitBot para OpenCode

Plan de trabajo del fork local de GitBot (`D:\Proyects\GitBot`) para convertir el panel en una herramienta usable a diario con **OpenCode como único agente**.

Este documento es el contrato de trabajo: qué se construye, en qué orden, con qué criterio de aceptación y qué queda explícitamente afuera. Para el detalle de endpoints ver [API.md](API.md); para la forma general del sistema, [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Contexto y alcance

**Punto de partida**

- Fork local en `D:\Proyects\GitBot`, versión `0.0.9`, reemplazando el global vía `npm link` (junction). `gitbot` ejecuta el `dist/` del clone.
- Agente en uso: **solo OpenCode**. Claude Code y Codex siguen sin suscripción/CLI activa.
- **API de OpenCode: v1.** El repo fija `@opencode-ai/sdk` **1.2.15**, que habla la API v1 (`/global/health`, `/session`, `/event`, sin auth). El server v1 en uso es **1.19.3** (binario pineado en `tools/opencode-v1`).
- El `opencode` del PATH es **v2.0.29**, que sirve una API distinta bajo `/api` con password: **no es compatible** y no debe usarse. Ver R0 y `docs/DEV.md` §5.
- Datos en `~/.gitbot` (`bots.json`, `threads.json`); historial **no** lo guarda GitBot: se relee desde OpenCode.


**Alcance**

1. Adjuntar archivos desde el panel (sin tipear rutas).
2. Ver consumo de tokens, costo y contexto por turno e hilo.
3. Ver el trabajo de subagentes en tiempo real, agrupado y legible.
4. Controlar el nivel de razonamiento/perfil del agente desde el chat.
5. *(Opcional, última fase)* orquestador que delega a otros bots/hilos.

**Fuera de alcance**

- Paridad nueva con Claude Code y Codex: se mantienen compilando y funcionando como hoy, sin features nuevas ni tests dedicados.
- Autenticación, multiusuario, deploy remoto (GitBot sigue sin auth y en red local).
- Reescribir la UI en otro framework o meter un state manager.
- Base de datos: todo sigue en JSON + transcript del agente.

---

## 2. Principios de diseño

1. **OpenCode es la fuente de verdad.** Historial, tokens, costo, sesiones hijas y agentes se leen de su API (`session.messages`, `session.children`, `config.providers`, `app.agents`). GitBot no duplica estado que OpenCode ya tiene.
2. **Los eventos son el contrato.** Todo lo que la UI muestra en vivo viaja por el SSE existente (`GET /events?sessionId=`). Un dato nuevo = un campo nuevo en un evento existente o un evento nuevo; nunca polling.
3. **Degradar, nunca romper.** Si el agente no es OpenCode, o el modelo no reporta ventana de contexto, la UI oculta el dato en vez de mostrar basura.
4. **Cambios chicos y verificables.** Una fase = una rama = un `npm run build` verde + un guion de aceptación manual.
5. **La UI sigue siendo React + `useState`.** Nada de stores globales; se agregan componentes y props.

---

## 3. Fases

Cada fase termina en un estado usable y demostrable. El orden está pensado para que la fase 1 entregue valor inmediato con el menor riesgo.

### Fase 0 — Higiene y línea base

**Objetivo:** poder cambiar cosas sin romper el `gitbot` global.

- Crear rama de trabajo `feat/panel` desde `main`.
- Añadir scripts al `package.json` raíz:
  - `typecheck`: `tsc --noEmit`
  - `check`: `npm run typecheck && npm run build:ui`
- Snapshot de datos: copiar `~/.gitbot/{bots,threads}.json` a `~/.gitbot/backup-YYYYMMDD/` (ya existe `bots.json.bak`; formalizarlo).
- Documentar en `docs/DEV.md` el ciclo: editar → `npm run build` → `gitbot start`.
- Fijar la dupla de versiones: registrar `opencode --version` y la versión del SDK en `docs/DEV.md`. **Si el build o el runtime falla por drift, ahí se ve primero.**
- **Arreglar el arranque del server en Windows.** El SDK lanza un `spawn("opencode")` pelado: en Windows `opencode` es un shim `.cmd` que node no puede ejecutar (`ENOENT`), y ahora apunta a la CLI 2.x, incompatible. GitBot pasa a resolver y arrancar él mismo un binario **1.x** (`GITBOT_OPENCODE_BIN`, o los `opencode` del PATH resolviendo el `.cmd` a su `.exe`), y sigue reutilizando un server ya corriendo en el puerto. `GITBOT_OPENCODE_URL` permite moverlo (usado por los spikes).
- Dejar un spike reutilizable (`scripts/spikes/opencode-events.mjs`) que vuelca los eventos crudos del server a `.spike-opencode/` (ignorado por git).

**Aceptación:** `npm run check` verde; `gitbot --version` sigue respondiendo; backup creado; `gitbot start` arranca su propio server v1 y se ve `opencode: ready (1.19.3)`.

**Estado: completada.** Resultados:

- `npm run check` y `npm run build` verdes en `feat/panel`.
- `gitbot start` sin server previo arranca `1.19.3` desde `GITBOT_OPENCODE_BIN`, responde `/global/health` y atiende turnos.
- S0 y S2 resueltos (ver §5). El server v1 que GitBot usaba estaba levantado a mano; ahora puede arrancarlo él mismo.

---

### Fase 1 — Tokens, costo y contexto

**Por qué primero:** el dato ya llega y se descarta; es la mejora con mejor relación valor/riesgo.

**Estado actual**

| Punto | Hoy |
|---|---|
| `message.updated` con `info.tokens` / `info.cost` | se ignora salvo el rol (`src/start-opencode.ts`) |
| `session.messages` con `info.tokens`, `info.cost`, `finish` | no se usa |
| Ventana de contexto | disponible en `config.providers()` → `models[].limit.context` (medido: **1.048.576** para `magpie/auto/deepseek-v4.1-flash-1017`) |
| UI | no escucha `result`; no muestra costo ni contexto |

**Lo que ya sabemos del server (S2, medido en v1.19.3)**

- Los tokens **no** llegan incrementalmente: la primera `message.updated` del assistant trae `tokens` en cero y el snapshot real llega recién en `step-finish` / al completar el mensaje (~4 s en un turno corto). No hace falta throttle; sí hace falta no emitir dos veces el mismo snapshot.
- Snapshot real del turno de prueba: `{"total":32696,"input":182,"output":2,"reasoning":0,"cache":{"read":32512,"write":0}}`, `cost: 0` (proveedor sin costo).
- `input` **excluye** lo leído de cache; el total del contexto se entiende como `input + cache.read + cache.write`.
- Eventos disponibles: `message.updated`, `message.part.updated`, `session.status` (`busy`/`idle`), `session.idle`, `session.diff`, `session.updated`, `server.connected`, `server.heartbeat`.

**Trabajo**

1. **Normalizador de uso** (`src/start-opencode.ts` + nuevo `src/usage.ts`):
   - En `message.updated` de rol `assistant`, guardar por `messageID`: `{ input, output, reasoning, cacheRead, cacheWrite, cost, modelID, providerID }`.
   - Emitir `usage` (evento nuevo) cuando el snapshot cambie respecto del último emitido para ese `messageID` (clave: `messageID` + `tokens.total` + `cost`), con `{ scope: "turn" ... }`. Sin throttle: el server ya entrega uno o dos snapshots por mensaje.
   - Al cerrar el turno (`session.idle`), emitir `{ scope: "session", ... }` con el acumulado y el `context` resuelto.
2. **Ventana de contexto** (`src/usage.ts`):
   - Cachear `config.providers()` al iniciar el server OpenCode.
   - Resolver `limit.context` por `providerID/modelID`; `null` si no aparece.
3. **Acumulado por hilo** (sin DB):
   - `GET /threads/:id/usage` → `{ turn: Usage, total: Usage, context: { used, limit, pct }, model }`.
   - `total` se calcula sumando `session.messages(sdkSessionId)` **una vez** al abrir el hilo y se actualiza con los deltas del turno en curso. Un solo origen por mensaje (`messageID` como clave) para evitar doble conteo.
4. **UI**:
   - Barra fina sobre el composer: `contexto 42% · 84k/200k`, `turno $0.012`, `hilo $0.148`, contador de tokens in/out.
   - Color por umbral (verde <60%, ámbar <85%, rojo ≥85%).
   - Expandir → desglose: input, output, reasoning, cache read/write, costo por turno.
   - Mostrar aviso `compactación` cuando llegue `session.compacted`.
5. **Contrato de API:** documentar `usage` en `docs/API.md` y en el listado de eventos.

**Aceptación**

- Un turno real muestra costo y tokens en <2 s tras terminar.
- Al reabrir el hilo (proceso reiniciado), el total histórico coincide con lo que reporta OpenCode para esa sesión.
- Con un modelo sin `limit.context`, se ven tokens y costo, sin porcentaje ni división por cero.
- Reiniciar `gitbot` no pierde el acumulado.

**Riesgo principal:** doble conteo entre histórico y deltas → mitigado con clave `messageID` y test manual de "abrir hilo a mitad de turno".

**Estado: completada.** Resultados:

- `src/usage.ts`: normalizador (dedupe por `messageID` + `total` + `cost`; el snapshot en cero que abre cada mensaje no se emite), límites de contexto cacheados de `config.providers()` al arrancar (`result.data.providers`; `models` llega como registro con ids con slash), y dos capas de acumulado: histórico sembrado por hilo (`thread:<id>`, una vez por proceso desde `session.messages`) + deltas en vivo por sesión de GitBot.
- **Corrección de diseño al probar:** la ventana de contexto no es el sumatorio de turnos (cada turno reintenta el cache; un hilo con 7.8M de tokens acumulados daba "747%"). `context.used` es el footprint del **último** mensaje assistant (`input + cacheRead + cacheWrite`). En el seed reshape se saca de `session.messages` hacia atrás.
- Evento SSE `usage` (turn al llegar el snapshot real, session al cerrar el turno) y `GET /threads/:id/usage` documentados en `docs/API.md`.
- UI: `UsageBar` sobre el composer con `contexto % · used/limit` (verde <60%, ámbar <85%, rojo ≥85%), `turno $x`, `hilo $x`, tokens in/out y desglose expandible. `EventSource` solo abierto durante un turno activo (el stream 404ea para hilos en reposo) y cerrado en error — sin bucle de reconexión.
- Smoke test `scripts/smoke-usage.mjs`: turno real contra `1.19.3` — snapshot de turno relevante en ~16 s (step-finish), reporte de sesión con `context {used, limit, pct}` resuelto, y REST post-turno idéntico al evento de sesión.
- Pendiente de aceptación manual: color/ámbito visual de la barra en el navegador.

---

### Fase 2 — Adjuntar archivos

**Por qué segundo:** elimina el tipeo de rutas, que es el dolor diario.

**Estado actual**

- `POST /chat` acepta `attachments: [{ url }]` y **solo imágenes**; el driver OpenCode fuerza `mime: "image/jpeg"`.
- Composer sin clip, sin drag-drop, sin paste (`ui/app/components/chat.tsx`).
- Ya existen `GET /dir` (listar dentro del repo) y `find.files` en el SDK de OpenCode (`/find/file`, búsqueda difusa).
- **S1 (parcial, desde el OpenAPI del server v1.19.3):** `FilePartInput` es `{ type:"file", mime, url, source? }` con `source` = `FileSource { text, type:"file", path }` | `SymbolSource` | `ResourceSource`. Es decir: un archivo local se puede mandar por **ruta** (`source.path`) o por `url` (data URL). Falta confirmar en vivo cuál acepta el server y si exige `text`.

**Diseño elegido**

Dos caminos, porque adjuntar código y adjuntar una imagen no son el mismo problema:

1. **Código / texto (camino principal, barato):** el panel inserta una **mención `@ruta/relativa`** en el texto del mensaje. OpenCode ya resuelve `@`-menciones de forma nativa y el agente decide si lee el archivo con su tool. Cero bytes de contexto extra, cero endpoints nuevos de subida.
2. **Imágenes / PDF (camino binario):** `FilePartInput` real con `mime` correcto y `url` como data URL base64 (o `source: { type: "file", path }` si el spike S1 confirma que el server lo acepta). Respetar `model.capabilities.input.image|pdf`; si el modelo no lo soporta, deshabilitar el clip con tooltip explicativo.

**Trabajo**

1. Spike S1 (ver §5) para fijar la forma exacta del `FilePartInput` que acepta el server v2.0.29.
2. Endpoint `GET /files/search?repoPath=&q=` que envuelva `client.find.files` (búsqueda difusa por nombre/ruta). Fallback al `GET /dir` actual si el server no responde.
3. Modelo de attachment en `/chat`: `{ kind: "path", path } | { kind: "image", path, mime }`, retrocompatible con `{ url }`.
4. Driver: mapear `kind:"path"` a mención en el text part; `kind:"image"` a `FilePartInput` con MIME detectado (sin el `image/jpeg` hardcodeado), límite de tamaño y validación de ruta dentro de `repoPath` (misma regla que `workspace.ts`).
5. UI composer:
   - Botón clip + drag-drop sobre el composer + paste de imágenes.
   - Chips de adjunto con nombre, tamaño y botón quitar.
   - Autocomplete `@` en el textarea: escribe 2+ letras → lista difusa de archivos del repo → Enter inserta la mención.
   - El historial debe **renderizar** las menciones y los adjuntos (hoy `image_url` se descarta al aplanar mensajes).

**Aceptación**

- Adjuntar `Assets/Scripts/Foo.cs` desde el panel sin tipear la ruta: 3 clics o `@foo`.
- Adjuntar un PNG y verlo aparecer en el hilo y en el turno siguiente.
- Archivo fuera de `repoPath` → rechazado con mensaje claro.
- Modelo sin visión → clip deshabilitado, no error en runtime.

---

### Fase 3 — Subagentes en vivo

**Estado actual:** OpenCode ya resuelve ancestría por `parentID` y etiqueta eventos hijos con `parent_tool_use_id`, pero:

- el vínculo `task` → sesión hija es heurístico ("último task visto"),
- la UI ignora `parent_tool_use_id`,
- los `reasoning` parts no se muestran,
- no hay forma de abrir el transcript de un subagente.

**Trabajo**

1. Spike S3: confirmar si el part de la tool `task` trae el `sessionId` del hijo en su metadata (en ese caso se reemplaza la heurística por el vínculo real).
2. Backend (`src/start-opencode.ts`):
   - `Map<childSessionId, parentToolUseId>` poblado al detectar el part `task` + `session.children`.
   - Evento nuevo `subagent` con `{ phase: "started" | "finished" | "error", parentToolUseId, childSessionId, agent, title }`.
   - Adjuntar `parent_tool_use_id` a `assistant`, `tool_use` y `usage` de hijos (ya casi está).
   - Propagar tokens/costo del hijo al total del turno y exponer `usage.children[]`.
3. UI:
   - Bajo la fila del `Task`, una tarjeta colapsable por subagente: agente, título, estado, contador de tools, tokens y costo.
   - Contenido en vivo (texto + tools) dentro de la tarjeta, con scroll propio.
   - Botón "ver transcript" → panel lateral que lee `session.messages(childId)` (histórico incluido).
   - Indicador agregado en la barra de estado: `2 subagentes activos`.
4. Opcional barato: render de `ReasoningPart` como bloque plegable "razonamiento".

**Aceptación**

- Pedir una tarea que dispare subagentes: se ven al menos dos tarjetas, cada una con sus tools y su costo, actualizándose en vivo.
- Al reabrir el hilo, los subagentes del turno anterior aparecen con su transcript (releído de OpenCode).
- Un subagente que falla se muestra en rojo sin romper el hilo padre.

**Nota de diseño:** no se persiste nada nuevo; todo se reconstruye desde OpenCode.

---

### Fase 4 — Perfil de razonamiento por hilo

**Restricción corregida (Fase 0).** El plan original decía que `promptAsync` no acepta razonamiento. **No es así en v1.19.3:** el body acepta un `variant: string` de primer nivel (verificado en `/doc`), y cada modelo anuncia sus variantes en `config.providers()`:

```json
"variants": { "low": {"reasoningEffort":"low"}, "high": {...}, "max": {...} }
```

El SDK 1.2.15 todavía no tipa `variant` (sus `types.gen.d.ts` no lo incluyen), así que va con un cast puntual, igual que el resto de los campos que el server conoce y el SDK no.

**Estrategia:** dos palancas, en este orden.

1. **`variant` por mensaje (preferida).** Si el modelo expone `variants`, el selector manda `variant` en cada `promptAsync`: `low` / `high` / `max` / sin variante. Es razonamiento real por mensaje y sobrevive a reiniciar GitBot sin estado nuevo.
2. **Perfil como fallback.** Si el modelo no expone variantes (o el agente no es OpenCode), "perfil" = agente de OpenCode con modelo/opciones fijas. `Bot.profile` + `Thread.profile` como override.

**Trabajo**

1. Spike S4: confirmar que `variant` cambia el comportamiento y se refleja en la respuesta; comprobar si aplica al próximo mensaje (esperado) y si los subagentes heredan la variante.
2. Backend: `variant` viaja en `/chat` y queda en `SessionStore` (junto a `mode` y `permissionMode`); se envía sólo si el modelo lo declara. `GET /agents` devuelve, por modelo, `variants` + `capabilities.reasoning`.
3. Modelo de datos de perfiles (fallback): `Bot.profile?: string`, `Thread.profile?: string`, migración tolerante.
4. Perfiles iniciales versionados en la config del workspace: `rapido`, `normal`, `profundo`, `plan`.
5. UI: selector en el composer junto a permisos, con la variante activa visible en la cabecera y en el resumen del turno. Etiqueta honesta: **"aplica al próximo mensaje"**; con turno corriendo, ofrecer "abortar y reiniciar con este perfil" (`session.abort`).
6. Mostrar `capabilities.reasoning`/`variants` del modelo para no ofrecer una palanca que ese modelo no tiene.


**Aceptación**

- Con un modelo que declara `variants`, cambiar la variante y enviar: el siguiente turno sale con esa variante (verificable en la respuesta/log del server).
- Con un modelo sin variantes, el selector no ofrece thinking; si hay perfiles declarados, se comporta como antes.
- El botón no promete cambio en vivo; con turno activo aparece la opción de reinicio.
- Sin perfiles ni variantes configurados, todo funciona como hoy.

---

### Fase 5 (opcional) — Orquestador que delega a otros bots

**Sólo si las fases 1–4 ya están en uso diario.** Los subagentes nativos cubren "delegar y ver"; esta fase cubre otra cosa: trabajo **durable**, en **distintos repos**, con **permisos y modelos distintos**, que sobrevive al turno.

**Trabajo**

1. Inyectar un MCP local propio en el server OpenCode que GitBot ya lanza (`ServerOptions.config` acepta `mcp`), con tools acotadas:
   - `list_bots`, `spawn_bot({ botId, repoPath, prompt })` → crea hilo + primer turno, devuelve `threadId`.
   - `send_to_thread({ threadId, prompt })`, `read_thread({ threadId, limit })`.
   - Sin tools de borrado, permisos ni settings.
2. `Thread.parentThreadId?: string` + `POST /threads/:id/tree` para reconstruir el árbol.
3. UI: vista de dos/tres columnas con el hilo padre y los hijos en vivo; costo agregado del árbol.
4. Regla anti-abuso: límite de hijos por turno y de profundidad (1 nivel), para que el orquestador no se auto-invoque en loop.

**Aceptación:** un bot orquestador crea dos hilos hijos en repos distintos, se ven en paralelo y el costo total del árbol aparece sumado.

---

## 4. Cambios de contrato (resumen)

**Eventos SSE nuevos/ampliados** (`docs/API.md`)

| Evento | Payload | Fase |
|---|---|---|
| `usage` | `{ scope, messageID?, input, output, reasoning, cacheRead, cacheWrite, cost, context?: { used, limit, pct } , children?: Usage[] }` | 1, 3 |
| `subagent` | `{ phase, parentToolUseId, childSessionId, agent, title }` | 3 |
| `result` (ampliado) | agrega `usage` y `modelID` | 1 |
| `assistant` / `tool_use` | agregan `parent_tool_use_id` ya existente en OpenCode | 3 |

**Endpoints nuevos**

| Método | Ruta | Fase |
|---|---|---|
| `GET` | `/threads/:id/usage` | 1 |
| `GET` | `/files/search?repoPath=&q=` | 2 |
| `POST` | `/chat` (amplía `attachments`) | 2 |
| `GET` | `/subagents/:childSessionId/messages` | 3 |
| `GET` | `/agents` (perfiles disponibles) | 4 |
| `PATCH` | `/threads/:id` (acepta `profile`) | 4 |

**Esquema de datos (compatible hacia atrás)**

```ts
Thread { ..., profile?: string, parentThreadId?: string }   // ambos opcionales
Bot    { ..., profile?: string }
// sin campo usage persistido: se deriva de OpenCode
```

---

## 5. Spikes (estado)

| ID | Pregunta | Resultado | Fase |
|---|---|---|---|
| **S0** | ¿El SDK 1.2.15 habla bien con el server de OpenCode? | **Sí, contra v1.19.3.** Turno completo: `session.create` → `promptAsync` → eventos → `session.idle`. **v2.0.29 no sirve:** API nueva bajo `/api` con password; el SDK y GitBot esperan v1. El server v1 ahora lo arranca GitBot si no hay uno (Fase 0). | 0 ✅ |
| **S2** | ¿`message.updated` trae tokens durante el turno o sólo al final? | **Sólo al final.** Primer update del assistant con `tokens` en cero; el snapshot real llega en `step-finish` (~4 s en un turno corto). `input` excluye cache; `total = input + output + cache.read + cache.write`. `limit.context` se lee de `config.providers()`. | 1 ✅ |
| **S1** | ¿Qué forma de `FilePartInput` acepta el server para imagen / PDF / texto? | **Parcial (schema).** `{ type:"file", mime, url, source? }`, con `source = { text, type:"file", path }` para archivo local. Falta probar en vivo si lee la ruta del disco y si exige `text`. | 2 |
| **S3** | ¿El part `task` expone el `sessionId` del hijo en metadata? | Pendiente. Requiere un turno que dispare subagente; el spike deja el volcado crudo en `.spike-opencode/`. | 3 |
| **S4** | ¿`variant` en el body cambia el razonamiento y aplica desde el próximo mensaje? | Pendiente. El OpenAPI confirma que `variant` es un campo válido del body, y los modelos declaran `variants` (`low`/`high`/`max`). Falta verificar efecto real y herencia a subagentes. | 4 |

Regla: si un spike contradice el plan, se ajusta el plan **antes** de escribir código, no durante. Ya pasó dos veces (v2 vs v1; `variant` sí existe) y el plan quedó corregido.

El spike reutilizable es `scripts/spikes/opencode-events.mjs`:

```bash
# contra un server v1 ya corriendo
BASE_URL=http://127.0.0.1:4096 PROMPT="hola" node scripts/spikes/opencode-events.mjs
```

Vuelca cada evento crudo a `.spike-opencode/events-<timestamp>.jsonl` (ignorado por git) y al final imprime tokens/costo por mensaje.


---

## 6. Riesgos

| ID | Riesgo | Impacto | Mitigación |
|---|---|---|---|
| R0 | Confundir el `opencode` del PATH (v2.0.29, API nueva con password) con el server v1 que GitBot necesita | **alto: rompe turnos enteros** | GitBot exige un binario 1.x (`GITBOT_OPENCODE_BIN`, resolución del `.cmd`→`.exe`, descarte de 2.x); `docs/DEV.md` §5 lo deja explícito. Nunca apuntar al v2 |
| R0b | El server v1 queda huérfano si `gitbot` muere sin señal | medio: puerto 4096 tomado por un proceso viejo | GitBot mata el que arrancó; si aparece uno ajeno, lo reutiliza y lo informa (`using the server already running ... (opencode 1.19.3)`) |
| R1 | Campos de eventos cambian entre versiones de OpenCode | medio | Toda lectura de eventos con optional chaining y guardas; degradar a "sin datos" |
| R2 | Modelo sin `limit.context` (proveedores custom) | bajo | Mostrar tokens sin porcentaje |
| R3 | Doble conteo de uso | medio | Clave `messageID`, un único origen (histórico al abrir, deltas en turno) |
| R4 | `npm link` deja el `gitbot` global apuntando al clone roto | alto (día a día) | `npm run check` antes de build; `git stash`/`checkout` para volver; reinstalar global como plan B |
| R5 | Cambios en `threads.json` rompen hilos existentes | medio | Campos opcionales + backup en Fase 0 + lectura tolerante |
| R6 | UI sin store: props cada vez más profundas | bajo-medio | Componentes nuevos con props explícitas; no introducir context global salvo que duela |

---

## 7. Orden, esfuerzo y criterio de corte

| Fase | Esfuerzo | Valor | Depende de |
|---|---|---|---|
| 0 Higiene | 0.5 sesión | base | — **hecha** |
| 1 Uso/contexto | 1–1.5 sesiones | **alto** | 0, S2 |
| 2 Archivos | 1.5 sesiones | **alto** | 0, S1 |
| 3 Subagentes | 1.5–2 sesiones | alto | 1 (para costo por hijo), S3 |
| 4 Perfiles | 1 sesión | medio | 0, S4 |
| 5 Orquestador | 3+ sesiones | opcional | 1–4 |

**Criterio de corte:** al terminar la Fase 3 el panel debe ser la forma normal de trabajar con OpenCode; si no lo es, la Fase 5 no se empieza.

---

## 8. Definición de terminado (por fase)

- `npm run check` verde y `npm run build` genera `dist/` + `dist/ui/`.
- `gitbot start` arranca desde una carpeta de proyecto y el flujo de la fase se prueba a mano de punta a punta.
- `docs/API.md` actualizado con eventos/endpoints nuevos.
- `~/.gitbot` sigue siendo válido para hilos viejos (probar abrir un hilo anterior a la fase).
- Sin regresiones en: permisos (Allow/Deny), stop de turno, reconexión de SSE, cambio de hilo con turno corriendo.
- Una nota corta en `CHANGELOG.md` del fork con lo agregado y lo que quedó pendiente.

---

## 9. No-goals explícitos

- No se implementa un slider de thinking genérico: se usa `variant` **sólo cuando el modelo lo declara**. Donde no hay variantes, los perfiles (Fase 4) son el sustituto honesto.
- No se migra a la API v2 de OpenCode: el fork se queda en v1 + SDK 1.2.15. Migrar es un proyecto aparte.
- No se persiste historial ni uso en GitBot: OpenCode sigue siendo la fuente.
- No se toca el flujo de Claude Code / Codex más allá de que compile.
- No se agrega autenticación: el panel sigue siendo local.
- No se construye un marketplace ni un sistema de equipos: los bots ya existen y alcanzan.

