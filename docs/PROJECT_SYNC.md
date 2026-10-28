# 🔄 Tablero de Sincronización en Tiempo Real (Humano & Agentes)

> **Archivo de Control Operativo**: punto de encuentro entre humanos y agentes.
> **Regla**: todo agente que inicie o finalice una tarea DEBE actualizar este documento.
> El tablero gr8r (UI) se compila desde aquí: las secciones definen el estado.

---

## 🎯 Hito Activo: M1 — Primera entrega

### 📋 Tablero Kanban de Tareas

#### 🚀 En Progreso (In Progress)

- 🔵 **[GIT-ROUTING-5B]** Fase 5 routing: dividir `rg_todos` en sub-grupos por tipo/costo (free vs paid, por sub-provider interno `auto/` `alibabacloud/` `qwen/` etc.) — `rg_todos` dinámico ya cubre "todos"; el siguiente paso es curar perfiles.

#### ⏳ Pendiente (Sprint Backlog / Próximo)

- 🟡 **[GIT-MASTERPLAN-5]** Fase 5 (opcional) MASTERPLAN: orquestador que convierte subagentes (oa-qa, oa-coder, oa-docs, oa-designer) en bots de GitBot y les envía mensajes en tiempo real. **Prerequisito cumplido:** routing groups (fases 0–5) ya están operativos.

#### ✅ Completado Recientemente (Done)

- [x] 🔵 **[GIT-ROUTING-5]** Grupos dinámicos por provider (source-driven): `RoutingGroup.source`, `catalogModelRefs`, `POST /routing-groups/:id/refresh`, auto-refresh al startup + timer 10 min, UI con toggle + filtros + "Refresh now". `rg_todos` recreado dinámico (332 modelos, bot A apunta). **Commit pendiente.** Ver [ROUTING-PLAN.md](ROUTING-PLAN.md) Fase 5, [CHANGELOG.md](CHANGELOG.md).
- [x] 🔵 **[GIT-ROUTING-4]** Editar y rebobinar mensajes (OpenCode): `POST /threads/:id/revert` + `/unrevert`, inline edit en el chat.
- [x] 🔵 **[GIT-ROUTING-0..3]** Routing groups fases 0–3: grupos, failover reactivo, ledger/budget diario, catálogo vivo Magpie, CRUD + UI.
