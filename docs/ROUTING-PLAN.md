# Plan: Routing Groups para GitBot (failover entre proveedores)

Plan para que un bot de GitBot use un **grupo de modelos** en vez de un único `provider/model`, y salte automáticamente al siguiente cuando el actual se queda sin cuota, alcanza su límite diario de tokens o falla con un error recuperable.

Este documento es el contrato de trabajo del feature. Complementa [MASTERPLAN.md](MASTERPLAN.md) (donde ya estaba anotado "perfiles/fallback" como pendiente) y [API.md](API.md) (donde se documentarán los endpoints y eventos nuevos).

---

## 1. Contexto y punto de partida

**Estado actual**

- Un bot tiene un solo modelo: `Bot.model` es el string `"providerID/modelID"` (`src/bot-store.ts`).
- El flujo del prompt: `runAgent()` en `src/start-opencode.ts` (línea ~250) parsea ese string y lo manda en el body de `client.session.promptAsync()` (línea ~335).
- Los errores llegan por dos caminos y hoy terminan igual (`status = "error"`, sin reintento):
  - **Error HTTP sincrónico** de `promptResult.error` (línea ~352): aquí cae un 429 / cuota / rate limit.
  - **Error en el event stream**: evento `session.error` (línea ~822).
- OpenCode por su parte tiene un `session.status` de tipo `retry` (observado, nunca actuado).
- `src/usage.ts` ya enumera todos los providers/models con sus límites (`initContextLimits`, `getModelInfo`) y acumula tokens por turno/hilo — base lista para llevar un ledger de límite diario.
- **No existe ningún mecanismo de retry, fallback ni rotación de modelos** en `src/` ni en `docs/`.

**Fuera de alcance**

- Failover entre agentes (OpenCode ↔ Claude Code ↔ Codex). Solo modelos de OpenCode.
- Orquestación multi-hilo / multi-bot.
- Balanceo por costo. **Todos los modelos en uso son gratuitos** (créditos regalados, sin billetera ni tarjeta asociada): el costo no entra en ninguna decisión, solo la disponibilidad.
- Autenticación ni multiusuario.

**Premisa de gratuidad**

Todos los modelos operativos de todos los proveedores son gratis para el usuario. No hay presupuesto monetario que proteger. Consecuencias:

1. El orden del grupo expresa **calidad**, no precio: primero el modelo más capaz (mayor `limit.context`/`limit.output` según `getModelInfo`), abajo los de respaldo.
2. `dailyTokenBudgets` es opcional: el límite real lo pone el proveedor. Sin budget declarado, el failover es reactivo (429 → saltar); con budget, es anticipado.
3. El ledger de Fase 2 es **por `provider/model`**, no por proveedor: si varios modelos comparten la ventana diaria de un proveedor, el grupo entero puede agotarse igual. Conviene que un grupo mezcle proveedores distintos.
4. El costo reportado por `usage.ts` se sigue mostrando pero no interviene en la rotación.

---

## 2. Principios de diseño

1. **Degradar, nunca romper.** Un bot sin grupo sigue funcionando exactamente como hoy: `model` con `provider/model` tiene prioridad sobre `group:<id>`. Los archivos JSON viejos siguen siendo válidos.
2. **GitBot no duplica estado de OpenCode.** Los límites de contexto se leen de `config.providers()` (ya hecho en `usage.ts`); GitBot solo agrega lo que OpenCode no sabe: cuota agotada y uso diario.
3. **Los eventos son el contrato.** Cada salto de modelo se anuncia con un evento nuevo (`agent_failover`) por el SSE existente (`GET /events?sessionId=`). Sin polling.
4. **Failover reactiva primero, proactiva después.** Fase 1 reacciona al error del proveedor; Fase 2 suma el ledger diario para saltar *antes* de recibir el 429.
5. **Errores clasificados, no adivinados.** Un 429/cuota → rotar. Un 401/modelo inexistente → error terminal, sin rotación infinita.

---

## 3. Diseño del feature

### 3.1 Modelo de datos

