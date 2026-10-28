# Agent Guidelines

## GR8R Sync Contract (docs es SSOT)

- Los agentes trabajan SOLO los documentos en 'docs/'. Nunca editar '.gr8r/tasks.json' a mano (es generado).
- Cada tarea del kanban es UNA línea con formato EXACTO:

  - [x] **[GIT-NN]** Título corto
  - [ ] **[GIT-NN]** Título corto

- Reglas de formato:
  - Checkbox SIEMPRE: [x] = done, [ ] = pendiente. El emoji de severidad (🔴🟠🟡🔵) es opcional y no reemplaza al checkbox.
  - SIGLA-NN es ID ÚNICO y PERMANENTE: nunca reutilices un ID existente para una tarea nueva (usa -B, -C…). Ejemplo: si GIT-ROUTING-5 ya está done, la tarea nueva de sub-grupos es GIT-ROUTING-5B.
  - Sub-detalles de la tarea como sub-lista anidada (líneas "  - " debajo).

- Estados por sección: En Progreso → progress · Completado/[x] → done · Pendiente/Próximo → todo.
- Compilar el puente gr8r (desde gr8r-studio): 'node tools/gr8r-compile.mjs --project ../GitBot' (agregar --watch durante sesiones largas).
- Self-check antes de commit: todas las tareas del kanban deben matchear 'grep -E "^\s*-\s+\[[ xX]\] \*\*\[" docs/PROJECT_SYNC.md' (cuenta debe ser igual a las tareas que ves).
