import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./bot-store";

// --- Daily token ledger ---------------------------------------------------
//
// Counting lives here, not in OpenCode: OpenCode knows context windows, not
// per-model daily quotas. The ledger is keyed by "provider/model" and resets
// implicitly when the UTC date changes. Nothing here is authoritative — it
// only lets a routing group skip a model whose declared budget is spent before
// spending a request on it.

interface LedgerEntry {
  /** UTC day, YYYY-MM-DD. An entry from another day counts as zero. */
  date: string;
  tokens: number;
}

type Ledger = Record<string, LedgerEntry>;

const LEDGER_FILE = join(dataDir(), "routing-ledger.json");

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function load(): Ledger {
  if (!existsSync(LEDGER_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const day = today();
    const out: Ledger = {};
    for (const [model, entry] of Object.entries(raw as Ledger)) {
      if (entry && entry.date === day && Number.isFinite(entry.tokens)) out[model] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function save(ledger: Ledger): void {
  if (!existsSync(dataDir())) mkdirSync(dataDir(), { recursive: true });
  const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf-8");
  renameSync(tmp, LEDGER_FILE);
}

/** Tokens this model has spent today (UTC). Unknown models read as zero. */
export function getSpentToday(model: string, now = new Date()): number {
  if (!model) return 0;
  const entry = load()[model];
  return entry && entry.date === today(now) ? entry.tokens : 0;
}

/** Adds a turn's tokens to the model's day. Negative/NaN values are ignored. */
export function addTokens(model: string, tokens: number): void {
  if (!model || !Number.isFinite(tokens) || tokens <= 0) return;
  const ledger = load();
  const day = today();
  if (ledger[model]?.date !== day) ledger[model] = { date: day, tokens: 0 };
  ledger[model].tokens += Math.round(tokens);
  save(ledger);
}

/** Forgets today's count for the given models (a manual reset). */
export function resetModels(models: string[]): void {
  if (!models.length) return;
  const ledger = load();
  let changed = false;
  for (const model of models) {
    if (model in ledger) {
      delete ledger[model];
      changed = true;
    }
  }
  if (changed) save(ledger);
}
