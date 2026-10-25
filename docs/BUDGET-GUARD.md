# Guard de presupuesto y contexto

**Estado:** propuesto, listo para implementar  
**Fase:** 6 (posterior a Fases 0–4; no depende de la Fase 5)  
**Ámbito:** OpenCode únicamente  
**Origen:** análisis de la sesión `BounceFinder` del 23–24 de octubre de 2026

---

## 1. Problema

La barra de uso actual muestra datos correctos, pero no ayuda a **decidir**:

- El costo casi siempre es `$0` porque `magpie` no reporta precio. La métrica útil son los tokens, no los dólares.
- El “turno” que muestra la barra es en realidad el último mensaje del asistente, no la suma del turno completo.
- El contexto se muestra como porcentaje del límite que declara el proveedor. Si ese límite es incorrecto (por ejemplo, declara 1M cuando el modelo real corta en 200k), el porcentaje tranquiliza cuando no debería.
- No hay ningún aviso cuando un hilo acumula decenas de millones de tokens.
- No hay una acción directa para bajar el contexto sin abandonar el hilo.

### Línea base medida

Sesión `ses_e99d9b00cffe4Xo5RQnD1B1u3w`, proyecto `BounceFinder`:

| Métrica | Valor |
|---|---:|
| Duración | ~45 h |
| Prompts del usuario | 22 |
| Pasos del orquestador | 227 |
| Subagentes | 31 sesiones, 154 pasos |
| Peticiones al modelo (aprox.) | 381 |
| Tokens totales | **43.724.890** |
| Input nuevo | 2.875.860 |
| Cache read | 40.734.464 (**93,4 %**) |
| Output | 102.586 (**0,23 %**) |
| Reasoning | 11.980 |
| Costo reportado | **$0** |
| Contexto máximo observado | 266.771 de 1.048.576 (25 %) |
| Promedio por petición | ~114.800 tokens |

Los totales de la tabla incluyen orquestador + subagentes; input/cache/output son la suma de ambos.

El gasto no vino del output: vino de **reenviar contexto muchas veces**. Cualquier guard tiene que atacar cantidad de pasos y tamaño de contexto, no “respuestas largas”.

Dos datos más que justifican la feature:

- Los turnos 1–17, casi todos pruebas de una palabra (`ok`, `pong`), consumieron 9.691.781 tokens: **28,6 % del orquestador** y 22,2 % del total con subagentes.
- El contexto máximo fue 267k. Si el modelo real tiene ventana de 200k, ya se estaba perdiendo contexto en silencio mientras OpenCode creía tener 1M.

---

## 2. Objetivo

Que el usuario pueda ver el consumo real de un hilo y actuar **antes** de que se vuelva caro:

1. Ver tokens de turno, hilo (incluidos subagentes) y ventana de contexto sin ambigüedad.
2. Ver la tasa de cache, porque explica por qué 43M brutos no equivalen a 43M de input nuevo.
3. Recibir avisos configurables al acercarse a un límite de contexto o de gasto por turno.
4. Poder **compactar el hilo en su lugar** con una acción explícita.
5. Poder crear un hilo nuevo sin arrastrar 45 horas de historia.

### No objetivos

- Comprimir prompts o tool outputs automáticamente. GitBot no va a reescribir el contexto de OpenCode.
- Estimar dólares cuando el proveedor reporta `$0`. Se muestra “reportado”, no un precio inventado.
- Bloquear o abortar turnos por defecto. Un guard que corta trabajo sin permiso es peor que el gasto.
- Reemplazar la compactación nativa de OpenCode.
- Cambiar la configuración global del usuario sin confirmación.
- Persistir historial de usage en GitBot. OpenCode sigue siendo la fuente de verdad.

---

## 3. Decisiones de diseño

