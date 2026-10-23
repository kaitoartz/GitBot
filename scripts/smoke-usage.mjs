// Fase 1 smoke test: a real opencode turn through gitbot, asserting the
// usage pipeline end to end. Run: node scripts/smoke-usage.mjs [port]
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.argv[2] ?? 32166;
const BASE = `http://127.0.0.1:${PORT}`;
const THREAD = process.env.SMOKE_THREAD_ID;
if (!THREAD) {
  console.error("SMOKE_THREAD_ID required");
  process.exit(1);
}

const api = {
  get: (p) => fetch(`${BASE}${p}`).then((r) => r.json()),
  post: (p, body) => fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() })),
};

// 1. Pre-turn usage (seeded history)
const before = await api.get(`/threads/${THREAD}/usage`);
console.log("pre-turn:", JSON.stringify(before.usage?.usage), "ctx:", before.usage?.context);
if (!before.usage) { console.error("FAIL: no seeded usage"); process.exit(1); }

// 2. Kick off a small turn
const chat = await api.post("/chat", { threadId: THREAD, prompt: "Reply with exactly the word ok and nothing else." });
if (chat.status !== 200) { console.error("FAIL /chat:", JSON.stringify(chat.body)); process.exit(1); }
const sessionId = chat.body.sessionId;
console.log("turn started, sessionId:", sessionId);

// 3. Stream events; collect usage + done
const events = [];
const res = await fetch(`${BASE}/events?sessionId=${sessionId}`);
if (!res.ok) { console.error("FAIL /events:", res.status); process.exit(1); }
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const seen = { usageTurn: 0, usageSession: null, assistant: false, done: false };
const t0 = Date.now();

reader.read().then(function pump({ done, value }) {
  if (done) return;
  buf += dec.decode(value);
  let idx;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    const ev = JSON.parse(dataLine.slice(6));
    events.push(ev);
    if (ev.type === "usage") {
      if (ev.scope === "turn") { seen.usageTurn++; if (seen.usageTurn === 1) console.log(`turn usage @+${((Date.now()-t0)/1000).toFixed(1)}s:`, JSON.stringify(ev.usage), "msg:", ev.messageID); }
      else { seen.usageSession = ev; console.log(`session usage @+${((Date.now()-t0)/1000).toFixed(1)}s:`, JSON.stringify(ev.usage), "ctx:", JSON.stringify(ev.context)); }
    }
    if (ev.type === "assistant" && !seen.assistant) { seen.assistant = true; console.log(`first assistant text @+${((Date.now()-t0)/1000).toFixed(1)}s`); }
    if (ev.type === "done" || ev.type === "error" || ev.type === "aborted") seen.done = true;
  }
  return reader.read().then(pump);
});

// Bounded wait: turn must finish within 120s
const deadline = Date.now() + 120_000;
while (!seen.done && Date.now() < deadline) await delay(500);
if (seen.usageTurn === 0 || !seen.usageSession) {
  console.error(`FAIL: seen = ${JSON.stringify(seen)}`);
  for (const e of events.slice(-30)) console.error(JSON.stringify(e).slice(0, 200));
  process.exit(1);
}

// 4. Post-turn usage from REST
await delay(500);
const after = await api.get(`/threads/${THREAD}/usage`);
console.log("post-turn:", JSON.stringify(after.usage?.usage), "ctx:", after.usage?.context);
const delta = after.usage.usage.total - before.usage.usage.total;
console.log(`RESULT: turnTotal=${delta} turnEvents=${seen.usageTurn} ok`);
console.log(delta > 0 ? "PASS" : "FAIL");
process.exit(delta > 0 ? 0 : 1);
