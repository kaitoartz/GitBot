import { execSync, spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";
import { bindSession } from "./bot-store";
import { presetSystemPrompt, recordSetupOutcomeFromEvents } from "./bot-prompt";
import {
  emitEvent,
  scheduleCleanup,
  sessions,
  notifyPermissionsChanged,
  shouldAutoApprove,
  type SessionStore,
  type SessionSubagent,
} from "./server-common";
import {
  initContextLimits,
  parseUsageFromMessage,
  buildTurnReport,
  buildSessionReport,
  accumulateUsage,
  getModelInfo,
} from "./usage";
import { filePartFor, mentionText } from "./attachments";

async function loadOpencodeSdk() {
  const sdk = await import("@opencode-ai/sdk");
  return { createOpencode: sdk.createOpencode, createOpencodeClient: sdk.createOpencodeClient };
}

// Per-directory opencode clients
const clientsByDir = new Map<string, any>();

// Reverse-lookup: opencode session ID → gitbot session ID
const sdkIdToGitbotId = new Map<string, string>();

// Cache of subagent (child) sdkSessionId → root gitbot session ID, populated by walking parentID.
const childSdkIdToRootGitbotId = new Map<string, string>();
// Dedupe concurrent in-flight parent walks for the same sdkSessionId.
const resolveInflight = new Map<string, Promise<SessionStore | undefined>>();

let sdkLoaded: any = null;

// Where the SDK's client looks for the server.
const OPENCODE_URL = process.env.GITBOT_OPENCODE_URL ?? "http://127.0.0.1:4096";
// The port gitbot spawns on, taken from that URL.
const OPENCODE_PORT = new URL(OPENCODE_URL).port || "4096";

// The server gitbot spawned. It is not detached, but it outlives gitbot
// whenever gitbot exits without passing on a signal, and every later start then
// finds the port taken — so gitbot stops it on the way out.
let spawnedServer: ChildProcess | null = null;

const permissionConfig = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
  doom_loop: "ask",
  external_directory: "ask",
} as const;

