/**
 * Usage tracking for OpenCode sessions: tokens, cost, and context window.
 *
 * Two layers, keyed separately:
 * - Seeded historical totals, keyed `thread:<threadId>`, loaded from
 *   OpenCode's session.messages once per process (on the first REST pull).
 * - Live turn deltas, keyed by gitbot session id, accumulated from
 *   message.updated events. Cross-referenced by messageID so a seed taken
 *   mid-turn excludes messages the live layer already counted (no double
 *   counting either way).
 *
 * A restart loses only the in-memory layers; the seed is rebuilt from
 * OpenCode (the source of truth) on the thread's next REST pull — nothing
 * permanent is lost. Snapshots arrive with tokens=0 and the real numbers on
 * step-finish, so turn reports dedupe on messageID + total + cost: the
 * zero snapshot is never emitted, the real one exactly once.
 */

import type { SessionStore } from "./server-common";

export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  total: number;
}

export interface ContextWindow {
  used: number;
  limit: number | null;
  pct: number | null;
}

export interface UsageReport {
  scope: "turn" | "session";
  messageID?: string;
  usage: UsageSnapshot;
  context?: ContextWindow;
  model?: string;
  [key: string]: unknown;
}

const emptyUsage = (): UsageSnapshot => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  total: 0,
});

// Last emitted fingerprint per messageID, so the zero-snapshot and the real
// one both pass only once (fingerprint: total+cost).
const emittedSnapshots = new Map<string, string>();

// Seeded historical totals per thread: `thread:<threadId>` → usage.
const seededTotals = new Map<string, UsageSnapshot>();

// The last assistant message's context footprint (input + cacheRead +
// cacheWrite): this, not the cross-turn sum, is what fills the window.
// Keyed live by gitbot session id and seeded by threadKey.
const lastWindowUsed = new Map<string, number>();

// Live turn deltas per gitbot session: gitbotId → usage (per store lifetime).
const liveTotals = new Map<string, UsageSnapshot>();

// Message IDs already counted live per gitbot session, used to exclude
// overlaps when seeding mid-turn.
const liveMessageIds = new Map<string, Set<string>>();

// Context limits: providerID/modelID → token limit (null = unknown).
let contextLimitsCache: Map<string, number | null> | null = null;

// What a model can take and how it thinks, straight from config.providers().
// Phase 2 uses `input.image` / `input.pdf` to gate the composer's clip;
// Phase 4 will read `variants`. Null while the cache has not loaded.
export interface ModelInfo {
  image: boolean;
  pdf: boolean;
  reasoning: boolean;
  variants: string[];
  limit: { context: number | null; output: number | null };
}

let modelInfoCache: Map<string, ModelInfo> | null = null;

/**
 * Initialize the model caches from OpenCode's config.providers().
 * Call once when the OpenCode server is ready.
 */
export async function initContextLimits(client: any): Promise<void> {
  const cache = new Map<string, number | null>();
  const info = new Map<string, ModelInfo>();
  try {
    const result = await client.config.providers();
    const providers = result.data?.providers ?? [];
    for (const provider of providers) {
      const models = provider.models ?? [];
      const entries: [string, any][] = Array.isArray(models)
        ? models.filter((m: any) => m?.id).map((m: any) => [m.id, m])
        : Object.entries<any>(models).map(([key, model]) => [model?.id ?? key, model]);
      for (const [key, model] of entries) {
        const id = `${provider.id}/${key}`;
        cache.set(id, model?.limit?.context ?? null);
        info.set(id, {
          image: model?.capabilities?.input?.image === true,
          // OpenCode calls it `input.pdf`; older builds only expose `attachment`.
          pdf:
            model?.capabilities?.input?.pdf === true ||
            (model?.capabilities?.input?.pdf == null && model?.capabilities?.attachment === true),
          reasoning: model?.capabilities?.reasoning === true,
          variants: Object.keys(model?.variants ?? {}),
          limit: {
            context: model?.limit?.context ?? null,
            output: model?.limit?.output ?? null,
          },
        });
      }
    }
  } catch (err: any) {
    console.warn("[usage] failed to load model info:", err.message);
  }
  contextLimitsCache = cache;
  modelInfoCache = info;
}