Archivo nuevo `~/.gitbot/routing-groups.json`, escrito atómicamente con el mismo patrón de `readCollection`/`writeCollection` de `bot-store.ts`:

```jsonc
{
  "rgroup": [
    {
      "id": "rg_free_daily",
      "name": "Free con límite diario",
      "models": [
        "magpie/glm-5.3-flash-free",
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-4-5"
      ],
      "onError": "rotate",          // rotate | fail (default rotate)
      "dailyTokenBudgets": {        // opcional; keys = "provider/model"
        "magpie/glm-5.3-flash-free": 200000
      },
      "matchers": {                 // opcional; regex extra por proveedor
        "magpie": "quota.*exceeded|daily limit"
      }
    }
  ]
}
```

- `models` en orden de prioridad: el primero disponible es el activo.
- **Fuente de verdad del catálogo: `/v1/models` de Magpie**, no los `provider.models` de `opencode.json` (están desactualizados y ya causaron 404 con modelos inexistentes). Un grupo solo debe listar ids que Magpie sirva, con prefijo `magpie/<id>`.
- `dailyTokenBudgets` permite declarar el límite diario por modelo; si falta y el modelo es "free", se usa el valor del key `defaultFreeBudget` de config (o solo failover reactivo).

**Formato del modelo del bot** — `Bot.model` acepta además `group:<id>`. Resolución:

1. Si `model` empieza con `group:` → resolver al modelo activo del grupo (ver 3.3).
2. Si no → `provider/model` directo (comportamiento actual).

### 3.2 Clasificador de errores (`src/routing.ts`)

Función pura `classifyError(err, providerID): "quota" | "daily" | "auth" | "fatal" | "unknown"`.

- Entrada: el `promptResult.error` (sync) o el payload de `session.error` (stream). Se inspecciona status HTTP + `message`.
- **quota**: HTTP 429, `retry-after` presente, mensajes tipo `rate limit`, `quota exceeded`, `insufficient_credits`, 402/403 de paywall.
  - Si `retry-after` < 5 min → cuota transitoria: opción de esperar y reintentar el mismo modelo antes de rotar (configurable en el grupo: `shortRetryMinutes`).
- **daily**: mensajes tipo `daily limit`, `monthly limit`, o matcheo del `matchers` del grupo.
- `provider`: HTTP 405/408/5xx (endpoint muerto, gateway caído). El modelo no tiene culpa; el siguiente proveedor puede responder. También rota.
- `model`: 404 o "model not found / knows no model / context length". El siguiente modelo puede existir o tener más contexto. **Rota y muestra el error** (decisión del usuario).
- **auth**: 401/403 con credenciales → `fatal`, no rota (rotar no lo arregla).
- **fatal**: modelo inexistente, 400 malformado, 5xx persistente tras N intentos → no rota.
- **unknown**: no rota en Fase 1 (evitar saltos por errores irrelevantes); logging para afinar matchers.

### 3.3 Estado del grupo

- `SessionStore` (en `server-common.ts`) gana `routingState?: { groupId, index }`.
- Modelo efectivo = `group.models[index]`, **clamp** al rango.
- El salto se persiste en el thread (`ThreadStore.routingState`) para que el siguiente turno arranque donde quedó — el proveedor agotado no se reintenta hasta el día siguiente (el ledger lo resetea) o reset manual.

### 3.4 Flujo de failover

1. `runAgent()` recibe el modelo efectivo resuelto del grupo.
2. Error → `classifyError()`.
   - `quota`/`daily` → `index++`; si `index` agotó la lista → error terminal "routing group agotado" con el detalle de cada modelo y su motivo (para mostrar en UI).
   - `fatal`/`auth`/`unknown` → error actual, sin cambio.
3. Al rotar: emitir evento **`agent_failover`** `{ from, to, reason }` por SSE, actualizar `store.model` lógico del thread, y re-mandar el prompt con el nuevo modelo (mismo turno, misma sesión — el historial vive en OpenCode, el modelo se cambia por prompt, no requiere sesión nueva).
4. Confirmación: si el nuevo prompt también falla, el flujo repite desde el paso 2 con el nuevo índice.

