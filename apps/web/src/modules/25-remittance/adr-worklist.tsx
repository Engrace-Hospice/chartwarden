import {
  Button,
  CountdownChip,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
// apps/web/src/modules/25-remittance — M25, the ADR WORKLIST (hospice ADR/TPE/QIC PRD, milestone 2a). Every
// additional documentation request from a MAC with its response due date as a countdown: a missed ADR window
// is a denial, so the soonest-due row leads. A window that comes from an unconfirmed rule is flagged, never
// hidden. Rows open the ADR work panel; "Log an ADR" and "MAC response windows" open the two forms.
import { BillingTabs } from "../../shell/billing-tabs";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  findStepUpDraftResourceId,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { AdrDetailPanel } from "./adr-detail-panel";
import { LogAdrModal, MacRulesModal } from "./adr-forms";
import { ADR_DRAFT_ACTION } from "./adr-packet-panel";
import { ADR_STATE_TONE, humanize, toneOf } from "./remittance-status";

interface AdrRow {
  id: string;
  macName: string;
  reviewType: string;
  state: string;
  requestedOn: string;
  windowDays: number;
  windowVerified: boolean;
  responseDueAt: string;
  dueDay: string;
}

const STATE_FILTERS = [
  "all",
  "received",
  "in_assembly",
  "in_review",
  "submitted",
  "denied_no_response",
  "withdrawn",
  "closed",
];
const isOpen = (s: string): boolean => s === "received" || s === "in_assembly" || s === "in_review";
const DAY_MS = 86_400_000;

export function AdrWorklist(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<AdrRow[]>([]);
  const [stateFilter, setStateFilter] = useState("all");
  const session = useSession();
  // Coming back from /step-up: reopen the ADR whose filing form was stashed.
  const [workingId, setWorkingId] = useState<string | null>(() =>
    findStepUpDraftResourceId(session, ADR_DRAFT_ACTION),
  );
  const [logging, setLogging] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/adrs").catch(() => null);
    if (!res || res.error) {
      setError("ADR worklist unavailable — you may lack provider scope.");
      setLoading(false);
      return;
    }
    setRows(res.data?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => rows.filter((r) => stateFilter === "all" || r.state === stateFilter),
    [rows, stateFilter],
  );
  const open = rows.filter((r) => isOpen(r.state));
  const dueSoon = open.filter((r) => new Date(r.responseDueAt).getTime() - Date.now() < 7 * DAY_MS);
  const overdue = open.filter((r) => new Date(r.responseDueAt).getTime() < Date.now());
  const unverified = open.filter((r) => !r.windowVerified);
  const shown = (n: number): string | number => (loading || error ? "—" : n);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="ADR Requests">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Additional documentation requests from your MAC, soonest response due first.
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <BillingTabs />
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Open ADRs"
              value={shown(open.length)}
              detail="Awaiting a response"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="Due ≤ 7 Days"
              value={shown(dueSoon.length)}
              detail="Open responses"
              tone={dueSoon.length > 0 ? "danger" : "neutral"}
              accentColor={
                dueSoon.length > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="Overdue"
              value={shown(overdue.length)}
              detail="Past the response date"
              tone={overdue.length > 0 ? "danger" : "neutral"}
              accentColor={
                overdue.length > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="Unverified Windows"
              value={shown(unverified.length)}
              detail="Confirm against the letter"
              tone={unverified.length > 0 ? "warning" : "neutral"}
              accentColor={
                unverified.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
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
              {filtered.length} of {rows.length} ADRs
            </span>
            <span style={{ flex: 1 }} />
            <Button tone="secondary" size="sm" onClick={() => setEditingRules(true)}>
              MAC response windows
            </Button>
            <Button size="sm" onClick={() => setLogging(true)}>
              Log an ADR
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
                  title="No ADRs"
                  description="Log an ADR when your MAC asks for documentation, so its response deadline is tracked."
                  action={
                    <Button size="sm" onClick={() => setLogging(true)}>
                      Log an ADR
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No ADRs in this state"
                  description="No ADR matches the state filter."
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
                    <th style={headStyle}>MAC</th>
                    <th style={headStyle}>Type</th>
                    <th style={headStyle}>State</th>
                    <th style={headStyle}>Request date</th>
                    <th style={headStyle}>Response due</th>
                    <th style={headStyle}>Work</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} style={rowStyle}>
                      <td style={cellStyle}>{r.macName}</td>
                      <td style={cellStyle}>{r.reviewType === "re_adr" ? "Re-ADR" : "ADR"}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          label={humanize(r.state)}
                          tone={toneOf(ADR_STATE_TONE, r.state)}
                        />
                      </td>
                      <td style={cellStyle}>{r.requestedOn}</td>
                      <td style={cellStyle}>
                        {isOpen(r.state) ? (
                          <CountdownChip
                            dueAt={r.responseDueAt}
                            label="responds"
                            warnWithinHours={14 * 24}
                            alertWithinHours={3 * 24}
                          />
                        ) : (
                          <span style={mutedStyle}>{r.dueDay}</span>
                        )}
                        {isOpen(r.state) && !r.windowVerified ? (
                          <span style={mutedStyle}> · unverified window</span>
                        ) : null}
                      </td>
                      <td style={cellStyle}>
                        <Button
                          size="sm"
                          tone="secondary"
                          aria-label={`Open ADR from ${r.macName}`}
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
            <AdrDetailPanel
              key={workingId}
              adrId={workingId}
              onClose={() => {
                // Closing abandons a stashed filing form (it would otherwise reopen this case on every visit).
                clearStepUpDraft(stepUpDraftKey(session, ADR_DRAFT_ACTION, workingId));
                setWorkingId(null);
              }}
              onChanged={() => void load()}
            />
          ) : null
        }
        fullPageScroll
      />
      {logging ? (
        <LogAdrModal
          onClose={() => setLogging(false)}
          onLogged={(id) => {
            setLogging(false);
            setWorkingId(id);
            void load();
          }}
        />
      ) : null}
      {editingRules ? <MacRulesModal onClose={() => setEditingRules(false)} /> : null}
    </>
  );
}

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
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
  padding: "0 1.5rem 0.75rem",
};
const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
