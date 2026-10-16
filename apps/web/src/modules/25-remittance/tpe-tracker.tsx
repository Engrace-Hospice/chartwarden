import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the TPE PROGRAM TRACKER (hospice ADR/TPE/QIC PRD, milestone 5). Leadership
// sees, per provider entity and MAC: the current round (of 3), the MAC's reported error rate against the exit threshold
// this organization recorded for that MAC, the earliest date the next round may start, and an advisory referral-risk
// label. No threshold is built in: a MAC with none shows "No threshold confirmed". Rows open the program panel; "Open a
// program" and "Exit thresholds" open the two forms. Claims are shown by id and ADR state only, never patient names.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { TPE_PROGRAM_STATE_TONE, TPE_RISK_TONE, humanize, toneOf } from "./remittance-status";
import { type TpeProgramSummary, loadTpePrograms } from "./tpe-api";
import { NO_THRESHOLD_TEXT, TpeDetailPanel, rateText } from "./tpe-detail-panel";
import { TpeProgramModal } from "./tpe-forms";
import { TpeRulesModal } from "./tpe-rules-modal";

const STATE_FILTERS = ["all", "active", "compliant", "referred", "closed"];

export function TpeTracker(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly TpeProgramSummary[]>([]);
  const [stateFilter, setStateFilter] = useState("all");
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await loadTpePrograms(client);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.value);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => rows.filter((r) => stateFilter === "all" || r.state === stateFilter),
    [rows, stateFilter],
  );
  const active = rows.filter((r) => r.state === "active");
  const inRound3 = active.filter((r) => r.currentRound === r.maxRounds);
  const overThreshold = active.filter((r) => r.aboveThreshold === true);
  const noThreshold = active.filter((r) => r.threshold.pct === null);
  const shown = (n: number): string | number => (loading || error ? "—" : n);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="TPE Program" breadcrumb="Revenue Cycle — TPE Program">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Targeted Probe and Educate rounds, the MAC's error rate against the threshold you
              recorded, and the earliest next round. Referral risk is advisory, not a CMS
              determination.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Active Programs"
              value={shown(active.length)}
              detail="Open TPE programs"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="In Round 3"
              value={shown(inRound3.length)}
              detail="A further failure risks referral"
              tone={inRound3.length > 0 ? "warning" : "neutral"}
              accentColor={
                inRound3.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="Over Threshold"
              value={shown(overThreshold.length)}
              detail="Latest MAC rate above the threshold"
              tone={overThreshold.length > 0 ? "danger" : "neutral"}
              accentColor={
                overThreshold.length > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="No Threshold"
              value={shown(noThreshold.length)}
              detail="Enter it from the MAC's letter"
              tone={noThreshold.length > 0 ? "warning" : "neutral"}
              accentColor={
                noThreshold.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
            />
          </KpiStrip>
        }
        filters={
          <div style={filterRowStyle}>
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
            ) : null}
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={mutedStyle}>State</span>
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                {STATE_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All states" : humanize(s)}
                  </option>
                ))}
              </select>
            </label>
            <span style={mutedStyle}>
              {filtered.length} of {rows.length} programs
            </span>
            <span style={{ flex: 1 }} />
            <Button tone="secondary" size="sm" onClick={() => setEditingRules(true)}>
              Exit thresholds
            </Button>
            <Button size="sm" onClick={() => setOpening(true)}>
              Open a program
            </Button>
          </div>
        }
        table={
          loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              {rows.length === 0 ? (
                <EmptyState
                  title="No TPE programs"
                  description="Open a program when your MAC puts you on Targeted Probe and Educate, then record each round as the MAC's letters arrive."
                  action={
                    <Button size="sm" onClick={() => setOpening(true)}>
                      Open a program
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No programs in this state"
                  description="No program matches the state filter."
                  action={
                    <Button tone="secondary" size="sm" onClick={() => setStateFilter("all")}>
                      Show all states
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={headStyle}>Provider</th>
                    <th style={headStyle}>MAC</th>
                    <th style={headStyle}>State</th>
                    <th style={headStyle}>Round</th>
                    <th style={headStyle}>MAC error rate vs threshold</th>
                    <th style={headStyle}>Earliest next round</th>
                    <th style={headStyle}>Referral risk (advisory)</th>
                    <th style={headStyle}>Work</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} style={rowStyle}>
                      <td style={cellStyle}>{r.providerEntityId.slice(0, 8)}</td>
                      <td style={cellStyle}>{r.macName}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          label={humanize(r.state)}
                          tone={toneOf(TPE_PROGRAM_STATE_TONE, r.state)}
                        />
                      </td>
                      <td style={cellStyle}>
                        {r.currentRound === null ? "—" : `${r.currentRound} of ${r.maxRounds}`}
                      </td>
                      <td style={cellStyle}>
                        {r.latestRound ? rateText(r.latestRound.macErrorRatePct) : "No results"}
                        {" · "}
                        {r.threshold.pct === null ? (
                          <span style={mutedStyle}>{NO_THRESHOLD_TEXT.split(" — ")[0]}</span>
                        ) : (
                          <span
                            style={r.aboveThreshold ? { color: "var(--color-error)" } : undefined}
                          >
                            threshold {r.threshold.pct}%
                            {r.threshold.verified ? "" : " (unverified)"}
                          </span>
                        )}
                      </td>
                      <td style={cellStyle}>
                        {r.nextRoundEarliest ?? <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={cellStyle}>
                        <StatusPill label={humanize(r.risk)} tone={toneOf(TPE_RISK_TONE, r.risk)} />
                      </td>
                      <td style={cellStyle}>
                        <Button
                          size="sm"
                          tone="secondary"
                          aria-label={`Open ${r.macName} TPE program`}
                          onClick={() => setWorkingId(r.id)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        detail={
          workingId ? (
            <TpeDetailPanel
              key={workingId}
              programId={workingId}
              onClose={() => setWorkingId(null)}
              onChanged={() => void load()}
            />
          ) : null
        }
        fullPageScroll
      />
      {opening ? (
        <TpeProgramModal
          onClose={() => setOpening(false)}
          onStale={() => setOpening(false)}
          onDone={(created) => {
            setOpening(false);
            setWorkingId(created.id);
            void load();
          }}
        />
      ) : null}
      {editingRules ? (
        <TpeRulesModal onClose={() => setEditingRules(false)} onSaved={() => void load()} />
      ) : null}
    </>
  );
}

const filterRowStyle = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.75rem",
  flexWrap: "wrap" as const,
  padding: "0 1.5rem",
};
const errorBannerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};
const mutedStyle = { color: "var(--color-on-surface-variant)", fontSize: "0.8rem" };
const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
