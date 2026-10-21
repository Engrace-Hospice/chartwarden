// apps/web/src/modules/16-bereavement — the SUPERVISOR CASELOAD DASHBOARD (§5.1 #2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Dashboard."
//
// Route 31's full-tenant rollups. The server reports COUNTS, never rates, and this screen keeps them that
// way: the CoP 418.64(d) figure is rendered as the raw PAIR ("47 of 52 touchpoints completed on time")
// with the derived percentage shown ALONGSIDE it and suppressed entirely when the denominator is zero.
// A pre-divided compliance number would strand M30's CMS small-N suppression and turn an empty scope into
// a fabricated 0% that nobody downstream could suppress — the same contract the §4.6 seams publish, so a
// supervisor and an HQRP report can never be shown two different bereavement-compliance rates.
import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SupervisorDashboard as SupervisorDashboardView,
  errorMessage,
  getSupervisorDashboard,
} from "./bereavement-api";
import { humanize } from "./bereavement-status";
import {
  CountGrid,
  Field,
  Notice,
  SummaryGrid,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
} from "./bereavement-ui";

type MetricCategory = "all" | "plans" | "touchpoints" | "risk" | "closures";

interface MetricRow {
  id: string;
  category: Exclude<MetricCategory, "all">;
  categoryLabel: string;
  segment: string;
  count: number;
  detail: string;
}

const SUPERVISOR_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

const thStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};

const drawerActionStyle: CSSProperties = {
  ...ghostButtonStyle,
  display: "flex",
  justifyContent: "center",
};

