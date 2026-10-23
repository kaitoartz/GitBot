// One-off: SDK client (exactly like gitbot's getClientForDir) subscribes,
// then a prompt fires; print what arrives.
import "@opencode-ai/sdk";
const m = await import("@opencode-ai/sdk");
const DIR = "D:\\Proyects\\BounceFinder";
const SID = "ses_e99d9b00cffe4Xo5RQnD1B1u3w";

const client = m.createOpencodeClient({ baseUrl: "http://127.0.0.1:4096", directory: DIR });
const events = await client.event.subscribe();
console.log("subscribed via SDK");

const types = [];
const pump = (async () => {
  for await (const event of events.stream) {
    types.push(event.type);
    if (types.length < 30) console.log("raw:", event.type);
  }
})();
pump.catch((e) => console.log("pump error:", e.message));

await new Promise((r) => setTimeout(r, 700));
const res = await client.session.promptAsync({
  path: { id: SID },
  body: {
    parts: [{ type: "text", text: "Reply with exactly: sdk-ping" }],
    model: { providerID: "magpie", modelID: "auto/deepseek-v4.1-flash-1017" },
  },
});
console.log("promptAsync ok:", !res.error);

await new Promise((r) => setTimeout(r, 20000));
const uniq = [...new Set(types)];
console.log("types seen:", uniq.length, uniq.slice(0, 20));
process.exit(0);