### 3.5 Ledger de límite diario (`src/usage.ts`)

- Nuevo módulo `src/routing-ledger.ts` (o sección en `usage.ts`): acumula tokens usados por `(provider/model, día UTC)` a partir de los `UsageSnapshot` que ya llegan por `message.updated` (misma vía que `accumulateUsage`).
- Persistencia: `~/.gitbot/ledger.json`, con purge de días viejos al cargar.
- Check **proactivo** antes de cada prompt: si el modelo del grupo tiene `dailyTokenBudgets` declarado y el ledger dice que ya lo superó → saltarlo directamente sin esperar el 429 (se anota el salto con motivo `daily_budget`).
- Si no hay budget declarado, el límite solo se aprende de forma reactiva (el 429 del proveedor).

### 3.6 API y eventos

Endpoints nuevos (detalle en API.md al implementar):

- `GET /routing-groups` — lista.
- `POST /routing-groups` — crear.
- `PUT /routing-groups/:id` — editar (incluye reordenar `models`).
- `DELETE /routing-groups/:id` — borrar (si un bot lo usa → 409 con lista de bots).
- `POST /routing-groups/:id/reset` — reset manual del ledger del día (para probar de nuevo un modelo agotado).

Eventos nuevos por SSE:

- `agent_failover` `{ from, to, reason }` — salto de modelo en vivo.
- `agent_failover_exhausted` `{ attempts: [{model, reason}] }` — grupo agotado.

### 3.7 UI

- En el editor de bot: selector de modelo con dos pestañas — "Modelo único" (como hoy) y "Grupo" (lista ordenable de modelos, crear/editar grupo inline).
- Badge en el header del thread cuando el bot usa grupo: `glm-5.3-flash-free · 2/3 del grupo` + tooltip con el motivo del último salto.
- Toast o línea en el chat por cada `agent_failover` ("cuota agotada → saltando a gpt-4o-mini").

---

## 4. Fases

Cada fase = estado usable y demostrable, `npm run check` verde, con guion de aceptación manual.

### Fase 0 — Fundaciones (sin comportamiento nuevo)

**Estado: implementada** (`src/routing.ts`, resolver en `runAgent`, `npm run check` verde).

- `src/routing.ts` con tipos (`RoutingGroup`, `classifyError`) y carga/guardado de `routing-groups.json` con el patrón de `bot-store.ts`.
- Resolver `group:<id>` → modelo efectivo en el punto donde hoy se parsea `store.model` (start-opencode ~292), con fallback a error claro si el grupo no existe.
- **Aceptación:** bot con `model: "group:<id>"` usa el primer modelo del grupo; todo lo demás idéntico a hoy.

### Fase 1 — Failover reactivo (el core)

**Estado: implementada** (`sendTurnPrompt`/`tryFailover`/`handleSessionError` en `start-opencode.ts`, eventos en API.md).

- Clasificador conectado en los dos puntos de error de `runAgent` (llamada `promptAsync` y `session.error`).
- Rotación de índice + re-prompt en el mismo turno + evento `agent_failover` + error terminal de grupo agotado.
- Persistencia del índice en el thread.
- El failover por `session.error` solo reintenta si el turno no emitió texto todavía: re-promptear después duplicaría el mensaje del usuario en el historial.
- La UI muestra cada salto como aviso (`agent_failover`) y el grupo agotado (`agent_failover_exhausted`), con modelo y detalle del error.
- **Aceptación:** forzar un 429 (modelo free agotado o header simulado con un provider de prueba) → el prompt se completa con el segundo modelo del grupo y la UI muestra el salto. Bot de un solo modelo sigue fallando igual que hoy.

### Fase 2 — Ledger diario y salto proactivo

**Estado: implementada** (`src/routing-ledger.ts`, `skipSpentModels`, `POST /routing-groups/:id/reset`, `GET /routing-groups`).

