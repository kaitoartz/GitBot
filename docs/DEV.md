# Desarrollo — fork local de GitBot

Guía corta del ciclo de trabajo de este fork. El plan de producto está en [MASTERPLAN.md](MASTERPLAN.md), los endpoints en [API.md](API.md) y la forma general del sistema en [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Entorno

| Pieza | Versión en uso | Dónde se fija |
|---|---|---|
| Node.js | v26.2.0 (el paquete declara `>=18`) | `package.json` → `engines` |
| npm | 11.13.0 | — |
| **server** `opencode` | **v1.19.3** (el que GitBot habla) | binario resuelto en runtime (ver §5) |
| `opencode` CLI del PATH | v2.0.29 — **incompatible** con GitBot | — |
| `@opencode-ai/sdk` | **1.2.15** | `package.json` → `dependencies` |
| `@anthropic-ai/claude-agent-sdk` | 0.2.42 | `package.json` → `dependencies` |
| `@openai/codex-sdk` | 0.155.1 | `package.json` → `dependencies` |
| GitBot | 0.0.9 | `package.json` → `version` |

> **v1 vs v2 (corregido en Fase 0).** El `opencode` del PATH es **v2.0.29**, que sirve una API nueva bajo `/api`, protegida con password, y **no es compatible** con el SDK 1.2.15 que usa GitBot. GitBot necesita un **server v1** (`/global/health`, `/session`, `/event`, sin auth). Si no hay uno en el puerto, GitBot intenta arrancar un binario **1.x** que resuelve solo. Detalle en §5.


---

## 2. Ciclo de trabajo

```bash
cd D:\Proyects\GitBot

# 1. editar src/ (server + drivers) o ui/app/ (panel)
# 2. verificación rápida: tipos del CLI + build de la UI
npm run check

# 3. build completo (CLI + UI → dist/)
npm run build

# 4. correr el panel desde la carpeta que querés ver como workspace
cd D:\Proyects\BounceFinder
gitbot start
```

`gitbot` corre el `dist/` de este clone (ver §5), así que **el paso 3 es obligatorio** para ver cambios.

### Scripts

| Script | Qué hace |
|---|---|
| `npm run typecheck` | `tsc --noEmit` sobre `src/` (no compila) |
| `npm run check` | `typecheck` + `build:ui` — el gate antes de commitear |
| `npm run build` | `clean` + `build:cli` (`tsc`) + `build:ui` |
| `npm run build:cli` | sólo el CLI a `dist/` |
| `npm run build:ui` | build de `ui/` (Next.js, export estático) y copia a `dist/ui` |
| `npm run dev` | corre `src/index.ts` con `tsx`, sin build (server directo) |

### UI sola (hot reload)

El build de la UI tarda ~1 min. Para iterar pantalla:

```bash
cd ui
npm run dev        # next dev, apunta al server de GitBot
```

Cuando el cambio está listo, `npm run build` desde la raíz para que quede en `dist/ui`.

### Pruebas de adjuntos (Fase 2)

```bash
npm run build:cli                            # el test del server lee dist/
node --test scripts/attachments.test.mjs     # validación, MIME, FilePart
node --test ui/scripts/attachments.test.mjs  # @menciones y tipos

# turno real contra un `gitbot start` aislado (data dir temporal, puerto 3100)
node scripts/smoke-attachments.mjs
```

El spike S1 (`scripts/spikes/opencode-file-parts.mjs`) sigue disponible para
reprobar qué forma de `FilePartInput` acepta un server nuevo.

---

## 3. Datos y respaldos

| Qué | Dónde |
|---|---|
| Bots e hilos | `~/.gitbot/bots.json`, `~/.gitbot/threads.json` |
| Attachments de Codex | `~/.gitbot/codex-attachments/` |
| Historial de conversación | **no lo guarda GitBot**: se relee del transcript del agente |

Para usar otro directorio: `GITBOT_DATA_DIR` (legacy: `GRASS_DATA_DIR`).

**Antes de tocar el esquema de `threads.json` / `bots.json`:**

```powershell
$d = Get-Date -Format yyyyMMdd
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gitbot\backup-$d" | Out-Null
Copy-Item "$env:USERPROFILE\.gitbot\bots.json","$env:USERPROFILE\.gitbot\threads.json" "$env:USERPROFILE\.gitbot\backup-$d\"
```

Regla: los campos nuevos son **opcionales** y la lectura es tolerante. Un hilo viejo tiene que abrir igual.

---

## 4. Reglas del fork

1. **Mismo stack.** React + `useState` en `ui/`, Next.js con export estático, Express-less `node:http` en `src/`, SSE para el vivo. Nada de stores globales, routers nuevos, ni frameworks adicionales.
2. **Sin dependencias nuevas** salvo que la fase lo exija explícitamente y quede anotado en el masterplan.
3. **Los eventos son el contrato.** Todo dato en vivo viaja por `GET /events?sessionId=`; si agregás algo, se documenta en `docs/API.md` (evento nuevo o campo nuevo, nunca polling).
4. **Degradar, nunca romper.** Agente distinto de OpenCode, campo ausente o modelo sin ventana de contexto ⇒ ocultar el dato, no tirar error.
5. **Una fase = una rama = un `npm run check` verde + prueba manual del criterio de aceptación.**

Ramas: `feat/panel` es la rama de trabajo de este fork; `main` queda como espejo de `origin` (gitbot-hq/GitBot).

---

## 5. Server de OpenCode (v1)

GitBot habla la API **v1** del server de OpenCode. Al arrancar, en este orden:

1. Si ya hay un server respondiendo en `http://127.0.0.1:4096`, lo **reutiliza** (es el caso normal si dejás un `opencode serve` corriendo).
2. Si no hay ninguno, busca un binario **1.x** y lo arranca él mismo:
   - `GITBOT_OPENCODE_BIN` si está definida;
   - los `opencode` del PATH, resolviendo el shim `.cmd` de Windows a su `.exe` real;
   - descarta cualquiera que no reporte `1.x` (v2 no sirve).
3. Si no encuentra ninguno, avisa y los turnos de OpenCode fallan hasta que levantes uno.

Variables de entorno:

| Variable | Para qué |
|---|---|
| `GITBOT_OPENCODE_BIN` | ruta al binario **1.x** a arrancar (ej. una instalación pineada de opencode v1) |
| `GITBOT_OPENCODE_URL` | URL del server (default `http://127.0.0.1:4096`); el puerto de spawn se deriva de acá |
| `GITBOT_DATA_DIR` | datos de bots/hilos (default `~/.gitbot`) |

En esta máquina el server v1 en uso es el de `C:\Users\Err0rNotFound\tools\opencode-v1\node_modules\opencode-ai\bin\opencode.exe` (v1.19.3). Para que GitBot lo arranque solo:

```powershell
$env:GITBOT_OPENCODE_BIN="C:\Users\Err0rNotFound\tools\opencode-v1\node_modules\opencode-ai\bin\opencode.exe"
gitbot start
```

No apuntes `GITBOT_OPENCODE_BIN` al `opencode` v2 del PATH: la API cambió y los turnos fallan.

**Cuidado con el server largo vivo.** El server 1.19.3 administra los eventos **por instancia/directorio**: `/event` sin header `x-opencode-directory` no entrega eventos de sesión. Después de horas de churn (múltiples clientes, `config.update` repetidos, instancias creadas/desechadas) puede quedarse en un estado donde la subscripción de GitBot recibe `server.connected` + `server.instance.disposed` y luego muere: los turnos corren, pero el panel no ve nada en vivo. Se arregla matando el server de OpenCode y dejando que GitBot levante uno fresco.

---

## 6. El `gitbot` global apunta a este clone

El paquete global se reemplazó con un link, no con una copia:

```
C:\Users\<user>\AppData\Roaming\npm\node_modules\@gitbot-hq\gitbot
  → junction → D:\Proyects\GitBot
```

Verificar:

```bash
where.exe gitbot
gitbot --version    # 0.0.9 mientras el clone sea la fuente
```

Volver al paquete publicado como plan B:

```bash
npm uninstall -g @gitbot-hq/gitbot
npm install -g @gitbot-hq/gitbot
```

Re-linkear el fork:

```bash
cd D:\Proyects\GitBot
npm link
```

---

## 7. Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| `gitbot start` falla al arrancar | `dist/` quedó a medio compilar → `npm run build` |
| La UI se ve vieja o en blanco | falta `build:ui` → `npm run build`, o `dist/ui` no existe |
| `EADDRINUSE` en 3000 | `gitbot start -p 4000` |
| El agente no aparece en el menú | CLI no instalado o sin login (`opencode auth login`), reiniciar `gitbot` |
| Un turno no responde y los eventos no llegan | drift CLI ↔ SDK (R0): comparar `opencode --version`, revisar logs del server |
| Cambios en `src/` no se reflejan | estás corriendo `dist/`, no `tsx` → `npm run build` |

---

## 8. Verificación mínima antes de cerrar una fase

- `npm run check` verde y `npm run build` genera `dist/index.js` + `dist/ui/`.
- `gitbot start` levanta y el flujo de la fase se prueba a mano de punta a punta.
- Abrir un hilo **anterior** a la fase (datos en `~/.gitbot`) y confirmar que sigue funcionando.
- Sin regresiones en: permisos Allow/Deny, stop de turno, reconexión SSE, cambio de hilo con turno corriendo.
- `docs/API.md` actualizado si cambió el contrato.
- Nota en `CHANGELOG.md`.
