// Spike S1 — ¿qué forma de FilePartInput acepta el server v1.19.3 para
// imagen / PDF / texto adjunto?
//
// Preguntas:
//   1. ¿`url` acepta un data URL base64? (lo que hoy hace GitBot)
//   2. ¿`url` acepta una ruta local (`file:///...` o `C:\...`)?
//   3. ¿`source: { type:"file", path, text }` basta sin `url`?
//   4. ¿El server guarda el part tal cual en `session.messages`?
//   5. ¿Qué pasa con un MIME no soportado por el modelo (PDF)?
//
// Uso (con un server v1 ya corriendo):
//   BASE_URL=http://127.0.0.1:4096 node scripts/spikes/opencode-file-parts.mjs
//
// No forma parte del build. Deja el volcado en .spike-opencode/file-parts-<ts>.jsonl

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, ".spike-opencode");
const attachDir = join(outDir, "attach");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, "file-parts-" + stamp + ".jsonl");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:4096";
const MODEL = process.env.MODEL || "magpie/auto/deepseek-v4.1-flash-1017";
const MAX_MS = Number(process.env.MAX_MS || 90000);

mkdirSync(attachDir, { recursive: true });
writeFileSync(outFile, "");
const log = (obj) => appendFileSync(outFile, JSON.stringify(obj) + "\n");

// 1x1 PNG rojo.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngPath = join(attachDir, "pixel.png");
writeFileSync(pngPath, Buffer.from(PNG_B64, "base64"));

const TXT = "# hola\n\narchivo de prueba para S1\n";
const txtPath = join(attachDir, "nota.md");
writeFileSync(txtPath, TXT, "utf-8");

// PDF mínimo válido, con una línea de texto.
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (S1 spike) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
const pdfPath = join(attachDir, "nota.pdf");
writeFileSync(pdfPath, PDF, "utf-8");

const slash = MODEL.indexOf("/");
const model =
  slash === -1
    ? undefined
    : { providerID: MODEL.slice(0, slash), modelID: MODEL.slice(slash + 1) };

const localUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;
const fileSource = (p, value) => ({
  type: "file",
  path: p,
  text: { value, start: 0, end: value.length },
});

const cases = [
  {
    id: "image-data-url",
    part: { type: "file", mime: "image/png", filename: "pixel.png", url: dataUrl("image/png", Buffer.from(PNG_B64, "base64")) },
  },
  {
    id: "image-file-url",
    part: { type: "file", mime: "image/png", filename: "pixel.png", url: localUrl(pngPath) },
  },
  {
    id: "image-plain-path",
    part: { type: "file", mime: "image/png", filename: "pixel.png", url: pngPath },
  },
  {
    id: "image-source-only",
    part: { type: "file", mime: "image/png", filename: "pixel.png", source: fileSource(pngPath, "@.spike-opencode/attach/pixel.png") },
  },
  {
    id: "image-source-and-data",
    part: {
      type: "file",
      mime: "image/png",
      filename: "pixel.png",
      url: dataUrl("image/png", Buffer.from(PNG_B64, "base64")),
      source: fileSource(pngPath, "@.spike-opencode/attach/pixel.png"),
    },
  },
  {
    id: "text-data-url",
    part: { type: "file", mime: "text/markdown", filename: "nota.md", url: dataUrl("text/markdown", Buffer.from(TXT)) },
  },
  {
    id: "text-source-and-data",
    part: {
      type: "file",
      mime: "text/markdown",
      filename: "nota.md",
      url: dataUrl("text/markdown", Buffer.from(TXT)),
      source: fileSource(txtPath, "@.spike-opencode/attach/nota.md"),
    },
  },
  {
    id: "pdf-data-url",
    part: { type: "file", mime: "application/pdf", filename: "nota.pdf", url: dataUrl("application/pdf", Buffer.from(PDF)) },
  },
];

const client = createOpencodeClient({ baseUrl: BASE_URL, directory: root });

async function runCase(c, idx) {
  const label = `[${idx + 1}/${cases.length}] ${c.id}`;
  const created = await client.session.create({ body: { title: `[S1] ${c.id}` }, query: { directory: root } });
  const sessionId = created.data?.id;
  if (!sessionId) {
    console.log(label, "-> could not create session:", JSON.stringify(created.error));
    return;
  }

  const events = await client.event.subscribe();
  const seen = [];
  let idle = false;
  const watcher = (async () => {
    for await (const ev of events.stream) {
      const props = ev.properties ?? {};
      const sid = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID;
      if (sid !== sessionId) continue;
      seen.push(ev.type);
      if (ev.type === "session.idle") { idle = true; break; }
      if (ev.type === "session.error") break;
    }
  })();

  const prompted = await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: "Responde exactamente: ok" }, c.part],
      ...(model ? { model } : {}),
    },
  });

  const result = {
    id: c.id,
    promptError: prompted.error ?? null,
    sentPart: c.part,
  };

  if (!prompted.error) {
    await Promise.race([watcher, new Promise((r) => setTimeout(r, MAX_MS))]);
    const history = await client.session.messages({ path: { id: sessionId } }).catch(() => null);
    const user = (history?.data ?? []).find((m) => m.info?.role === "user");
    const filePart = (user?.parts ?? []).find((p) => p.type === "file");
    result.idle = idle;
    result.events = [...new Set(seen)];
    result.storedPart = filePart
      ? {
          type: filePart.type,
          mime: filePart.mime,
          filename: filePart.filename,
          url: String(filePart.url).slice(0, 80),
          source: filePart.source,
        }
      : null;
    result.assistantText = (history?.data ?? [])
      .filter((m) => m.info?.role === "assistant")
      .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
      .join("\n")
      .slice(0, 160);
  }

  console.log(label, "->", prompted.error ? "ERROR " + JSON.stringify(prompted.error).slice(0, 200) : `ok idle=${idle} stored=${JSON.stringify(result.storedPart)?.slice(0, 160)}`);
  log({ at: new Date().toISOString(), kind: "case", result });

  try {
    await client.session.abort({ path: { id: sessionId } }).catch(() => {});
  } catch {}
}

try {
  for (let i = 0; i < cases.length; i++) await runCase(cases[i], i);
  console.log("dump:", outFile);
} finally {
  process.exit(0);
}
