import { randomUUID } from "crypto";
import { join } from "path";
import { dataDir, readCollection, writeCollection } from "./bot-store";

// --- Routing groups -------------------------------------------------------
//
// A routing group is an ordered list of provider/model pairs. GitBot uses the
// first one that still has quota; when a provider reports rate limits or a
// spent daily budget, it moves down the list (see docs/ROUTING-PLAN.md).
// A bot opts in by setting `model` to `group:<id>`; anything else keeps its
// old meaning of a single "provider/model" string.

/** A model entry as the user writes it: "providerID/modelID". */
export type ModelRef = string;

export interface RoutingGroup {
  id: string;
  name: string;
  /** Priority order: the first usable model is the active one. */
  models: ModelRef[];
  /** What to do when a model says it is out: move on (default) or fail the turn. */
  onError?: "rotate" | "fail";
  /** Tokens allowed per UTC day, keyed by "provider/model". Unknown means learn from 429s. */
  dailyTokenBudgets?: Record<ModelRef, number>;
  /** Extra error regexes per providerID, for providers that word quotas oddly. */
  matchers?: Record<string, string>;
  /** Wait in place for a short `retry-after` before rotating. Off when unset. */
  shortRetryMinutes?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type NewRoutingGroup = Partial<RoutingGroup> & Pick<RoutingGroup, "name">;

/** Prefix that marks a bot's `model` field as a group reference. */
export const GROUP_PREFIX = "group:";

const GROUPS_FILE = join(dataDir(), "routing-groups.json");
const now = () => new Date().toISOString();

// --- Storage --------------------------------------------------------------

export function listRoutingGroups(): RoutingGroup[] {
  return readCollection<RoutingGroup>(GROUPS_FILE).sort((a, b) => a.name.localeCompare(b.name));
}

export function getRoutingGroup(id: string): RoutingGroup | undefined {
  return readCollection<RoutingGroup>(GROUPS_FILE).find((g) => g.id === id);
}

export function createRoutingGroup(input: NewRoutingGroup): RoutingGroup {
  const groups = readCollection<RoutingGroup>(GROUPS_FILE);
  const ts = now();
  const group: RoutingGroup = {
    id: randomUUID(),
    name: input.name,
    models: input.models ?? [],
    onError: input.onError ?? "rotate",
    dailyTokenBudgets: input.dailyTokenBudgets,
    matchers: input.matchers,
    shortRetryMinutes: input.shortRetryMinutes,
    createdAt: ts,
    updatedAt: ts,
  };
  groups.push(group);
  writeCollection(GROUPS_FILE, groups);
  return group;
}

export function updateRoutingGroup(id: string, patch: Partial<RoutingGroup>): RoutingGroup | undefined {
  const groups = readCollection<RoutingGroup>(GROUPS_FILE);
  const idx = groups.findIndex((g) => g.id === id);
  if (idx === -1) return undefined;
  const { id: _ignored, createdAt: _created, ...rest } = patch;
  groups[idx] = { ...groups[idx], ...rest, updatedAt: now() };
  writeCollection(GROUPS_FILE, groups);
  return groups[idx];
}

export function deleteRoutingGroup(id: string): boolean {
  const groups = readCollection<RoutingGroup>(GROUPS_FILE);
  const remaining = groups.filter((g) => g.id !== id);
  if (remaining.length === groups.length) return false;
  writeCollection(GROUPS_FILE, remaining);
  return true;
}

// --- Resolution -----------------------------------------------------------

export function isGroupRef(model: string | undefined): boolean {
  return !!model && model.startsWith(GROUP_PREFIX);
}

function parseModelRef(ref: ModelRef): { providerID: string; modelID: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model "${ref}": expected "provider/model"`);
  }
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
}

export type ModelTarget =
  | {
      kind: "model";
      /** The full "provider/model" string, as before groups existed. */
      model: string;
      providerID: string;
      modelID: string;
      group?: undefined;
      index?: undefined;
    }
  | {
      kind: "group";
      group: RoutingGroup;
      index: number;
      model: ModelRef;
      providerID: string;
      modelID: string;
    };

/**
 * Turns a bot's `model` field into the concrete model to send. `group:<id>`
 * resolves to the entry at `index` (clamped), a plain string stays itself.
 * Throws a readable error for a missing/empty/one-off group so the turn ends
 * with a real message instead of a provider failure.
 */
export function resolveModelTarget(model: string | undefined, index = 0): ModelTarget | undefined {
  if (!model) return undefined;

  if (!isGroupRef(model)) {
    return { kind: "model", model, ...parseModelRef(model) };
  }

  const groupId = model.slice(GROUP_PREFIX.length).trim();
  if (!groupId) throw new Error(`Invalid model "${model}": missing routing group id`);

  const group = getRoutingGroup(groupId);
  if (!group) throw new Error(`Routing group "${groupId}" not found`);
  if (group.models.length === 0) throw new Error(`Routing group "${group.name}" has no models`);

  const safeIndex = Math.min(Math.max(0, Math.trunc(index)), group.models.length - 1);
  const ref = group.models[safeIndex];
  return { kind: "group", group, index: safeIndex, model: ref, ...parseModelRef(ref) };
}

// --- Error classification -------------------------------------------------

export type RoutingErrorKind = "quota" | "daily" | "auth" | "provider" | "model" | "fatal" | "unknown";

/**
 * Reads a provider error and says whether another model might help. Quota and
 * daily-limit errors rotate; auth and malformed-request errors do not, because
 * the next model would fail the same way. `unknown` deliberately does not
 * rotate: a bad matcher must not turn an unrelated bug into a model hop.
 */
export function classifyError(
  err: unknown,
  providerID?: string,
  group?: RoutingGroup,
): RoutingErrorKind {
  const { status, message } = readError(err);
  const text = message.toLowerCase();

  if (providerID && group?.matchers?.[providerID]) {
    try {
      if (new RegExp(group.matchers[providerID], "i").test(message)) return "quota";
    } catch {
      // A bad regex is the user's typo, not a reason to crash the turn.
    }
  }

  // Daily/monthly wording wins over the generic 429 check: it means "do not
  // retry this model today", which the ledger uses to skip it proactively.
  if (/daily (?:token )?(?:limit|quota)|monthly (?:limit|quota)|per[- ]day limit/.test(text)) {
    return "daily";
  }
  if (
    status === 429 ||
    /rate limit|too many requests|quota|insufficient[_ ]?(?:credits|balance|funds)|usage limit|capacity/.test(text)
  ) {
    return "quota";
  }
  if (status === 401 || status === 403 || /unauthorized|invalid (?:api )?key|no auth/.test(text)) {
    return "auth";
  }
  // Provider-side breakage (dead endpoint, gateway error, timeout): the model
  // itself is not at fault, so the next provider may still answer. 405 covers
  // openai-compatible endpoints pointed at a URL that does not serve the API.
  if (status === 405 || status === 408 || status === 502 || status === 503 || status === 504 || (status ?? 0) >= 500) {
    return "provider";
  }
  // A model the provider does not know (stale catalog, renamed id) or a prompt
  // that no longer fits: the next entry may well work, so it rotates.
  if (
    status === 404 ||
    /knows no model|model (?:not found|does not exist)|invalid model|unsupported model|context length|token limit exceeded/.test(text)
  ) {
    return "model";
  }
  if (status === 400) {
    return "fatal";
  }
  return "unknown";
}

/** Pulls an HTTP status and a message out of the SDK's several error shapes. */
function readError(err: unknown): { status?: number; message: string } {
  if (err == null) return { message: "" };
  if (typeof err === "string") return { message: err };
  const e = err as any;
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : typeof e.data?.status === "number"
          ? e.data.status
          : typeof e.data?.statusCode === "number"
            ? e.data.statusCode
            : undefined;
  const message =
    e.data?.message || e.message || e.detail?.message || e.detail || e.name || "";
  return { status, message: typeof message === "string" ? message : JSON.stringify(message) };
}
