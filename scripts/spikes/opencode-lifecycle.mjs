// One-off: replicate gitbot's exact client lifecycle, watching events pass/fail.
const m = await import("@opencode-ai/sdk");
const DIR = "D:\\Proyects\\BounceFinder";
const SID = "ses_e99d9b00cffe4Xo5RQnD1B1u3w";
const BASE = "http://127.0.0.1:4096";

const client = m.createOpencodeClient({ baseUrl: BASE, directory: DIR });

// Step 1: config.get
const cfg = await client.config.get();
console.log("config.get ok:", !cfg.error);

// Step 2: config.update (gitbot's permissionConfig)
const perm = { permission: { edit: "ask", bash: "ask", webfetch: "ask" } };
const upd = await client.config.update({ body: { ...(cfg.data ?? {}), ...perm } });
console.log("config.update ok:", !upd.error);

// Step 3: config.providers (our initContextLimits)
const prov = await client.config.providers();
console.log("config.providers ok:", !prov.error, Array.isArray(prov.data?.providers) ? "providers ok" : "?");

// Step 4: subscribe
const events = await client.event.subscribe();
console.log("subscribed");
const types = [];
const pump = (async () => {
  for await (const event of events.stream) {
    types.push(event.type);
    if (types.length < 25) console.log("raw:", event.type);
  }
})();
pump.catch((e) => console.log("pump error:", e.message));

await new Promise((r) => setTimeout(r, 700));
const res = await client.session.promptAsync({
  path: { id: SID },
  body: {
    parts: [{ type: "text", text: "Reply with exactly: flow-ping" }],
    model: { providerID: "magpie", modelID: "auto/deepseek-v4.1-flash-1017" },
  },
});
console.log("promptAsync ok:", !res.error);

await new Promise((r) => setTimeout(r, 20000));
const uniq = [...new Set(types)];
console.log("types seen:", uniq.length, uniq.slice(0, 20));
process.exit(0);