/** Context limit for providerID/modelID; null when unknown (UI hides the pct). */
export function getContextLimit(providerID: string, modelID: string): number | null {
  if (!contextLimitsCache) return null;
  return contextLimitsCache.get(`${providerID}/${modelID}`) ?? null;
}

/** Capabilities for providerID/modelID; null when the provider list is not loaded. */
export function getModelInfo(providerID: string, modelID: string): ModelInfo | null {
  if (!modelInfoCache) return null;
  return modelInfoCache.get(`${providerID}/${modelID}`) ?? null;
}

/** Normalize an OpenCode message into a usage snapshot; null without token data. */
export function parseUsageFromMessage(msg: any): UsageSnapshot | null {
  const tokens = msg.info?.tokens;
  if (!tokens) return null;
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
    cost: msg.info?.cost ?? 0,
    total: tokens.total ?? 0,
  };
}

/**
 * Snapshot worth emitting? Dedupes on messageID + total + cost, so the
 * tokens=0 snapshot that opens each assistant message is swallowed and the
 * real step-finish snapshot passes exactly once.
 */
export function buildTurnReport(
  messageID: string,
  snapshot: UsageSnapshot,
  model?: string
): UsageReport | null {
  // OpenCode opens every assistant message with an all-zero snapshot and
  // delivers the real numbers at step-finish; the zero one is noise.
  if (snapshot.total === 0 && snapshot.cost === 0) return null;
  const fingerprint = `${snapshot.total}:${snapshot.cost}`;
  const last = emittedSnapshots.get(messageID);
  if (last === fingerprint) return null;
  emittedSnapshots.set(messageID, fingerprint);
  return { scope: "turn", messageID, usage: snapshot, model };
}

/** Accumulate a live turn delta under a gitbot session id. */
export function accumulateUsage(
  gitbotId: string,
  delta: UsageSnapshot,
  messageID?: string,
  options: { updateWindow?: boolean } = {},
): void {
  const current = liveTotals.get(gitbotId) ?? emptyUsage();
  if (messageID) {
    let ids = liveMessageIds.get(gitbotId);
    if (!ids) { ids = new Set(); liveMessageIds.set(gitbotId, ids); }
    ids.add(messageID);
  }
  current.input += delta.input;
  current.output += delta.output;
  current.reasoning += delta.reasoning;
  current.cacheRead += delta.cacheRead;
  current.cacheWrite += delta.cacheWrite;
  current.cost += delta.cost;
  current.total += delta.total;
  liveTotals.set(gitbotId, current);
  // The window reflects the newest message, not the sum of all turns. A
  // subagent's message does not fill the parent's window, so it opts out.
  // Same formula as OpenCode's own TUI/context meter: everything the provider
  // reports for that message, including its output and reasoning.
  if (options.updateWindow !== false) {
    lastWindowUsed.set(
      gitbotId,
      delta.input + delta.output + delta.reasoning + delta.cacheRead + delta.cacheWrite,
    );
  }
}

/** Context footprint of the newest counted message for a gitbot session. */
export function getLiveWindowUsed(gitbotId: string): number | undefined {
  return lastWindowUsed.get(gitbotId);
}

/** Live delta total for a gitbot session (0 = none). */
export function getLiveTotal(gitbotId: string): UsageSnapshot {
  return liveTotals.get(gitbotId) ?? emptyUsage();
}

/**
 * Seed a thread's historical total from OpenCode's session.messages, skipping
 * any message a running store has already counted live (mid-turn seeding).
 * `key` is `thread:<threadId>`; a re-seed overwrites.
 */
export async function loadHistoricalUsage(
  client: any,
  sdkSessionId: string,
  key: string,
  excludeMessageIds?: Set<string>
): Promise<UsageSnapshot | null> {
  const [total, lastWindow] = await Promise.all([
    sumHistoricalUsage(client, sdkSessionId, excludeMessageIds),
    lastMessageWindowUsed(client, sdkSessionId, excludeMessageIds),
  ]);
  if (!total) return null;
  seededTotals.set(key, total);
  if (lastWindow > 0) lastWindowUsed.set(key, lastWindow);
  return total;
}

