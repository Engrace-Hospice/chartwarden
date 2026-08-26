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
// apps/web/src/modules/26-cap — M26, the CAP WATCH DASHBOARD (R2, §5.1.1). The primary surface for billing
// managers + compliance officers: the current cap period, the agency-aggregate + inpatient utilization bands,
// the top patients by utilization, and the recent threshold-event feed. Reads are org-scoped server-side
// (RLS); the server is the only authz point (ADR-0030) — this gates nav visibility only. Lantern:
// WorkQueueLayout + KpiStrip + No-Line tables + §6.6 StatusPill via cap-status.ts; CSS-var tokens only. The
// "what-if" projection is advisory (D14: cap projection NEVER blocks clinical service).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  BAND_TONE,
  PERIOD_STATUS_TONE,
  humanize,
  money,
  pct,
  shortDate,
  toneOf,
} from "./cap-status";

interface Projection {
  alertBand: string;
  paidYtdCents: number;
  projectedYearEndCents: number;
  capAmountCents: number | null;
  pctOfCap: number;
  inpatientDaysYtd: number | null;
  patientId: string | null;
}
interface EventRow {
  id: string;
  scope: string;
  priorBand: string;
  currentBand: string;
  raisedAt: string;
  acknowledgedAt: string | null;
}
interface Dashboard {
  period: { capYear: string; status: string; methodology: string | null; endDate: string } | null;
  agency: Projection | null;
  inpatient: Projection | null;
  topPatients: Projection[];
  recentEvents: EventRow[];
  openVarianceCount: number;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CapDashboard(): JSX.Element {
  const client = useApiClient();
  const [data, setData] = useState<Dashboard | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [bandFilter, setBandFilter] = useState("");
  const [patientPage, setPatientPage] = useState(1);
  const [patientPageSize, setPatientPageSize] = useState(10);
  const [eventPage, setEventPage] = useState(1);
  const [eventPageSize, setEventPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/cap/dashboard");
    if (res.error) {
      setError(
        "Cap watch is unavailable — you may lack cap visibility, or no cap period is open yet.",
      );
      setLoading(false);
      return;
    }
    setData(res.data as unknown as Dashboard);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const period = data?.period ?? null;
  const agency = data?.agency ?? null;
  const inpatient = data?.inpatient ?? null;
  const topPatients = data?.topPatients ?? [];
  const recentEvents = data?.recentEvents ?? [];
  const bandOptions = useMemo(
    () => [
      { value: "", label: "Any band" },
      ...Array.from(new Set(topPatients.map((p) => p.alertBand)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [topPatients],
  );
  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return topPatients.filter((p) => {
      const matchesBand = !bandFilter || p.alertBand === bandFilter;
      const matchesSearch =
        !q ||
        [
          p.patientId ?? "",
          p.alertBand,
          String(p.paidYtdCents),
          String(p.projectedYearEndCents),
          String(p.capAmountCents ?? ""),
          String(p.pctOfCap),
        ].some((value) => value.toLowerCase().includes(q));
      return matchesBand && matchesSearch;
    });
  }, [bandFilter, searchQuery, topPatients]);
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return recentEvents
      .filter(
        (e) =>
          !q ||
          [
            e.id,
            e.scope,
            e.priorBand,
            e.currentBand,
            e.acknowledgedAt ? "acknowledged" : "unacknowledged",
          ].some((value) => value.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }, [recentEvents, searchQuery]);
  const patientPageCount = Math.max(1, Math.ceil(filteredPatients.length / patientPageSize));
  const activePatientPage = Math.min(patientPage, patientPageCount);
  const pagedPatients = filteredPatients.slice(
    (activePatientPage - 1) * patientPageSize,
    activePatientPage * patientPageSize,
  );
  const eventPageCount = Math.max(1, Math.ceil(filteredEvents.length / eventPageSize));
  const activeEventPage = Math.min(eventPage, eventPageCount);
  const pagedEvents = filteredEvents.slice(
    (activeEventPage - 1) * eventPageSize,
    activeEventPage * eventPageSize,
  );
  const breachPatientCount = topPatients.filter((p) => p.alertBand.includes("breach")).length;
  const unacknowledgedEventCount = recentEvents.filter((e) => !e.acknowledgedAt).length;
  const hasActiveFilters = searchQuery !== "" || bandFilter !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Cap Watch"
          breadcrumb={
            period
              ? `Revenue Cycle — ${period.capYear} · ${humanize(period.methodology) ?? "methodology unset"}`
              : "Revenue Cycle — Cap management"
          }
          actions={
            period ? (
              <StatusPill
                tone={toneOf(PERIOD_STATUS_TONE, period.status)}
                label={humanize(period.status)}
              />
            ) : null
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor aggregate cap, inpatient utilization, patient-level risk, and threshold events.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Agency Utilization"
            value={loading || error || !agency ? "—" : pct(agency.pctOfCap)}
            detail={agency ? humanize(agency.alertBand) : "No projection"}
            tone={agency ? toneToKpi(toneOf(BAND_TONE, agency.alertBand)) : "neutral"}
            accentColor={bandAccent(agency?.alertBand)}
          />
          <KpiCard
            label="Inpatient Cap"
            value={loading || error || !inpatient ? "—" : pct(inpatient.pctOfCap)}
            detail={inpatient ? humanize(inpatient.alertBand) : "No projection"}
            tone={inpatient ? toneToKpi(toneOf(BAND_TONE, inpatient.alertBand)) : "neutral"}
            accentColor={bandAccent(inpatient?.alertBand)}
          />
          <KpiCard
            label="Open PS&R Variances"
            value={loading || error || !data ? "—" : String(data.openVarianceCount)}
            detail="Need reconciliation"
            tone={data && data.openVarianceCount > 0 ? "warning" : "neutral"}
            accentColor={
              data && data.openVarianceCount > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Breach Patients"
            value={loading || error ? "—" : breachPatientCount}
            detail="Patient watchlist"
            tone={breachPatientCount > 0 ? "danger" : "neutral"}
            accentColor={
              breachPatientCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Unack Events"
            value={loading || error ? "—" : unacknowledgedEventCount}
            detail="Recent transitions"
            tone={unacknowledgedEventCount > 0 ? "warning" : "neutral"}
            accentColor={
              unacknowledgedEventCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
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
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search patient, band, scope..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPatientPage(1);
                  setEventPage(1);
                }}
                aria-label="Search cap dashboard"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Patient band</span>
              <select
                aria-label="Filter patients by band"
                value={bandFilter}
                onChange={(e) => {
                  setBandFilter(e.target.value);
                  setPatientPage(1);
                }}
                style={selectStyle}
              >
                {bandOptions.map((o) => (
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
                  setBandFilter("");
                  setPatientPage(1);
                  setEventPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredPatients.length} of {topPatients.length} patients · {filteredEvents.length}{" "}
              of {recentEvents.length} events
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
        ) : !period ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No open cap period"
              description="Open a cap period to begin tracking the aggregate and inpatient caps."
            />
          </div>
        ) : (
          <section style={{ display: "grid", gap: "1.5rem", padding: "0 1.5rem 1.5rem" }}>
            <div>
              <h3 style={sectionTitle}>Patients on the watch</h3>
              {filteredPatients.length === 0 ? (
                <EmptyState
                  title="No patients near cap"
                  description={
                    hasActiveFilters
                      ? "No patient projection matches these filters."
                      : "No patient is projected near the per-beneficiary cap."
                  }
                  action={
                    hasActiveFilters ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setBandFilter("");
                          setPatientPage(1);
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={headStyle}>Patient</th>
                        <th style={headStyle}>Band</th>
                        <th style={headNumStyle}>Paid YTD</th>
                        <th style={headNumStyle}>Projected YE</th>
                        <th style={headNumStyle}>Allocated cap</th>
                        <th style={headNumStyle}>Utilization</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedPatients.map((p, idx) => (
                        <tr
                          key={p.patientId ?? `patient-${idx}`}
                          style={rowStyle}
                        >
                          <td style={tdCodeStyle}>{p.patientId?.slice(0, 8) ?? "—"}</td>
                          <td style={cellStyle}>
                            <StatusPill
                              tone={toneOf(BAND_TONE, p.alertBand)}
                              label={humanize(p.alertBand)}
                            />
                          </td>
                          <td style={numStyle}>{money(p.paidYtdCents)}</td>
                          <td style={numStyle}>{money(p.projectedYearEndCents)}</td>
                          <td style={numStyle}>{money(p.capAmountCents)}</td>
                          <td style={numStyle}>{pct(p.pctOfCap)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activePatientPage}
                    pageSize={patientPageSize}
                    totalItems={filteredPatients.length}
                    onPageChange={setPatientPage}
                    onPageSizeChange={(next) => {
                      setPatientPageSize(next);
                      setPatientPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="patients"
                  />
                </div>
              )}
            </div>

            <div>
              <h3 style={sectionTitle}>Recent threshold events</h3>
              {filteredEvents.length === 0 ? (
                <EmptyState
                  title="No recent events"
                  description={
                    searchQuery
                      ? "No threshold event matches this search."
                      : "No band transitions in the last 14 days."
                  }
                  action={
                    searchQuery ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setEventPage(1);
                        }}
                      >
                        Clear search
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div style={{ width: "100%", overflowX: "auto" }}>
                  <table style={tableStyle}>
                    <thead>
                      <tr style={headerRowStyle}>
                        <th style={headStyle}>Scope</th>
                        <th style={headStyle}>Transition</th>
                        <th style={headStyle}>Raised</th>
                        <th style={headStyle}>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedEvents.map((e) => (
                        <tr key={e.id} style={rowStyle}>
                          <td style={cellStyle}>{humanize(e.scope)}</td>
                          <td style={cellStyle}>
                            <StatusPill
                              tone={toneOf(BAND_TONE, e.currentBand)}
                              label={`${humanize(e.priorBand)} → ${humanize(e.currentBand)}`}
                            />
                          </td>
                          <td style={tdDateStyle}>{shortDate(e.raisedAt)}</td>
                          <td style={cellStyle}>
                            <StatusPill
                              label={e.acknowledgedAt ? "Acknowledged" : "Unacknowledged"}
                              tone={e.acknowledgedAt ? "success" : "warning"}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <OffsetPagination
                    page={activeEventPage}
                    pageSize={eventPageSize}
                    totalItems={filteredEvents.length}
                    onPageChange={setEventPage}
                    onPageSizeChange={(next) => {
                      setEventPageSize(next);
                      setEventPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="events"
                  />
                </div>
              )}
            </div>
          </section>
        )
      }
      fullPageScroll
    />
  );
}

function toneToKpi(tone: "neutral" | "progress" | "success" | "warning" | "error" | "critical") {
  if (tone === "error" || tone === "critical") return "danger";
  if (tone === "progress") return "info";
  return tone;
}

function bandAccent(band: string | null | undefined): string {
  if (!band) return "var(--color-outline-variant)";
  const tone = toneOf(BAND_TONE, band);
  if (tone === "error") return "var(--color-error)";
  if (tone === "warning") return "var(--color-warning)";
  if (tone === "success") return "var(--color-success)";
  return "var(--color-outline-variant)";
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
const numStyle = {
  ...cellStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums" as const,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const headNumStyle = { ...headStyle, textAlign: "right" as const };
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const sectionTitle = {
  fontSize: "0.85rem",
  margin: "0 0 0.5rem",
  color: "var(--color-on-surface)",
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
const searchInputStyle = {
  width: "100%",
  paddingLeft: "2rem",
  height: "2.25rem",
  fontSize: "0.85rem",
};
const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};
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
