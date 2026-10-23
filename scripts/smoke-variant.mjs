// Smoke de Fase 4 (variantes de razonamiento) contra un GitBot real.
//
// Verifica que `variant` viaja en /chat, que OpenCode lo marca en cada
// mensaje del asistente y que un valor no declarado se rechaza con 400.
//
// Uso:
//   node scripts/smoke-variant.mjs
//   BASE_URL=http://127.0.0.1:3100 OPENCODE_URL=http://127.0.0.1:4096 node scripts/smoke-variant.mjs
//
// Requiere un `gitbot start` corriendo contra un workspace y un server
// OpenCode 1.x con un modelo que declare variantes.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const OPENCODE = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const WORKSPACE = resolve(process.env.WORKSPACE || resolve(dirname(fileURLToPath(import.meta.url)), "..", ".smoke-workspace"));
const MODEL = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 180000);

mkdirSync(WORKSPACE, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
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
      const type = parsed.type ?? event;
      if (type === "done" || type === "error" || type === "aborted") return parsed;
    }
  }
  throw new Error("turn timed out");
}

const opencode = createOpencodeClient({ baseUrl: OPENCODE, directory: WORKSPACE });

async function assistantVariants(sdkSessionId) {
  const msgs = await opencode.session.messages({ path: { id: sdkSessionId } });
  return (msgs.data ?? [])
    .filter((m) => m.info?.role === "assistant")
    .map((m) => m.info.variant ?? null);
}

async function main() {
  const health = await api("/health");
  check("health", health.status === 200, health.body?.serverVersion);

  const bot = await api("/bots", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke variant",
      agent: "opencode",
      model: MODEL,
      instructions: "Responde corto.",
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

  let gitbotSessionId = null;
  try {
    const low = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ threadId, prompt: "Responde solo: low", variant: "low" }),
    });
    check("variant turn accepted", low.status === 200, JSON.stringify(low.body));
    gitbotSessionId = low.body.sessionId;
    await runTurn(gitbotSessionId);

    const status = await api(`/sessions/${encodeURIComponent(gitbotSessionId)}/status`);
    const sdkSessionId = status.body.sdkSessionId;
    check("sdk session available", !!sdkSessionId, String(sdkSessionId));

    const first = await assistantVariants(sdkSessionId);
    check("message carries variant low", first.at(-1) === "low", JSON.stringify(first));

    const config = await api(`/sessions/${encodeURIComponent(gitbotSessionId)}/config`);
    check("store keeps the variant", config.body.variant === "low", JSON.stringify(config.body));

    const max = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ threadId, prompt: "Responde solo: max", variant: "max" }),
    });
    check("second variant turn accepted", max.status === 200, JSON.stringify(max.body));
    gitbotSessionId = max.body.sessionId;
    await runTurn(gitbotSessionId);

    const second = await assistantVariants(sdkSessionId);
    check("variant applies per message", second.at(-1) === "max", JSON.stringify(second));

    const plain = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ threadId, prompt: "Responde solo: default" }),
    });
    check("turn without variant accepted", plain.status === 200, JSON.stringify(plain.body));
    gitbotSessionId = plain.body.sessionId;
    await runTurn(gitbotSessionId);

    const third = await assistantVariants(sdkSessionId);
    check("omitting the variant clears it", third.at(-1) === null, JSON.stringify(third));

    const bad = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ threadId, prompt: "x", variant: "ultra-not-real" }),
    });
    check("unknown variant rejected", bad.status === 400, `${bad.status} ${bad.body?.error ?? ""}`);
    check(
      "rejection names the valid variants",
      String(bad.body?.error ?? "").includes("offers:"),
      String(bad.body?.error ?? ""),
    );
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
