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
// apps/web/src/modules/27-cost-report — the BAD-DEBT log (R2, §5 / D7). Pick a report → its Medicare
// bad-debt entries (deductible / coinsurance) with the CMS-allowability signal (collection efforts
// documented + supporting docs). Read-only; the server is the only authz point (ADR-0030).
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
import { humanize, money, shortDate } from "./cost-report-status";

interface BadDebtRow {
  recordId: string;
  periodLabel: string;
  debtKind: string;
  amountCents: number;
  collectionEffortsDocumented: boolean;
  supportingDocumentIds: string[];
  addedAt: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function CostReportBadDebt(): JSX.Element {
  const client = useApiClient();
  const {
    reports,
    selectedId,
    setSelectedId,
    loading: picking,
    error: pickErr,
  } = useReportPicker();
  const [rows, setRows] = useState<BadDebtRow[]>([]);
  const [kindFilter, setKindFilter] = useState("");
  const [effortsFilter, setEffortsFilter] = useState("");
  const [docsFilter, setDocsFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [debtError, setDebtError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setDebtError(null);
    const res = await client.GET("/api/v1/cost-reports/{id}/bad-debt", {
      params: { path: { id: selectedId } },
    });
    if (res.error) {
      setRows([]);
      setDebtError("Bad-debt entries could not be loaded.");
      setLoading(false);
      return;
    }
    const d = res.data as unknown as { items?: BadDebtRow[] };
    setRows(d.items ?? (res.data as unknown as BadDebtRow[]) ?? []);
    setLoading(false);
  }, [client, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCents = useMemo(() => rows.reduce((s, r) => s + r.amountCents, 0), [rows]);
  const documented = rows.filter((r) => r.collectionEffortsDocumented).length;
  const selectedReport = useMemo(
    () => reports.find((report) => report.costReportId === selectedId) ?? null,
    [reports, selectedId],
  );
  const kindOptions = useMemo(
    () => [
      { value: "", label: "Any kind" },
      ...Array.from(new Set(rows.map((r) => r.debtKind)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter((r) => {
        const matchesKind = !kindFilter || r.debtKind === kindFilter;
        const matchesEfforts =
          !effortsFilter ||
          (effortsFilter === "documented"
            ? r.collectionEffortsDocumented
            : !r.collectionEffortsDocumented);
        const matchesDocs =
          !docsFilter ||
          (docsFilter === "with_docs"
            ? r.supportingDocumentIds.length > 0
            : r.supportingDocumentIds.length === 0);
        const matchesSearch =
          !q ||
          [
            r.recordId,
            r.periodLabel,
            r.debtKind,
            String(r.amountCents),
            r.addedAt,
            ...r.supportingDocumentIds,
          ].some((value) => value.toLowerCase().includes(q));
        return matchesKind && matchesEfforts && matchesDocs && matchesSearch;
      })
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }, [docsFilter, effortsFilter, kindFilter, rows, searchQuery]);

  const missingEfforts = rows.length - documented;
  const withDocs = rows.filter((r) => r.supportingDocumentIds.length > 0).length;
  const filteredTotalCents = filteredRows.reduce((s, r) => s + r.amountCents, 0);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filteredRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters =
    searchQuery !== "" || kindFilter !== "" || effortsFilter !== "" || docsFilter !== "";

  return (
    <WorkQueueLayout
      fullPageScroll
      header={
        <PageHeader
          title="Bad-Debt Log"
          breadcrumb="Revenue Cycle — Medicare bad-debt reimbursement (D7)"
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review deductible and coinsurance bad debt, collection-effort documentation, supporting
            documents, and claimed amounts for the selected report.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Entries"
            value={picking || debtError ? "—" : rows.length}
            detail={
              selectedReport
                ? `FYE ${shortDate(selectedReport.fiscalYearEndDate)}`
                : "No report selected"
            }
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Claimed"
            value={picking || debtError ? "—" : money(totalCents)}
            detail={hasActiveFilters ? `${money(filteredTotalCents)} visible` : "Total amount"}
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Documented"
            value={picking || debtError ? "—" : `${documented} / ${rows.length}`}
            detail="Collection efforts"
            tone={missingEfforts > 0 ? "warning" : "success"}
            accentColor={missingEfforts > 0 ? "var(--color-warning)" : "var(--color-success)"}
          />
          <KpiCard
            label="Missing Efforts"
            value={picking || debtError ? "—" : missingEfforts}
            detail="Needs follow-up"
            tone={missingEfforts > 0 ? "danger" : "neutral"}
            accentColor={missingEfforts > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={effortsFilter === "missing"}
            onSelect={() => {
              setEffortsFilter("missing");
              setPage(1);
            }}
          />
          <KpiCard
            label="With Docs"
            value={picking || debtError ? "—" : withDocs}
            detail="Supporting files"
            tone={withDocs > 0 ? "success" : "neutral"}
            accentColor={withDocs > 0 ? "var(--color-success)" : "var(--color-outline-variant)"}
            selected={docsFilter === "with_docs"}
            onSelect={() => {
              setDocsFilter("with_docs");
              setPage(1);
            }}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {pickErr || debtError ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{pickErr ? "Cost reports could not be loaded." : debtError}</span>
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
            <div style={{ position: "relative", minWidth: "17rem" }}>
              <input
                type="search"
                placeholder="Search period, kind, document..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search bad-debt entries"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Kind</span>
              <select
                aria-label="Filter by debt kind"
                value={kindFilter}
                onChange={(e) => {
                  setKindFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {kindOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Efforts</span>
              <select
                aria-label="Filter by collection efforts"
                value={effortsFilter}
                onChange={(e) => {
                  setEffortsFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any</option>
                <option value="documented">Documented</option>
                <option value="missing">Missing</option>
              </select>
            </label>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Docs</span>
              <select
                aria-label="Filter by supporting documents"
                value={docsFilter}
                onChange={(e) => {
                  setDocsFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">Any</option>
                <option value="with_docs">With docs</option>
                <option value="without_docs">No docs</option>
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setKindFilter("");
                  setEffortsFilter("");
                  setDocsFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {picking ? "Loading reports..." : `${filteredRows.length} of ${rows.length} entries`}
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
              description="Create a cost report to log bad debt."
            />
          </div>
        ) : loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : debtError ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={debtError} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No bad-debt entries"
              description={
                hasActiveFilters
                  ? "No bad-debt entry matches these filters."
                  : "No Medicare bad debt has been logged for this cost report."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setKindFilter("");
                      setEffortsFilter("");
                      setDocsFilter("");
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
            <div style={tableViewportStyle}>
              <table style={badDebtTableStyle}>
                <colgroup>
                  <col style={{ width: "24%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={headStyle}>Period</th>
                    <th style={headStyle}>Kind</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Amount</th>
                    <th style={headStyle}>Collection efforts</th>
                    <th style={{ ...headStyle, textAlign: "right" }}>Supporting docs</th>
                    <th style={headStyle}>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r) => (
                    <tr key={r.recordId} style={rowStyle}>
                      <td style={primaryCellStyle}>
                        <span style={periodStyle}>{r.periodLabel}</span>
                        <span style={mutedStyle}>{r.recordId.slice(0, 8)}</span>
                      </td>
                      <td style={cellStyle}>{humanize(r.debtKind)}</td>
                      <td style={numStyle}>{money(r.amountCents)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          tone={r.collectionEffortsDocumented ? "success" : "warning"}
                          label={r.collectionEffortsDocumented ? "Documented" : "Missing"}
                        />
                      </td>
                      <td style={numStyle}>{r.supportingDocumentIds.length}</td>
                      <td style={cellStyle}>{shortDate(r.addedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredRows.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="entries"
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
  color: "var(--color-error-pill-fg)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  fontSize: "0.875rem",
};

const tableViewportStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const badDebtTableStyle: CSSProperties = {
  ...tableStyle,
  minWidth: "64rem",
  tableLayout: "fixed",
};

const primaryCellStyle: CSSProperties = {
  ...cellStyle,
  display: "grid",
  gap: "0.2rem",
};

const periodStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontWeight: 600,
};
