import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/26-cap — M26, the THRESHOLD EVENT QUEUE (R2, §5.1.4). The reviewer-oriented queue of
// band transitions (90/95/100 aggregate · 18/20 inpatient) for billing managers + compliance officers.
// GAP-079 wires Acknowledge here (optional notes); the server stays authoritative for cap.event.acknowledge. Lantern: WorkQueueLayout + No-Line table + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { CapActionDialog, sendCapMutation } from "./cap-actions";
import { BAND_TONE, humanize, shortDate, toneOf } from "./cap-status";

interface EventRow {
  id: string;
  scope: string;
  patientId: string | null;
  priorBand: string;
  currentBand: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  { value: "unacknowledged", label: "Unacknowledged" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
] as const;

export function CapEvents(): JSX.Element {
  const client = useApiClient();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [scopeFilter, setScopeFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState<EventRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cap/threshold-events", {
      params: { query: { unacknowledgedOnly: "true" } },
    } as never);
    if (res.error) {
      setError("Threshold events are unavailable — you may lack cap visibility.");
      setLoading(false);
      return;
    }
    setEvents((res.data as unknown as EventRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeOptions = useMemo(
    () => [
      { value: "", label: "Any scope" },
      ...Array.from(new Set(events.map((e) => e.scope)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [events],
  );
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return events
      .filter((e) => {
        const state = eventState(e).toLowerCase();
        const matchesScope = !scopeFilter || e.scope === scopeFilter;
        const matchesState = !stateFilter || state === stateFilter;
        const matchesSearch =
          !q ||
          [e.id, e.scope, e.patientId ?? "", e.priorBand, e.currentBand, state, e.raisedAt].some(
            (value) => value.toLowerCase().includes(q),
          );
        return matchesScope && matchesState && matchesSearch;
      })
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }, [events, scopeFilter, searchQuery, stateFilter]);

  const unacknowledgedCount = events.filter((e) => !e.acknowledgedAt && !e.resolvedAt).length;
  const acknowledgedCount = events.filter((e) => e.acknowledgedAt && !e.resolvedAt).length;
  const resolvedCount = events.filter((e) => e.resolvedAt).length;
  const breachCount = events.filter((e) => e.currentBand.includes("breach")).length;
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedEvents = filteredEvents.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || scopeFilter !== "" || stateFilter !== "";

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Threshold Events" breadcrumb="Revenue Cycle — cap band transitions">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review cap band transitions that need acknowledgement and follow-up.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Open Events"
              value={loading || error ? "—" : events.length}
              detail="Unacknowledged read"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="Unacknowledged"
              value={loading || error ? "—" : unacknowledgedCount}
              detail="Needs review"
              tone={unacknowledgedCount > 0 ? "warning" : "neutral"}
              accentColor={
                unacknowledgedCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
              selected={stateFilter === "unacknowledged"}
              onSelect={() => {
                setStateFilter("unacknowledged");
                setPage(1);
              }}
            />
            <KpiCard
              label="Acknowledged"
              value={loading || error ? "—" : acknowledgedCount}
              detail="Review started"
              tone="success"
              accentColor="var(--color-success)"
            />
            <KpiCard
              label="Resolved"
              value={loading || error ? "—" : resolvedCount}
              detail="Closed events"
              tone="neutral"
              accentColor="var(--color-outline-variant)"
            />
            <KpiCard
              label="Breach"
              value={loading || error ? "—" : breachCount}
              detail="Current band"
              tone={breachCount > 0 ? "danger" : "neutral"}
              accentColor={breachCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            />
          </KpiStrip>
        }
        filters={
          <div style={filterPanelStyle}>
            {error ? (
              <div role="alert" style={errorBannerStyle}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
            ) : null}
            <div style={filterRowStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search scope, patient, band..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search threshold events"
                />
              </label>
              <label style={filterLabelStyle}>
                <span style={mutedStyle}>Scope</span>
                <select
                  aria-label="Filter by scope"
                  value={scopeFilter}
                  onChange={(e) => {
                    setScopeFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  {scopeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={filterLabelStyle}>
                <span style={mutedStyle}>State</span>
                <select
                  aria-label="Filter by state"
                  value={stateFilter}
                  onChange={(e) => {
                    setStateFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  {STATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {hasActiveFilters ? (
                <Button
                  size="sm"
                  tone="tertiary"
                  onClick={() => {
                    setSearchQuery("");
                    setScopeFilter("");
                    setStateFilter("");
                    setPage(1);
                  }}
                >
                  Clear
                </Button>
              ) : null}
              <span style={mutedStyle}>
                {filteredEvents.length} of {events.length} events
              </span>
            </div>
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
          ) : filteredEvents.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No open events"
                description={
                  hasActiveFilters
                    ? "No cap-band transition matches these filters."
                    : "No unacknowledged cap-band transitions. The cap is within band."
                }
                action={
                  hasActiveFilters ? (
                    <Button
                      tone="secondary"
                      size="sm"
                      onClick={() => {
                        setSearchQuery("");
                        setScopeFilter("");
                        setStateFilter("");
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={headStyle}>Scope</th>
                    <th style={headStyle}>Patient</th>
                    <th style={headStyle}>Transition</th>
                    <th style={headStyle}>Raised</th>
                    <th style={headStyle}>State</th>
                    <th style={headStyle}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedEvents.map((e) => (
                    <tr key={e.id} style={rowStyle}>
                      <td style={cellStyle}>{humanize(e.scope)}</td>
                      <td style={tdCodeStyle}>{e.patientId?.slice(0, 8) ?? "—"}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={toneOf(BAND_TONE, e.currentBand)}
                          label={`${humanize(e.priorBand)} → ${humanize(e.currentBand)}`}
                        />
                      </td>
                      <td style={tdDateStyle}>{shortDate(e.raisedAt)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          label={eventState(e)}
                          tone={
                            e.resolvedAt ? "success" : e.acknowledgedAt ? "progress" : "warning"
                          }
                        />
                      </td>
                      <td style={cellStyle}>
                        {e.acknowledgedAt || e.resolvedAt ? (
                          <span style={mutedStyle}>—</span>
                        ) : (
                          <Button size="sm" tone="secondary" onClick={() => setAcknowledging(e)}>
                            Acknowledge
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={filteredEvents.length}
                onPageChange={setPage}
                onPageSizeChange={(next) => {
                  setPageSize(next);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="events"
              />
            </div>
          )
        }
        fullPageScroll
      />
      <CapActionDialog
        open={acknowledging !== null}
        title="Acknowledge threshold event"
        hint="Records that you reviewed this band transition. Add a note if the reviewer trail should carry context."
        submitLabel="Acknowledge"
        onClose={() => setAcknowledging(null)}
        onSubmit={() =>
          sendCapMutation(
            client,
            "PATCH",
            "/api/v1/cap/threshold-events/{eventId}/acknowledge",
            { eventId: acknowledging?.id ?? "" },
            {},
          )
        }
        onDone={() => {
          setAcknowledging(null);
          void load();
        }}
      />
    </>
  );
}

function eventState(e: EventRow): "Resolved" | "Acknowledged" | "Unacknowledged" {
  if (e.resolvedAt) return "Resolved";
  if (e.acknowledgedAt) return "Acknowledged";
  return "Unacknowledged";
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const tdCodeStyle = {
  ...cellStyle,
  fontVariantNumeric: "tabular-nums" as const,
  fontFamily: "var(--font-mono)",
};
const tdDateStyle = { ...cellStyle, fontVariantNumeric: "tabular-nums" as const };
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
const filterPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
};
const filterLabelStyle = { display: "flex", flexDirection: "column" as const, gap: "0.25rem" };
const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
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
