// Smoke de Fase 3 (subagentes) contra un GitBot real.
//
// Ejercita: prompt que dispara la tool `task` → eventos `subagent`, texto y
// uso del hijo con `parent_tool_use_id`, y el bloque `tool_use` del historial
// con el `childSessionId` para releer el transcript.
//
// Uso:
//   node scripts/smoke-subagents.mjs
//   BASE_URL=http://127.0.0.1:3100 WORKSPACE=D:\tmp\repo node scripts/smoke-subagents.mjs
//
// Requiere un `gitbot start` corriendo contra un workspace y un server
// OpenCode 1.x (GITBOT_OPENCODE_URL).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const WORKSPACE = resolve(process.env.WORKSPACE || resolve(dirname(fileURLToPath(import.meta.url)), "..", ".smoke-workspace"));
const MODEL = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 240000);

mkdirSync(WORKSPACE, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`);
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function runTurn(sessionId) {
  const res = await fetch(`${BASE}/events?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      events.push({ event, data: parsed });
      const type = parsed.type ?? event;
      if (type === "done" || type === "error" || type === "aborted") return events;
    }
  }
  throw new Error("turn timed out");
}

async function main() {
  const health = await api("/health");
  check("health", health.status === 200, health.body?.serverVersion);

  const bot = await api("/bots", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke subagents",
      agent: "opencode",
      model: MODEL,
      instructions: "Cuando se te pida delegar, usá la herramienta task con el subagente general.",
      repoPath: WORKSPACE,
      permissionMode: "auto-approve",
    }),
  });
  const botId = bot.body?.bot?.id;
  check("create bot", !!botId, bot.status === 200 ? botId : JSON.stringify(bot.body));

  const thread = await api("/threads", {
    method: "POST",
    body: JSON.stringify({ botId, repoPath: WORKSPACE }),
  });
  const threadId = thread.body?.thread?.id;
  check("create thread", !!threadId, thread.status === 200 ? threadId : JSON.stringify(thread.body));

  try {
    const chat = await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        prompt:
          "Delegá al subagente general la tarea de responder exactamente: ok. " +
          "Usá la herramienta task y después respondé con su respuesta.",
      }),
    });
    check("subagent turn accepted", chat.status === 200, JSON.stringify(chat.body));

    const events = await runTurn(chat.body.sessionId);
    const ofType = (t) => events.filter((e) => (e.data.type ?? e.event) === t).map((e) => e.data);

    const subagents = ofType("subagent");
    const started = subagents.find((e) => e.phase === "started");
    check(
      "subagent started event",
      !!started && !!started.parentToolUseId && !!started.childSessionId,
      JSON.stringify(started ?? null),
    );
    check(
      "subagent finished event",
      subagents.some((e) => e.phase === "finished" && e.childSessionId === started?.childSessionId),
      subagents.map((e) => e.phase).join(","),
    );

    const childText = ofType("assistant").find((e) => e.parent_tool_use_id === started?.parentToolUseId);
    check("child text tagged with parent_tool_use_id", !!childText, childText?.content?.slice(0, 60));

    const childUsage = ofType("usage").find((e) => e.parent_tool_use_id === started?.parentToolUseId);
    check(
      "child usage tagged and non-zero",
      !!childUsage && Number(childUsage.usage?.total) > 0,
      childUsage ? `total=${childUsage.usage.total} cost=${childUsage.usage.cost}` : "no child usage",
    );

    const history = await api(`/threads/${threadId}/messages`);
    const blocks = (history.body.messages ?? []).flatMap((m) => m.content ?? []);
    const taskBlock = blocks.find((b) => b.type === "tool_use" && b.tool_name === "task" && b.subagent);
    check(
      "history keeps the task → child link",
      !!taskBlock && taskBlock.subagent.childSessionId === started?.childSessionId,
      JSON.stringify(taskBlock?.subagent ?? null),
    );

    if (started?.childSessionId) {
      const transcript = await api(
        `/sessions/${encodeURIComponent(started.childSessionId)}/history?agent=opencode&repoPath=${encodeURIComponent(WORKSPACE)}`,
      );
      const hasText = (transcript.body.messages ?? []).some((m) =>
        (m.content ?? []).some((b) => b.type === "text" && b.text?.trim()),
      );
      check("child transcript readable", transcript.status === 200 && hasText, `status ${transcript.status}`);
    }
  } finally {
    if (threadId) await api(`/threads/${threadId}`, { method: "DELETE" });
    if (botId) await api(`/bots/${botId}`, { method: "DELETE" });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error("smoke failed:", err?.stack ?? err);
  process.exit(1);
});
