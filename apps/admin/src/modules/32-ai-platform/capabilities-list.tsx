import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/32-ai-platform — §5.1.1 capability registry overview
// (`/admin/ai-platform/capabilities`, `ai.capability.read`). The AI Safety Owner's front door: every
// registered capability with its lifecycle state, risk tier, active backend and re-approval clock.
//
// FILTERS. `lifecycleState` / `riskTier` / `hotPhase1` are SERVER-side query parameters (the route
// takes all three), so the filter controls re-fetch rather than narrowing a client-side array — the
// registry is small today but the filter must not start lying the day it is not.
//
// COLUMNS THE SPEC ASKS FOR AND THE API DOES NOT SERVE: `30d invocation count` and `Last hallucination
// report` are not on `GET /api/v1/ai/capabilities`. Rather than fabricate them from a second N+1 fan-out
// over the invocation search, each row links to its detail screen, whose Invocations tab is exactly that
// query pre-filtered. Adding the two counts to the list response is a backend change, not a UI one.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { lifecycleTone, riskTierTone } from "./status";
import {
  actionButtonStyle,
  bodyRow,
  cap,
  cell,
  formatDate,
  inputStyle,
  pageStyle,
  tableStyle,
  theadRow,
} from "./ui";

type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];
type Capability = CapabilityPage["capabilities"][number];

const LIFECYCLE_STATES = [
  "PROPOSED",
  "DESIGN_REVIEW",
  "EVALUATION",
  "PILOT",
  "APPROVED",
  "MONITORING",
  "DEPRECATED",
  "RETIRED",
] as const;
const RISK_TIERS = ["high", "medium", "low"] as const;

export function CapabilitiesList(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Capability[]>([]);
  const [lifecycleState, setLifecycleState] = useState("");
  const [riskTier, setRiskTier] = useState("");
  const [hotPhase1, setHotPhase1] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string | boolean> = {};
    if (lifecycleState) query.lifecycleState = lifecycleState;
    if (riskTier) query.riskTier = riskTier;
    if (hotPhase1) query.hotPhase1 = true;
    const res = await client.GET("/api/v1/ai/capabilities", { params: { query } });
    if (res.error) {
      setError("Capability registry unavailable.");
      setLoading(false);
      return;
    }
    setRows(res.data.capabilities);
    setLoading(false);
  }, [client, lifecycleState, riskTier, hotPhase1]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = rows;

  return (
    <div style={pageStyle}>
      <PageHeader
        title="AI capabilities"
        breadcrumb="AI Platform"
        actions={
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <select
              value={lifecycleState}
              onChange={(e) => setLifecycleState(e.target.value)}
              style={inputStyle}
              aria-label="Filter by lifecycle state"
            >
              <option value="">All lifecycle states</option>
              {LIFECYCLE_STATES.map((s) => (
                <option key={s} value={s}>
                  {cap(s.toLowerCase())}
                </option>
              ))}
            </select>
            <select
              value={riskTier}
              onChange={(e) => setRiskTier(e.target.value)}
              style={inputStyle}
              aria-label="Filter by risk tier"
            >
              <option value="">All risk tiers</option>
              {RISK_TIERS.map((r) => (
                <option key={r} value={r}>
                  {cap(r)}
                </option>
              ))}
            </select>
            <label style={{ display: "flex", gap: "0.4rem", fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                checked={hotPhase1}
                onChange={(e) => setHotPhase1(e.target.checked)}
              />
              Phase-1 hot only
            </label>
            <Link to="/admin/ai-platform/kill-switches" style={actionButtonStyle(false)}>
              Kill switches
            </Link>
          </div>
        }
      />
      {loading && rows.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : filtered.length === 0 ? (
        // §5.1.1: never empty in production (14 Phase-1 capabilities are pre-seeded), so an empty table
        // means the FILTERS excluded everything — say that, rather than "no capabilities exist".
        <EmptyState
          title="No capabilities match filters"
          description="Clear a filter to see the rest of the registry."
        />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={cell}>Key</th>
              <th style={cell}>Display name</th>
              <th style={cell}>Lifecycle</th>
              <th style={cell}>Risk</th>
              <th style={cell}>Active backend</th>
              <th style={cell}>Active prompt</th>
              <th style={cell}>Re-approval due</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} style={bodyRow}>
                <td style={cell}>
                  <code>{c.capabilityKey}</code>
                </td>
                <td style={cell}>{c.displayName}</td>
                <td style={cell}>
                  <StatusPill
                    label={cap(c.lifecycleState.toLowerCase())}
                    tone={lifecycleTone(c.lifecycleState)}
                  />
                </td>
                <td style={cell}>
                  <StatusPill label={cap(c.riskTier)} tone={riskTierTone(c.riskTier)} />
                </td>
                <td style={cell}>
                  <code>{c.defaultBackendKey}</code>
                </td>
                <td style={cell}>
                  {c.currentPromptTemplateKey ? <code>{c.currentPromptTemplateKey}</code> : "—"}
                </td>
                <td style={cell} className="tabular-nums">
                  {formatDate(c.nextReapprovalDueAt)}
                </td>
                <td style={cell}>
                  <Link
                    to={`/admin/ai-platform/capabilities/${c.id}`}
                    style={actionButtonStyle(true)}
                  >
                    Detail
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
