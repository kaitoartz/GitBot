import {
  jsonOk,
  jsonError,
  readBody,
  parseQuery,
  IRequest,
  IResponse,
  sessions,
} from "./server-common";
import {
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  listThreads,
  getThread,
  createThread,
  updateThread,
  deleteThread,
  botNeedsSetup,
  ensureSetupThread,
  setSetupStatus,
  isBotAgent,
  BOT_AGENTS,
  type Bot,
} from "./bot-store";
import { existsSync, statSync } from "fs";
import { loadTranscript } from "./start-claude-code";
import { loadTranscript as loadCodexTranscript } from "./start-codex";
import {
  getSessionHistory as loadOpencodeHistory,
  getOpencodeClientForDir,
  revertSession as revertOpencodeSession,
  unrevertSession as unrevertOpencodeSession,
} from "./start-opencode";
import { buildSessionReport, loadHistoricalUsage, isSeeded, liveMessageIdsOf, getModelInfo } from "./usage";
import { resolveModelTarget, listRoutingGroups, getRoutingGroup, createRoutingGroup, updateRoutingGroup, deleteRoutingGroup, GROUP_PREFIX } from "./routing";
import { getSpentToday, resetModels } from "./routing-ledger";
import { getProviderCatalog, unknownModelRefs } from "./model-catalog";

/**
 * REST surface for the bot hub: bots, their threads, and a thread's messages.
 * Messages are not stored here — they are read back from the transcript of the
 * agent the thread runs on, using the thread's sdkSessionId.
 *
 * Returns true when the request was handled.
 */
