# gitbot HTTP API

The bot hub UI talks to the gitbot server over a plain REST + Server-Sent Events (SSE) API. You can use the same API to build your own client.

- **Base URL:** wherever `gitbot start` is listening, e.g. `http://localhost:3000`.
- **Format:** JSON in, JSON out, unless noted. Errors are `{ "error": "<message>" }` with a 4xx/5xx status; some carry extra fields (noted below).
- **Auth:** none. See [Security](../README.md#security) before exposing the port to anything but a trusted network.
- **CORS:** every origin is allowed for `GET`, `POST` and `PATCH`. `DELETE` is not in the allowed methods, so browser clients on another origin cannot delete; same-origin clients (the bundled UI) and non-browser clients can.

Contents: [Workspace](#workspace) · [Bots](#bots) · [Threads](#threads) · [Chat](#chat) · [Sessions](#sessions) · [Event streams](#event-streams)

---

## Workspace

The workspace is the directory `gitbot start` was run in. Repos are its subdirectories.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{ status: "ok", cwd, serverVersion, clientVersionRange }` |
| `GET` | `/agents` | `{ agents: string[] }` — the agents installed on this machine, in order of preference. Values: `claude-code`, `opencode`, `codex` |
| `GET` | `/repos` | Subdirectories of the workspace as `{ name, path, isGit }[]` |
| `GET` | `/repos/details?repoPath=<path>` | `{ branch, lastCommit, dominantLanguage }`. `lastCommit` has the message, hash and timestamp; `dominantLanguage` is the most common file extension from `git ls-files`, so it respects `.gitignore` |
| `POST` | `/repos/clone` | Clone a git repo into the workspace. Body: `{ url }`. Returns `{ path, name }` |
| `POST` | `/folders` | Create an empty folder in the workspace. Body: `{ name }`. Returns `{ path, name }` |
| `GET` | `/browse?path=<dir>` | Folder picker. Returns `{ path, parent, workspace, home, dirs: { name, path }[] }`. `parent` is `null` at the filesystem root. Without `path` it starts at the workspace. Not confined to the workspace: it lists folders anywhere the gitbot process can read |
| `GET` | `/dir?repoPath=<path>&path=<subpath>` | Directory entries inside a repo. The path is validated to stay inside `repoPath` |
| `GET` | `/browse/files?path=<dir>` | Files and folders anywhere the gitbot process can read, for attaching paths outside the repo. Returns `{ path, parent, entries }` with the same entry shape as `/dir`, capped at 500 entries. Without `path` it starts at the workspace |
| `GET` | `/files/search?repoPath=<path>&q=<query>` | Fuzzy file search inside a repo (OpenCode's `/find/file`), for the composer's `@` picker. Returns `{ files: { path, name }[] }`, `path` repo-relative, at most 20. Queries shorter than 2 chars and server errors answer `{ files: [] }` |
| `GET` | `/models/capabilities?model=<provider/model>` | What the model accepts: `{ model, known, image, pdf, reasoning, variants, limit }`. `known: false` means the provider list has not loaded yet |
| `GET` | `/file?repoPath=<path>&path=<filePath>` | Read a file. Validated to stay inside `repoPath`. 5 MB max |
| `GET` | `/diffs?repoPath=<path>` | `{ diff }` — the output of `git diff HEAD` |

## Bots

A bot is a named, reusable agent preset.

| Method | Path | Description |
|---|---|---|
| `GET` | `/bots` | `{ bots: Bot[] }` |
| `POST` | `/bots` | Create a bot. Returns `{ bot, setupThread? }` |
| `GET` | `/bots/:id` | `{ bot }` |
| `PATCH` | `/bots/:id` | Update any bot field. Returns `{ bot, setupThread? }` |
| `DELETE` | `/bots/:id` | Delete a bot and its threads |
| `POST` | `/bots/:id/setup` | Set this machine's setup state. Body: `{ action: "complete" \| "reset" \| "fail" }` |
| `GET` | `/routing-groups` | `{ groups: RoutingGroup[] }`, each with `spentToday` per model |
| `POST` | `/routing-groups` | Create a group. Static: `{ name, models, onError?, dailyTokenBudgets?, matchers?, shortRetryMinutes? }`. Dynamic: `{ name, source: { provider, include?, exclude?, onlyFree? }, onError?, ... }` — the server pulls `models` from the provider's live `/v1/models` so the saved ids are always valid |
| `GET` | `/routing-groups/:id` | `{ group }` with `spentToday` |
| `PATCH` | `/routing-groups/:id` | Update any group field. `source` re-pulls `models` from the catalog (or `source: null` switches back to static, keeping the current snapshot); `models` checks newly added ids against the live catalog (existing entries stay editable if the gateway retires them) |
| `DELETE` | `/routing-groups/:id` | Delete a group. `409` with `bots` when a bot still uses it |
| `POST` | `/routing-groups/:id/reset` | Forget today's ledger for the group and send its threads back to the first model. `{ ok, group, models, threads }` |
| `POST` | `/routing-groups/:id/refresh` | Repopulate a dynamic group's `models` from its provider's live catalog. `{ group, refreshed, count }`; static groups answer `refreshed: false, reason: "not_dynamic"`; a transient gateway outage keeps the last snapshot and returns `502` with the error |
| `GET` | `/models/catalog?provider=magpie&q=` | Live model list from the provider's own `/v1/models`, not `opencode.json` |

A bot joins a routing group by setting `model` to `group:<id>` instead of `provider/model`. The group rotates on quota, daily limit, provider failures (405/408/5xx) and unknown models (404). See [ROUTING-PLAN.md](ROUTING-PLAN.md).

**RoutingGroup fields**

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID, or a stable id when written by hand |
| `name` | string | Required |
| `models` | string[] | Ordered failover list of `provider/model`. Source of truth when static; a snapshot when `source` is set |
| `onError` | `rotate` \| `fail` | Default `rotate` |
| `dailyTokenBudgets` | `{ [provider/model]: number }` | Optional proactive limit per UTC day |
| `matchers` | `{ [provider]: regex }` | Optional extra quota-error regexes |
| `shortRetryMinutes` | number | Optional in-place wait for short `retry-after` |
| `source` | `{ provider, include?, exclude?, onlyFree? }` | When set, the group is dynamic: `models` is auto-populated from the provider's live `/v1/models` on create, on refresh, and at server startup. `include`/`exclude` are case-insensitive regexes; `onlyFree` keeps ids that look free. A bad regex is ignored, never blocks saving |
| `sourceStatus` | `{ at, count, error? }` | Read-only result of the last auto-refresh |
| `createdAt`, `updatedAt` | ISO string | Timestamps |

A dynamic group keeps its last snapshot if the gateway is unreachable, so a transient outage never empties the group mid-turn. The server re-syncs dynamic groups at startup and on a timer (default 10 min, `GITBOT_DYNAMIC_REFRESH_MS=0` disables the timer; the startup refresh always runs). Manual re-sync: `POST /routing-groups/:id/refresh`.

**Bot fields**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required |
| `description`, `emoji` | string | Shown in the hub |
| `agent` | `claude-code` \| `opencode` \| `codex` | Which agent runs the bot. Default `claude-code`. Any other value is a `400` |
| `instructions` | string | The bot's job. Sent to the agent on top of its own system prompt |
| `setupInstructions` | string | What the bot needs from a machine. Blank means no setup run. See [setup](../README.md#bots-set-themselves-up) |
| `model` | string | Optional. OpenCode needs `provider/model` — run `opencode models` for the values that install accepts |
| `repoPath` | string | Default folder for new threads |
| `permissionMode` | `ask-permissions` \| `auto-approve` \| `plan` | Default `ask-permissions` |
| `allowedTools` | string[] | The only tools the bot may use. Blank means all. Not applied to setup runs. Not supported on Codex |
| `disallowedTools` | string[] | Tools the bot may never use. Not supported on Codex |

Read-only fields the server maintains: `id`, `setupStatus` (`pending` \| `complete` \| `failed`), `setupThreadId`, `createdAt`, `updatedAt`.

## Threads

A thread is one conversation between a bot and a folder.

| Method | Path | Description |
|---|---|---|
| `GET` | `/threads?botId=<id>` | `{ threads: Thread[] }`, optionally for one bot |
| `POST` | `/threads` | Open a thread. Body: `{ botId, repoPath?, title? }`. Returns `{ thread }`. `409` with `{ setupRequired: true, setupThreadId }` if the bot has not set up this machine yet |
| `GET` | `/threads/:id` | `{ thread }` |
| `PATCH` | `/threads/:id` | Update a thread, e.g. `{ title }` |
| `DELETE` | `/threads/:id` | Delete the thread. The agent's own transcript stays on disk |
| `GET` | `/threads/:id/messages` | `{ messages }` - history read from the transcript of the agent the thread runs on. OpenCode messages carry the agent's `id` |
| `POST` | `/threads/:id/revert` | Stage an OpenCode rewind to a user message. Body: `{ messageID, partID? }`. The target and everything after it disappear when the next prompt is sent |
| `POST` | `/threads/:id/unrevert` | Cancel a staged rewind before the next prompt commits it |
| `GET` | `/threads/:id/usage` | [Usage](#usage) report for OpenCode threads, `null` otherwise |

A thread records `agent` and `sdkSessionId` on its first turn and keeps them: a session id only means something to the agent that issued it. Other fields: `kind` (`chat` \| `setup`), `title`, `repoPath`, `preview`, `messageCount`, `createdAt`, `updatedAt`.

Messages are `{ id?, role: "user" | "assistant", content: Block[] }`, where a block is `{ type: "text", text }`, `{ type: "tool_use", tool_name, tool_input }`, `{ type: "image_url", url, name?, mime? }` or `{ type: "file", url, name?, mime? }` (PDFs and other file parts). `url` is a data URL when the agent stored the bytes. `id` is the OpenCode message id; use it as `messageID` in `POST /threads/:id/revert`. Rewind is OpenCode-only and works on user messages.

## Chat

| Method | Path | Description |
|---|---|---|
| `POST` | `/chat` | Start a turn. Returns `{ sessionId }` immediately; the reply arrives on [`/events`](#event-streams) |

Two body forms:

- **Thread turn** (what the hub uses): `{ threadId, prompt, permissionMode? }`. The thread supplies the folder, the agent, the resume handle and the bot's preset.
- **Bare session:** `{ repoPath, agent, prompt, sessionId?, model?, permissionMode? }`. Pass `sessionId` to continue an earlier session.

Both accept `attachments`. Session `permissionMode` values are `ask-permissions`, `allow-all-edits` and `yolo`.

**Reasoning variant (OpenCode):** both forms accept `variant: string | null` — one of the model's declared `variants` (`low`, `high`, `max`, …) from `/models/capabilities`. It applies to that message only; omitting it or sending `null` uses the model default (it does not inherit the previous message's level). An unknown value is rejected with `400` and the list of valid variants. The variant is sent to OpenCode only when the model declares it. Subagents spawned by a `task` inherit the parent's variant.

**Attachments** describe files that ride with the message. Two shapes:

```json
{ "kind": "path", "path": "src/usage.ts" }
{ "kind": "image", "name": "shot.png", "mime": "image/png", "dataUrl": "data:image/png;base64,..." }
```

- `kind: "path"` is a text/code reference. The server validates it lives inside
  the thread's `repoPath` and appends `@<relative/path>` to the prompt; OpenCode
  resolves the mention itself. No bytes enter the prompt.
- `kind: "image"` sends a real `FilePartInput`. `dataUrl` may be replaced by a
  `path` inside `repoPath`; the server reads the file. Only `image/*` and
  `application/pdf` are accepted, up to 10 MB each. The turn is rejected before
  it starts when the model declares that input unsupported.
- Legacy `{ url }` is still accepted for images.

The `user_prompt` event carries only metadata (`kind`, `name`, `mime`, `size`,
and `path` for mentions), never the data URL. The visible history comes back
from the agent transcript.

Errors: `400` with `{ agentUnavailable: "<agent>" }` when the bot's agent is not installed; `409` with `{ setupRequired: true }` when the bot still needs setup; `409` when that session is already running.

## Marketplace

The Discover page reads from a separate service, the gitbot marketplace API, which indexes the
[gitbot-hq/Library](https://github.com/gitbot-hq/Library) repo. gitbot proxies its public routes so
the UI stays on one origin:

| Method | Path | Forwarded to |
|---|---|---|
| GET | `/marketplace/v1/bots` | `GET /v1/bots` — cards; query `q`, `category`, `agent`, `verified`, `featured`, `sort`, `limit`, `offset` |
| GET | `/marketplace/v1/bots/:slug` | `GET /v1/bots/:slug` — full detail incl. `instructions`, `setupInstructions`, `shareCode` |
| GET | `/marketplace/v1/categories` | `GET /v1/categories` |
| GET | `/marketplace/v1/index` | `GET /v1/index` — when the library was last indexed |
| POST | `/marketplace/v1/bots/:slug/installs` | `POST /v1/bots/:slug/installs` — anonymous install counter |

Anything else under `/marketplace/` is 404. Errors from this service are shaped
`{ "error": { "code", "message" } }`; when it cannot be reached gitbot answers
`502 MARKETPLACE_UNAVAILABLE`. The upstream is `GITBOT_MARKETPLACE_API`.

## Sessions

A session is one running (or finished) agent conversation, held in the server's memory.

| Method | Path | Description |
|---|---|---|
| `GET` | `/sessions?agent=<agent>&repoPath=<path>` | `{ sessions }` — past sessions for a folder, read from the agent's own store |
| `GET` | `/sessions/:id/history?agent=<agent>&repoPath=<path>` | `{ messages }` for a session |
| `GET` | `/sessions/:id/status` | `{ streaming: boolean, sdkSessionId }` |
| `GET` | `/sessions/:id/config` | `{ gitbotId, sessionId, agent, model, variant, mode, permissionMode }` |
| `PATCH` | `/sessions/:id` | Change the permission mode, also mid-turn. Body: `{ permissionMode }`. Approvals already waiting that the new mode covers are resolved at once. Returns `{ sessionId, permissionMode }`. On Codex the change applies from the next turn |
| `GET` | `/sessions/:id/permissions` | `{ pending: string[] }` — the `toolUseID`s still awaiting an answer |
| `POST` | `/sessions/:id/permission` | Answer an approval. Body: `{ toolUseID, approved: boolean }` |
| `POST` | `/sessions/:id/abort` | Stop a running turn |

`:id` is the `sessionId` from `/chat`. `config`, `status`, `permissions`, `abort` and `/events` also accept the agent's own session id (`sdkSessionId`), which is what a thread stores; answering an approval and `PATCH` need the `sessionId`.

`status` is also a reconciliation point for OpenCode: if the store still says `streaming: true` but `session.status` on the OpenCode server reports the session idle (a lost `session.idle` on the single, non-replayable event stream), the turn is finalized on the spot — `usage` and `done` are emitted to any connected stream and `streaming` comes back `false`. Turns younger than 5 s and turns waiting on an approval are never reconciled.

Subagents in history: a `task` `tool_use` block carries `tool_use_id` plus `subagent: { childSessionId, agent, title, status }`. Its transcript is that child session's own history: `GET /sessions/<childSessionId>/history?agent=opencode&repoPath=<path>`.

## Event streams

| Method | Path | Description |
|---|---|---|
| `GET` | `/events?sessionId=<id>` | SSE stream for one session. Closes after `done`, `error` or `aborted` |
| `GET` | `/permissions/events` | SSE stream of every pending approval across all sessions |

Events carry a `seq` field and an SSE `id:`, so a client that reconnects with `Last-Event-ID` receives what it missed. A finished session replays its events and closes.

### `/events`

| Event | Payload | Meaning |
|---|---|---|
| `user_prompt` | `prompt`, `attachments?`, `variant?` | The prompt that started the turn. `variant` is the reasoning level used for this message, when one was requested |
| `system` | `subtype`, `data` or `session_id` | Agent session initialised |
| `assistant` | `content`, `parent_tool_use_id?` | Assistant text. On a subagent it carries `parent_tool_use_id` (the parent `task` callID) |
| `tool_use` | `tool_name`, `tool_input`, `tool_use_id?`, `parent_tool_use_id?` | The agent is calling a tool. Subagent calls carry `parent_tool_use_id` |
| `subagent` | `phase`, `parentToolUseId`, `childSessionId`, `agent?`, `title?`, `status` | A `task` spawned a child session (`started`), it finished (`finished`) or failed (`error`). OpenCode names the child in the task part's metadata, so the link is exact |
| `tool_result` | `tool_use_id`, `tool_name`, `output`, `exit_code`, `status` | A command finished (Codex) |
| `status` | `status`, `tool_name?`, `summary?` | Activity: `thinking`, `tool`, `tool_summary` |
| `permission_request` | `toolUseID`, `toolName`, `input` | The agent needs approval (Claude Code, OpenCode — Codex never asks; its permission mode selects a sandbox) |
| `result` | `subtype`, `cost`, `duration_ms`, `num_turns` | Turn statistics (Claude Code) |
| `agent_error` | `message` | The agent itself reported a problem — provider refused, bad model (OpenCode); a connection retry or transport fallback (Codex). Not terminal on its own: it is followed by a terminal event only if the turn actually fails |
| `agent_failover` | `group`, `from`, `to`, `reason`, `index`, `total` | A routing group moved to its next model because the previous one reported `quota`, `daily` or `provider`. The turn continues on `to` |
| `agent_failover_exhausted` | `group`, `name`, `reason`, `attempts[]` | No model left in the routing group. Followed by `error` |
| `usage` | `scope`, `usage`, `messageID?`, `context?`, `model?`, `parent_tool_use_id?` | Token/cost accounting (OpenCode only). `scope: "turn"` rides along after a real assistant snapshot (`messageID` names its message); `scope: "session"` lands once at turn end with the cumulative total and the resolved context window. A subagent's report carries `parent_tool_use_id`; its tokens count toward the turn total but never toward the parent's context window. See [Usage](#usage) |
| `done` | — | Turn finished |
| `aborted` | `message` | Turn was stopped |
| `error` | `message` | Turn failed |

### `/permissions/events`

| Event | Payload | Meaning |
|---|---|---|
| `permissions` | `permissions[]` | Full snapshot of pending approvals |

Each entry has `sessionId`, `agent`, `repoPath`, `repoName`, `toolUseID`, `toolName` and `input`.

## Usage

OpenCode threads report tokens, cost and context. Numbers arrive once per
assistant message, at step-finish (OpenCode sends a zero placeholder first;
that one is never emitted). The `usage` object:

```json
{
  "input": 182,        // prompt tokens, excluding cache reads
  "output": 2,
  "reasoning": 0,
  "cacheRead": 32512,
  "cacheWrite": 0,
  "cost": 0,
  "total": 32696
}
```

- `total` = input + output + reasoning + cacheRead + cacheWrite.
- Cost depends on the provider; many report `0`.
- The **window** (how much of the model's context is in use) is the newest
  assistant message's `input + cacheRead + cacheWrite` — not the sum across
  turns, because every turn re-reads the cache. It travels in `context`:

```json
{ "used": 123602, "limit": 1048576, "pct": 12 }
```

`limit` comes from OpenCode's `config.providers()` and is `null` (with no
percentage) when the model does not declare one.

| Method | Path | Description |
|---|---|---|
| `GET` | `/threads/:id/usage` | A thread's usage: `usage` (session-scoped report above) or `null` for non-OpenCode agents. Seeds the historical total from OpenCode once per process; restarts do not lose it |