1. **Tokens primero, dólares después.** El presupuesto principal se expresa en tokens. El costo se muestra solo si el proveedor lo reporta.
2. **Avisos suaves por defecto; corte duro opt-in.** La UI avisa, no interrumpe. Un “hard stop” queda para una fase posterior y desactivado por defecto.
3. **Compactar en sitio, no bifurcar.** `session.summarize` de OpenCode ya existe y mantiene el `sdkSessionId`. Crear un hilo nuevo con resumen es un flujo aparte, con más superficie de error, y no es necesario para el MVP.
4. **El límite asumido es una ayuda visual, no cambia OpenCode.** Si el proveedor declara mal la ventana, GitBot puede avisar con un `contextCap` local, pero la compactación automática de OpenCode sigue dependiendo de `opencode.json`. Hay que arreglar las dos cosas por separado.
5. **La UI no inventa datos.** Si no hay ventana conocida, se muestra `—`, no `0 %`.
6. **Nada de estado global nuevo.** El guard vive en `usage-bar.tsx` + props de `chat.tsx`, como el resto del panel.

---

## 4. Experiencia de usuario

### 4.1 Barra compacta

Reemplazar los chips actuales por tres bloques, en este orden:

```text
contexto 25% · 267k/1M     turno 8.3M     hilo 43.7M · 93% cache
```

Reglas:

- `contexto`: usa el límite efectivo (ver §5.3). Si la ventana es desconocida, `contexto —`. Si se superó el límite asumido, se permite `>100 %` y se pinta rojo.
- `turno`: se muestra solo mientras hay un turno en curso o hasta que el usuario cambie de hilo/recargue. Es la **suma acumulada** de todos los eventos `usage` del turno, incluidos subagentes.
- `hilo`: total acumulado del hilo, incluyendo subagentes.
- `cache`: `cacheRead / (input + cacheRead + cacheWrite)` del total del hilo. Si el denominador es 0, se oculta.
- Costo: si `cost > 0`, agregar `· $X` al chip de hilo. Si es `0`, no ocupar espacio en la barra compacta.
- El chip de contexto mantiene el tooltip actual, ampliado con “límite del proveedor” vs “límite asumido”.

### 4.2 Panel expandido

Además de las filas actuales, agregar:

| Fila | Valor |
|---|---|
| Cache hit | `93,4 %` |
| Turno actual | tokens totales, input, output, cache |
| Pasos del turno | cantidad de eventos `usage` del turno (aproximado) |
| Costo reportado | `$0` con nota “el proveedor no informa precio” |
| Límite efectivo | `200k asumido` o `1M del proveedor` |

No agregar gráficos ni históricos por turno. El objetivo es responder “¿cuánto llevo y cuánto me queda?”, no construir un dashboard.

### 4.3 Avisos

Un solo banner, no una pila. Se muestra encima del compositor, debajo de la barra.

Niveles:

| Condición | Nivel | Texto |
|---|---|---|
| `contexto >= 60 %` del límite efectivo | ámbar | “Contexto al 60 %. Conviene compactar o abrir un hilo nuevo.” |
| `contexto >= 85 %` | rojo | “Contexto al 85 %. OpenCode puede empezar a compactar o truncar.” |
| `contexto > 100 %` del `contextCap` | rojo | “Superaste tu límite asumido. El proveedor declara X; tu tope es Y.” |
| `turno >= 2M` tokens | ámbar | “Este turno lleva 2M tokens. Revisá si hace falta seguir.” |
| `turno >= 5M` tokens | rojo | “Este turno lleva 5M tokens. Considerá detenerlo.” |

Acciones del banner:

- **Compactar hilo** (solo OpenCode, no mientras corre un turno).
- **Nuevo hilo** (reutiliza `onNewThread`).
- **Seguir** / cerrar: oculta el banner para ese nivel y ese hilo.

El aviso de contexto se vuelve a mostrar si el nivel sube (ámbar → rojo) o si el contexto baja y vuelve a subir. El de turno se muestra una vez por turno y nivel.

No bloquear el envío. No abrir modales automáticos.

### 4.4 Compactar hilo

