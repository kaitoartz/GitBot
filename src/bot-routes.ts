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
import { getSessionHistory as loadOpencodeHistory } from "./start-opencode";
import { getOpencodeClientForDir } from "./start-opencode";
import { buildSessionReport, loadHistoricalUsage, isSeeded, liveMessageIdsOf, getModelInfo } from "./usage";

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
    // The model rides on the bot, not on the thread.
    const model = getBot(thread.botId)?.model;
    if (model) {
      const slashIdx = model.indexOf("/");
      if (slashIdx !== -1) {
        providerID = model.slice(0, slashIdx);
        modelID = model.slice(slashIdx + 1);
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
