import {
  Button,
  StatusPill,
  interactiveRowProps,
  useApiClient,
  useRequestGuard,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
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
// over the invocation search, each row opens its detail screen, whose Invocations tab is exactly that
// query pre-filtered. Adding the two counts to the list response is a backend change, not a UI one.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { lifecycleTone, riskTierTone } from "./status";
import { EmptyListState, ErrorState, LoadingState, PageHead, cap, formatDate } from "./ui";

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
  const navigate = useNavigate();
  const [rows, setRows] = useState<Capability[]>([]);
  const [lifecycleState, setLifecycleState] = useState("");
  const [riskTier, setRiskTier] = useState("");
  const [hotPhase1, setHotPhase1] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const query: Record<string, string | boolean> = {};
    if (lifecycleState) query.lifecycleState = lifecycleState;
    if (riskTier) query.riskTier = riskTier;
    if (hotPhase1) query.hotPhase1 = true;
    const res = await client.GET("/api/v1/ai/capabilities", { params: { query } });
    if (!isCurrent()) return;
    if (res.error) {
      setError("Capability registry unavailable.");
      setLoading(false);
      return;
    }
    setRows(res.data.capabilities);
    setLoading(false);
  }, [client, guard, lifecycleState, riskTier, hotPhase1]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <PageHead
          title="AI capabilities"
          description="Every registered AI capability with its lifecycle state, risk tier, active backend and re-approval clock."
        >
          <select
            value={lifecycleState}
            onChange={(e) => setLifecycleState(e.target.value)}
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
            aria-label="Filter by risk tier"
          >
            <option value="">All risk tiers</option>
            {RISK_TIERS.map((r) => (
              <option key={r} value={r}>
                {cap(r)}
              </option>
            ))}
          </select>
          <select
            value={hotPhase1 ? "hot" : ""}
            onChange={(e) => setHotPhase1(e.target.value === "hot")}
            aria-label="Filter by Phase-1 hot set"
          >
            <option value="">All phases</option>
            <option value="hot">Phase-1 hot only</option>
          </select>
          <Button
            tone="secondary"
            onClick={() => void navigate("/admin/ai-platform/kill-switches")}
          >
            Kill switches
          </Button>
        </PageHead>

        {loading && rows.length === 0 ? (
          <LoadingState label="Loading capabilities…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          // §5.1.1: never empty in production (14 Phase-1 capabilities are pre-seeded), so an empty table
          // means the FILTERS excluded everything — say that, rather than "no capabilities exist".
          <EmptyListState
            glyph="filter"
            title="No capabilities match filters"
            description="Clear a filter to see the rest of the registry."
          />
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">AI capabilities</caption>
              <thead>
                <tr>
                  <th scope="col">Capability</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Active backend</th>
                  <th scope="col">Active prompt</th>
                  <th scope="col">Re-approval due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const open = (): void => {
                    void navigate(`/admin/ai-platform/capabilities/${c.id}`);
                  };
                  return (
                    <tr
                      key={c.id}
                      className="wx-data-row-interactive"
                      {...interactiveRowProps(open, false)}
                    >
                      <td>
                        <span className="wx-row-title">{c.displayName}</span>
                        <span className="wx-row-sub wx-data-md">{c.capabilityKey}</span>
                      </td>
                      <td>
                        <StatusPill
                          label={cap(c.lifecycleState.toLowerCase())}
                          tone={lifecycleTone(c.lifecycleState)}
                        />
                      </td>
                      <td>
                        <StatusPill label={cap(c.riskTier)} tone={riskTierTone(c.riskTier)} />
                      </td>
                      <td className="wx-data-md">{c.defaultBackendKey}</td>
                      <td className="wx-data-md">{c.currentPromptTemplateKey ?? "—"}</td>
                      <td className="wx-nums">{formatDate(c.nextReapprovalDueAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