Flujo:

1. El usuario pulsa **Compactar hilo**.
2. Confirmación: “Compactar resume el historial y libera contexto. Puede perder detalle y consume tokens. ¿Seguir?”
3. Botón en estado `Compactando…`, deshabilitado.
4. `POST /threads/:id/compact`.
5. Al volver `200`:
   - toast “Hilo compactado. La ventana se recalcula en el próximo turno”.
   - el contexto pasa a `—` / “recalculando”.
   - el total acumulado del hilo **no baja**.
   - el banner se limpia.
6. Si falla: mensaje de error, sin tocar el estado local.

La acción también aparece en el panel expandido, no solo en el banner.

### 4.5 Ajustes

Valores por defecto, sin pantalla de settings en el MVP:

```json
{
  "contextWarnPct": 60,
  "contextHighPct": 85,
  "turnWarnTokens": 2000000,
  "turnHighTokens": 5000000,
  "contextCaps": {
    "magpie/auto/deepseek-v4.1-flash-1017": 200000
  }
}
```

Persistencia: `localStorage["gitbot.usageGuard.v1"]`. En Fase C se agrega un editor pequeño dentro del panel expandido. Hasta entonces, se puede editar a mano desde DevTools o dejar los defaults.

`contextCaps` va por modelo, no global: cambiar de modelo no debe heredar un tope que no corresponde.

---

## 5. Datos y fórmulas

### 5.1 Totales

Se reutiliza `UsageSnapshot` de `src/usage.ts`:

```ts
total = input + output + reasoning + cacheRead + cacheWrite
```

El total del hilo es la suma de mensajes del asistente, incluyendo sesiones hijas. El live ya lo hace (`accumulateUsage`); el seed histórico **todavía no** y hay que corregirlo en esta fase.

#### Deuda actual: el seed ignora subagentes

Hoy `loadHistoricalUsage` recorre solo la sesión raíz. Por eso, tras recargar el hilo de BounceFinder, GitBot muestra 33,8M en vez de 43,7M: desaparecen los 9,9M de los 31 subagentes hasta que corra otro turno.

Corrección (refactor de `sumHistoricalUsage` para acumular sobre un total y un `Set` compartidos):

```ts
async function walkSession(
  client: any,
  sessionId: string,
  total: UsageSnapshot,
  seenMessages: Set<string>,
  seenSessions: Set<string>,
): Promise<void> {
  if (seenSessions.has(sessionId)) return;
  seenSessions.add(sessionId);

  await sumHistoricalUsage(client, sessionId, total, seenMessages);

  const children = await client.session.children({ path: { id: sessionId } })
    .then((r: any) => r.data ?? [])
    .catch((err: any) => {
      console.warn(`[usage] children failed for ${sessionId}:`, err.message);
      return [];
    });

  for (const child of children) {
    await walkSession(client, child.id, total, seenMessages, seenSessions);
  }
}
```

Reglas:

- `seenMessages` se comparte entre todo el árbol: un mensaje se cuenta una sola vez.
- `seenSessions` evita ciclos y doble visita.
- Si un hijo falla, se sigue con el resto: degradar, no romper.
- La **ventana** se calcula solo con la sesión raíz. Los tokens de un subagente suman al total, no al contexto del padre.
- El seed se sigue haciendo una vez por proceso; 31 hijos son 31 requests extra, aceptable para un hilo largo. Si un hilo tiene cientos de subagentes, evaluar paralelizar por nivel con un límite (4–8 concurrentes).
- Test de aceptación: el hilo de BounceFinder debe mostrar **43.724.890** después de recargar, no 33,8M.

### 5.2 Turno

Hoy `usage-bar.tsx` hace `setTurnUsage(event)` con cada evento `usage`, por lo que el “turno” termina siendo el último mensaje. Cambiar a acumulación:

```ts
type TurnState = UsageSnapshot & { steps: number };

onTurnUsage(event) {
  setTurn(prev => add(prev, event.usage, +1));
}
```

