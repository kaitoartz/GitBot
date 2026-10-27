import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Live model catalog ---------------------------------------------------
//
// OpenCode's provider list comes from opencode.json, which is a snapshot: a
// gateway such as Magpie can add, rename, or retire models without touching
// that file. Routing groups must only contain models the gateway actually
// serves, so the editor reads the provider's own /v1/models instead.

interface CatalogResult {
  models: string[];
  source: "live" | "cache" | "unavailable";
  baseURL?: string;
  error?: string;
}

interface CacheEntry {
  at: number;
  models: string[];
  baseURL?: string;
  error?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function configCandidates(): string[] {
  const out: string[] = [];
  if (process.env.OPENCODE_CONFIG) out.push(process.env.OPENCODE_CONFIG);
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
  out.push(join(dir, "opencode.json"), join(dir, "opencode.jsonc"));
  return out;
}

/** opencode.jsonc allows comments; JSON.parse does not. Strings stay intact. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Drop trailing commas outside strings, without touching text inside them.
  let clean = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      clean += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    clean += ch;
  }
  return clean;
}

function readOpencodeConfig(): Record<string, any> | undefined {
  for (const file of configCandidates()) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(stripJsonc(readFileSync(file, "utf-8")));
      if (parsed && typeof parsed === "object") return parsed as Record<string, any>;
    } catch {
      // A malformed config is OpenCode's problem, not a reason to fail the UI.
    }
  }
  return undefined;
}

function providerOptions(providerID: string): { baseURL?: string; apiKey?: string } {
  if (providerID === "magpie" && process.env.GITBOT_MAGPIE_URL) {
    return {
      baseURL: process.env.GITBOT_MAGPIE_URL,
      apiKey: process.env.GITBOT_MAGPIE_KEY,
    };
  }
  const config = readOpencodeConfig();
  const provider = config?.provider?.[providerID] ?? config?.providers?.[providerID];
  const options = provider?.options ?? {};
  return {
    baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
    apiKey: typeof options.apiKey === "string" ? options.apiKey : undefined,
  };
}

/** Models a provider serves right now, from its own /v1/models. */
export async function getProviderCatalog(providerID: string): Promise<CatalogResult> {
  const now = Date.now();
  const hit = cache.get(providerID);
  if (hit && now - hit.at < TTL_MS) {
    return { models: hit.models, baseURL: hit.baseURL, error: hit.error, source: "cache" };
  }

  const { baseURL, apiKey } = providerOptions(providerID);
  if (!baseURL) {
    return {
      models: hit?.models ?? [],
      source: "unavailable",
      error: `Provider "${providerID}" has no baseURL in opencode.json`,
    };
  }

  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    const raw = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.models)
          ? body.models
          : [];
    const models = raw
      .map((m: any) => (typeof m === "string" ? m : String(m?.id ?? "")))
      .filter(Boolean);
    cache.set(providerID, { at: now, models, baseURL });
    return { models, source: "live", baseURL };
  } catch (err: any) {
    const message = err?.name === "TimeoutError" ? "timeout" : err?.message ?? String(err);
    if (hit?.models.length) {
      return { models: hit.models, baseURL, error: message, source: "cache" };
    }
    return { models: [], baseURL, error: message, source: "unavailable" };
  }
}

/**
 * Returns the refs a provider does not list. Providers whose catalog cannot be
 * read are skipped on purpose: a gateway being down must not block saving a
 * group that was valid a minute ago.
 */
export async function unknownModelRefs(
  refs: string[],
): Promise<{ provider: string; models: string[] }[]> {
  const byProvider = new Map<string, string[]>();
  for (const ref of refs) {
    const slash = ref.indexOf("/");
    if (slash <= 0) continue;
    const provider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    const list = byProvider.get(provider) ?? [];
    list.push(model);
    byProvider.set(provider, list);
  }

  const out: { provider: string; models: string[] }[] = [];
  for (const [provider, models] of byProvider) {
    const catalog = await getProviderCatalog(provider);
    if (!catalog.models.length) continue;
    const known = new Set(catalog.models);
    const unknown = models.filter((m) => !known.has(m));
    if (unknown.length) out.push({ provider, models: unknown });
  }
  return out;
}
