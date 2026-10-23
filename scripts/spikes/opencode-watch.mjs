// One-off: watch OP /event raw and simultaneously fire a prompt to the smoke
// session. Prints any event for that session (and heartbeats suppressed).
const OP = process.env.OP_URL ?? "http://127.0.0.1:4096";
const SID = process.env.SMOKE_SDK_SESSION ?? "ses_e99d9b00cffe4Xo5RQnD1B1u3w";

const seen = [];
const sub = fetch(`${OP}/event`).then(async (r) => {
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
        if (e.properties?.sessionID === SID || e.type.startsWith("server.connected")) {
          seen.push(e.type);
        }
      } catch {}
    }
  }
});

// Give the subscription a moment, then prompt via the sync endpoint.
await new Promise((r) => setTimeout(r, 1000));
const prompt = await fetch(`${OP}/session/${SID}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Reply with exactly: watch-ping" }],
    model: { providerID: "magpie", modelID: "auto/deepseek-v4.1-flash-1017" },
  }),
});
console.log("prompt status:", prompt.status);
await new Promise((r) => setTimeout(r, 15000));
console.log("events seen for session:", [...new Set(seen)], `(n=${seen.length})`);
process.exit(0);
