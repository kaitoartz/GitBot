// Spike S0/S2 — habla directo con el server de OpenCode, sin pasar por GitBot.
//
// Preguntas que responde:
//   S0: ¿el @opencode-ai/sdk 1.2.15 habla bien con el `opencode` instalado?
//   S2: ¿message.updated trae tokens/costo durante el turno o sólo al final?
//   S2b: ¿de dónde sale limit.context para el modelo? (config.providers)
//
// Uso:
//   node scripts/spikes/opencode-events.mjs
//   MODEL=magpie/auto/deepseek-v4.1-flash-1017 PROMPT="hola" node scripts/spikes/opencode-events.mjs
//
// No forma parte del build: se corre a mano y deja el volcado en
// .spike-opencode/events-<timestamp>.jsonl (ignorado por git).

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, ".spike-opencode");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, "events-" + stamp + ".jsonl");

const MODEL = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const PROMPT = process.env.PROMPT || "Responde exactamente: ok";
const DIRECTORY = process.env.DIRECTORY || root;
const MAX_MS = Number(process.env.MAX_MS || 120000);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, "");

const log = (obj) => appendFileSync(outFile, JSON.stringify(obj) + "\n");
const t0 = Date.now();
const rel = () => Date.now() - t0;

// Split at the first slash, exactly like GitBot does (provider/model).
const slash = MODEL.indexOf("/");
const model = slash === -1 ? undefined : { providerID: MODEL.slice(0, slash), modelID: MODEL.slice(slash + 1) };

// BASE_URL: use a server already running (otherwise the SDK spawns one, which
// fails on Windows when `opencode` is a .cmd shim).
const { client, server } = process.env.BASE_URL
  ? { client: createOpencodeClient({ baseUrl: process.env.BASE_URL, directory: DIRECTORY }), server: { close() {} } }
  : await createOpencode({ config: { permission: { edit: "ask", bash: "ask" } } });
console.log("server up:", rel() + "ms", process.env.BASE_URL ?? "(spawned by SDK)");

const counts = new Map();
let idle = false;

try {
  const providers = await client.config.providers().catch((err) => ({ error: String(err) }));
  const providerList = providers?.data?.providers ?? providers?.providers ?? [];
  const hit = providerList
    .map((p) => ({ id: p.id, model: (p.models ?? {})[model?.modelID] }))
    .find((p) => p.id === model?.providerID && p.model);
  const limit = hit?.model?.limit ?? null;
  console.log("model:", MODEL, "| limit.context:", limit?.context ?? "(not found)", "| providers:", providerList.length);
  log({ at: rel(), kind: "providers", model: MODEL, limit, modelInfo: hit?.model ?? null, providerCount: providerList.length });

  const created = await client.session.create({
    body: { title: "[spike] " + PROMPT.slice(0, 40) },
    query: { directory: DIRECTORY },
  });
  const sessionId = created.data.id;
  console.log("session:", sessionId, "in", DIRECTORY);
  log({ at: rel(), kind: "session", sessionId });

  const events = await client.event.subscribe();

  const done = (async () => {
    for await (const event of events.stream) {
      const type = event.type;
      const props = event.properties ?? {};
      counts.set(type, (counts.get(type) ?? 0) + 1);
      const sid = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID;
      if (sid && sid !== sessionId && props.info?.parentID !== sessionId) {
        // Child sessions belong to the same spike: keep them, they are S3 data.
      }
      log({ at: rel(), type, properties: props });
      if (type === "session.idle" && sid === sessionId) { idle = true; break; }
    }
  })();

  const prompted = await client.session.promptAsync({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: PROMPT }], ...(model ? { model } : {}) },
  });
  if (prompted.error) console.error("promptAsync error:", JSON.stringify(prompted.error));

  await Promise.race([done, new Promise((r) => setTimeout(r, MAX_MS))]);
  console.log("events captured:", [...counts.entries()].map(([k, v]) => k + "=" + v).join(" "), idle ? "(idle)" : "(timeout)");

  const history = await client.session.messages({ path: { id: sessionId } }).catch(() => null);
  const msgs = history?.data ?? [];
  const assistants = msgs.filter((m) => m.info?.role === "assistant");
  console.log("messages:", msgs.length, "| assistants:", assistants.length);
  for (const m of assistants) {
    const i = m.info;
    console.log("  assistant", i.id, "model:", i.providerID + "/" + i.modelID, "cost:", i.cost, "tokens:", JSON.stringify(i.tokens));
    log({ at: rel(), kind: "assistant.info", info: { id: i.id, modelID: i.modelID, providerID: i.providerID, cost: i.cost, tokens: i.tokens, time: i.time } });
  }
  console.log("dump:", outFile);
} finally {
  server.close();
  // The event stream stays open, so the process would never exit on its own.
  process.exit(0);
}