- Sumar **todos** los eventos `scope: "turn"`, incluidos los que traen `parent_tool_use_id` (subagentes).
- Reiniciar el estado al empezar un turno nuevo (`streaming` pasa de `false` a `true`) y al cambiar de hilo.
- No reiniciar cuando llega `scope: "session"` al final; ese reporte reemplaza el total del hilo, no el del turno.
- `steps` es la cantidad de eventos, no una métrica oficial de OpenCode. Etiquetarlo como aproximado.

### 5.3 Contexto y límite efectivo

La ventana sigue siendo la del último mensaje del asistente con `output > 0`:

```ts
used = input + output + reasoning + cacheRead + cacheWrite
```

`limit` viene de `config.providers()` (`usage.ts`). El límite efectivo para la UI:

```ts
const providerLimit = report.context?.limit ?? null;
const cap = caps[report.model ?? ""] ?? null;
const effectiveLimit =
  providerLimit && cap ? Math.min(providerLimit, cap) : cap ?? providerLimit;

const pct = effectiveLimit && used > 0
  ? Math.round((used / effectiveLimit) * 100)
  : null;
```

Si `effectiveLimit` es un `contextCap`, la UI debe decirlo: “límite asumido”, no “límite del modelo”.

Esto no cambia el comportamiento de OpenCode. Solo cambia el semáforo de GitBot.

### 5.4 Cache hit

```ts
const cacheHitPct = cacheRead + input + cacheWrite > 0
  ? Math.round((cacheRead / (input + cacheRead + cacheWrite)) * 1000) / 10
  : null;
```

Mostrar un decimal solo en el panel expandido. En la barra compacta, entero.

### 5.5 Costo

- Mostrar el costo **reportado**.
- Si `cost === 0`, el panel expandido dice `$0 reportado` con tooltip “el proveedor no informa precio; no implica que sea gratis”.
- No calcular costo a partir de una tabla de precios externa en esta fase.
- Un presupuesto en dólares solo se habilita si `cost > 0` de forma consistente.

---

## 6. Contrato HTTP

### 6.1 Endpoint nuevo

```http
POST /threads/:id/compact
```

Sin body.

Respuestas:

| Código | Caso | Body |
|---|---|---|
| `200` | compactado | `{ "compacted": true }` |
| `404` | hilo inexistente | `{ "error": "Thread not found" }` |
| `400` | no es OpenCode | `{ "error": "Compaction is only available for OpenCode threads" }` |
| `400` | sin sesión todavía | `{ "error": "Thread has no OpenCode session yet" }` |
| `409` | turno en curso | `{ "error": "Wait for the running turn to finish" }` |
| `502` | OpenCode falla o devuelve `false` | `{ "error": "<detalle>" }` |

Implementación en `src/bot-routes.ts`, **antes** del bloque genérico `/threads/:id`:

```ts
const compactId = matchId(path, "/threads/", "/compact");
if (compactId && method === "POST") {
  const thread = getThread(compactId);
  if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
  if (!thread.sdkSessionId) {
    jsonError(res, 400, "Thread has no OpenCode session yet");
    return true;
  }
  if (thread.agent !== "opencode") {
    jsonError(res, 400, "Compaction is only available for OpenCode threads");
    return true;
  }
  const running = [...sessions.values()].some(
    s => s.threadId === thread.id && s.status === "running"
  );
  if (running) {
    jsonError(res, 409, "Wait for the running turn to finish");
    return true;
  }

  const client = await getOpencodeClientForDir(thread.repoPath);
  const model = getBot(thread.botId)?.model;
  let modelParam: { providerID: string; modelID: string } | undefined;
  if (model) {
    const slash = model.indexOf("/");
    if (slash !== -1) {
      modelParam = {
        providerID: model.slice(0, slash),
        modelID: model.slice(slash + 1),
      };
    }
  }

  try {
    const result = await client.session.summarize({
      path: { id: thread.sdkSessionId },
      ...(modelParam ? { body: modelParam } : {}),
    });
    if (result?.data !== true) {
      jsonError(res, 502, "OpenCode declined to compact the session");
      return true;
    }
    // No hay turno corriendo, pero puede quedar un store cerrado.
    const store = [...sessions.values()].find(s => s.threadId === thread.id);
    if (store) invalidateLiveWindow(store.gitbotId);
    invalidateThreadUsage(`thread:${thread.id}`);
    jsonOk(res, { compacted: true });
  } catch (err: any) {
    jsonError(res, 502, err?.message ?? "Compaction failed");
  }
  return true;
}
```

