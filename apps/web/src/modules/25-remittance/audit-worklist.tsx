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
// apps/web/src/modules/25-remittance — M25, the AUDIT REQUESTS worklist (milestone 7a-1): RAC / UPIC / SMRC / other
// record requests. The authority is a label. Every due date is one the user recorded from a notice; a request with
// none says "No due date recorded" and is counted, never defaulted. Rows open the audit work rail; "Log an audit
// request" opens the intake form.
import { BillingTabs } from "../../shell/billing-tabs";
import { type AuditRequestSummary, loadAuditRequests } from "./audit-api";
import { AuditDetailPanel } from "./audit-detail-panel";
import { AuditIntakeModal } from "./audit-forms";
import { NO_DUE_DATE } from "./recorded-deadlines";
import { AUDIT_DUE_TONE, AUDIT_STATE_TONE, formatDay, humanize, toneOf } from "./remittance-status";

const STATE_FILTERS = [
  "all",
  "received",
  "in_assembly",
  "in_review",
  "responded",
  "closed",
  "withdrawn",
];
const OPEN_STATES = new Set(["received", "in_assembly", "in_review"]);
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export const isOpenAudit = (r: Pick<AuditRequestSummary, "state">): boolean =>
  OPEN_STATES.has(r.state);
export const hasNoDueDate = (r: AuditRequestSummary): boolean =>
  isOpenAudit(r) && r.dueState === "no_deadline_recorded";
export const isDueWithinWeek = (r: AuditRequestSummary, now: number): boolean => {
  if (!isOpenAudit(r) || !r.nextDueAt) return false;
  const left = new Date(r.nextDueAt).getTime() - now;
  return left >= 0 && left <= WEEK_MS;
};

export function AuditWorklist(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<readonly AuditRequestSummary[]>([]);
  const [stateFilter, setStateFilter] = useState("all");
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A failed reload keeps the rows already shown (stale beats blank); the error shows inline once.
  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadAuditRequests(client);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setError(null);
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
  const open = rows.filter(isOpenAudit);
  const noDueDate = rows.filter(hasNoDueDate);
  const now = Date.now();
  const dueSoon = rows.filter((r) => isDueWithinWeek(r, now));
  const noData = rows.length === 0 && (loading || error !== null);
  const shown = (n: number): string | number => (noData ? "—" : n);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Audit Requests">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              RAC, UPIC and SMRC record requests. Due dates are the ones you recorded from the
              notice.
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <BillingTabs />
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Open Requests"
              value={shown(open.length)}
              detail="Not yet responded"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="No Due Date"
              value={shown(noDueDate.length)}
              detail="Enter it from the notice"
              tone={noDueDate.length > 0 ? "danger" : "neutral"}
              accentColor={
                noDueDate.length > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
              }
            />
            <KpiCard
              label="Due ≤ 7 Days"
              value={shown(dueSoon.length)}
              detail="Recorded deadlines"
              tone={dueSoon.length > 0 ? "warning" : "neutral"}
              accentColor={
                dueSoon.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
            />
          </KpiStrip>
        }
        filters={
          <div style={filterRowStyle}>
            {error && rows.length > 0 ? (
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
              {filtered.length} of {rows.length} requests
            </span>
            <span style={{ flex: 1 }} />
            <Button size="sm" onClick={() => setLogging(true)}>
              Log an audit request
            </Button>
          </div>
        }
        table={
          rows.length === 0 && loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : rows.length === 0 && error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="Unavailable"
                description={error}
                action={
                  <Button size="sm" tone="secondary" onClick={() => void load()}>
                    Retry
                  </Button>
                }
              />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={rows.length === 0 ? "No audit requests" : "No requests in this state"}
                description={
                  rows.length === 0
                    ? "Log a request when a RAC, UPIC or SMRC asks for records, then record its due date from the notice."
                    : "No request matches the state filter."
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={headStyle}>Authority</th>
                    <th style={headStyle}>Reference</th>
                    <th style={headStyle}>Received</th>
                    <th style={headStyle}>State</th>
                    <th style={headStyle}>Claims</th>
                    <th style={headStyle}>Due</th>
                    <th style={headStyle}>
                      <span className="wx-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const name = r.authorityName ?? humanize(r.authorityKind);
                    return (
                      <tr key={r.id} style={rowStyle}>
                        <td style={cellStyle}>{name}</td>
                        <td style={cellStyle}>{r.requestReference ?? "—"}</td>
                        <td style={cellStyle}>{formatDay(r.receivedOn)}</td>
                        <td style={cellStyle}>
                          <StatusPill
                            label={humanize(r.state)}
                            tone={toneOf(AUDIT_STATE_TONE, r.state)}
                          />
                        </td>
                        <td style={cellStyle}>{r.claimCount}</td>
                        <td style={cellStyle}>
                          {r.dueState === "no_deadline_recorded" ? (
                            <StatusPill
                              label={NO_DUE_DATE}
                              tone={toneOf(AUDIT_DUE_TONE, r.dueState)}
                            />
                          ) : r.nextDueAt && isOpenAudit(r) ? (
                            <CountdownChip
                              dueAt={r.nextDueAt}
                              label="due"
                              warnWithinHours={14 * 24}
                              alertWithinHours={3 * 24}
                            />
                          ) : (
                            <span style={mutedStyle}>{humanize(r.dueState)}</span>
                          )}
                        </td>
                        <td style={cellStyle}>
                          <Button
                            size="sm"
                            tone="secondary"
                            aria-label={`Open audit request from ${name}`}
                            onClick={() => setWorkingId(r.id)}
                          >
                            Open
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
        detail={
          workingId ? (
            <AuditDetailPanel
              key={workingId}
              auditId={workingId}
              onClose={() => setWorkingId(null)}
              onChanged={() => void load()}
            />
          ) : null
        }
        fullPageScroll
      />
      {logging ? (
        <AuditIntakeModal
          onClose={() => setLogging(false)}
          onCreated={(id) => {
            setLogging(false);
            setWorkingId(id);
            void load();
          }}
        />
      ) : null}
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