export async function initAgent(): Promise<boolean> {
  // The SDK is a hard dependency, so importing it proves nothing about whether
  // opencode itself is installed — and the SDK shells out to `opencode serve`.
  // Without this check the agent is offered on every machine and only fails
  // later, when a turn cannot reach a server that was never started.
  try {
    execSync("opencode --version", { stdio: "ignore" });
  } catch {
    console.warn("  opencode CLI not found — opencode agent unavailable");
    return false;
  }

  const loaded = await loadOpencodeSdk().catch(() => null) as any;

  if (!loaded?.createOpencode || !loaded?.createOpencodeClient) {
    console.warn("  @opencode-ai/sdk not found — opencode agent unavailable");
    return false;
  }

  sdkLoaded = loaded;

  // An opencode server already on the port — the user's own `opencode serve`,
  // or another gitbot's — is used as is. Spawning over it only fails with
  // "Failed to start server on port 4096" and a dump of opencode's output.
  const running = await runningServerVersion();
  if (running !== null) {
    console.log(`  opencode: using the server already running on ${OPENCODE_URL}${running ? ` (opencode ${running})` : ""}`);
    // Seed the default client and prime the context-window cache so usage
    // reports know the limits without waiting for a turn.
    const client = loaded.createOpencodeClient({ baseUrl: OPENCODE_URL });
    clientsByDir.set("", client);
    await initContextLimits(client);
    return true;
  }

  // GitBot speaks the v1 HTTP API (@opencode-ai/sdk 1.2.15). opencode 2.x
  // serves a different, password-protected /api and cannot be used here, so the
  // server is spawned from a 1.x binary we resolve ourselves instead of through
  // the SDK (which runs a bare `opencode`, unusable on Windows where it is a
  // .cmd shim, and would now pick up 2.x).
  const bin = resolveOpencodeBin();
  if (!bin) {
    console.warn(
      "  opencode: no 1.x binary found (GitBot speaks the v1 API; opencode 2.x is not compatible). " +
        "Start `opencode serve --port 4096` yourself or set GITBOT_OPENCODE_BIN to a 1.x opencode binary.",
    );
    return true;
  }

  try {
    const proc = spawn(bin.bin, ["serve", "--hostname=127.0.0.1", `--port=${OPENCODE_PORT}`], {
      env: {
        ...process.env,
        // The SDK's own launcher passes the permission config this way.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionConfig }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    spawnedServer = proc;
    let output = "";
    proc.stdout?.on("data", (chunk) => { output += String(chunk); });
    proc.stderr?.on("data", (chunk) => { output += String(chunk); });
    proc.on("exit", () => { if (spawnedServer === proc) spawnedServer = null; });

    if (!(await waitForServer(15000))) {
      throw new Error(output.trim().split("\n")[0] || "did not start in time");
    }
    // Seed the default client (no directory) from the spawned server.
    clientsByDir.set("", loaded.createOpencodeClient({ baseUrl: OPENCODE_URL }));
    await initContextLimits(clientsByDir.get(""));
    console.log(`  opencode: ready (${bin.version})`);
  } catch (err: any) {
    const reason = String(err?.message ?? err).split("\n")[0];
    console.warn(`  opencode: could not start a server on ${OPENCODE_URL} (${reason}) — opencode turns will fail until one is running`);
  }

  return true;
}

/**
 * The 1.x binary to spawn. Bare `opencode` is not used directly: on Windows it
 * is a .cmd shim node cannot spawn, and its target may be 2.x.
 */
function resolveOpencodeBin(): { bin: string; version: string } | null {
  const candidates: string[] = [];
  if (process.env.GITBOT_OPENCODE_BIN) candidates.push(process.env.GITBOT_OPENCODE_BIN);
  try {
    const find = process.platform === "win32" ? "where opencode" : "which -a opencode";
    const found = execSync(find, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of found.split(/\r?\n/)) {
      const path = line.trim();
      if (!path) continue;
      candidates.push(path);
      // Windows shims are wrappers; the real binary is quoted inside.
      if (path.toLowerCase().endsWith(".cmd")) {
        try {
          const target = readFileSync(path, "utf8").match(/"([^"]+\.exe)"/);
          if (target) candidates.push(target[1]);
        } catch {}
      }
    }
  } catch {}

  for (const bin of candidates) {
    const version = opencodeVersionOf(bin);
    // 1.x only: 2.x is a different API. "" means the binary answers without a version.
    if (version && /^v?1\./.test(version)) return { bin, version };
  }
  return null;
}

function opencodeVersionOf(bin: string): string | null {
  try {
    return execSync(`"${bin}" --version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolves once the server answers its health check, false on timeout. */
async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await runningServerVersion()) !== null) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Stops the opencode server this gitbot started, if it started one. */
export function stopAgent(): void {
  spawnedServer?.kill();
  spawnedServer = null;
}

/**
 * The version of the opencode server answering on the port: "" when it answers
 * without saying, null when nothing answers.
 */
async function runningServerVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${OPENCODE_URL}/config`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${OPENCODE_URL}/global/health`, { signal: AbortSignal.timeout(1000) });
    const health = (await res.json()) as { version?: string };
    return health.version ?? "";
  } catch {
    return "";
  }
}

async function getClientForDir(directory: string): Promise<any> {
  if (clientsByDir.has(directory)) return clientsByDir.get(directory);

  const { createOpencodeClient } = sdkLoaded;
  const client = createOpencodeClient({ baseUrl: OPENCODE_URL, directory });
  clientsByDir.set(directory, client);

  try {
    const configResult = await client.config.get();
    const currentConfig = (configResult.data ?? {}) as Record<string, any>;
    await client.config.update({
      body: { ...currentConfig, permission: permissionConfig },
    });
  } catch (err: any) {
    console.warn("  permissions: could not set permission config:", err?.message);
  }

  // Initialize context limits cache on the first client (directory="")
  if (directory === "") {
    initContextLimits(client).catch((err) => {
      console.warn("[usage] failed to initialize context limits:", err?.message);
    });
  }

  startEventStream(client, directory).catch((err) => {
    console.error("[gitbot] startEventStream crashed:", err);
  });
  return client;
}

export async function runAgent(store: SessionStore): Promise<void> {
  const lastUserEvent = [...store.events].reverse().find(e => e.type === "user_prompt");
  const prompt = (lastUserEvent?.prompt as string) ?? "";
  // Bytes live on the store (never in the SSE event). The legacy `{ url }`
  // shape is still honoured for callers that post attachments directly; the
  // new metadata-only event shape has no `url` and must not become a part.
  const pending = store.pendingAttachments ?? [];
  const legacyAttachments = ((lastUserEvent?.attachments as Array<{ url?: string }> | undefined) ?? [])
    .filter((a) => typeof a?.url === "string" && a.url);
  const mentions = mentionText(pending);
  // Consume the bytes now: they are either attached to this turn or dropped by
  // a failure below. A long-lived session map must not retain megabytes.
  store.pendingAttachments = undefined;
  // Reconciliation (`/sessions/:id/status`) refuses to settle a turn that is
  // still ramping up; this is the clock it reads.
  store.turnStartedAt = Date.now();
  (store as any)._msgRoles = new Map<string, string>();
  store.lastTaskToolUseId = undefined;

  try {
    // Inside the try: reaching the opencode server is the first thing that can
    // fail, and a throw here used to escape runAgent entirely, leaving the
    // session pinned to "running" — 409 on every later message, stream never closed.
    const client = await getClientForDir(store.repoPath);

    if (!store.sdkSessionId) {
      const repoName = basename(store.repoPath);
      const firstLine = prompt || mentionText(pending);
      const sessionResult = await client.session.create({
        body: { title: `[${repoName}] ${firstLine.slice(0, 60) || (pending.length || legacyAttachments.length ? "Attachment message" : "New chat")}` },
        query: { directory: store.repoPath },
      });
      const sdkId = (sessionResult.data as any).id as string;
      store.sdkSessionId = sdkId;
      // Bind the hub thread to its conversation, so its next turn resumes it.
      if (store.threadId) bindSession(store.threadId, sdkId);
      emitEvent(store, "system", { subtype: "init", session_id: sdkId });
    }
    // Always register the mapping so event stream can find the store
    sdkIdToGitbotId.set(store.sdkSessionId!, store.gitbotId);


    // Parse model string into providerID/modelID if provided
    let modelParam: { providerID: string; modelID: string } | undefined;
    if (store.model) {
      const slashIdx = store.model.indexOf("/");
      if (slashIdx !== -1) {
        modelParam = {
          providerID: store.model.slice(0, slashIdx),
          modelID: store.model.slice(slashIdx + 1),
        };
      }
    }

    const system = presetSystemPrompt(store.botPreset);
    // A bot's disallowed tools are switched off for the message. Bots name
    // tools the Claude Code way ("Bash"); OpenCode's ids are lowercase.
    const tools = await presetTools(client, store);

    // Gate binaries on what the model actually declares. Unknown capabilities
    // (older providers, no cache) degrade to "try it" rather than blocking.
    const binary = pending.filter((a) => a.kind === "image");
    if (binary.length && modelParam) {
      const info = getModelInfo(modelParam.providerID, modelParam.modelID);
      const images = binary.filter((a) => a.mime.startsWith("image/"));
      const pdfs = binary.filter((a) => a.mime === "application/pdf");
      if (info && images.length && !info.image) {
        throw new Error(`Model ${store.model} does not accept image attachments`);
      }
      if (info && pdfs.length && !info.pdf) {
        throw new Error(`Model ${store.model} does not accept PDF attachments`);
      }
    }
    const fileParts = await Promise.all(binary.map(filePartFor));

    // Use promptAsync so the request returns immediately; completion signaled via event stream
    const promptResult = await client.session.promptAsync({
      path: { id: store.sdkSessionId! },
      body: {
        parts: [
          ...(prompt || mentions ? [{ type: "text" as const, text: [prompt, mentions].filter(Boolean).join("\n\n") }] : []),
          ...fileParts,
          ...legacyAttachments.map(att => ({ type: "file" as const, mime: "image/jpeg", url: att.url })),
        ],
        ...(modelParam ? { model: modelParam } : {}),
        ...(store.mode ? { agent: store.mode } : {}),
        // A bot is a preset: its instructions ride along as the system prompt.
        // OpenCode takes it per message, so it is sent on every turn.
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
      },
    });
    if (promptResult.error) {
      // The SDK wraps server errors as { name, data: { message, kind } }.
      const errObj: any = promptResult.error;
      const errMsg =
        errObj?.data?.message ||
        errObj?.message ||
        errObj?.detail ||
        (typeof errObj === "string" ? errObj : "Prompt failed");
      console.error("[query] promptAsync error:", errMsg, JSON.stringify(errObj).slice(0, 500));
      emitEvent(store, "agent_error", { message: errMsg });
      // The turn never started, so no idle event will follow: close the stream.
      emitEvent(store, "error", { message: errMsg });
      store.status = "error";
      notifyPermissionsChanged();
      scheduleCleanup(store);
      return;
    }
    // completion signaled via event stream (session.idle or session.status idle)
  } catch (err: any) {
    console.error("[query] error:", err.message);
    emitEvent(store, "agent_error", { message: err?.message ?? "Unknown error" });
    // The turn never started, so no idle event will follow: close the stream.
    emitEvent(store, "error", { message: err?.message ?? "Unknown error" });
    store.status = "error";
    notifyPermissionsChanged();
    scheduleCleanup(store);
  }
}

/**
 * A bot's tool lists as OpenCode's per-message switch map. Allowed tools are the
 * only tools the bot has, so every other tool OpenCode knows is switched off.
 * If the tool list cannot be read the turn fails rather than run unfenced.
 */
async function presetTools(
  client: Awaited<ReturnType<typeof getClientForDir>>,
  store: SessionStore,
): Promise<Record<string, boolean> | undefined> {
  const norm = (names?: string[]) => (names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const allowed = norm(store.botPreset?.allowedTools);
  const disallowed = norm(store.botPreset?.disallowedTools);
  if (!allowed.length && !disallowed.length) return undefined;

  const tools: Record<string, boolean> = {};
  if (allowed.length) {
    const result = await client.tool.ids({ query: { directory: store.repoPath } });
    const ids = result.data;
    if (!Array.isArray(ids) || !ids.length) {
      throw new Error("Could not read OpenCode's tool list, so this bot's allowed tools cannot be enforced");
    }
    for (const id of ids) tools[id] = allowed.includes(id.toLowerCase());
  }
  for (const name of disallowed) tools[name] = false;
  return tools;
}

/**
 * A client for ad-hoc SDK reads from outside the driver (usage seeding, etc.).
 * Reuses the per-directory cache; safe to call repeatedly.
 */
export async function getOpencodeClientForDir(directory: string = ""): Promise<any> {
  return getClientForDir(directory);
}

export async function getSessionHistory(sdkSessionId: string, directory: string = ""): Promise<{ role: string; content: any[] }[]> {
  const client = await getClientForDir(directory);
  try {
    const messagesResult = await client.session.messages({ path: { id: sdkSessionId } });
    const allMsgs = messagesResult.data ?? [];
    const history: { role: string; content: any[] }[] = [];
    for (const msg of allMsgs) {
      const role = (msg as any).info?.role;
      const parts = (msg as any).parts ?? [];
      if (role === "user" || role === "assistant") {
        const blocks: any[] = [];
        for (const p of parts) {
          if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
          else if (p.type === "file" && p.url) {
            blocks.push({
              type: String(p.mime ?? "").startsWith("image/") ? "image_url" : "file",
              url: p.url,
              ...(p.filename ? { name: p.filename } : {}),
              ...(p.mime ? { mime: p.mime } : {}),
            });
          } else if (p.type === "tool") {
            const toolName = p.tool ?? "";
            const input = p.state?.input;
            let tool_input: string;
            try {
              tool_input = JSON.stringify(input) ?? "";
            } catch {
              tool_input = "";
            }
            const md = p.state?.metadata ?? {};
            const childSessionId = typeof md.sessionId === "string" ? md.sessionId : undefined;
            blocks.push({
              type: "tool_use",
              tool_name: toolName,
              tool_input,
              ...(p.callID ? { tool_use_id: p.callID } : {}),
              // A Task row keeps the link to its subagent so history can render
              // the card and fetch the child transcript on demand.
              ...(toolName === "task" && childSessionId
                ? {
                    subagent: {
                      childSessionId,
                      agent: p.state?.input?.subagent_type ?? null,
                      title: p.state?.title ?? p.state?.input?.description ?? null,
                      status: p.state?.status ?? null,
                    },
                  }
                : {}),
            });
          }
        }
        if (blocks.length) history.push({ role, content: blocks });
      }
    }
    return history;
  } catch (err: any) {
    console.error("Error loading opencode history:", err.message);
    return [];
  }
}

export async function listSessions(
  repoPath: string
): Promise<{ id: string; preview: string; updatedAt: string }[]> {
  const client = await getClientForDir(repoPath);
  try {
    const listOptions = repoPath ? { query: { directory: repoPath } } : undefined;
    const result = await client.session.list(listOptions);
    // Subagent sessions (parentID set) belong nested under their parent thread, not at chat-history top level.
    const sessionList = (result.data ?? [])
      .filter((s: any) => !s.parentID)
      .map((s: any) => ({
        id: s.id,
        preview: s.title || s.id,
        updatedAt: (() => {
          const ts = s.time?.updated || s.time?.created || 0;
          const ms = ts > 1e12 ? ts : ts * 1000;
          return new Date(ms).toISOString();
        })(),
      }));
    sessionList.sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
    return sessionList;
  } catch (err: any) {
    console.error("Error listing sessions:", err.message);
    return [];
  }
}

export async function abortSession(sdkSessionId: string, directory: string = ""): Promise<void> {
  const client = await getClientForDir(directory);
  await client.session.abort({ path: { id: sdkSessionId } });
}

export async function respondPermission(
  sdkSessionId: string,
  permissionId: string,
  approved: boolean,
  directory: string = ""
): Promise<void> {
  const client = await getClientForDir(directory);
  await client.postSessionIdPermissionsPermissionId({
    path: { id: sdkSessionId, permissionID: permissionId },
    body: { response: approved ? "once" : "reject" },
  });
}

// Extract sessionID from any event's properties
function extractSessionId(_type: string, props: any): string | undefined {
  if (props?.sessionID) return props.sessionID;
  if (props?.info?.sessionID) return props.info.sessionID;
  if (props?.part?.sessionID) return props.part.sessionID;
  return undefined;
}

function findStoreByOpencodeSdkId(sdkId: string): SessionStore | undefined {
  const gitbotId = sdkIdToGitbotId.get(sdkId) ?? childSdkIdToRootGitbotId.get(sdkId);
  if (!gitbotId) return undefined;
  return sessions.get(gitbotId);
}

/**
 * Close a running turn: usage, setup verdict, status, terminal event, cleanup.
 * Shared by the event stream (`session.idle`) and the reconciliation below so
 * both paths end a turn identically.
 */
function finalizeTurn(store: SessionStore): void {
  if (store.status === "done") return;
  // Emit final session usage report with context window
  let providerID: string | undefined;
  let modelID: string | undefined;
  if (store.model) {
    const slashIdx = store.model.indexOf("/");
    if (slashIdx !== -1) {
      providerID = store.model.slice(0, slashIdx);
      modelID = store.model.slice(slashIdx + 1);
    }
  }
  const sessionReport = buildSessionReport(
    store, providerID, modelID,
    store.threadId ? `thread:${store.threadId}` : undefined,
  );
  emitEvent(store, "usage", sessionReport);
  recordSetupOutcomeFromEvents(store);
  store.status = "done";
  store.turnStartedAt = undefined;
  store.pendingPermissions.clear();
  notifyPermissionsChanged();
  emitEvent(store, "done", {});
  scheduleCleanup(store);
}

/** A turn younger than this may still be starting; never reconcile it away. */
const RECONCILE_MIN_AGE_MS = 5000;

/**
 * Bind a `task` tool part to its child session. S3 proved the part carries
 * `state.metadata.sessionId` (and `parentSessionId`), so the mapping is exact:
 * no need to guess which child belongs to which Task row, and no extra
 * `session.children` round-trip.
 */
function trackTaskSubagent(store: SessionStore, part: any): void {
  const md = part.state?.metadata ?? {};
  const childSessionId = typeof md.sessionId === "string" && md.sessionId ? md.sessionId : undefined;
  const parentToolUseId = typeof part.callID === "string" && part.callID ? part.callID : undefined;
  if (!childSessionId || !parentToolUseId) return;

  const raw = part.state?.status;
  const status: SessionSubagent["status"] =
    raw === "completed" ? "completed" : raw === "error" ? "error" : "running";

  if (!store.subagents) store.subagents = new Map();
  if (!store.childToParentTool) store.childToParentTool = new Map();
  const prev = store.subagents.get(parentToolUseId);
  const agent =
    typeof part.state?.input?.subagent_type === "string" ? part.state.input.subagent_type : prev?.agent;
  const title =
    typeof part.state?.title === "string" && part.state.title ? part.state.title : prev?.title;

  const entry: SessionSubagent = { parentToolUseId, childSessionId, agent, title, status };
  store.subagents.set(parentToolUseId, entry);
  store.childToParentTool.set(childSessionId, parentToolUseId);
  // Warm the child→root cache with the exact link, so child events route
  // immediately instead of waiting for a parentID walk.
  childSdkIdToRootGitbotId.set(childSessionId, store.gitbotId);

  if (prev && prev.status === status) return;
  emitEvent(store, "subagent", {
    phase: status === "completed" ? "finished" : status === "error" ? "error" : "started",
    ...entry,
  });
}
/** Guards for reconciliation, exported so the rules are unit-testable. */
export function shouldReconcileTurn(store: SessionStore, now = Date.now()): boolean {
  if (store.agent !== "opencode" || store.status !== "running" || !store.sdkSessionId) return false;
  if (store.pendingPermissions.size > 0) return false;
  return !!store.turnStartedAt && now - store.turnStartedAt >= RECONCILE_MIN_AGE_MS;
}

/**
 * Reconcile a store that still says "running" against OpenCode itself.
 *
 * `session.idle` travels over a single global event stream with no replay: if
 * that stream hiccups, the reply lands in the UI but the terminal event never
 * does, and the thread spins "Thinking…" forever. `/sessions/:id/status` calls
 * this so a poll can settle the turn; returns true when it just did.
 */
export async function reconcileTurnStatus(store: SessionStore): Promise<boolean> {
  if (!shouldReconcileTurn(store)) return false;

  const client = await getClientForDir(store.repoPath);
  const result = await client.session.status();
  // The map holds active sessions only: an absent id means the session is not
  // busy. `type` is "busy" | "retry" | "idle" on 1.19.x.
  const status = (result?.data ?? {})[store.sdkSessionId!];
  if (status && status.type !== "idle") return false;

  finalizeTurn(store);
  return true;
}

// Walk session.parentID via the SDK until we land on a session we own (root) or run out.
// Returns the root gitbot store and caches the mapping. Used to route subagent events
// to the parent thread.
async function resolveParentStore(client: any, sdkSessionId: string): Promise<SessionStore | undefined> {
  const direct = findStoreByOpencodeSdkId(sdkSessionId);
  if (direct) return direct;

  const inflight = resolveInflight.get(sdkSessionId);
  if (inflight) return inflight;

  const promise = (async () => {
    let cur = sdkSessionId;
    for (let hops = 0; hops < 5; hops++) {
      const got = await client.session.get({ path: { id: cur } }).catch(() => null);
      const data = got?.data;
      if (!data?.parentID) return undefined;
      cur = data.parentID;
      const rootGitbotId = sdkIdToGitbotId.get(cur);
      if (rootGitbotId) {
        childSdkIdToRootGitbotId.set(sdkSessionId, rootGitbotId);
        return sessions.get(rootGitbotId);
      }
    }
    return undefined;
  })();
  resolveInflight.set(sdkSessionId, promise);
  promise.finally(() => resolveInflight.delete(sdkSessionId));
  return promise;
}

async function startEventStream(client: any, directory: string) {
  try {
    const events = await client.event.subscribe();
    console.log(`[event-stream] subscribed (${directory || "no dir"})`);
    for await (const event of events.stream) {
      const type = event.type as string;
      const props = event.properties as any;
      if (type.startsWith("server.")) continue;

      const sdkSessionId = extractSessionId(type, props);
      if (!sdkSessionId) continue;

      let store = findStoreByOpencodeSdkId(sdkSessionId);
      if (!store) {
        // First event from a not-yet-mapped session: kick off the parent walk
        // in the background and drop this event. Awaiting here would stall the
        // for-await loop and back up every other session's events behind one
        // SDK round-trip. By the next event from this child, the cache is warm.
        void resolveParentStore(client, sdkSessionId);
        continue;
      }
      // Child events: store was reached via childSdkIdToRootGitbotId (root's parent store),
      // so its sdkSessionId differs from the event's sdkSessionId.
      const isChildEvent = sdkSessionId !== store.sdkSessionId;

      // Real link when the parent `task` part exposed its child session;
      // `lastTaskToolUseId` stays as the fallback for older parts.
      const parentToolUseId = isChildEvent
        ? store.childToParentTool?.get(sdkSessionId) ?? store.lastTaskToolUseId
        : undefined;

      // Track message roles so we can filter out user message parts
      if (type === "message.updated") {
        const info = props.info;
        if (info?.id && info?.role) {
          if (!(store as any)._msgRoles) (store as any)._msgRoles = new Map<string, string>();
          (store as any)._msgRoles.set(info.id, info.role);
        }
        // Usage for the parent and for children: a subagent's tokens count
        // toward the turn total but not toward the parent's context window.
        if (info?.role === "assistant") {
          const snapshot = parseUsageFromMessage(props);
          if (snapshot) {
            const report = buildTurnReport(info.id, snapshot, store.model);
            if (report) {
              accumulateUsage(store.gitbotId, snapshot, info.id, { updateWindow: !isChildEvent });
              emitEvent(store, "usage", {
                ...report,
                ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
              });
            }
          }
        }
      }

      if (type === "message.part.updated") {
        const part = props.part;
        const msgRole = (store as any)._msgRoles?.get(part.messageID);

        if (part.type === "text") {
          const text = part.text ?? "";
          if (text && msgRole === "assistant") {
            emitEvent(store, "assistant", {
              content: text,
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
        if (part.type === "tool") {
          const state = part.state;
          if (state?.status === "running" || state?.status === "completed") {
            const title = state.title;
            const input = state.input ?? {};
            const label = title || formatToolInput(part.tool, input);
            // A `task` part names its child session in metadata: that is the
            // real link (no guessing from "last task seen").
            if (!isChildEvent && part.tool === "task") {
              if (part.callID) store.lastTaskToolUseId = part.callID;
              trackTaskSubagent(store, part);
            }
            emitEvent(store, "tool_use", {
              tool_name: part.tool,
              tool_input: label,
              ...(part.callID ? { tool_use_id: part.callID } : {}),
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
        if (part.type === "step-start" && !isChildEvent) {
          emitEvent(store, "status", { status: "thinking" });
        }
      }

      if (type === "permission.asked") {
        const permId = props.id;
        const permType = props.permission as string || "";
        const patterns: string[] = props.patterns ?? [];

        let toolName: string;
        let input: Record<string, unknown>;
        if (permType === "bash") {
          toolName = "Bash";
          input = { command: patterns.join(" ") };
        } else if (permType === "edit") {
          toolName = "Edit";
          const filePath = props.metadata?.filepath || patterns[0] || "";
          const diff = props.metadata?.diff as string | undefined;
          let old_string = "";
          let new_string = "";
          if (diff) {
            const removed: string[] = [];
            const added: string[] = [];
            for (const line of (diff as string).split("\n")) {
              if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
              else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
            }
            old_string = removed.join("\n");
            new_string = added.join("\n");
          }
          input = { file_path: filePath, old_string, new_string };
        } else if (permType === "webfetch") {
          toolName = "WebFetch";
          input = { url: patterns[0] ?? "" };
        } else {
          toolName = permType || props.title || "Unknown";
          input = patterns.length > 0 ? { patterns } : (props.metadata ?? {});
        }

        if (permId) {
          if (shouldAutoApprove(store.agent, toolName, store.permissionMode)) {
            // Respond on the child's own sdkSessionId, not the parent's.
            respondPermission(sdkSessionId, permId, true, store.repoPath).catch(() => {});
          } else {
            const parentToolUseId = isChildEvent ? store.lastTaskToolUseId : undefined;
            store.pendingPermissions.set(permId, {
              resolve: () => {},
              input,
              toolName,
              toolUseID: permId,
              askedBySdkSessionId: sdkSessionId,
            });
            notifyPermissionsChanged();
            emitEvent(store, "permission_request", {
              toolUseID: permId,
              toolName,
              input,
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            });
          }
        }
      }

      // Child-session lifecycle events do NOT terminate the parent thread —
      // the parent's own session.idle/error governs the thread's lifecycle.
      if (isChildEvent) continue;

      if (type === "session.error") {
        const err = props?.error;
        const message = err?.data?.message || err?.message || err?.name || "Session error";
        emitEvent(store, "agent_error", { message });
        store.status = "error";
        store.pendingPermissions.clear();
        notifyPermissionsChanged();
        scheduleCleanup(store);
      }

      if (type === "session.idle" || (type === "session.status" && props?.status?.type === "idle")) {
        finalizeTurn(store);
      }
    }
  } catch (err: any) {
    console.error("[event-stream] error:", err.message);
    setTimeout(() => startEventStream(client, directory), 2000);
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase().replace(/_/g, "");
  switch (name) {
    case "bash":
      return input.command
        ? (input.description ? `${input.description}: ${input.command}` : `${input.command}`)
        : toolName;
    case "read":
    case "readfile":
      return input.file_path ? `${input.file_path}` : toolName;
    case "write":
    case "writefile": {
      if (!input.file_path) return toolName;
      const len = typeof input.content === "string" ? input.content.length : null;
      return len != null ? `${input.file_path} (${len} chars)` : `${input.file_path}`;
    }
    case "edit":
    case "editfile":
      return input.file_path ? `${input.file_path}` : toolName;
    case "glob":
      return input.pattern
        ? (input.path ? `${input.pattern} in ${input.path}` : `${input.pattern}`)
        : toolName;
    case "grep":
      return input.pattern
        ? (input.path ? `/${input.pattern}/ in ${input.path}` : `/${input.pattern}/`)
        : toolName;
    case "task":
      return input.description ? `[${input.subagent_type}] ${input.description}` : toolName;
    case "webfetch":
      return input.url ? `${input.url}` : toolName;
    case "websearch":
      return input.query ? `"${input.query}"` : toolName;
    case "notebookedit":
      return input.notebook_path ? `${input.notebook_path} (${input.edit_mode || "replace"})` : toolName;
    default: {
      const vals = Object.values(input).filter(v => typeof v === "string" && v.length < 100);
      return vals.length > 0 ? `${vals[0]}` : toolName;
    }
  }
}