`session.summarize` existe en el SDK 1.2.15 (`SessionSummarizeData`) y devuelve `boolean`. Si en el futuro el server no lo soporta, el `catch` lo convierte en `502`, no en un crash.

### 6.2 Invalidación de usage

Hay dos invalidaciones distintas. No mezclarlas o el total del hilo puede bajar a mitad de turno.

Agregar a `src/usage.ts`:

```ts
/** Solo la ventana: el próximo GET usa el seed que ya existe. */
export function invalidateThreadWindow(threadKey: string): void {
  lastWindowUsed.delete(threadKey);
}

/** Seed + ventana; se usa al compactar sin turno corriendo. */
export function invalidateThreadUsage(threadKey: string): void {
  seededTotals.delete(threadKey);
  lastWindowUsed.delete(threadKey);
}
```

Reglas:

- **Compactación manual** (endpoint): no hay turno corriendo, así que se puede borrar el seed. El próximo `GET /threads/:id/usage` lo reconstruye desde OpenCode. Validar que el total no baje; si OpenCode deja de listar mensajes viejos al compactar, conservar el último total conocido como piso hasta reiniciar.
- **Compactación automática durante un turno** (evento SSE): borrar solo la ventana (`invalidateThreadWindow`). Borrar `seededTotals` haría que el total visible pierda la historia hasta el próximo re-seed.
- No borrar `liveTotals` de un turno ya cerrado: el total acumulado debe seguir siendo monótono.
- `invalidateLiveWindow` borra la ventana del store vivo; junto con `invalidateThreadWindow` evita el fallback a la ventana vieja del seed.

### 6.3 Detectar compactación al re-sembrar

Si GitBot se reinicia después de compactar, `loadHistoricalUsage` no debe resucitar la ventana vieja. En `lastMessageWindowUsed`:

- localizar el último mensaje del asistente con `output > 0`;
- si existe un `part.type === "compaction"` en un mensaje **posterior** a ese asistente, devolver `0` (ventana desconocida);
- en caso contrario, devolver la ventana como hoy.

Así, tras compactar y reiniciar, la UI muestra `—` hasta el próximo turno, en vez de 267k obsoletos.

### 6.4 Evento SSE nuevo

En `src/start-opencode.ts`, al recibir `session.compacted` para la sesión raíz:

```ts
if (type === "session.compacted" && !isChildEvent) {
  invalidateLiveWindow(store.gitbotId);
  if (store.threadId) invalidateThreadWindow(`thread:${store.threadId}`);
  emitEvent(store, "compacted", {});
}
```

`invalidateLiveWindow` es un helper nuevo:

```ts
export function invalidateLiveWindow(gitbotId: string): void {
  lastWindowUsed.delete(gitbotId);
}
```

El evento `compacted` no cierra el turno ni altera totales. La UI lo usa para poner el contexto en “recalculando” y volver a pedir `/threads/:id/usage`.

Si la compactación se dispara desde el botón, el endpoint ya invalidó el seed; el evento puede llegar después y la invalidación es idempotente.

### 6.5 API de cliente UI

Agregar a `ui/app/lib/api.ts`:

```ts
export async function compactThread(threadId: string): Promise<void> {
  const res = await fetch(`/threads/${threadId}/compact`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json()).error ?? "Compaction failed");
}
```