- `src/routing-ledger.ts` con persistencia y purge diario.
- Check pre-prompt contra `dailyTokenBudgets`; salto anticipado con motivo `daily_budget`.
- Endpoint `POST /routing-groups/:id/reset`.
- Sin budget declarado no hay ledger: solo failover reactivo (decisión cerrada).
- **Aceptación:** con budget chico de prueba, el segundo prompt del día ya arranca con el modelo 2 sin intentar el 1; tras `reset`, vuelve al modelo 1.

### Fase 3 - API completa + UI

**Estado: implementada** (CRUD, `GET /models/catalog`, pestañas en el bot, badge `n/m`, selector vivo).

- CRUD de `routing-groups` (con 409 al borrar en uso) y `GET /models/catalog`.
- Editor de bot con pestañas, badge `n/m del grupo`, avisos de failover como tarjeta visible.
- Selector de modelos alimentado por el catálogo vivo de Magpie (`/v1/models`), no por `opencode.json`.
- Los ids se validan contra el catálogo al crear y al agregar modelos a un grupo existente; un modelo ya guardado queda exento para poder editar budgets/orden aunque Magpie lo oculte o lo retire. Si Magpie no responde, se permite guardar.
- Documentado en API.md y ARCHITECTURE.md.
- **Aceptación:** crear grupo de 3 modelos desde la UI, asignarlo a un bot, ver el badge y los saltos sin tocar config a mano.

### Fase 4 - Editar y rebobinar mensajes

**Estado: implementada** (`POST /threads/:id/revert`, `POST /threads/:id/unrevert`, acciones en el chat).

- El historial de OpenCode expone el `id` de cada mensaje. La UI ofrece **Edit & rewind** y **Rewind to here** en los mensajes del usuario. `Edit` abre la burbuja como input en su lugar: Enter envía, Esc cancela.
- `revert` deja el corte en staging. El siguiente prompt lo confirma: desaparecen el mensaje objetivo y todo lo posterior, y OpenCode revierte los cambios de archivos hechos desde ese punto.
- Si el usuario no envía nada, salir del hilo o desmontar el chat llama a `unrevert` y cancela el corte. La UI pide confirmación porque el envío también revierte archivos.
- Solo OpenCode: Claude Code y Codex no tienen equivalente y no muestran las acciones. Un turno corriendo bloquea el corte con `409`.
- **Aceptación:** editar un mensaje de usuario, cambiar el texto y enviarlo; el mensaje original y su respuesta desaparecen, el nuevo turno arranca desde ahí y el historial recargado coincide.

---

## 5. Riesgos y decisiones abiertas

| Riesgo | Mitigación |
|---|---|
| Doble prompt en failover → doble consumo/costo | El re-prompt reemplaza el turno fallido; verificar con `session.messages` que el turno fallido no acumule usage (los snapshots vacíos ya se deduplican en `usage.ts`). |
| Bucle de saltos con grupo de 1 modelo | Si `models.length === 1`, tratar `quota/daily` como error terminal normal. |
| Matcher de error demasiado laxo → rota por un bug | `unknown` no rota en Fase 1; matchers por proveedor configurables; log de todo error no clasificado. |
| `promptAsync` es fire-and-forget | El error sync de 429 ocurre al enviar; el re-prompt es otra llamada `promptAsync`. Verificar que OpenCode acepte re-prompt tras un prompt fallido en la misma sesión (prueba en Fase 1 antes de construir el resto). |

**Decisiones cerradas**

1. Reintento corto con `retry-after`: no. Rotar directo; `shortRetryMinutes` queda como opción futura.
2. El salto **persiste** en el thread; el reset (Fase 2) lo devuelve al primer modelo.
3. Grupos **globales**, referenciados por `group:<id>` desde cada bot.
4. Orden del grupo: manual. Un botón "ordenar por capacidad" puede llegar en Fase 3; nunca automático al guardar.
5. **Budget: reactivo por defecto.** El ledger diario es opcional y solo actúa si el grupo declara `dailyTokenBudgets`; los límites reales de Magpie no son públicos.
6. 404 / modelo inexistente: rota y muestra el error en el chat (ya implementado).