/** The summed historical usage for a session, or null when nothing was read. */
async function sumHistoricalUsage(
  client: any,
  sdkSessionId: string,
  excludeMessageIds?: Set<string>
): Promise<UsageSnapshot | null> {
  const total = emptyUsage();
  const seen = new Set<string>();
  try {
    const result = await client.session.messages({ path: { id: sdkSessionId } });
    for (const msg of result.data ?? []) {
      const messageId = msg.id ?? msg.info?.id;
      if (messageId) {
        if (excludeMessageIds?.has(messageId)) continue;
        if (seen.has(messageId)) continue;
        seen.add(messageId);
      }
      const snapshot = parseUsageFromMessage(msg);
      if (!snapshot) continue;
      total.input += snapshot.input;
      total.output += snapshot.output;
      total.reasoning += snapshot.reasoning;
      total.cacheRead += snapshot.cacheRead;
      total.cacheWrite += snapshot.cacheWrite;
      total.cost += snapshot.cost;
      total.total += snapshot.total;
    }
  } catch (err: any) {
    console.warn(`[usage] seed failed for ${sdkSessionId}:`, err.message);
    return null;
  }
  return total;
}

/** The window usage of the final assistant message in this thread. Mirrors
 *  OpenCode's own meter: input + output + reasoning + cache read/write of the
 *  newest assistant message that produced output. */
async function lastMessageWindowUsed(
  client: any,
  sdkSessionId: string,
  excludeMessageIds?: Set<string>
): Promise<number> {
  try {
    const result = await client.session.messages({ path: { id: sdkSessionId } });
    for (let i = (result.data ?? []).length - 1; i >= 0; i--) {
      const msg = (result.data ?? [])[i];
      const messageId = msg.id ?? msg.info?.id;
      if (messageId && excludeMessageIds?.has(messageId)) continue;
      if (msg.info?.role !== "assistant") continue;
      const snapshot = parseUsageFromMessage(msg);
      if (snapshot && snapshot.output > 0) {
        return (
          snapshot.input + snapshot.output + snapshot.reasoning + snapshot.cacheRead + snapshot.cacheWrite
        );
      }
    }
  } catch {}
  return 0;
}

/**
 * The authoritative total: seeded historical + this store's live deltas.
 * When there is no live store (between turns), the thread key still brings in
 * the seeded layer.
 */
export function getCombinedTotal(storeKeyOrGitbotId: string, threadKey?: string): UsageSnapshot {
  const live = getLiveTotal(storeKeyOrGitbotId);
  const seeded = threadKey ? seededTotals.get(threadKey) : undefined;
  return {
    input: live.input + (seeded?.input ?? 0),
    output: live.output + (seeded?.output ?? 0),
    reasoning: live.reasoning + (seeded?.reasoning ?? 0),
    cacheRead: live.cacheRead + (seeded?.cacheRead ?? 0),
    cacheWrite: live.cacheWrite + (seeded?.cacheWrite ?? 0),
    cost: live.cost + (seeded?.cost ?? 0),
    total: live.total + (seeded?.total ?? 0),
  };
}

/**
 * Session-scoped usage report: combined total + resolved context window.
 * `threadKey` is the `thread:<id>` key the REST endpoint's seed lives under —
 * omit for a fresh session with no seed. The window is the newest assistant
 * message's full token count (input + output + reasoning + cache read/write),
 * the number OpenCode itself reports. Each turn re-sends the cached history,
 * so the cross-turn sum is not what fills the window.
 */
export function buildSessionReport(
  store: Pick<SessionStore, "gitbotId"> & { model?: string },
  providerID?: string,
  modelID?: string,
  threadKey?: string
): UsageReport {
  const total = getCombinedTotal(store.gitbotId, threadKey);
  let context: ContextWindow | undefined;
  if (providerID && modelID) {
    const limit = getContextLimit(providerID, modelID);
    const used =
      // Live window wins: a turn in flight is the newest state by definition.
      lastWindowUsed.get(store.gitbotId)
      ?? (threadKey ? lastWindowUsed.get(threadKey) : undefined)
      ?? 0;
    context = { used, limit, pct: limit && used > 0 ? Math.round((used / limit) * 100) : 0 };
  }
  return { scope: "session", usage: total, context, model: store.model };
}

/** Whether this thread's seeded total was loaded in this process. */
export function isSeeded(threadKey: string): boolean {
  return seededTotals.has(threadKey);
}

/** Message IDs a running store has already counted live. */
export function liveMessageIdsOf(gitbotId: string): Set<string> | undefined {
  return liveMessageIds.get(gitbotId);
}