---

## 7. Cambios por archivo

### `ui/app/components/usage-bar.tsx`

- Convertir `turnUsage` en un acumulador `TurnState`.
- Calcular `cacheHitPct`.
- Calcular `effectiveLimit` con `contextCaps`.
- Exponer al padre, vía prop, el estado del guard:

```ts
interface UsageGuardState {
  level: "none" | "warn" | "high";
  reason: "context" | "turn" | null;
  contextPct: number | null;
  turnTokens: number;
  canCompact: boolean;
}
```

- Mantener el EventSource actual; no abrir uno nuevo.
- Emitir `onGuardChange(state)` cada vez que cambie el nivel.
- No renderizar el banner acá: el banner necesita `onNewThread` y la llamada a `compactThread`, que viven en `chat.tsx`.

### `ui/app/components/chat.tsx`

- Estado `guard` y `guardDismissed`.
- Renderizar `<BudgetBanner>` entre `UsageBar` y el `<form>`.
- `onNewThread` ya existe; pasarlo al banner.
- `handleCompact()` llama `compactThread(thread.id)`, muestra toast/error y refresca usage.
- No permitir compactar si `streaming || turnActiveRef.current`.
- Escuchar `compacted` en `openStream` y actualizar el estado local.
- Al cambiar de hilo, limpiar `guardDismissed`.

### `ui/app/components/budget-banner.tsx` (nuevo)

Componente presentacional:

```tsx
<BudgetBanner
  level={guard.level}
  reason={guard.reason}
  message={...}
  canCompact={guard.canCompact}
  compacting={compacting}
  onCompact={handleCompact}
  onNewThread={onNewThread}
  onDismiss={dismiss}
/>
```

Sin lógica de cálculo. Solo render y accesibilidad (`role="status"` para ámbar, `role="alert"` para rojo).

### `ui/app/globals.css`

Clases nuevas:

- `.budget-banner`, `.budget-banner.is-warn`, `.budget-banner.is-high`
- `.budget-banner-copy`, `.budget-banner-actions`
- `.usage-bar-cache`
- `.usage-bar-flat` (para el chip de costo cuando sea necesario)

Reusar tokens existentes (`--amber`, `--danger`, `--ok`, `--surface`, `--border`). No agregar colores nuevos.

### `src/usage.ts`

- `invalidateThreadUsage`.
- `invalidateThreadWindow`.
- `invalidateLiveWindow`.
- `loadHistoricalUsage` recorre el árbol de `session.children` y acumula subagentes una sola vez.
- Detección de compactación en `lastMessageWindowUsed` (solo sesión raíz).
- Tests de la fórmula de ventana y del recorrido de hijos.

### `src/start-opencode.ts`

- Manejo de `session.compacted`.
- Export de `invalidateLiveWindow` si se necesita desde tests.
- No tocar `finalizeTurn` salvo que el evento `compacted` llegue en medio de un turno: en ese caso, no finalizar.

### `src/bot-routes.ts`

- Ruta `POST /threads/:id/compact`.
- Import de `invalidateThreadUsage`.
- Parseo de modelo reutilizable (extraer helper si hoy está duplicado en `/usage`).

### `docs/API.md`

Agregar:

- fila del endpoint en la tabla de Threads;
- sección de errores;
- evento `compacted` en la tabla de `/events`;
- nota de que `context.used = 0` significa “desconocido/recalculando”, no “vacío”.

### `README.md`

Opcional: una nota corta en la sección de uso sobre compactar y límites reales. No hace falta duplicar toda la spec.

---

## 8. Configuración del límite real

Esto es **independiente** del guard de GitBot y es la parte que más impacta el gasto.

En `%USERPROFILE%\.config\opencode\opencode.json` (Windows) o `~/.config/opencode/opencode.json`:

```json
"auto/deepseek-v4.1-flash-1017": {
  "name": "DeepSeek V4.1 Flash 1017 — routing group",
  "tool_call": true,
  "limit": {
    "context": 200000,
    "output": 32768
  }
}
```

Reglas:

- Cambiar `context` a **200000** solo si el modelo real corta ahí. Si el routing group realmente soporta 1M, bajarlo es una decisión de presupuesto, no una corrección.
- Bajar también `output`. Un `output` de 393216 con un `context` de 200000 es incoherente y puede hacer que OpenCode calcule mal la ventana o que el proveedor rechace la petición. `32768` es un valor conservador; usar el máximo real del modelo si se conoce.
- Reiniciar el server de OpenCode y GitBot: `initContextLimits` cachea los límites una vez por proceso.
- Verificar con `GET /threads/:id/usage` que `context.limit` sea `200000`.
- Si se deja el límite del proveedor en 1M, OpenCode **no** compactará a 200k. El `contextCap` de GitBot solo pinta el semáforo; no cambia la compactación automática.
- No editar el archivo automáticamente desde GitBot. Es configuración global del usuario y afecta a todos los proyectos.

Riesgo de bajar el límite: compactaciones más frecuentes y pérdida de detalle. Es preferible a que el proveedor trunque en silencio, pero debe ser una decisión explícita.

---

## 9. Flujo completo

```text
Usuario envía un prompt
  → turno arranca, UsageBar reinicia TurnState
  → por cada mensaje del asistente (incluidos subagentes) llega usage
  → TurnState suma; contexto usa solo mensajes del padre
  → si turno >= umbral o contexto >= umbral, chat muestra banner
  → usuario puede:
      a) seguir
      b) abrir hilo nuevo (onNewThread)
      c) compactar (POST /threads/:id/compact)
  → compactar:
      OpenCode summarize
      → invalidar seed + ventana
      → responder 200
      → UI refresca usage: contexto —
      → próximo mensaje del asistente reporta la ventana real
```

---

## 10. Casos borde

| Caso | Comportamiento |
|---|---|
| Compactar mientras corre un turno | `409`; el botón está deshabilitado en la UI |
| Hilo sin `sdkSessionId` | `400`; el botón no se muestra |
| Hilo de Claude/Codex | `400`; la barra de usage ya devuelve `null` |
| `session.summarize` devuelve `false` | `502`; no se invalida nada |
| Compactación automática durante un turno | evento `compacted`; contexto a desconocido; el turno sigue |
| Varias pestañas | cada una recibe el evento; el dismiss es local a la pestaña |
| GitBot se reinicia tras compactar | el seed detecta el part de compactación y devuelve ventana desconocida |
| Proveedor reporta `$0` | no se muestra chip de costo en la barra; el panel aclara “reportado” |
| Límite del proveedor desconocido | contexto `—`; no se calcula porcentaje |
| `contextCap` menor que el usado | se muestra `>100 %` y banner rojo; no se recorta el número |
| Subagente consume mucho | suma al turno y al hilo; no cambia la ventana del padre |

---

## 11. Fases de implementación

### Fase A — Consumo real (1–1,5 días)

- Seed histórico con subagentes (corrige el 33,8M → 43,7M).
- Acumular turno.
- Cache hit.
- Límite efectivo con `contextCaps` por modelo.
- Banner de contexto y de turno.
- Estilos y accesibilidad.

**Corte:** con la sesión de BounceFinder abierta y después de recargar, la barra muestra `contexto 25% · 267k/1M`, `hilo 43.7M · 93% cache`; al poner un cap de 200k, pasa a `>100 %` y aparece el banner.

### Fase B — Compactar (1–2 días)

- `POST /threads/:id/compact`.
- Invalidación de seed/ventana.
- Evento `compacted` en SSE.
- Botón + confirmación + toast.
- Detección de compactación al re-sembrar.
- Tests de ruta y de ventana.

**Corte:** compactar un hilo real; el total no baja; el contexto queda `—`; el siguiente mensaje reporta una ventana menor.