export async function handleBotRoutes(
  req: IRequest,
  res: IResponse,
  workspaceCwd: string
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  const query = parseQuery(url);

  // --- Files (composer @mentions) ---

  // GET /files/search?repoPath=&q= — fuzzy file search inside a repo, backed
  // by OpenCode's own /find/file. Paths come back repo-relative, ready to be
  // inserted as an `@mention`. Degrades to an empty list when the server
  // cannot answer, so the composer simply shows no suggestions.
  if (method === "GET" && path === "/files/search") {
    const repoPath = query.repoPath;
    const q = (query.q ?? "").trim();
    if (!repoPath) { jsonError(res, 400, "repoPath is required"); return true; }
    if (q.length < 2) { jsonOk(res, { files: [] }); return true; }
    try {
      const client = await getOpencodeClientForDir(repoPath);
      const result = await client.find.files({
        query: { directory: repoPath, query: q, dirs: "false" },
      });
      const files = (Array.isArray(result.data) ? result.data : [])
        .filter((p: unknown): p is string => typeof p === "string" && !!p && !p.startsWith("/") && !p.split(/[\\/]/).includes(".."))
        .slice(0, 20)
        .map((p: string) => ({ path: p, name: p.split("/").pop() ?? p }));
      jsonOk(res, { files });
    } catch (err: any) {
      console.warn("[files] search failed:", err?.message);
      jsonOk(res, { files: [] });
    }
    return true;
  }

  // GET /models/capabilities?model=provider/model — what the model can take.
  // Phase 2 gates the composer's clip on `image` / `pdf`; Phase 4 reads
  // `variants`. `known:false` means the provider list has not loaded (yet):
  // the UI offers the control and lets the server reject if it must.
  if (method === "GET" && path === "/models/capabilities") {
    const model = query.model ?? "";
    const slash = model.indexOf("/");
    if (slash === -1) { jsonError(res, 400, "model must be provider/model"); return true; }
    const info = getModelInfo(model.slice(0, slash), model.slice(slash + 1));
    if (!info) { jsonOk(res, { model, known: false }); return true; }
    jsonOk(res, { model, known: true, ...info });
    return true;
  }

  // GET /models/catalog?provider=magpie — the provider's own live model list.
  // opencode.json is a stale snapshot for gateways, so the routing editor must
  // not populate itself from it. `source:"unavailable"` carries a reason and
  // leaves manual entry possible.
  if (method === "GET" && path === "/models/catalog") {
    const provider = (query.provider ?? "magpie").trim() || "magpie";
    const q = (query.q ?? "").trim().toLowerCase();
    const catalog = await getProviderCatalog(provider);
    const models = catalog.models
      .filter((id) => !q || id.toLowerCase().includes(q))
      .slice(0, 500)
      .map((id) => ({ id, ref: `${provider}/${id}` }));
    jsonOk(res, {
      provider,
      models,
      count: models.length,
      source: catalog.source,
      ...(catalog.error ? { error: catalog.error } : {}),
    });
    return true;
  }

  // --- Routing groups ---

  // GET /routing-groups — definitions plus today's spend per model, so a
  // client can show how close each entry is to its declared budget.
  if (method === "GET" && path === "/routing-groups") {
    const groups = listRoutingGroups().map((group) => ({
      ...group,
      spentToday: Object.fromEntries(group.models.map((m) => [m, getSpentToday(m)])),
    }));
    jsonOk(res, { groups });
    return true;
  }

  // POST /routing-groups — create from the editor. Model ids are checked
  // against the provider's live catalog when it can be reached.
  if (method === "POST" && path === "/routing-groups") {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) { jsonError(res, 400, "name is required"); return true; }
    const parsedModels = normalizeModels(body.models);
    if (parsedModels.error) { jsonError(res, 400, parsedModels.error); return true; }
    const parsedBudgets = normalizeBudgets(body.dailyTokenBudgets, parsedModels.models!);
    if (parsedBudgets.error) { jsonError(res, 400, parsedBudgets.error); return true; }
    const unknown = await unknownModelRefs(parsedModels.models!);
    if (unknown.length) {
      jsonError(res, 400, "Some models are not in the provider's catalog", { unknown });
      return true;
    }
    const group = createRoutingGroup({
      name,
      models: parsedModels.models!,
      onError: body.onError === "fail" ? "fail" : "rotate",
      dailyTokenBudgets: parsedBudgets.budgets,
      matchers: normalizeMatchers(body.matchers),
      shortRetryMinutes: normalizeRetry(body.shortRetryMinutes),
    });
    jsonOk(res, { group });
    return true;
  }

  // POST /routing-groups/:id/reset — forget the ledger for today and send
  // every thread using the group back to its first entry.
  const groupResetId = matchId(path, "/routing-groups/", "/reset");
  if (method === "POST" && groupResetId) {
    const group = getRoutingGroup(groupResetId);
    if (!group) { jsonError(res, 404, "Routing group not found"); return true; }
    resetModels(group.models);
    const ref = `${GROUP_PREFIX}${group.id}`;
    const botIds = new Set(listBots().filter((b) => b.model === ref).map((b) => b.id));
    let threads = 0;
    for (const thread of listThreads()) {
      if (botIds.has(thread.botId) && thread.routing?.groupId === group.id) {
        updateThread(thread.id, { routing: undefined });
        threads += 1;
      }
    }
    jsonOk(res, { ok: true, group: group.id, models: group.models.length, threads });
    return true;
  }

  const groupId = matchId(path, "/routing-groups/");
  if (groupId) {
    const group = getRoutingGroup(groupId);
    if (!group) { jsonError(res, 404, "Routing group not found"); return true; }

    if (method === "GET") {
      jsonOk(res, {
        group: {
          ...group,
          spentToday: Object.fromEntries(group.models.map((m) => [m, getSpentToday(m)])),
        },
      });
      return true;
    }

    if (method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};

      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) { jsonError(res, 400, "name cannot be empty"); return true; }
        patch.name = name;
      }

      let models = group.models;
      if (body.models !== undefined) {
        const parsed = normalizeModels(body.models);
        if (parsed.error) { jsonError(res, 400, parsed.error); return true; }
        models = parsed.models!;
        patch.models = models;
        // A model already saved in the group is grandfathered: the gateway can
        // retire or hide it from /v1/models, but that must not block editing
        // the group's budgets, order or name. Only refs being introduced are
        // checked against the live catalog.
        const added = models.filter((ref) => !group.models.includes(ref));
        const unknown = await unknownModelRefs(added);
        if (unknown.length) {
          jsonError(res, 400, "Some models are not in the provider's catalog", { unknown });
          return true;
        }
      }

      if (body.dailyTokenBudgets !== undefined) {
        const parsed = normalizeBudgets(body.dailyTokenBudgets, models);
        if (parsed.error) { jsonError(res, 400, parsed.error); return true; }
        patch.dailyTokenBudgets = parsed.budgets;
      }
      if (body.onError !== undefined) {
        patch.onError = body.onError === "fail" ? "fail" : "rotate";
      }
      if (body.matchers !== undefined) {
        patch.matchers = normalizeMatchers(body.matchers);
      }
      if (body.shortRetryMinutes !== undefined) {
        patch.shortRetryMinutes = normalizeRetry(body.shortRetryMinutes);
      }

      const updated = updateRoutingGroup(groupId, patch as any);
      jsonOk(res, { group: updated });
      return true;
    }

    if (method === "DELETE") {
      const ref = `${GROUP_PREFIX}${groupId}`;
      const users = listBots().filter((b) => b.model === ref);
      if (users.length) {
        jsonError(res, 409, `Routing group is used by ${users.length} bot(s)`, {
          bots: users.map((b) => ({ id: b.id, name: b.name })),
        });
        return true;
      }
      resetModels(group.models);
      for (const thread of listThreads()) {
        if (thread.routing?.groupId === groupId) updateThread(thread.id, { routing: undefined });
      }
      deleteRoutingGroup(groupId);
      jsonOk(res, { deleted: true });
      return true;
    }
  }

  // --- Bots ---

  if (path === "/bots") {
    if (method === "GET") {
      jsonOk(res, { bots: listBots() });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      if (typeof body.name !== "string" || !body.name.trim()) {
        jsonError(res, 400, "name is required");
        return true;
      }
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      const bot = createBot({ ...body, name: body.name.trim() });
      // A bot that states what it needs from a machine gets its setup thread the
      // moment it lands here, whether it was made here or imported.
      const setupThread = ensureSetupThread(bot.id, workspaceCwd);
      jsonOk(res, { bot: getBot(bot.id) ?? bot, setupThread });
      return true;
    }
  }

  // POST /bots/:id/setup — the manual controls beside the automatic run.
  const setupBotId = matchId(path, "/bots/", "/setup");
  if (setupBotId && method === "POST") {
    const bot = getBot(setupBotId);
    if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
    if (!bot.setupInstructions?.trim()) { jsonError(res, 400, "This bot has no setup instructions"); return true; }
    const body = await readBody(req);
    const action = body.action;
    if (action !== "complete" && action !== "reset" && action !== "fail") {
      jsonError(res, 400, "action must be complete, reset or fail");
      return true;
    }
    // A reset re-arms the run and makes sure there is a thread to run it in —
    // the old one may have been deleted.
    const updated = setSetupStatus(bot.id, action === "complete" ? "complete" : action === "fail" ? "failed" : "pending");
    const setupThread = action === "reset" ? ensureSetupThread(bot.id, workspaceCwd) : undefined;
    jsonOk(res, { bot: getBot(bot.id) ?? updated, setupThread });
    return true;
  }

  const botId = matchId(path, "/bots/");
  if (botId) {
    if (method === "GET") {
      const bot = getBot(botId);
      if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
      jsonOk(res, { bot });
      return true;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      const bot = updateBot(botId, body as Partial<Bot>);
      if (!bot) { jsonError(res, 404, "Bot not found"); return true; }
      // Setup instructions can arrive on an edit, not just at creation.
      const setupThread = ensureSetupThread(bot.id, workspaceCwd);
      jsonOk(res, { bot: getBot(bot.id) ?? bot, setupThread });
      return true;
    }
    if (method === "DELETE") {
      if (!deleteBot(botId)) { jsonError(res, 404, "Bot not found"); return true; }
      jsonOk(res, { deleted: true });
      return true;
    }
  }

  // --- Threads ---

  if (path === "/threads") {
    if (method === "GET") {
      jsonOk(res, { threads: listThreads(query.botId) });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      const bot = body.botId ? getBot(body.botId) : undefined;
      if (!bot) { jsonError(res, 400, "a valid botId is required"); return true; }
      // A thread runs where it is told to: the folder the user picked, else the
      // bot's default, else the directory the CLI was started in.
      const repoPath = body.repoPath ?? bot.repoPath ?? workspaceCwd;
      if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
        jsonError(res, 400, `Not a directory: ${repoPath}`);
        return true;
      }
      if (body.agent !== undefined && !isBotAgent(body.agent)) {
        jsonError(res, 400, `agent must be one of: ${BOT_AGENTS.join(", ")}`);
        return true;
      }
      // Setup comes first: a bot that has not prepared this machine cannot be
      // given work yet. Its own setup thread is made by the server, never here.
      if (botNeedsSetup(bot)) {
        const setupThread = ensureSetupThread(bot.id, workspaceCwd);
        jsonError(res, 409, `${bot.name} still needs to set up this machine`, {
          setupRequired: true,
          setupThreadId: setupThread?.id,
        });
        return true;
      }
      jsonOk(res, { thread: createThread(bot.id, repoPath, body.title, "chat", body.agent) });
      return true;
    }
  }

  // /threads/:id/revert stages an OpenCode rewind. The next prompt commits it;
  // unrevert cancels it. Only OpenCode exposes this, and a running turn must
  // finish (or abort) before its history can be cut.
  const revertId = matchId(path, "/threads/", "/revert");
  if (revertId && method === "POST") {
    const thread = getThread(revertId);
    if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
    if (thread.agent !== "opencode" || !thread.sdkSessionId) {
      jsonError(res, 400, "Rewind is only available for OpenCode threads with history");
      return true;
    }
    if ([...sessions.values()].some(s => s.threadId === thread.id && s.status === "running")) {
      jsonError(res, 409, "Session is already running");
      return true;
    }
    const body = await readBody(req);
    if (typeof body.messageID !== "string" || !body.messageID) {
      jsonError(res, 400, "messageID is required");
      return true;
    }
    try {
      await revertOpencodeSession(
        thread.sdkSessionId,
        body.messageID,
        thread.repoPath,
        typeof body.partID === "string" ? body.partID : undefined,
      );
      jsonOk(res, { ok: true });
    } catch (err: any) {
      jsonError(res, 500, err?.message ?? "Rewind failed");
    }
    return true;
  }

  const unrevertId = matchId(path, "/threads/", "/unrevert");
  if (unrevertId && method === "POST") {
    const thread = getThread(unrevertId);
    if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
    if (thread.agent !== "opencode" || !thread.sdkSessionId) {
      jsonError(res, 400, "Rewind is only available for OpenCode threads with history");
      return true;
    }
    try {
      await unrevertOpencodeSession(thread.sdkSessionId, thread.repoPath);
      jsonOk(res, { ok: true });
    } catch (err: any) {
      jsonError(res, 500, err?.message ?? "Unrevert failed");
    }
    return true;
  }

  // /threads/:id/messages must be matched before /threads/:id
  const messagesId = matchId(path, "/threads/", "/messages");
  if (messagesId && method === "GET") {
    const thread = getThread(messagesId);
    if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
    // A thread that has not had a turn yet has no transcript on disk.
    const messages = !thread.sdkSessionId
      ? []
      : thread.agent === "codex"
        ? await loadCodexTranscript(thread.sdkSessionId, thread.repoPath)
        : thread.agent === "opencode"
          ? await loadOpencodeHistory(thread.sdkSessionId, thread.repoPath)
          : await loadTranscript(thread.sdkSessionId, thread.repoPath);
    jsonOk(res, { messages });
    return true;
  }

  // /threads/:id/usage must be matched before /threads/:id
  const usageId = matchId(path, "/threads/", "/usage");
  if (usageId && method === "GET") {
    const thread = getThread(usageId);
    if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
    // Only OpenCode tracks usage; other agents return empty data
    if (thread.agent !== "opencode") {
      jsonOk(res, { usage: null });
      return true;
    }
    const threadKey = `thread:${thread.id}`;
    // Find the active session store for this thread, if a turn is running.
    const activeStore = [...sessions.values()].find(s => s.threadId === thread.id);
    const liveGitbotId = activeStore?.gitbotId;
    // Seed the historical total once per process, from OpenCode itself.
    // Mid-turn, messages the live layer already counted are excluded, so
    // seeded + live never doubles up.
    if (thread.sdkSessionId && !isSeeded(threadKey)) {
      await loadHistoricalUsage(
        await getOpencodeClientForDir(thread.repoPath),
        thread.sdkSessionId,
        threadKey,
        liveGitbotId ? liveMessageIdsOf(liveGitbotId) : undefined,
      );
    }
    let providerID: string | undefined;
    let modelID: string | undefined;
    // The model rides on the bot, not on the thread. A routing group resolves
    // to its active entry for the report.
    const model = getBot(thread.botId)?.model;
    if (model) {
      try {
        const target = resolveModelTarget(model, thread.routing?.index ?? 0);
        if (target) {
          providerID = target.providerID;
          modelID = target.modelID;
        }
      } catch {
        // A dangling group reference must not break the usage endpoint.
      }
    }
    const store = activeStore ?? { gitbotId: threadKey, model };
    const report = buildSessionReport(store, providerID, modelID, threadKey);
    jsonOk(res, { usage: report });
    return true;
  }

  const threadId = matchId(path, "/threads/");
  if (threadId) {
    if (method === "GET") {
      const thread = getThread(threadId);
      if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
      jsonOk(res, { thread });
      return true;
    }
    if (method === "PATCH") {
      const body = await readBody(req);
      const thread = updateThread(threadId, body);
      if (!thread) { jsonError(res, 404, "Thread not found"); return true; }
      jsonOk(res, { thread });
      return true;
    }
    if (method === "DELETE") {
      const thread = getThread(threadId);
      if (!deleteThread(threadId)) { jsonError(res, 404, "Thread not found"); return true; }
      // Deleting the setup thread leaves the bot pointing at nothing; unbind so
      // the next run can make a fresh one.
      if (thread && thread.kind === "setup") updateBot(thread.botId, { setupThreadId: undefined });
      jsonOk(res, { deleted: true });
      return true;
    }
  }

  return false;
}

