import {
  Button,
  CountdownChip,
  DashboardLayout,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/10-hope — HOPE timepoint dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_HOPE_ENGINE.md — "Use Dashboard."
// The operational hub: four counters (Open, Closing 48h, Late, Expired) over the org's open HOPE
// schedules, each clickable to filter, above the schedule worklist sorted by window-close. Window state
// (green/amber/red/grey) is derived client-side as a UX cue only — the SERVER is authoritative for status
// (ADR-0030, no frontend authz). Reads GET /api/v1/hope/schedules via the typed client. Leaves only (@chartwarden/ui).
//
// #91 — this worklist is where a HOPE window is ACTED on, and it used to offer no action at all: a
// clinician could see "closes in 6 hours" and had no way to record the timepoint that closes it. Each
// OPEN row now carries Record (the §5.2 capture modal, pinned to that window's RFA and schedule id) and
// Skip (the §4.1 route-3 ceremony). A terminal row (completed / skipped / expired) offers neither,
// because the server refuses both — offering a control the server will refuse is the F-007 rule.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { NameLabel, matchesAllTokens, patientNameOf } from "../../shell/name-display";
import { usePatientNames } from "../../shell/patient-names";
import { type HopeAction, HopeActionModal } from "./hope-action-modal";
import type { RfaKind } from "./hope-api";
import { HopeRecordModal, type RecordWindow } from "./hope-record-modal";
import { BUCKET_TONE, rfaLabel, stateLabel } from "./hope-status";

interface ScheduleRow {
  id: string;
  patientId: string;
  admissionId: string;
  rfaKind: string;
  status: string;
  windowOpensAt: string;
  windowClosesAt: string;
  lateDeadlineAt: string;
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
type Bucket = "" | "open" | "closing" | "late" | "expired";
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

// Pure window-state derivation — a UX cue only; the server owns the authoritative status.
function bucketOf(row: ScheduleRow, nowMs: number): Exclude<Bucket, ""> {
  if (row.status === "expired") return "expired";
  if (row.status !== "open") return "open"; // completed/skipped fall out of the open worklist filters
  const closes = Date.parse(row.windowClosesAt);
  if (nowMs > closes) return "late";
  if (closes - nowMs <= FORTY_EIGHT_HOURS_MS) return "closing";
  return "open";
}

export function HopeDashboard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<ScheduleRow[]>([]);
  const [filter, setFilter] = useState<Bucket>("");
  const [rfaFilter, setRfaFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<ScheduleRow | null>(null);
  const [acting, setActing] = useState<{ action: HopeAction; row: ScheduleRow } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/hope/schedules", {
      params: { query: {} },
    });
    if (err) {
      setError("Could not load HOPE schedules.");
      setLoading(false);
      return;
    }
    setItems((data?.schedules ?? []) as ScheduleRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const patientNames = usePatientNames(items.map((r) => r.patientId));
  const nowMs = Date.now();
  const tagged = useMemo(
    () => items.map((r) => ({ row: r, bucket: bucketOf(r, nowMs) })),
    [items, nowMs],
  );
  const counts = useMemo(
    () => ({
      open: tagged.filter((t) => t.bucket === "open").length,
      closing: tagged.filter((t) => t.bucket === "closing").length,
      late: tagged.filter((t) => t.bucket === "late").length,
      expired: tagged.filter((t) => t.bucket === "expired").length,
    }),
    [tagged],
  );

  const rfaOptions = useMemo(
    () => [
      { value: "", label: "All" },
      ...Array.from(new Set(items.map((r) => r.rfaKind)))
        .sort()
        .map((value) => ({ value, label: rfaLabel(value) })),
    ],
    [items],
  );
  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = tagged.filter((t) => {
      const matchesBucket = !filter || t.bucket === filter;
      const matchesRfa = !rfaFilter || t.row.rfaKind === rfaFilter;
      const matchesSearch = matchesAllTokens(
        [
          t.row.id,
          patientNames[t.row.patientId]?.name,
          patientNames[t.row.patientId]?.mrn,
          t.row.rfaKind,
          t.row.status,
          t.row.windowOpensAt,
          t.row.windowClosesAt,
        ],
        q,
      );
      return matchesBucket && matchesRfa && matchesSearch;
    });
    return [...visible].sort(
      (a, b) => Date.parse(a.row.windowClosesAt) - Date.parse(b.row.windowClosesAt),
    );
  }, [filter, rfaFilter, searchQuery, tagged, patientNames]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = filter !== "" || rfaFilter !== "" || searchQuery !== "";
  const clearFilters = (): void => {
    setFilter("");
    setRfaFilter("");
    setSearchQuery("");
    setPage(1);
  };

  const recordWindow: RecordWindow | null =
    recording === null
      ? null
      : {
          id: recording.id,
          rfaKind: recording.rfaKind,
          windowOpensAt: recording.windowOpensAt,
          windowClosesAt: recording.windowClosesAt,
          lateDeadlineAt: recording.lateDeadlineAt,
        };

  return (
    <>
      <DashboardLayout
        header={
          <PageHeader title="HOPE Timepoints" breadcrumb="Clinical Quality — HOPE schedules">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Track open HOPE timepoint windows, closing deadlines, late schedules, and expired
              items by RFA.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Open"
              value={loading || error ? "—" : counts.open}
              detail="Outside final 48h"
              tone="info"
              accentColor="var(--color-primary)"
              selected={filter === "open"}
              onSelect={() => {
                setFilter("open");
                setPage(1);
              }}
            />
            <KpiCard
              label="Closing 48h"
              value={loading || error ? "—" : counts.closing}
              detail="Needs attention"
              tone={counts.closing > 0 ? "warning" : "neutral"}
              accentColor={
                counts.closing > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
              selected={filter === "closing"}
              onSelect={() => {
                setFilter("closing");
                setPage(1);
              }}
            />
            <KpiCard
              label="Late"
              value={loading || error ? "—" : counts.late}
              detail="Window closed"
              tone={counts.late > 0 ? "danger" : "neutral"}
              accentColor={counts.late > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
              selected={filter === "late"}
              onSelect={() => {
                setFilter("late");
                setPage(1);
              }}
            />
            <KpiCard
              label="Expired"
              value={loading || error ? "—" : counts.expired}
              detail="Terminal schedule"
              tone="neutral"
              accentColor="var(--color-outline-variant)"
              selected={filter === "expired"}
              onSelect={() => {
                setFilter("expired");
                setPage(1);
              }}
            />
          </KpiStrip>
        }
        charts={
          <div style={filterPanelStyle}>
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
            ) : null}
            <div className="wx-filter-panel">
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search schedule or patient..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search HOPE schedules"
                />
              </label>
              <label className="wx-filter-field">
                <span>State</span>
                <select
                  aria-label="Filter by state"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value as Bucket);
                    setPage(1);
                  }}
                  className="wx-select"
                >
                  <option value="">All</option>
                  <option value="open">Open</option>
                  <option value="closing">Closing 48h</option>
                  <option value="late">Late</option>
                  <option value="expired">Expired</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>RFA</span>
                <select
                  aria-label="Filter by RFA"
                  value={rfaFilter}
                  onChange={(e) => {
                    setRfaFilter(e.target.value);
                    setPage(1);
                  }}
                  className="wx-select"
                >
                  {rfaOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {hasActiveFilters ? (
                <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                  <Glyph name="filter" size={15} /> Clear
                </button>
              ) : null}
              <span style={{ ...mutedStyle, lineHeight: "2.5rem", marginLeft: "auto" }}>
                {rows.length} of {items.length} schedules
              </span>
            </div>
          </div>
        }
        table={
          error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : loading && items.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No HOPE schedules"
                description={
                  hasActiveFilters
                    ? "No timepoint windows match the current filters."
                    : "No HOPE schedules are currently open."
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
                aria-label="HOPE records"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
                tabIndex={0}
                className="wx-list-table-wrap"
              >
                <table
                  className="wx-list-table"
                  style={{ minWidth: "66rem", tableLayout: "fixed" }}
                >
                  <colgroup>
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "18%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>RFA</th>
                      <th>Window closes</th>
                      <th>State</th>
                      <th>Patient</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map(({ row, bucket }) => (
                      <tr
                        key={row.id}
                        {...interactiveRowProps(
                          () => navigate(`/patients/${row.patientId}/hope`),
                          false,
                          true,
                        )}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <div style={primaryCellStyle}>
                            <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                              {rfaLabel(row.rfaKind)}
                            </span>
                            <span style={monoMutedStyle}>{row.id.slice(0, 8)}</span>
                          </div>
                        </td>
                        <td>
                          <CountdownChip
                            dueAt={row.windowClosesAt}
                            warnWithinHours={48}
                            label="Closes"
                          />
                        </td>
                        <td>
                          <StatusPill
                            label={stateLabel(bucket)}
                            tone={BUCKET_TONE[bucket] ?? "neutral"}
                          />
                        </td>
                        <td>
                          <div style={primaryCellStyle}>
                            <span style={{ color: "var(--color-on-surface)", fontWeight: 600 }}>
                              <NameLabel value={patientNameOf(patientNames, row.patientId)} />
                            </span>
                            {patientNames[row.patientId]?.mrn ? (
                              <span style={monoMutedStyle}>{patientNames[row.patientId]?.mrn}</span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {row.status === "open" ? (
                            // The row itself navigates; a click on an action must not also do that.
                            <div
                              style={{ display: "flex", gap: "0.375rem" }}
                              onClick={(ev) => ev.stopPropagation()}
                              onKeyDown={(ev) => ev.stopPropagation()}
                            >
                              <Button size="sm" onClick={() => setRecording(row)}>
                                Record
                              </Button>
                              <Button
                                size="sm"
                                tone="tertiary"
                                onClick={() => setActing({ action: "skip", row })}
                              >
                                Skip
                              </Button>
                            </div>
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
                totalItems={rows.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="schedules"
              />
            </>
          )
        }
      />
      {recording !== null ? (
        <HopeRecordModal
          open
          admissionId={recording.admissionId}
          window={recordWindow}
          defaultRfaKind={recording.rfaKind as RfaKind}
          onClose={() => setRecording(null)}
          onDone={() => {
            void load();
          }}
        />
      ) : null}
      {acting !== null ? (
        <HopeActionModal
          open
          action={acting.action}
          targetId={acting.row.id}
          onClose={() => setActing(null)}
          onDone={() => {
            void load();
          }}
        />
      ) : null}
    </>
  );
}

// The dashboard layout's content region supplies the page gutter.
const filterPanelStyle: CSSProperties = {};

const mutedStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
};

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "color-mix(in srgb, var(--color-error) 60%, var(--color-on-surface))",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
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