### Fase C — Opcional (2–3 días)

- Editor de umbrales en el panel expandido.
- Presupuesto por hilo (`Thread.budgetTokens?`) con validación en `PATCH /threads/:id`.
- Hard stop opt-in: al superar el presupuesto, `POST /sessions/:id/abort` con confirmación previa. Si se implementa, que sea server-side y apagado por defecto.
- “Nuevo hilo con traspaso”: resumen visible + primer mensaje del hilo nuevo. Requiere validar la forma del resumen de OpenCode; no es parte del MVP.

No empezar Fase C hasta que A y B se usen en un hilo real.

---

## 12. Pruebas

### Unitarias

- `cacheHitPct`: 0, 50 %, 93,4 %, denominador 0.
- `effectiveLimit`: sin cap, cap menor, cap mayor, límite nulo.
- `TurnState`: suma de varios eventos, incluidos subagentes; reset al inicio.
- Umbrales: no repetir el mismo nivel; volver a avisar al subir de nivel.
- `lastMessageWindowUsed`: último asistente normal; compactación posterior → 0.
- Seed de árbol: raíz + hijos + nietos sin duplicar mensajes; un hijo que falla no aborta el resto.

### Integración

- `POST /threads/:id/compact` con mock de `session.summarize`:
  - 200 y `{ compacted: true }`;
  - 409 con turno corriendo;
  - 400 para agente no OpenCode;
  - 502 cuando `summarize` lanza o devuelve `false`.
- `GET /threads/:id/usage` después de compactar: total igual, `context.used === 0`.
- Evento `compacted` no dispara `done` ni duplica usage.

### Manual

1. Abrir el hilo de BounceFinder y recargar la página.
2. Confirmar `43.7M` (no 33,8M), `93 % cache`, `25 %` de 1M.
3. Configurar `contextCaps` a 200000 y confirmar `>100 %` + banner rojo.
4. Compactar; confirmar que el total no cambia y el contexto queda `—`.
5. Enviar un prompt corto; confirmar que la ventana se recalcula con el nuevo mensaje.
6. Probar en viewport móvil (Tailscale/iPhone): banner usable, botones no tapados por el compositor.
7. `npm run check` verde.

---

## 13. Riesgos

| Riesgo | Mitigación |
|---|---|
| `session.summarize` cambia o falla en otra versión | SDK pineado 1.2.15; `502` controlado; botón oculto si no hay sesión |
| Compactar pierde detalle | confirmación explícita; no es automático |
| El proveedor declara mal la ventana | `contextCap` visible como “asumido”; arreglar `opencode.json` aparte |
| Costo `$0` engañoso | decir “reportado”; no calcular dólares |
| Seed viejo tras compactar | invalidar seed y detectar compaction part al re-sembrar |
| Compactar oculta mensajes viejos y el total baja | comparar antes/después; conservar el mayor como piso; el test manual lo detecta |
| Evento `compacted` en medio de un turno | no finalizar; solo resetear ventana y avisar |
| Banners molestos | uno solo, dismiss por nivel/hilo, sin modales |
| Budget hard stop pierde trabajo | Fase C, opt-in, con confirmación |

---

## 14. Definición de terminado

- La barra distingue turno, hilo, contexto y cache sin ambigüedad.
- Un turno de 8M se ve como 8M, no como el costo del último mensaje.
- El total del hilo incluye subagentes también después de recargar (43,7M en BounceFinder).
- El contexto usa el límite efectivo y dice si es del proveedor o asumido.
- Hay aviso a 60 %, 85 %, 2M y 5M, con acciones.
- Compactar funciona, no baja el total y deja la ventana en “recalculando”.
- El siguiente mensaje vuelve a reportar contexto real.
- Nada se rompe para Claude Code/Codex: la feature se oculta.
- `npm run check` verde y `docs/API.md` actualizado.
- La configuración de 200k queda documentada, no aplicada a ciegas.
