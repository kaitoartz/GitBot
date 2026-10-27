"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { CloseButton } from "./panel-controls";
import {
  ApiError,
  createRoutingGroup,
  deleteRoutingGroup,
  getModelCatalog,
  patchRoutingGroup,
  refreshRoutingGroup,
  resetRoutingGroup,
  type CatalogModel,
  type GroupSource,
  type RoutingGroup,
} from "../lib/api";

// Editor for one routing group: an ordered list of provider/model entries.
// Order is failover order (first entry is active). Budgets are optional and
// only used by the proactive skip in the server.
export default function RoutingGroupEditor({
  group,
  onClose,
  onSaved,
  onDeleted,
}: {
  group: RoutingGroup | null;
  onClose: () => void;
  onSaved: (group: RoutingGroup) => void;
  onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [models, setModels] = useState<string[]>(group?.models ?? []);
  const [budgets, setBudgets] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [ref, value] of Object.entries(group?.dailyTokenBudgets ?? {})) {
      out[ref] = String(value);
    }
    return out;
  });
  const [onError, setOnError] = useState<"rotate" | "fail">(group?.onError ?? "rotate");
  // Dynamic mode: the server pulls models[] from the provider's live catalog
  // on save, refresh, and at startup. The editor hides the manual list then.
  const [dynamic, setDynamic] = useState<boolean>(!!group?.source);
  const [srcProvider, setSrcProvider] = useState<string>(group?.source?.provider ?? "magpie");
  const [srcInclude, setSrcInclude] = useState<string>(group?.source?.include ?? "");
  const [srcExclude, setSrcExclude] = useState<string>(group?.source?.exclude ?? "");
  const [srcOnlyFree, setSrcOnlyFree] = useState<boolean>(!!group?.source?.onlyFree);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogSource, setCatalogSource] = useState<string>("");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pick, setPick] = useState("");
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getModelCatalog("magpie").then(
      (res) => {
        if (!alive) return;
        setCatalog(res.models);
        setCatalogSource(res.source);
        setCatalogError(res.error ?? null);
      },
      (err) => {
        if (!alive) return;
        setCatalogSource("unavailable");
        setCatalogError(err instanceof Error ? err.message : "Catalog unavailable");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? catalog.filter((m) => m.id.toLowerCase().includes(q)) : catalog;
  }, [catalog, filter]);

  function addRef(ref: string) {
    const clean = ref.trim();
    if (!clean) return;
    if (models.includes(clean)) {
      setError(`${clean} is already in this group`);
      return;
    }
    setError(null);
    setModels((prev) => [...prev, clean]);
  }

  function addPicked() {
    const ref = pick || filtered[0]?.ref;
    if (!ref) return;
    addRef(ref);
    setPick("");
  }

  function move(index: number, delta: number) {
    setModels((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function remove(ref: string) {
    setModels((prev) => prev.filter((m) => m !== ref));
    setBudgets((prev) => {
      const next = { ...prev };
      delete next[ref];
      return next;
    });
  }

  function setBudget(ref: string, value: string) {
    setBudgets((prev) => {
      const next = { ...prev };
      if (value.trim()) next[ref] = value;
      else delete next[ref];
      return next;
    });
  }

  function buildSource(): GroupSource | null {
    const provider = srcProvider.trim();
    if (!provider) return null;
    const src: GroupSource = { provider };
    if (srcInclude.trim()) src.include = srcInclude.trim();
    if (srcExclude.trim()) src.exclude = srcExclude.trim();
    if (srcOnlyFree) src.onlyFree = true;
    return src;
  }

  function save() {
    if (!name.trim()) {
      setError("Name the group first.");
      return;
    }
    if (dynamic) {
      const source = buildSource();
      if (!source) {
        setError("Dynamic mode needs a provider (e.g. magpie).");
        return;
      }
      setBusy(true);
      setError(null);
      const body = { name: name.trim(), onError, source };
      const request = group
        ? patchRoutingGroup(group.id, body)
        : createRoutingGroup(body);
      request.then(
        (res) => {
          setBusy(false);
          onSaved({ ...res.group, spentToday: group?.spentToday ?? {} });
        },
        (err) => {
          setBusy(false);
          setError(err instanceof Error ? err.message : "Save failed");
        },
      );
      return;
    }
    if (!models.length) {
      setError("Add at least one model.");
      return;
    }
    const narrowing: Record<string, number> = {};
    for (const [ref, raw] of Object.entries(budgets)) {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) narrowing[ref] = Math.round(value);
    }
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      models,
      onError,
      dailyTokenBudgets: narrowing,
      // Clear source: switching back to static keeps the current snapshot.
      source: null,
    };
    const request = group
      ? patchRoutingGroup(group.id, body)
      : createRoutingGroup(body);
    request.then(
      (res) => {
        setBusy(false);
        onSaved({ ...res.group, spentToday: group?.spentToday ?? {} });
      },
      (err) => {
        setBusy(false);
        if (err instanceof ApiError && err.extra?.unknown) {
          const unknown = err.extra.unknown as { provider: string; models: string[] }[];
          const list = unknown.flatMap((u) => u.models.map((m) => `${u.provider}/${m}`));
          setError(`Not in the live catalog: ${list.join(", ")}`);
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed");
      },
    );
  }

  function removeGroup() {
    if (!group) return;
    if (!confirm(`Delete routing group "${group.name}"?`)) return;
    setBusy(true);
    setError(null);
    deleteRoutingGroup(group.id).then(
      () => {
        setBusy(false);
        onDeleted(group.id);
      },
      (err) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : "Delete failed");
      },
    );
  }

  function resetLedger() {
    if (!group) return;
    setBusy(true);
    setError(null);
    resetRoutingGroup(group.id).then(
      (res) => {
        setBusy(false);
        setNotice(
          `Ledger cleared. ${res.threads} thread(s) will start at ${group.models[0] ?? "the first model"}.`,
        );
      },
      (err) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : "Reset failed");
      },
    );
  }

  function refreshNow() {
    if (!group) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    refreshRoutingGroup(group.id).then(
      (res) => {
        setBusy(false);
        if (res.group) {
          // Keep the editor in sync: the server's snapshot is now truth.
          setModels(res.group.models);
          onSaved({ ...res.group, spentToday: group.spentToday ?? {} });
          setNotice(
            res.refreshed
              ? `Refreshed from ${res.group.source?.provider ?? "catalog"}: ${res.count} models.`
              : `Not dynamic — kept ${res.group.models.length} models.`,
          );
        } else {
          setNotice("Refreshed.");
        }
      },
      (err) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : "Refresh failed");
      },
    );
  }

  const sourceLabel =
    catalogSource === "live"
      ? `${catalog.length} live models from Magpie`
      : catalogSource === "cache"
        ? `${catalog.length} cached models`
        : "catalog unavailable — add models manually";

  return (
    <div
      className="backdrop routing-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal routing-modal" role="dialog" aria-modal="true" aria-label="Routing group">
        <div className="modal-head">
          <h2>{group ? "Edit routing group" : "New routing group"}</h2>
          <CloseButton disabled={busy} onClick={onClose} />
        </div>

        <div className="field">
          <label>Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Cheap fallbacks"
            aria-label="Routing group name"
          />
        </div>

        <div className="field">
          <label>When a model runs out</label>
          <select
            value={onError}
            onChange={(event) => setOnError(event.target.value === "fail" ? "fail" : "rotate")}
          >
            <option value="rotate">Move to the next model</option>
            <option value="fail">Stop the turn</option>
          </select>
        </div>

        <div className="field routing-dynamic">
          <label className="routing-dynamic-toggle">
            <input
              type="checkbox"
              checked={dynamic}
              onChange={(event) => setDynamic(event.target.checked)}
              disabled={busy}
              aria-label="Pull models from the provider catalog"
            />
            Pull models from the provider catalog (dynamic)
          </label>
          {dynamic && (
            <div className="routing-dynamic-fields">
              <p className="routing-dynamic-hint">
                The server pulls the model list from the provider&rsquo;s live
                /v1/models on save, on refresh, and at startup — so the group
                never holds stale ids.
              </p>
              <div className="routing-add-row">
                <label className="routing-dynamic-mini">Provider</label>
                <input
                  value={srcProvider}
                  onChange={(event) => setSrcProvider(event.target.value)}
                  placeholder="magpie"
                  aria-label="Catalog provider"
                  disabled={busy}
                />
              </div>
              <div className="routing-add-row">
                <label className="routing-dynamic-mini">Include (regex)</label>
                <input
                  value={srcInclude}
                  onChange={(event) => setSrcInclude(event.target.value)}
                  placeholder="^auto/"
                  aria-label="Include filter regex"
                  disabled={busy}
                />
                <label className="routing-dynamic-mini">Exclude (regex)</label>
                <input
                  value={srcExclude}
                  onChange={(event) => setSrcExclude(event.target.value)}
                  placeholder="pre-mock_"
                  aria-label="Exclude filter regex"
                  disabled={busy}
                />
              </div>
              <div className="routing-add-row">
                <label className="routing-dynamic-mini">
                  <input
                    type="checkbox"
                    checked={srcOnlyFree}
                    onChange={(event) => setSrcOnlyFree(event.target.checked)}
                    disabled={busy}
                  />{" "}
                  Only free models
                </label>
                {group?.sourceStatus && (
                  <span className="routing-dynamic-status">
                    {group.sourceStatus.error ? (
                      <>last refresh failed: {group.sourceStatus.error}</>
                    ) : (
                      <>
                        {group.sourceStatus.count} models · refreshed{" "}
                        {new Date(group.sourceStatus.at).toLocaleTimeString()}
                      </>
                    )}
                  </span>
                )}
                {group && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={refreshNow}
                  >
                    <IconRefresh size={15} /> Refresh now
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {dynamic ? (
          <div className="field">
            <label>
              Current snapshot
              <span className="hint">{models.length} models from last refresh</span>
            </label>
            <p className="routing-empty">
              {models.length
                ? `${models.length} models pulled from the catalog. Save to re-sync, or uncheck the box to edit the list by hand.`
                : "No snapshot yet. Save to pull the list from the catalog."}
            </p>
          </div>
        ) : (
          <div className="field">
            <label>
              Models
              <span className="hint">order is failover order</span>
            </label>
            {models.length === 0 ? (
              <p className="routing-empty">No models yet. Add one from the catalog below.</p>
            ) : (
              <div className="routing-model-list">
                {models.map((ref, index) => {
                  const spent = group?.spentToday?.[ref] ?? 0;
                  return (
                    <div className="routing-model-row" key={ref}>
                      <span className="routing-model-order">{index + 1}</span>
                      <div className="routing-model-main">
                        <code>{ref}</code>
                        <small>
                          {spent > 0 ? `${spent.toLocaleString()} tokens today` : "not used today"}
                          {budgets[ref] ? ` · budget ${Number(budgets[ref]).toLocaleString()}` : ""}
                        </small>
                      </div>
                      <input
                        className="routing-model-budget"
                        type="number"
                        min={1}
                        step={1}
                        value={budgets[ref] ?? ""}
                        placeholder="budget"
                        title="Daily token budget (optional)"
                        aria-label={`Daily token budget for ${ref}`}
                        onChange={(event) => setBudget(ref, event.target.value)}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="Move up"
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <IconArrowUp size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Move down"
                        disabled={busy || index === models.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <IconArrowDown size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Remove"
                        disabled={busy}
                        onClick={() => remove(ref)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!dynamic && (
          <div className="routing-add">
            <p className="routing-add-title">
              Add from Magpie
              <span>{sourceLabel}</span>
            </p>
            <div className="routing-add-row">
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter models…"
                aria-label="Filter model catalog"
              />
              <select
                value={pick}
                onChange={(event) => setPick(event.target.value)}
                aria-label="Model catalog"
                disabled={!filtered.length}
              >
                {filtered.length === 0 ? (
                  <option value="">No matches</option>
                ) : (
                  filtered.map((model) => (
                    <option key={model.ref} value={model.ref}>
                      {model.id}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !filtered.length}
                onClick={addPicked}
              >
                <IconPlus size={15} /> Add
              </button>
            </div>
            {catalogError && <small className="field-warn">Catalog: {catalogError}</small>}
            <div className="routing-add-row">
              <input
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                placeholder="or type provider/model"
                aria-label="Manual model reference"
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !manual.trim()}
                onClick={() => {
                  addRef(manual);
                  setManual("");
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}

        {notice && <p className="routing-notice">{notice}</p>}
        {error && <p className="chat-error">{error}</p>}

        <div className="acts">
          {group && (
            <>
              <button type="button" className="btn-danger" disabled={busy} onClick={removeGroup}>
                Delete
              </button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={resetLedger}>
                <IconRefresh size={15} /> Reset ledger
              </button>
            </>
          )}
          <div className="spacer" />
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim() || (dynamic ? !srcProvider.trim() : !models.length)}
            onClick={save}
          >
            {group ? "Save group" : "Create group"}
          </button>
        </div>
      </div>
    </div>
  );
}