/** Extracts a single path segment: matchId("/bots/abc", "/bots/") -> "abc". */
function matchId(path: string, prefix: string, suffix = ""): string | null {
  if (!path.startsWith(prefix)) return null;
  let rest = path.slice(prefix.length);
  if (suffix) {
    if (!rest.endsWith(suffix)) return null;
    rest = rest.slice(0, -suffix.length);
  }
  if (!rest || rest.includes("/")) return null;
  return rest;
}

function normalizeModels(input: unknown): { models?: string[]; error?: string } {
  if (!Array.isArray(input)) return { error: "models must be an array of provider/model strings" };
  const models: string[] = [];
  for (const raw of input) {
    const ref = typeof raw === "string" ? raw.trim() : "";
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      return { error: `Invalid model "${ref}": expected provider/model` };
    }
    if (models.includes(ref)) return { error: `Duplicate model "${ref}"` };
    models.push(ref);
  }
  if (!models.length) return { error: "A routing group needs at least one model" };
  return { models };
}

function normalizeBudgets(
  input: unknown,
  models: string[],
): { budgets?: Record<string, number>; error?: string } {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: "dailyTokenBudgets must be an object keyed by provider/model" };
  }
  const budgets: Record<string, number> = {};
  for (const [ref, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!models.includes(ref)) return { error: `Budget for "${ref}" is not in this group` };
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `Budget for "${ref}" must be a positive number` };
    }
    budgets[ref] = Math.round(value);
  }
  return { budgets: Object.keys(budgets).length ? budgets : undefined };
}

function normalizeMatchers(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [provider, pattern] of Object.entries(input as Record<string, unknown>)) {
    if (typeof pattern === "string" && pattern) out[provider] = pattern;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeRetry(input: unknown): number | undefined {
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
