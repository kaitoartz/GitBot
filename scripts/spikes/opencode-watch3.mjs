// One-off: three watchers subscribed to OP /event while a prompt fires.
// A: without directory header  B: with X-Opencode-Directory  C: after prompt
const OP = "http://127.0.0.1:4096";
const SID = "ses_e99d9b00cffe4Xo5RQnD1B1u3w";
const DIR = "D:\\Proyects\\BounceFinder";

async function makeWatcher(name, headers) {
  const r = await fetch(`${OP}/event`, { headers });
  if (!r.ok) { console.log(name, "HTTP", r.status); return null; }
  const out = { name, events: { message: 0, other: 0 }, types: new Set(), res: r };
  (async () => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.startsWith("data: ")) continue;
        try {
          const e = JSON.parse(line.slice(6));
          if (/^message/.test(e.type)) out.events.message++;
          else out.events.other++;
          if (out.types.size < 10) out.types.add(e.type);
        } catch {}
      }
    }
  })().catch((e) => console.log(name, "reader error", e.message));
  return out;
}

const a = await makeWatcher("A-no-dir", {});
const b = await makeWatcher("B-with-dir", { "X-Opencode-Directory": DIR });
await new Promise((r) => setTimeout(r, 800));

await fetch(`${OP}/session/${SID}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Reply with exactly: watch-ping3" }],
    model: { providerID: "magpie", modelID: "auto/deepseek-v4.1-flash-1017" },
  }),
});
await new Promise((r) => setTimeout(r, 20000));

const report = (w) => w == null ? "watcher failed" : JSON.stringify({ message: w.events.message, other: w.events.other, types: [...w.types] });
console.log("A:", report(a));
console.log("B:", report(b));
process.exit(0);
