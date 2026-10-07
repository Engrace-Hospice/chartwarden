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
// apps/web/src/modules/26-cap — M26, the PS&R RECONCILIATION WORKBENCH (R2, §5.1.5). The reimbursement
// specialist's surface: upload the quarterly CMS PS&R CSV, then reconcile the per-beneficiary variance lines
// (M26 ledger vs the MAC figure) above the per-tenant threshold (default $50). Phase 1 is upload-driven — the
// import is created via POST /api/v1/cap/periods/:id/psr-imports and the per-import variance view drills in at
// /api/v1/cap/psr-imports/:importId/reconciliation (server-authoritative, gated on cap.psr.read/reconcile).
// GAP-079 wires the per-line resolution (a variance reason + resolution notes) here; the upload stays on the
// import view and the server stays authoritative for cap.psr.reconcile.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import { CapActionDialog, sendCapMutation } from "./cap-actions";
import { humanize, money, shortDate } from "./cap-status";

interface PsrImportView {
  id: string;
  capPeriodId: string;
  macRegion: string;
  psrPeriodFrom: string;
  psrPeriodTo: string;
  parseStatus: string;
  parseError: string | null;
  beneficiaryCountPsr: number | null;
  paidTotalCentsPsr: number | null;
  importedAt: string;
}

