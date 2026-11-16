import {
  Button,
  CountdownChip,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  type ReadStatus,
  StatusPill,
  WorkQueueLayout,
  settleRead,
  useApiClient,
  useReloadFocus,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — SFV worklist (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Work Queue."
// Open / overdue / missed Symptom Follow-Up Visits across the org, sorted by due-at; each row shows the
// triggering assessment, the 2-calendar-day deadline countdown (ADR-0018 D1), and the server status. A
// state filter narrows the queue server-side. Reads GET /api/v1/hope/sfv via the typed client; the server
// enforces every scope (ADR-0030 — no authz on the frontend). Leaves only (@chartwarden/ui).
//
// #91 — this is the queue whose reason to exist is COMPLETING the follow-up. Each OPEN or OVERDUE row (the two
// states the capture hub treats as actionable) carries Complete, a link to the TRIGGERING assessment (`?completeSfv=1`
// opens its completion dialog on arrival, when one can be offered): the follow-up
// is answered (J2053A-H) in its "Complete SFV" dialog, and the server refuses an SFV completion without those
// answers, so this queue never records one itself. A missed or completed row offers nothing: `planSfvCompletion`
// refuses both, and offering a refused control is the F-007 rule.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import { withRequestTimeout } from "./hope-api";
import { formatInstantDateTime } from "./hope-format";
import { completeSfvPath } from "./hope-paths";
import { HopeListReadState } from "./hope-read-state";
import { SFV_TONE, stateLabel } from "./hope-status";

interface SfvRow {
  id: string;
  patientId: string;
  admissionId: string;
  triggeringAssessmentId: string;
  status: string;
  triggeredAt: string;
  dueAt: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function SfvWorklist(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [items, setItems] = useState<SfvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const focusRef = useReloadFocus<HTMLDivElement>(loading);
  const [readStatus, setReadStatus] = useState<ReadStatus>("ok");
  const unavailable = readStatus !== "ok";

  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latestLoad.current;
    // Drop the previous outcome so an old Retry cannot be pressed while this load is in flight.
    setLoading(true);
    setReadStatus("ok");
    const query: { state?: string } = {};
    if (state) query.state = state;
    // An empty reply from a gateway fault is not an empty queue, and a rejected request is not an exception: both are
    // `failed` (with Retry), and a refusal is `denied`. A queue that says "nothing to do" when it could not be read hides
    // the follow-ups that are due.
    // Bounded: a request nobody answers is `failed` too (with Retry), not a spinner that never ends.
    const { status, res } = await settleRead(
      withRequestTimeout((signal) => client.GET("/api/v1/hope/sfv", { params: { query }, signal })),
    );
    if (mine !== latestLoad.current) return;
    setReadStatus(status);
    const rows = status === "ok" ? ((res?.data?.sfvs ?? []) as SfvRow[]) : [];
    setItems([...rows].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)));
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();
  const decoratedItems = useMemo(
    () =>
      items.map((s) => {
        const overdue = s.status === "open" && nowMs > Date.parse(s.dueAt);
        return { row: s, effectiveStatus: overdue ? "overdue" : s.status };
      }),
    [items, nowMs],
  );
  const counts = useMemo(
    () => ({
      open: decoratedItems.filter((i) => i.effectiveStatus === "open").length,
      overdue: decoratedItems.filter((i) => i.effectiveStatus === "overdue").length,
      missed: decoratedItems.filter((i) => i.effectiveStatus === "missed").length,
      completed: decoratedItems.filter((i) => i.effectiveStatus === "completed").length,
    }),
    [decoratedItems],
  );
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return decoratedItems.filter(({ row, effectiveStatus }) => {
      const matchesSearch =
        !q ||
        [
          row.id,
          row.patientId,
          row.triggeringAssessmentId,
          row.status,
          effectiveStatus,
          // What the column shows (the viewer's zone), so the date the clinician sees is a date they can search; the raw
          // instant still matches, for anyone who pastes one.
          formatInstantDateTime(row.triggeredAt),
          row.triggeredAt,
          row.dueAt,
        ].some((value) => value.toLowerCase().includes(q));
      return matchesSearch;
    });
  }, [decoratedItems, searchQuery]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = state !== "" || searchQuery !== "";
  const clearFilters = (): void => {
    setState("");
    setSearchQuery("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader title="Symptom Follow-Up Visits">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track symptom follow-up visits triggered by HOPE assessments, due dates, missed visits,
            and overdue risk.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open"
            value={loading || unavailable ? "—" : counts.open}
            detail="Awaiting visit"
            tone="info"
            accentColor="var(--color-primary)"
            selected={state === "open"}
            onSelect={() => {
              setState("open");
              setPage(1);
            }}
          />
          <KpiCard
            label="Overdue"
            value={loading || unavailable ? "—" : counts.overdue}
            detail="Past due"
            tone={counts.overdue > 0 ? "warning" : "neutral"}
            accentColor={
              counts.overdue > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            selected={state === "overdue"}
            onSelect={() => {
              setState("overdue");
              setPage(1);
            }}
          />
          <KpiCard
            label="Missed"
            value={loading || unavailable ? "—" : counts.missed}
            detail="Escalated miss"
            tone={counts.missed > 0 ? "danger" : "neutral"}
            accentColor={counts.missed > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={state === "missed"}
            onSelect={() => {
              setState("missed");
              setPage(1);
            }}
          />
          <KpiCard
            label="Completed"
            value={loading || unavailable ? "—" : counts.completed}
            detail="Closed SFVs"
            tone="success"
            accentColor="var(--color-success)"
            selected={state === "completed"}
            onSelect={() => {
              setState("completed");
              setPage(1);
            }}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          <div style={filterRowStyle}>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search patient, assessment, SFV..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search symptom follow-up visits"
              />
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>State</span>
              <select
                aria-label="SFV state"
                value={state}
                onChange={(e) => {
                  setState(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">All</option>
                <option value="open">Open</option>
                <option value="overdue">Overdue</option>
                <option value="missed">Missed</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button size="sm" tone="tertiary" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {unavailable ? "SFVs unavailable" : `${filteredItems.length} of ${items.length} SFVs`}
            </span>
          </div>
        </div>
      }
      table={
        <div
          ref={focusRef}
          tabIndex={-1}
          // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is for form controls; this names a results region.
          role="group"
          aria-label="SFV worklist results"
          aria-busy={loading}
          style={{ outline: "none" }}
        >
          {unavailable ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <HopeListReadState
                status={readStatus}
                subject="the symptom follow-up queue"
                failedTitle="The symptom follow-up queue could not be loaded"
                onRetry={() => void load()}
              />
            </div>
          ) : loading && items.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No SFVs"
                description={
                  hasActiveFilters
                    ? "No symptom-follow-up visits match the current filters."
                    : "No symptom-follow-up visits are currently open."
                }
                action={
                  hasActiveFilters ? (
                    <Button tone="secondary" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <section
                aria-label="SFV worklist"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
                tabIndex={0}
                style={tableViewportStyle}
              >
                <table style={tableStyle}>
                  <colgroup>
                    <col style={{ width: "19%" }} />
                    <col style={{ width: "15%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>SFV</th>
                      <th>Triggered</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>Patient</th>
                      <th>Assessment</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedItems.map(({ row: s, effectiveStatus }) => (
                      <tr key={s.id}>
                        <td>
                          <div style={primaryCellStyle}>
                            <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                              Symptom follow-up
                            </span>
                            <span style={monoMutedStyle}>{s.id.slice(0, 8)}</span>
                          </div>
                        </td>
                        <td className="tabular-nums">{formatInstantDateTime(s.triggeredAt)}</td>
                        <td>
                          <CountdownChip
                            dueAt={s.dueAt}
                            warnWithinHours={48}
                            alertWithinHours={12}
                            label="Due"
                          />
                        </td>
                        <td>
                          <StatusPill
                            label={stateLabel(effectiveStatus)}
                            tone={SFV_TONE[effectiveStatus] ?? "neutral"}
                          />
                        </td>
                        <td style={monoMutedStyle}>{s.patientId.slice(0, 8)}</td>
                        <td style={monoMutedStyle}>{s.triggeringAssessmentId.slice(0, 8)}</td>
                        <td>
                          {s.status === "open" || s.status === "overdue" ? (
                            <Link
                              to={completeSfvPath(s.triggeringAssessmentId)}
                              className="wx-btn-primary wx-btn-sm"
                              aria-label={`Complete symptom follow-up ${s.id.slice(0, 8)}`}
                            >
                              Complete
                            </Link>
                          ) : (
                            <span style={mutedStyle}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={filteredItems.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="SFVs"
              />
            </>
          )}
        </div>
      }
    />
  );
}

const filterPanelStyle: CSSProperties = {
  padding: "0 1.5rem 0.75rem",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  gap: "0.75rem",
};

const filterLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.25rem",
};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const selectStyle: CSSProperties = {
  minHeight: "2.35rem",
  padding: "0.45rem 0.65rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const tableViewportStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const tableStyle: CSSProperties = {
  width: "100%",
  minWidth: "68rem",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  fontSize: "0.875rem",
};

const primaryCellStyle: CSSProperties = {
  display: "grid",
  gap: "0.2rem",
};

const monoMutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
  fontVariantNumeric: "tabular-nums",
};
