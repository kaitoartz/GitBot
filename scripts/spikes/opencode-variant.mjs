// Spike S4 — ¿`variant` viaja en promptAsync, aplica por mensaje y lo heredan
// los subagentes?
//
// Uso:
//   node scripts/spikes/opencode-variant.mjs
//   MODEL=magpie/auto/deepseek-v4.1-flash-1017 node scripts/spikes/opencode-variant.mjs
//
// Deja el volcado en .spike-opencode/variant-<timestamp>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, ".spike-opencode");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `variant-${stamp}.json`);
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:4096";
const directory = resolve(process.env.DIRECTORY || join(root, ".smoke-workspace"));
const model = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const [providerID, ...rest] = model.split("/");
const modelID = rest.join("/");

mkdirSync(outDir, { recursive: true });
mkdirSync(directory, { recursive: true });

const client = createOpencodeClient({ baseUrl, directory });
const log = [];
const record = (label, value) => {
  log.push({ label, value });
  console.log(label, JSON.stringify(value).slice(0, 400));
};

/** Send one prompt with an explicit variant and wait for session.idle. */
async function turn(sessionId, prompt, variant) {
  const events = [];
  const ac = new AbortController();
  const stream = await client.event.subscribe({ signal: ac.signal });
  const done = (async () => {
    try {
      for await (const event of stream.stream) {
        events.push(event);
        if (event.type === "session.idle" && event.properties?.sessionID === sessionId) return;
        if (event.type === "session.error") throw new Error(JSON.stringify(event.properties));
      }
    } catch (err) {
      if (err?.name !== "AbortError") throw err;
    }
  })();

  const body = {
    parts: [{ type: "text", text: prompt }],
    model: { providerID, modelID },
    // Not in the 1.2.15 SDK types yet; the v1.19 server accepts it.
    ...(variant ? { variant } : {}),
  };
  const res = await client.session.promptAsync({ path: { id: sessionId }, body });
  if (res.error) throw new Error(`promptAsync ${variant}: ${JSON.stringify(res.error)}`);

  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("idle timeout")), 180000)),
  ]);
  ac.abort();

  const msgs = await client.session.messages({ path: { id: sessionId } });
  const assistants = (msgs.data ?? []).filter((m) => m.info?.role === "assistant");
  const last = assistants[assistants.length - 1];
  return {
    variant,
    prompt,
    assistant: last
      ? {
          id: last.info.id,
          modelID: last.info.modelID,
          providerID: last.info.providerID,
          variant: last.info.variant ?? null,
          tokens: last.info.tokens,
          cost: last.info.cost,
          text: (last.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
            .slice(0, 200),
        }
      : null,
    events: events.map((e) => e.type),
  };
}

async function main() {
  const session = await client.session.create({
    body: { title: `spike variant ${stamp}` },
    query: { directory },
  });
  const sessionId = session.data.id;
  record("session", { sessionId, directory, model });

  const low = await turn(sessionId, "Responde solo: ok (low)", "low");
  record("turn low", low);

  const max = await turn(sessionId, "Responde solo: ok (max)", "max");
  record("turn max", max);

  const plain = await turn(sessionId, "Responde solo: ok (sin variante)", undefined);
  record("turn plain", plain);

  const delegated = await turn(
    sessionId,
    "Delegá al subagente general la tarea de responder exactamente: ok. Después respondé con su respuesta.",
    "max",
  );
  record("turn delegated", delegated);

  // The task part names the child session; inspect that child's assistant
  // message to see whether the parent's variant was inherited.
  const all = await client.session.messages({ path: { id: sessionId } });
  let childSessionId = null;
  for (const msg of all.data ?? []) {
    for (const part of msg.parts ?? []) {
      if (part.type === "tool" && part.tool === "task" && part.state?.metadata?.sessionId) {
        childSessionId = part.state.metadata.sessionId;
      }
    }
  }
  record("childSessionId", childSessionId);
  if (childSessionId) {
    const child = await client.session.messages({ path: { id: childSessionId } });
    const assistants = (child.data ?? []).filter((m) => m.info?.role === "assistant");
    record(
      "child assistants",
      assistants.map((m) => ({ variant: m.info.variant ?? null, modelID: m.info.modelID, tokens: m.info.tokens })),
    );
    await client.session.delete({ path: { id: childSessionId } });
  }

  const variants = new Set(
    [low.assistant, max.assistant, plain.assistant].map((a) => a?.variant).filter(Boolean),
  );
  record("observed message.variant values", [...variants]);

  await client.session.delete({ path: { id: sessionId } });
  writeFileSync(outFile, JSON.stringify(log, null, 2));
  console.log("dump:", outFile);
}

main().catch((err) => {
  console.error("spike failed:", err?.stack ?? err);
  process.exit(1);
});
