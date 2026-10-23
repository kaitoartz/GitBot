"use client";

import { useState, useEffect } from "react";
import { ChevronDownIcon } from "@animateicons/react/lucide/chevron-down-icon";
import AnimatedActionIcon from "./animated-action-icon";

export interface UsageData {
  scope: "turn" | "session";
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    total: number;
  };
  context?: {
    used: number;
    limit: number | null;
    pct: number | null;
  };
  model?: string;
}

interface UsageBarProps {
  /** Thread id, for the historical total (GET /threads/:id/usage). */
  threadId: string | null;
  /** GitBot session id (not the thread id) — only known once a turn has run. */
  sessionId: string | null;
  agent: string;
  /** True while a turn is running: only then does a live stream exist. */
  streaming: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export default function UsageBar({ threadId, sessionId, agent, streaming }: UsageBarProps) {
  const [turnUsage, setTurnUsage] = useState<UsageData | null>(null);
  const [sessionUsage, setSessionUsage] = useState<UsageData | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Fetch historical usage when the thread changes.
  useEffect(() => {
    setTurnUsage(null);
    setSessionUsage(null);
    if (!threadId || agent !== "opencode") return;
    fetch(`/threads/${threadId}/usage`)
      .then((res) => res.json())
      .then((data) => {
        if (data.usage) setSessionUsage(data.usage);
      })
      .catch(() => {});
  }, [threadId, agent]);

  // Live usage while a turn runs. The stream is bound to the gitbot session id
  // — which only answers while a session store exists — so the connection is
  // only opened while streaming, and closed on 404/error instead of retrying.
  useEffect(() => {
    if (!sessionId || !streaming || agent !== "opencode") return;
    const eventSource = new EventSource(`/events?sessionId=${encodeURIComponent(sessionId)}`);
    eventSource.addEventListener("usage", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data) as UsageData;
        if (event.scope === "turn") {
          setTurnUsage(event);
          // Merge the turn into the running session total.
          setSessionUsage((prev) => {
            if (!prev) return prev;
            const u = prev.usage;
            const d = event.usage;
            // The turn's footprint is the newest window state: OpenCode's own
            // formula, including the message's output and reasoning.
            const windowUsed =
              d.input + d.output + d.reasoning + d.cacheRead + d.cacheWrite;
            return {
              ...prev,
              usage: {
                input: u.input + d.input,
                output: u.output + d.output,
                reasoning: u.reasoning + d.reasoning,
                cacheRead: u.cacheRead + d.cacheRead,
                cacheWrite: u.cacheWrite + d.cacheWrite,
                cost: u.cost + d.cost,
                total: u.total + d.total,
              },
              ...(prev.context && prev.context.limit != null
                ? {
                    context: {
                      ...prev.context,
                      used: windowUsed,
                      pct: Math.min(999, Math.round((windowUsed / prev.context.limit) * 100)),
                    },
                  }
                : {}),
            };
          });
        } else if (event.scope === "session") {
          setSessionUsage(event);
          setTurnUsage(null);
        }
      } catch {}
    });
    // The store may already be gone (404) or the stream closed on "done" —
    // either way, stop EventSource's automatic reconnect loop.
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, [sessionId, streaming, agent]);

  if (!sessionUsage) return null;

  const { usage: sessionTotal, context } = sessionUsage;
  const turnTotal = turnUsage?.usage;

  // Color by context percentage: green <60%, amber <85%, red ≥85%.
  let contextColor = "var(--ok)";
  if (context?.pct != null) {
    if (context.pct >= 85) contextColor = "var(--danger)";
    else if (context.pct >= 60) contextColor = "var(--amber)";
  }

  return (
    <div className="usage-bar">
      <div className="usage-bar-compact">
        {context && context.used > 0 && (
          <span
            className="usage-bar-context"
            style={{ color: contextColor }}
            title={
              context.limit != null
                ? `Ventana de contexto actual del modelo: ${context.used.toLocaleString()} de ${context.limit.toLocaleString()} tokens (${context.pct}% usado, ${Math.max(0, 100 - (context.pct ?? 0))}% libre). No es el total acumulado del hilo.`
                : `Ventana de contexto actual: ${context.used.toLocaleString()} tokens. El modelo no informa su limite.`
            }
          >
            contexto{context.limit != null ? ` ${context.pct}% · ` : " "}
            {formatTokens(context.used)}
            {context.limit != null ? `/${formatTokens(context.limit)}` : ""}
          </span>
        )}
        {turnTotal && turnTotal.total > 0 && (
          <span className="usage-bar-turn">turno {formatCost(turnTotal.cost)}</span>
        )}
        <span className="usage-bar-session">hilo {formatCost(sessionTotal.cost)}</span>
        {turnTotal && turnTotal.total > 0 && (
          <span className="usage-bar-tokens">
            {formatTokens(turnTotal.input)} in · {formatTokens(turnTotal.output)} out
          </span>
        )}
        <button
          type="button"
          className="usage-bar-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Ocultar detalles" : "Ver detalles"}
          aria-expanded={expanded}
        >
          <AnimatedActionIcon
            icon={ChevronDownIcon}
            size={12}
            style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
          />
        </button>
      </div>
      {expanded && (
        <div className="usage-bar-expanded">
          <div className="usage-bar-row">
            <span className="usage-bar-label">Input</span>
            <span>{formatTokens(sessionTotal.input)}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Output</span>
            <span>{formatTokens(sessionTotal.output)}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Reasoning</span>
            <span>{formatTokens(sessionTotal.reasoning)}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Cache read</span>
            <span>{formatTokens(sessionTotal.cacheRead)}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Cache write</span>
            <span>{formatTokens(sessionTotal.cacheWrite)}</span>
          </div>
          {context && context.limit != null && (
            <>
              <div className="usage-bar-row">
                <span className="usage-bar-label">Contexto usado</span>
                <span>
                  {formatTokens(context.used)} ({context.pct}%)
                </span>
              </div>
              <div className="usage-bar-row">
                <span className="usage-bar-label">Contexto libre</span>
                <span>{formatTokens(Math.max(0, context.limit - context.used))}</span>
              </div>
              <div className="usage-bar-row">
                <span className="usage-bar-label">Limite del modelo</span>
                <span>{formatTokens(context.limit)}</span>
              </div>
            </>
          )}
          <div className="usage-bar-row">
            <span className="usage-bar-label">Tokens acumulados del hilo</span>
            <span>{formatTokens(sessionTotal.total)}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Costo por turno</span>
            <span>{turnTotal ? formatCost(turnTotal.cost) : "—"}</span>
          </div>
          <div className="usage-bar-row">
            <span className="usage-bar-label">Costo del hilo</span>
            <span>{formatCost(sessionTotal.cost)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
