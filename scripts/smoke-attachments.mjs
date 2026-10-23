// Smoke de Fase 2 (adjuntos) contra un GitBot real.
//
// Ejercita el camino completo: bot + hilo + POST /chat con `attachments`,
// turno real contra OpenCode 1.19.3, evento `user_prompt` (solo metadatos) y
// el historial releído de OpenCode (imagen + mención @ruta).
//
// Uso:
//   node scripts/smoke-attachments.mjs
//   BASE_URL=http://127.0.0.1:3100 WORKSPACE=D:\tmp\repo node scripts/smoke-attachments.mjs
//
// Requiere un `gitbot start` corriendo contra un workspace que contenga
// `smoke/note.md` y `smoke/pixel.png` (el script los crea si puede).

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const WORKSPACE = resolve(process.env.WORKSPACE || resolve(dirname(fileURLToPath(import.meta.url)), "..", ".smoke-workspace"));
const MODEL = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 180000);

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

mkdirSync(join(WORKSPACE, "smoke"), { recursive: true });
writeFileSync(join(WORKSPACE, "smoke", "note.md"), "# nota de smoke\n");
writeFileSync(join(WORKSPACE, "smoke", "pixel.png"), Buffer.from(PNG_B64, "base64"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Reads the session SSE until done/error/aborted and returns the events. */
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

  const caps = await api(`/models/capabilities?model=${encodeURIComponent(MODEL)}`);
  check("model capabilities", caps.status === 200, JSON.stringify(caps.body));

  const search = await api(`/files/search?repoPath=${encodeURIComponent(WORKSPACE)}&q=note`);
  const found = (search.body.files ?? []).some((f) => f.path.endsWith("smoke/note.md"));
  check("/files/search finds the mention target", search.status === 200 && found, JSON.stringify(search.body.files));

  const bot = await api("/bots", {
    method: "POST",
    body: JSON.stringify({
      name: "Smoke attachments",
      agent: "opencode",
      model: MODEL,
      instructions: "Responde con una sola palabra cuando se te pida.",
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
    // Outside the repo: must fail before a turn starts.
    const outside = await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        prompt: "hola",
        attachments: [{ kind: "path", path: "../outside.txt" }],
      }),
    });
    check("outside-repo path is rejected", outside.status === 400, outside.body?.error);

    // Mention turn: code travels as @path, no bytes.
    const mentionTurn = await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        prompt: "Responde exactamente: ok",
        attachments: [{ kind: "path", path: "smoke/note.md" }],
      }),
    });
    check("mention turn accepted", mentionTurn.status === 200, JSON.stringify(mentionTurn.body));
    const mentionEvents = await runTurn(mentionTurn.body.sessionId);
    const userPrompt = mentionEvents.find((e) => (e.data.type ?? e.event) === "user_prompt");
    const meta = userPrompt?.data?.attachments?.[0];
    check(
      "user_prompt carries metadata only",
      !!meta && meta.kind === "mention" && meta.path === "smoke/note.md" && !meta.dataUrl,
      JSON.stringify(meta),
    );
    const mentions = await api(`/threads/${threadId}/messages`);
    const mentionText = JSON.stringify(mentions.body.messages ?? []);
    check("history keeps the @mention", mentionText.includes("@smoke/note.md"));

    // Image turn: real FilePartInput, stored by OpenCode.
    const imageTurn = await api("/chat", {
      method: "POST",
      body: JSON.stringify({
        threadId,
        prompt: "Responde exactamente: ok",
        attachments: [
          { kind: "image", name: "pixel.png", mime: "image/png", dataUrl: `data:image/png;base64,${PNG_B64}` },
        ],
      }),
    });
    check("image turn accepted", imageTurn.status === 200, JSON.stringify(imageTurn.body));
    const imageEvents = await runTurn(imageTurn.body.sessionId);
    const imagePrompt = imageEvents.find((e) => (e.data.type ?? e.event) === "user_prompt");
    const imageMeta = imagePrompt?.data?.attachments?.[0];
    check(
      "user_prompt image metadata",
      !!imageMeta && imageMeta.kind === "image" && imageMeta.mime === "image/png" && !imageMeta.dataUrl,
      JSON.stringify(imageMeta),
    );
    const history = await api(`/threads/${threadId}/messages`);
    const blocks = (history.body.messages ?? []).flatMap((m) => m.content ?? []);
    const imageBlock = blocks.find((b) => b.type === "image_url");
    check(
      "history renders the attached image",
      !!imageBlock && String(imageBlock.url).startsWith("data:image/png;base64,"),
      imageBlock ? String(imageBlock.url).slice(0, 32) : "no image_url block",
    );
    const hasReply = (history.body.messages ?? []).some((m) =>
      m.role === "assistant" && (m.content ?? []).some((b) => b.type === "text" && b.text?.trim()),
    );
    check("assistant replied after the attachment", hasReply);
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
