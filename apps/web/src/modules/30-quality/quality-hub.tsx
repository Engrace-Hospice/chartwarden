import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/30-quality — M30 QUALITY HUB (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HQRP_QUALITY.md — Quality Hub (KPI strip + CoP strip).
//
// The agency's quality posture at a glance: the computed measures with their band, and the CoP compliance
// strip beside them. Reads GET /api/v1/quality/measures and /quality/cop/citations through the typed
// client (M30's read responses are enriched, so no `as unknown as` cast).
//
// The KPI strip deliberately counts SUPPRESSED measures as their own tile rather than folding them into
// "not meeting target". A measure below the CMS reportable-denominator floor has NO verdict; counting it
// as a miss would invent one, and counting it as a pass would hide one.
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  COP_STATUS_TONE,
  DOMAIN_LABEL,
  MEASURE_BAND_TONE,
  fraction,
  humanize,
  measureRate,
  readErrorMessage,
  toneOf,
} from "./quality-status";

type MeasureRow =
  paths["/api/v1/quality/measures"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type CitationRow =
  paths["/api/v1/quality/cop/citations"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

/** The §4.12 page bound M30's list queries enforce (`PageQuery.limit` max). Exceeding it is a 422. */
const MAX_PAGE = 100;

export function QualityHub(): JSX.Element {
  const client = useApiClient();
  const [measures, setMeasures] = useState<MeasureRow[]>([]);
  const [citations, setCitations] = useState<CitationRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [band, setBand] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [mRes, cRes] = await Promise.all([
        client.GET("/api/v1/quality/measures", { params: { query: { limit: MAX_PAGE } } }),
        client.GET("/api/v1/quality/cop/citations", { params: { query: { limit: MAX_PAGE } } }),
      ]);
      if (!active) return;
      if (mRes.error) setError(readErrorMessage(mRes.response?.status, "quality.measure.read"));
      else {
        setError(null);
        setMeasures(mRes.data?.items ?? []);
      }
      if (!cRes.error) setCitations(cRes.data?.items ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  // `insufficient_n` covers two facts the wire used to conflate: a population under the CMS reportable
  // floor, and an input this platform structurally cannot assemble (HCI 5/6/7, defined over the
  // beneficiary's Medicare claims across every provider). Only the first is a low-N problem, and only the
  // first can be fixed by having more patients — so they get their own tiles. `unavailableReason` is the
  // discriminator; it is non-null only for the second.
  const kpis = useMemo(() => {
    let meeting = 0;
    let missing = 0;
    let suppressed = 0;
    let notComputable = 0;
    let uncomputed = 0;
    for (const m of measures) {
      const v = m.latestValue;
      if (!v) uncomputed += 1;
      else if (v.unavailableReason) notComputable += 1;
      else if (v.bandColor === "insufficient_n") suppressed += 1;
      else if (v.thresholdMet) meeting += 1;
      else missing += 1;
    }
    return { meeting, missing, suppressed, notComputable, uncomputed };
  }, [measures]);

  const deficient = useMemo(
    () => citations.filter((c) => c.status === "deficient" || c.status === "at_risk").length,
    [citations],
  );

  const domainOptions = useMemo(
    () => [...new Set(measures.map((m) => m.domain).filter(Boolean))].sort(),
    [measures],
  );

  const filteredMeasures = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return measures.filter((m) => {
      // `not_computable` is a pseudo-band the filter understands but the wire does not send: it is the
      // `insufficient_n` rows carrying a reason. Resolved here so the tile, the dropdown and the free-text
      // search all agree on one vocabulary.
      const currentBand = m.latestValue
        ? m.latestValue.unavailableReason
          ? "not_computable"
          : m.latestValue.bandColor
        : "not_computed";
      const matchesDomain = !domain || m.domain === domain;
      const matchesBand = !band || currentBand === band;
      const matchesSearch =
        !q ||
        m.measureId.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.domain.toLowerCase().includes(q) ||
        currentBand.toLowerCase().includes(q);
      return matchesDomain && matchesBand && matchesSearch;
    });
  }, [measures, band, domain, searchQuery]);

  const pageCount = Math.max(1, Math.ceil(filteredMeasures.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedMeasures = filteredMeasures.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [searchQuery.trim() !== "", domain !== "", band !== ""].filter(
    Boolean,
  ).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setDomain("");
    setBand("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Quality" breadcrumb="Compliance / Quality">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            HQRP measures and Conditions of Participation posture.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Meeting target"
            value={loading ? "—" : String(kpis.meeting)}
            detail="Threshold met"
            tone={kpis.meeting > 0 ? "success" : "neutral"}
            accentColor={kpis.meeting > 0 ? "var(--color-success)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Below target"
            value={loading ? "—" : String(kpis.missing)}
            detail="Needs attention"
            tone={kpis.missing > 0 ? "danger" : "neutral"}
            accentColor={kpis.missing > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={band === "red"}
            onSelect={() => {
              setBand("red");
              setPage(1);
            }}
          />
          <KpiCard
            label="Suppressed (low N)"
            value={loading ? "—" : String(kpis.suppressed)}
            detail="Low denominator"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={band === "insufficient_n"}
            onSelect={() => {
              setBand("insufficient_n");
              setPage(1);
            }}
          />
          <KpiCard
            label="Not computable here"
            value={loading ? "—" : String(kpis.notComputable)}
            detail="Needs data outside this system"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            selected={band === "not_computable"}
            onSelect={() => {
              setBand("not_computable");
              setPage(1);
            }}
          />
          <KpiCard
            label="Not yet computed"
            value={loading ? "—" : String(kpis.uncomputed)}
            detail="Awaiting worker"
            tone={kpis.uncomputed > 0 ? "warning" : "neutral"}
            accentColor={
              kpis.uncomputed > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            selected={band === "not_computed"}
            onSelect={() => {
              setBand("not_computed");
              setPage(1);
            }}
          />
          <KpiCard
            label="CoP at risk / deficient"
            value={loading ? "—" : String(deficient)}
            detail="At risk or deficient"
            tone={deficient > 0 ? "danger" : "neutral"}
            accentColor={deficient > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} style={dismissButtonStyle}>
                x
              </button>
            </div>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Measures</span>
              <strong>{filteredMeasures.length} matching measures</strong>
            </div>
            <div style={controlGroupStyle}>
              <div style={searchWrapStyle}>
                <input
                  type="search"
                  placeholder="Search measure, domain, band..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search quality measures"
                  style={searchInputStyle}
                />
              </div>
              <select
                aria-label="Measure domain"
                value={domain}
                onChange={(e) => {
                  setDomain(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Domain: All</option>
                {domainOptions.map((option) => (
                  <option key={option} value={option}>
                    {DOMAIN_LABEL[option] ?? humanize(option)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Measure band"
                value={band}
                onChange={(e) => {
                  setBand(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Band: All</option>
                <option value="green">Green</option>
                <option value="yellow">Yellow</option>
                <option value="red">Red</option>
                <option value="insufficient_n">Suppressed</option>
                <option value="not_computable">Not computable here</option>
                <option value="not_computed">Not computed</option>
              </select>
              {activeFilters > 0 ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
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
        ) : measures.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No measures computed"
              description="Nothing has been computed for this fiscal year yet. Measures land as the recompute worker runs."
            />
          </div>
        ) : (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={{ ...thStyle, width: "32%" }}>Measure</th>
                  <th style={{ ...thStyle, width: "14%" }}>Domain</th>
                  <th style={{ ...thStyle, width: "10%" }}>FY</th>
                  <th style={{ ...thStyle, width: "12%" }}>Rate</th>
                  <th style={{ ...thStyle, width: "14%" }}>Population</th>
                  <th style={{ ...thStyle, width: "18%", textAlign: "right" }}>Band</th>
                </tr>
              </thead>
              <tbody>
                {pagedMeasures.map((m) => (
                  <tr key={m.measureId} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>{m.displayName}</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {m.measureId}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>{DOMAIN_LABEL[m.domain] ?? humanize(m.domain)}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {m.fiscalYear}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {m.latestValue ? measureRate(m.measureId, m.latestValue) : "—"}
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {m.latestValue
                        ? fraction(m.latestValue.numerator, m.latestValue.denominator)
                        : "—"}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {m.latestValue ? (
                        // The reason rides on a wrapping `title` rather than its own column: it is a full
                        // sentence per measure and only three of ~36 carry one, so a column would be empty
                        // for the rest. A row that HAS one is still discoverable without hovering — the
                        // "Not computable here" tile filters straight to them.
                        <span title={m.latestValue.unavailableReason ?? undefined}>
                          <StatusPill
                            tone={toneOf(MEASURE_BAND_TONE, m.latestValue.bandColor)}
                            label={
                              m.latestValue.unavailableReason
                                ? "Not computable here"
                                : m.latestValue.bandColor === "insufficient_n"
                                  ? "Suppressed"
                                  : humanize(m.latestValue.bandColor)
                            }
                          />
                        </span>
                      ) : (
                        <StatusPill tone="neutral" label="Not computed" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredMeasures.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={QUALITY_PAGE_SIZES}
              noun="measures"
            />
            <section style={{ paddingTop: "1rem" }}>
              <h2 style={sectionTitleStyle}>Conditions of Participation</h2>
              {citations.length === 0 ? (
                <div style={{ padding: "1rem 0" }}>
                  <EmptyState
                    title="No citations"
                    description="No CoP citations are on file for this agency."
                  />
                </div>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={{ ...thStyle, width: "18%" }}>Ref</th>
                      <th style={{ ...thStyle, width: "34%" }}>Condition</th>
                      <th style={{ ...thStyle, width: "16%" }}>Status</th>
                      <th style={{ ...thStyle, width: "16%" }}>Last reviewed</th>
                      <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Next due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {citations.map((c) => (
                      <tr key={c.citationId} style={rowStyle}>
                        <td style={tdStyle}>{c.citationRef}</td>
                        <td style={tdStyle}>{c.displayName}</td>
                        <td style={tdStyle}>
                          <StatusPill
                            tone={toneOf(COP_STATUS_TONE, c.status)}
                            label={humanize(c.status)}
                          />
                        </td>
                        <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                          {formatDate(c.lastReviewedAt)}
                        </td>
                        <td
                          style={{
                            ...tdStyle,
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDate(c.nextReviewDueAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const QUALITY_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};

const searchWrapStyle = {
  minWidth: "15rem",
};

const searchInputStyle = {
  width: "100%",
  height: "2.25rem",
  fontSize: "0.85rem",
};

const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const dismissButtonStyle = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};

const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem 1.5rem",
};

const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};

const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};

const primaryTextStyle = {
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const codeStyle = {
  display: "inline-block",
  maxWidth: "18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};

const sectionTitleStyle = {
  margin: "0 0 0.75rem",
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};