export function BereavementSupervisorDashboard(): JSX.Element {
  const client = useApiClient();
  const [view, setView] = useState<SupervisorDashboardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<MetricCategory>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedMetricId, setSelectedMetricId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { view: v, error: err } = await getSupervisorDashboard(client);
    if (err) {
      setError(errorMessage(err, "The bereavement program rollups could not be loaded."));
      setLoading(false);
      return;
    }
    setView(v);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!view)
    return <EmptyState title="No data" description="No bereavement rollups were returned." />;

  const { numerator, denominator } = view.copCounts;
  const entries = (m: Record<string, number>) =>
    Object.entries(m).map(([k, v]) => ({ label: humanize(k), value: v }));
  const metricRows = metricRowsFor(view);
  const hasActiveFilters = searchQuery !== "" || categoryFilter !== "all";
  const filteredRows = metricRows.filter((row) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      row.categoryLabel.toLowerCase().includes(q) ||
      row.segment.toLowerCase().includes(q) ||
      row.detail.toLowerCase().includes(q);
    const matchesCategory = categoryFilter === "all" || row.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const selectedMetric = metricRows.find((row) => row.id === selectedMetricId) ?? null;
  const onTimeRate = denominator === 0 ? null : (numerator / denominator) * 100;

  const clearFilters = (): void => {
    setSearchQuery("");
    setCategoryFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Bereavement program"
          breadcrumb="Bereavement / Supervisor"
          actions={
            <Link to="/bereavement/eligible" style={ghostButtonStyle}>
              Intake queue
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor org-wide coverage, assignment gaps, risk distribution, and closure outcomes.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="On-Time"
            value={onTimeRate === null ? "—" : `${onTimeRate.toFixed(1)}%`}
            detail={`${numerator} of ${denominator} touchpoints`}
            tone={onTimeRate === null ? "neutral" : onTimeRate >= 90 ? "success" : "warning"}
            accentColor={
              onTimeRate === null
                ? "var(--color-outline-variant)"
                : onTimeRate >= 90
                  ? "var(--color-success)"
                  : "var(--color-warning)"
            }
          />
          <KpiCard
            label="Unassigned"
            value={view.unassignedPlanCount}
            detail="Plans without counselor"
            tone={view.unassignedPlanCount > 0 ? "warning" : "neutral"}
            accentColor={
              view.unassignedPlanCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            onSelect={() => {
              setCategoryFilter("plans");
              setSearchQuery("unassigned");
              setPage(1);
            }}
          />
          <KpiCard
            label="Pending Cosign"
            value={view.externalSourceCosignPendingCount}
            detail="External-source plans"
            tone={view.externalSourceCosignPendingCount > 0 ? "warning" : "neutral"}
            accentColor={
              view.externalSourceCosignPendingCount > 0
                ? "var(--color-warning)"
                : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Plan Segments"
            value={Object.keys(view.planCountsByStatus).length}
            detail="Statuses represented"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Risk Segments"
            value={Object.keys(view.tierDistribution).length}
            detail="Tiers represented"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
        </KpiStrip>
      }
      filters={
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0 1.5rem 0.75rem",
          }}
        >
          {view.unassignedPlanCount > 0 ? (
            <Notice tone="warning">
              {view.unassignedPlanCount === 1
                ? "One bereavement plan has no assigned counselor."
                : `${view.unassignedPlanCount} bereavement plans have no assigned counselor.`}{" "}
              <Link to="/bereavement/eligible" style={linkStyle}>
                Open the intake queue
              </Link>
            </Notice>
          ) : null}

          {view.externalSourceCosignPendingCount > 0 ? (
            <Notice tone="warning">
              {view.externalSourceCosignPendingCount === 1
                ? "One external-source plan is"
                : `${view.externalSourceCosignPendingCount} external-source plans are`}{" "}
              awaiting the platform-mandated medical-director cosign. First contact is locked on
              those plans.
            </Notice>
          ) : null}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search metrics..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search bereavement program metrics"
                />
              </label>

              <label className="wx-filter-field">
                <span>Category</span>
                <select
                  className="wx-select"
                  value={categoryFilter}
                  onChange={(event) => {
                    setCategoryFilter(event.target.value as MetricCategory);
                    setPage(1);
                  }}
                  aria-label="Filter by metric category"
                >
                  <option value="all">All</option>
                  <option value="plans">Plans</option>
                  <option value="touchpoints">Touchpoints</option>
                  <option value="risk">Risk</option>
                  <option value="closures">Closures</option>
                </select>
              </label>

              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>

            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
              {filteredRows.length} of {metricRows.length} metrics
            </span>
          </div>
        </div>
      }
      table={
        filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching metrics"
              description="Try adjusting your search criteria or clearing active filters."
              action={
                <Button tone="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <MetricTable
              rows={pagedRows}
              selectedMetricId={selectedMetricId}
              onSelectMetric={setSelectedMetricId}
            />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={SUPERVISOR_PAGE_SIZES}
              noun="metrics"
            />
          </div>
        )
      }
      detail={
        selectedMetric ? (
          <RightDetailPanel
            open={selectedMetric !== null}
            title="Metric Detail"
            onClose={() => setSelectedMetricId(null)}
            hideScrollbar
          >
            <MetricDrawerContent
              row={selectedMetric}
              copCounts={view.copCounts}
              planEntries={entries(view.planCountsByStatus)}
              outreachEntries={entries(view.outreachCountsByStatus)}
              riskEntries={entries(view.tierDistribution)}
              closureEntries={entries(view.closureCountsByReason)}
            />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function metricRowsFor(view: SupervisorDashboardView): MetricRow[] {
  const fromMap = (
    category: MetricRow["category"],
    categoryLabel: string,
    map: Record<string, number>,
    detail: string,
  ): MetricRow[] =>
    Object.entries(map).map(([key, count]) => ({
      id: `${category}:${key}`,
      category,
      categoryLabel,
      segment: humanize(key),
      count,
      detail,
    }));

  return [
    {
      id: "plans:unassigned",
      category: "plans",
      categoryLabel: "Plans",
      segment: "Unassigned counselor",
      count: view.unassignedPlanCount,
      detail: "Plans without an assigned bereavement counselor.",
    },
    {
      id: "plans:external-cosign",
      category: "plans",
      categoryLabel: "Plans",
      segment: "Pending external-source cosign",
      count: view.externalSourceCosignPendingCount,
      detail: "External-source plans whose first contact remains locked.",
    },
    ...fromMap("plans", "Plans", view.planCountsByStatus, "Plan status distribution."),
    ...fromMap(
      "touchpoints",
      "Touchpoints",
      view.outreachCountsByStatus,
      "Scheduled and historical outreach status distribution.",
    ),
    ...fromMap("risk", "Risk", view.tierDistribution, "Risk-tier distribution across the program."),
    ...fromMap(
      "closures",
      "Closures",
      view.closureCountsByReason,
      "Closure reasons across completed or early-ended plans.",
    ),
  ];
}

function MetricTable({
  rows,
  selectedMetricId,
  onSelectMetric,
}: {
  rows: MetricRow[];
  selectedMetricId: string | null;
  onSelectMetric: (id: string) => void;
}): JSX.Element {
  return (
    <table
      style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
    >
      <thead>
        <tr
          style={{
            textAlign: "left",
            color: "var(--color-on-surface-variant)",
            borderBottom:
              "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
            background: "var(--color-surface-low)",
          }}
        >
          <th style={{ ...thStyle, width: "20%" }}>Category</th>
          <th style={{ ...thStyle, width: "34%" }}>Segment</th>
          <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Count</th>
          <th style={{ ...thStyle, width: "30%" }}>Detail</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isSelected = selectedMetricId === row.id;
          return (
            <tr
              key={row.id}
              {...interactiveRowProps(() => onSelectMetric(row.id), isSelected)}
              className="wx-data-row-interactive"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                background: isSelected ? "var(--color-primary-tint)" : "transparent",
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
            >
              <td style={tdStyle}>
                <StatusPill label={row.categoryLabel} tone={toneForCategory(row.category)} />
              </td>
              <td style={tdStyle}>{row.segment}</td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {row.count}
              </td>
              <td style={{ ...tdStyle, color: "var(--color-on-surface-variant)" }}>{row.detail}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MetricDrawerContent({
  row,
  copCounts,
  planEntries,
  outreachEntries,
  riskEntries,
  closureEntries,
}: {
  row: MetricRow;
  copCounts: SupervisorDashboardView["copCounts"];
  planEntries: { label: string; value: number }[];
  outreachEntries: { label: string; value: number }[];
  riskEntries: { label: string; value: number }[];
  closureEntries: { label: string; value: number }[];
}): JSX.Element {
  const rate =
    copCounts.denominator === 0 ? null : (copCounts.numerator / copCounts.denominator) * 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <StatusPill label={row.categoryLabel} tone={toneForCategory(row.category)} />
        <StatusPill label={`${row.count}`} tone={row.count > 0 ? "progress" : "neutral"} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>{row.segment}</span>
        <span style={mutedStyle}>{row.detail}</span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          padding: "0.75rem",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface-low)",
        }}
      >
        <Field label="Completed on time" value={copCounts.numerator} />
        <Field label="Touchpoints owed" value={copCounts.denominator} />
        <Field
          label="On-time rate"
          value={
            rate === null ? (
              <StatusPill label="No touchpoints owed" tone="neutral" />
            ) : (
              `${rate.toFixed(1)}%`
            )
          }
        />
      </div>

      <span style={mutedStyle}>
        The CoP rate is displayed from the raw count pair so downstream HQRP surfaces can apply
        small-N suppression consistently.
      </span>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <SummaryGrid>
          <Field label="Plan groups" value={planEntries.length} />
          <Field label="Touchpoint groups" value={outreachEntries.length} />
          <Field label="Risk groups" value={riskEntries.length} />
          <Field label="Closure groups" value={closureEntries.length} />
        </SummaryGrid>
        <CountGrid
          entries={
            row.category === "plans"
              ? planEntries
              : row.category === "touchpoints"
                ? outreachEntries
                : row.category === "risk"
                  ? riskEntries
                  : closureEntries
          }
        />
      </div>

      <Link to="/bereavement/eligible" style={drawerActionStyle}>
        Open intake queue
      </Link>
    </div>
  );
}

function toneForCategory(
  category: MetricRow["category"],
): "neutral" | "success" | "warning" | "error" | "progress" | "critical" {
  if (category === "plans") return "progress";
  if (category === "touchpoints") return "progress";
  if (category === "risk") return "warning";
  if (category === "closures") return "success";
  return "neutral";
}
