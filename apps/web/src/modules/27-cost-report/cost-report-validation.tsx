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
// apps/web/src/modules/27-cost-report — the VALIDATION worklist (R2, §5 / §11.B). Pick a report → its
// validation runs with the per-run pass/fail/warn/skip roll-up (the cost-report version of the M23 claim
// worklist). Read-only; the server is the only authz point (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  ReportPicker,
  cellStyle,
  headStyle,
  numStyle,
  rowStyle,
  tableStyle,
  useReportPicker,
} from "./cost-report-shared";
import { RUN_TONE, humanize, shortDate, toneOf } from "./cost-report-status";

interface RunRow {
  validationId: string;
  status: string;
  ruleSetVersion: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  skippedCount: number;
  overriddenCount: number;
  runStartedAt: string;
  runCompletedAt: string | null;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CostReportValidation(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    setLoading(true);
    setRunError(null);
    const res = await client.GET("/api/v1/cost-reports/{id}/validations", {
      params: { path: { id: selectedId } },
    });
    if (res.error) {
      setRuns([]);
      setRunError("Validation runs could not be loaded.");
      setLoading(false);
      return;
    }
    const d = res.error ? null : (res.data as unknown as { items?: RunRow[] });
    setRuns(d?.items ?? (res.data as unknown as RunRow[]) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = runs[0];
  const selectedReport = useMemo(
    () => reports.find((report) => report.costReportId === selectedId) ?? null,
    [reports, selectedId],
  );
  const statusOptions = useMemo(
    () => [
      { value: "", label: "Any status" },
      ...Array.from(new Set(runs.map((r) => r.status)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [runs],
  );
  const filteredRuns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return runs
      .filter((r) => {
        const matchesStatus = !statusFilter || r.status === statusFilter;
        const matchesSearch =
          !q ||
          [
            r.validationId,
            r.status,
            String(r.ruleSetVersion),
            r.runStartedAt,
            r.runCompletedAt ?? "",
          ].some((value) => value.toLowerCase().includes(q));
        return matchesStatus && matchesSearch;
      })
      .sort((a, b) => b.runStartedAt.localeCompare(a.runStartedAt));
  }, [runs, searchQuery, statusFilter]);

  const failedRuns = runs.filter((r) => r.failedCount > 0).length;
  const warningRuns = runs.filter((r) => r.warningCount > 0).length;
  const overriddenRuns = runs.filter((r) => r.overriddenCount > 0).length;
  const pageCount = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRuns = filteredRuns.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || statusFilter !== "";

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Validation Worklist"
          breadcrumb="Revenue Cycle — pre-submission rule library (§11.B)"
          actions={
            latest ? (
              <StatusPill tone={toneOf(RUN_TONE, latest.status)} label={humanize(latest.status)} />
            ) : null
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review validation runs, rule-set versions, failures, warnings, skipped checks, and
            override volume before filing.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Runs"
            value={picking || runError ? "—" : runs.length}
            detail={
              selectedReport
                ? `FYE ${shortDate(selectedReport.fiscalYearEndDate)}`
                : "No report selected"
            }
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Latest Passed"
            value={latest && !runError ? latest.passedCount : "—"}
            detail="Most recent run"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Runs Failed"
            value={picking || runError ? "—" : failedRuns}
            detail="Failed count > 0"
            tone={failedRuns > 0 ? "danger" : "neutral"}
            accentColor={failedRuns > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={statusFilter === "complete_fail"}
            onSelect={() => {
              setStatusFilter("complete_fail");
              setPage(1);
            }}
          />
          <KpiCard
            label="Warnings"
            value={picking || runError ? "—" : warningRuns}
            detail="Warning count > 0"
            tone={warningRuns > 0 ? "warning" : "neutral"}
            accentColor={warningRuns > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Overrides"
            value={picking || runError ? "—" : overriddenRuns}
            detail="Override count > 0"
            tone={overriddenRuns > 0 ? "warning" : "neutral"}
            accentColor={
              overriddenRuns > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {pickErr || runError ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{pickErr ? "Cost reports could not be loaded." : runError}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <ReportPicker
              reports={reports}
              selectedId={selectedId}
              onChange={(id) => {
                setSelectedId(id);
                setPage(1);
              }}
            />
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search run, status, rule set..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search validation runs"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Status</span>
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {statusOptions.map((o) => (
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
                  setStatusFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {picking ? "Loading reports..." : `${filteredRuns.length} of ${runs.length} runs`}
            </span>
          </div>
        </div>
      }
      table={
        picking ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : pickErr ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description="Cost reports could not be loaded." />
          </div>
        ) : !selectedId ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No cost reports"
              description="Create a cost report to run validation."
            />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : runError ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={runError} />
          </div>
        ) : filteredRuns.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No validation runs"
              description={
                hasActiveFilters
                  ? "No validation run matches these filters."
                  : "Run validation on this cost report to populate the worklist."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setStatusFilter("");
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
          <>
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={headStyle}>Started</th>
                    <th style={headStyle}>Status</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Rule set</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Passed</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Failed</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Warned</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Skipped</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Overridden</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRuns.map((r) => (
                    <tr key={r.validationId} style={rowStyle}>
                      <td style={cellStyle}>{shortDate(r.runStartedAt)}</td>
                      <td style={cellStyle}>
                        <StatusPill tone={toneOf(RUN_TONE, r.status)} label={humanize(r.status)} />
                      </td>
                      <td style={numStyle}>v{r.ruleSetVersion}</td>
                      <td style={numStyle}>{r.passedCount}</td>
                      <td style={numStyle}>{r.failedCount}</td>
                      <td style={numStyle}>{r.warningCount}</td>
                      <td style={numStyle}>{r.skippedCount}</td>
                      <td style={numStyle}>{r.overriddenCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRuns.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="runs"
            />
          </>
        )
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

const searchInputStyle: CSSProperties = {
  width: "100%",
  minHeight: "2.35rem",
  padding: "0.45rem 0.75rem 0.45rem 2rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-surface-container)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const searchIconStyle: CSSProperties = {
  position: "absolute",
  left: "0.65rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none",
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

const errorBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--color-error)",
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};