interface PsrVarianceView {
  id: string;
  scope: string;
  patientId: string | null;
  m26AccrualCents: number | null;
  psrAmountCents: number | null;
  varianceCents: number | null;
  varianceReason: string | null;
  status: string;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const STATUS_TONE: Record<string, "neutral" | "progress" | "success" | "warning" | "error"> = {
  queued: "progress",
  parsing: "progress",
  parsed: "success",
  failed: "error",
  open: "warning",
  investigating: "progress",
  resolved: "success",
  accepted: "neutral",
};

export function CapPsrWorkbench(): JSX.Element {
  const client = useApiClient();
  const [importId, setImportId] = useState("");
  const [loadedImportId, setLoadedImportId] = useState("");
  const [psrImport, setPsrImport] = useState<PsrImportView | null>(null);
  const [variances, setVariances] = useState<PsrVarianceView[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<PsrVarianceView | null>(null);

  const loadImport = useCallback(
    async (nextImportId: string) => {
      const id = nextImportId.trim();
      if (!id) return;
      setLoading(true);
      setError(null);
      setLoadedImportId(id);
      const [importRes, reconciliationRes] = await Promise.all([
        client.GET("/api/v1/cap/psr-imports/{importId}", {
          params: { path: { importId: id } },
        } as never),
        client.GET("/api/v1/cap/psr-imports/{importId}/reconciliation", {
          params: { path: { importId: id } },
        } as never),
      ]);
      if (importRes.error) {
        setError("PS&R import is unavailable — the import may not exist, or you may lack scope.");
        setPsrImport(null);
        setVariances([]);
        setLoading(false);
        return;
      }
      setPsrImport(importRes.data as unknown as PsrImportView);
      setVariances(
        reconciliationRes.error
          ? []
          : ((reconciliationRes.data as unknown as PsrVarianceView[]) ?? []),
      );
      setLoading(false);
      setPage(1);
    },
    [client],
  );

  const statusOptions = useMemo(
    () => [
      { value: "", label: "Any status" },
      ...Array.from(new Set(variances.map((v) => v.status)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [variances],
  );
  const scopeOptions = useMemo(
    () => [
      { value: "", label: "Any scope" },
      ...Array.from(new Set(variances.map((v) => v.scope)))
        .sort()
        .map((value) => ({ value, label: humanize(value) })),
    ],
    [variances],
  );
  const filteredVariances = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return variances.filter((v) => {
      const matchesStatus = !statusFilter || v.status === statusFilter;
      const matchesScope = !scopeFilter || v.scope === scopeFilter;
      const matchesSearch =
        !q ||
        [
          v.id,
          v.scope,
          v.patientId ?? "",
          v.status,
          v.varianceReason ?? "",
          String(v.m26AccrualCents ?? ""),
          String(v.psrAmountCents ?? ""),
          String(v.varianceCents ?? ""),
        ].some((value) => value.toLowerCase().includes(q));
      return matchesStatus && matchesScope && matchesSearch;
    });
  }, [scopeFilter, searchQuery, statusFilter, variances]);

  const openCount = variances.filter(
    (v) => v.status === "open" || v.status === "investigating",
  ).length;
  const resolvedCount = variances.filter(
    (v) => v.status === "resolved" || v.status === "accepted",
  ).length;
  const totalVarianceCents = variances.reduce((sum, v) => sum + Math.abs(v.varianceCents ?? 0), 0);
  const patientVarianceCount = variances.filter((v) => v.patientId).length;
  const pageCount = Math.max(1, Math.ceil(filteredVariances.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedVariances = filteredVariances.slice(
    (activePage - 1) * pageSize,
    activePage * pageSize,
  );
  const hasActiveFilters = searchQuery !== "" || statusFilter !== "" || scopeFilter !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="PS&R Reconciliation" breadcrumb="Revenue Cycle — MAC reconciliation">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review a PS&R import, compare MAC figures to the M26 ledger, and triage variance lines.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Import"
            value={loading ? "..." : loadedImportId ? loadedImportId.slice(0, 8) : "—"}
            detail={psrImport ? humanize(psrImport.parseStatus) : "Paste import ID"}
            tone={
              psrImport
                ? STATUS_TONE[psrImport.parseStatus] === "error"
                  ? "danger"
                  : "info"
                : "neutral"
            }
            accentColor={psrImport ? "var(--color-primary)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Variances"
            value={loading || error ? "—" : variances.length}
            detail="Lines loaded"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Open"
            value={loading || error ? "—" : openCount}
            detail="Needs work"
            tone={openCount > 0 ? "warning" : "neutral"}
            accentColor={openCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Resolved"
            value={loading || error ? "—" : resolvedCount}
            detail="Accepted/resolved"
            tone={resolvedCount > 0 ? "success" : "neutral"}
            accentColor={
              resolvedCount > 0 ? "var(--color-success)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Abs Variance"
            value={loading || error ? "—" : money(totalVarianceCents)}
            detail={`${patientVarianceCount} patient lines`}
            tone={totalVarianceCents > 0 ? "warning" : "neutral"}
            accentColor={
              totalVarianceCents > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
          />
        </KpiStrip>
      }
      filters={
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadImport(importId);
          }}
          style={filterPanelStyle}
        >
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
                value={importId}
                onChange={(e) => setImportId(e.target.value)}
                placeholder="Paste PS&R import ID..."
                aria-label="PS&R import ID"
              />
            </label>
            <Button type="submit" tone="primary" size="sm" disabled={!importId.trim() || loading}>
              {loading ? "Loading..." : "Load import"}
            </Button>
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search variance lines..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search PS&R variances"
              />
            </label>
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
            {hasActiveFilters ? (
              <Button
                type="button"
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setStatusFilter("");
                  setScopeFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filteredVariances.length} of {variances.length} variances
            </span>
          </div>
        </form>
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
        ) : !psrImport ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="Load a PS&R import"
              description={
                "Paste a PS&R import ID to inspect MAC totals and reconciliation variance lines. Imports are created from the cap period upload flow."
              }
            />
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.25rem",
              padding: "0 1.5rem 1.5rem",
            }}
          >
            <section>
              <h3 style={sectionTitle}>Import summary</h3>
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr style={headerRowStyle}>
                      <th style={headStyle}>MAC region</th>
                      <th style={headStyle}>PS&R period</th>
                      <th style={headStyle}>Imported</th>
                      <th style={headNumStyle}>Beneficiaries</th>
                      <th style={headNumStyle}>PS&R paid</th>
                      <th style={headStyle}>Parse</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={rowStyle}>
                      <td style={cellStyle}>{humanize(psrImport.macRegion)}</td>
                      <td style={cellStyle}>
                        {shortDate(psrImport.psrPeriodFrom)} – {shortDate(psrImport.psrPeriodTo)}
                      </td>
                      <td style={tdDateStyle}>{shortDate(psrImport.importedAt)}</td>
                      <td style={numStyle}>
                        {psrImport.beneficiaryCountPsr?.toLocaleString() ?? "—"}
                      </td>
                      <td style={numStyle}>{money(psrImport.paidTotalCentsPsr)}</td>
                      <td style={cellStyle}>
                        <StatusPill
                          label={humanize(psrImport.parseStatus)}
                          tone={statusTone(psrImport.parseStatus)}
                        />
                        {psrImport.parseError ? (
                          <div style={mutedStyle}>{psrImport.parseError}</div>
                        ) : null}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 style={sectionTitle}>Variance lines</h3>
              {filteredVariances.length === 0 ? (
                <EmptyState
                  title="No variance lines"
                  description={
                    hasActiveFilters
                      ? "No PS&R variance matches these filters."
                      : "This import has no reconciliation variances."
                  }
                  action={
                    hasActiveFilters ? (
                      <Button
                        tone="secondary"
                        size="sm"
                        onClick={() => {
                          setSearchQuery("");
                          setStatusFilter("");
                          setScopeFilter("");
                          setPage(1);
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
                        <th style={headStyle}>Scope</th>
                        <th style={headStyle}>Patient</th>
                        <th style={headNumStyle}>M26 accrual</th>
                        <th style={headNumStyle}>PS&R amount</th>
                        <th style={headNumStyle}>Variance</th>
                        <th style={headStyle}>Reason</th>
                        <th style={headStyle}>Status</th>
                        <th style={headStyle}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedVariances.map((v) => (
                        <tr key={v.id} style={rowStyle}>
                          <td style={cellStyle}>{humanize(v.scope)}</td>
                          <td style={tdCodeStyle}>{v.patientId?.slice(0, 8) ?? "—"}</td>
                          <td style={numStyle}>{money(v.m26AccrualCents)}</td>
                          <td style={numStyle}>{money(v.psrAmountCents)}</td>
                          <td style={numStyle}>{money(v.varianceCents)}</td>
                          <td style={cellStyle}>{humanize(v.varianceReason)}</td>
                          <td style={cellStyle}>
                            <StatusPill label={humanize(v.status)} tone={statusTone(v.status)} />
                          </td>
                          <td style={cellStyle}>
                            {v.status === "resolved" || v.status === "accepted" ? (
                              <span style={mutedStyle}>—</span>
                            ) : (
                              <Button size="sm" tone="secondary" onClick={() => setResolving(v)}>
                                Resolve
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
                    totalItems={filteredVariances.length}
                    onPageChange={setPage}
                    onPageSizeChange={(next) => {
                      setPageSize(next);
                      setPage(1);
                    }}
                    pageSizeOptions={PAGE_SIZES}
                    noun="variances"
                  />
                </div>
              )}
            </section>
          </div>
        )
      }
      detail={
        <>
          <span style={mutedStyle}>
            Uploads are created from a cap period. Resolving a variance line records its reason and
            notes; the server remains authoritative for who may reconcile.
          </span>
          <CapActionDialog
            open={resolving !== null}
            title="Resolve variance line"
            hint="Pick why the M26 accrual and the PS&R figure differ and record what was done. Resolution notes are kept on the reconciliation record."
            submitLabel="Resolve"
            choice={{ label: "Variance reason", options: VARIANCE_REASONS }}
            textLabel="Resolution notes"
            textMinLength={20}
            onClose={() => setResolving(null)}
            onSubmit={({ text, choice }) =>
              sendCapMutation(
                client,
                "PATCH",
                "/api/v1/cap/psr-imports/{importId}/reconciliation/{lineId}/resolve",
                { importId: loadedImportId, lineId: resolving?.id ?? "" },
                { varianceReason: choice, resolutionNotes: text },
              )
            }
            onDone={() => {
              setResolving(null);
              void loadImport(loadedImportId);
            }}
          />
        </>
      }
      fullPageScroll
    />
  );
}

/** The server's `ResolveVarianceRequest.varianceReason` union, labelled for the picker. */
const VARIANCE_REASONS = [
  { value: "timing", label: "Timing" },
  { value: "psr_correction", label: "PS&R correction" },
  { value: "our_correction", label: "Our correction" },
  { value: "mbi_mismatch", label: "MBI mismatch" },
  { value: "data_quality", label: "Data quality" },
  { value: "unknown", label: "Unknown" },
] as const;

function statusTone(value: string): "neutral" | "progress" | "success" | "warning" | "error" {
  return STATUS_TONE[value] ?? "neutral";
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
