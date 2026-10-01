import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/18-evv — Aggregator Submission Queue (M18 §5.1 `/app/evv/aggregator-submissions`,
// Track B / ADR-0030).
//
// #91 — the two §2.2.5 D7 operator actions are here now. This is the last hop of an EVV visit: the state's
// aggregator either accepts the submission or the Medicaid claim behind it is denied. A rejection is
// fixed and RESUBMITTED by a person (§7.9, attempt_count++); a submission for a voided visit is CANCELLED
// so the state never sees it. Neither had a caller, so a rejected row stayed rejected forever and nothing
// on this platform could retry it.
//
// `submissionActions` narrows which button a row OFFERS — an affordance over the D7 graph, not a gate.
// Server-side state_code/status narrowing and the transition machine remain authoritative (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { type AggregatorSubmissionView, submissionActions } from "./evv-api";
import { type SubmissionAction, SubmissionActionModal } from "./evv-modals";
import { EVV_SUBMISSION_TONE, stateLabel } from "./evv-shared";

interface SubmissionRow {
  id: string;
  visitId: string;
  stateCode: string;
  aggregatorVendor: string;
  status: string;
  attemptCount: number;
}

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const RETRY_STATUSES = new Set(["rejected", "timeout"]);
const ACTIVE_STATUSES = new Set(["pending", "queued", "submitting", "submitted"]);

export function EvvAggregatorSubmissions(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const stateCode = params.get("stateCode") ?? undefined;
  const status = params.get("status") ?? undefined;
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(status ?? "all");
  const [stateFilter, setStateFilter] = useState(stateCode ?? "all");
  const [vendorFilter, setVendorFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: SubmissionAction; row: SubmissionRow } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/aggregator-submissions", {
      params: { query: { ...(stateCode ? { stateCode } : {}), ...(status ? { status } : {}) } },
    });
    if (err) {
      setError("Could not load the aggregator submission queue.");
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as SubmissionRow[]) ?? []);
    setLoading(false);
  }, [client, stateCode, status]);

  useEffect(() => {
    setStatusFilter(status ?? "all");
    setStateFilter(stateCode ?? "all");
  }, [stateCode, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const statusOptions = useMemo(() => [...new Set(rows.map((row) => row.status))].sort(), [rows]);
  const stateOptions = useMemo(() => [...new Set(rows.map((row) => row.stateCode))].sort(), [rows]);
  const vendorOptions = useMemo(
    () => [...new Set(rows.map((row) => row.aggregatorVendor))].sort(),
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      const matchesState = stateFilter === "all" || row.stateCode === stateFilter;
      const matchesVendor = vendorFilter === "all" || row.aggregatorVendor === vendorFilter;
      const matchesSearch =
        !q ||
        row.id.toLowerCase().includes(q) ||
        row.visitId.toLowerCase().includes(q) ||
        row.stateCode.toLowerCase().includes(q) ||
        row.aggregatorVendor.toLowerCase().includes(q) ||
        row.status.toLowerCase().includes(q);
      return matchesStatus && matchesState && matchesVendor && matchesSearch;
    });
  }, [rows, searchQuery, stateFilter, statusFilter, vendorFilter]);

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => submissionRank(a) - submissionRank(b)),
    [filteredRows],
  );
  const activePage = Math.min(page, Math.max(1, Math.ceil(sortedRows.length / pageSize)));
  const pagedRows = sortedRows.slice((activePage - 1) * pageSize, activePage * pageSize);
  const activeFilters = [
    searchQuery.trim() !== "",
    statusFilter !== "all",
    stateFilter !== "all",
    vendorFilter !== "all",
    stateCode,
    status,
  ].filter(Boolean).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatusFilter(status ?? "all");
    setStateFilter(stateCode ?? "all");
    setVendorFilter("all");
    setPage(1);
  };

  const applySubmission = (updated: AggregatorSubmissionView): void => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === updated.id
          ? { ...r, status: updated.status, attemptCount: updated.attemptCount }
          : r,
      ),
    );
    setNotice(`Submission ${updated.id.slice(0, 8)} is now ${stateLabel(updated.status)}.`);
  };

  return (
    <>
      {pending ? (
        <SubmissionActionModal
          open
          action={pending.action}
          submissionId={pending.row.id}
          stateCode={pending.row.stateCode}
          attemptCount={pending.row.attemptCount}
          onClose={() => setPending(null)}
          onDone={applySubmission}
        />
      ) : null}
      <WorkQueueLayout
        header={
          <PageHeader
            title="Aggregator Submissions"
            breadcrumb="Admin / EVV"
            actions={
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Monitor state aggregator handoffs, retries, and rejected submissions.
            </div>
          </PageHeader>
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
                <span style={toolbarEyebrowStyle}>Submission queue</span>
                <strong>{sortedRows.length} matching submissions</strong>
                {notice ? (
                  <output style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
                    {notice}
                  </output>
                ) : null}
              </div>
              <div style={controlGroupStyle}>
                <div style={searchWrapStyle}>
                  <input
                    type="search"
                    placeholder="Search submission, visit, state, vendor..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search aggregator submissions"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  aria-label="Submission status"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">Status: All</option>
                  {statusOptions.map((option) => (
                    <option key={option} value={option}>
                      {stateLabel(option)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="State code"
                  value={stateFilter}
                  onChange={(e) => {
                    setStateFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">State: All</option>
                  {stateOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Aggregator vendor"
                  value={vendorFilter}
                  onChange={(e) => {
                    setVendorFilter(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">Vendor: All</option>
                  {vendorOptions.map((option) => (
                    <option key={option} value={option}>
                      {stateLabel(option)}
                    </option>
                  ))}
                </select>
                {activeFilters > 0 ? (
                  <Button size="sm" tone="tertiary" onClick={clearFilters}>
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
            {stateCode || status ? (
              <div role="note" style={noteStyle}>
                <StatusPill label="Server scoped" tone="progress" />
                <span>
                  URL state/status filters are applied by the server before local filtering.
                </span>
              </div>
            ) : null}
          </div>
        }
        table={
          error && rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : sortedRows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title={activeFilters > 0 ? "No matching submissions" : "No submissions"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the submission filters."
                    : "No aggregator submissions match your server-scoped request."
                }
                action={
                  activeFilters > 0 ? (
                    <Button size="sm" tone="secondary" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "18%" }}>Submission</th>
                    <th style={{ ...thStyle, width: "16%" }}>Visit</th>
                    <th style={{ ...thStyle, width: "8%" }}>State</th>
                    <th style={{ ...thStyle, width: "14%" }}>Vendor</th>
                    <th style={{ ...thStyle, width: "10%" }}>Attempts</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "20%", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <tr key={row.id} style={rowStyle}>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(row.id)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(row.visitId)}
                        </code>
                      </td>
                      <td style={tdStyle}>{row.stateCode}</td>
                      <td style={tdStyle}>{stateLabel(row.aggregatorVendor)}</td>
                      <td className="tabular-nums" style={tdStyle}>
                        {row.attemptCount}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(row.status)}
                          tone={EVV_SUBMISSION_TONE[row.status] ?? "neutral"}
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <SubmissionRowActions
                          row={row}
                          onPick={(action) => setPending({ action, row })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={sortedRows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="submissions"
              />
            </div>
          )
        }
        fullPageScroll
      />
    </>
  );
}

function submissionRank(row: SubmissionRow): number {
  if (RETRY_STATUSES.has(row.status)) return 0;
  if (row.attemptCount >= 3) return 1;
  if (ACTIVE_STATUSES.has(row.status)) return 2;
  return 3;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
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
const searchWrapStyle = { minWidth: "16rem" };
const searchInputStyle = { width: "100%", height: "2.25rem", fontSize: "0.85rem" };
const selectStyle = { height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" };
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error-pill-fg)",
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
const codeStyle = {
  display: "inline-block",
  maxWidth: "13rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};

/**
 * The D7 operator actions a row can take. `submissionActions` narrows which to OFFER; the machine
 * decides whether each is legal, and a status this build has never heard of keeps both rather than
 * losing them to a stale frontend.
 */
function SubmissionRowActions({
  row,
  onPick,
}: { row: SubmissionRow; onPick: (action: SubmissionAction) => void }): JSX.Element {
  const can = submissionActions(row.status);
  if (!can.resubmit && !can.cancel)
    return <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>;
  return (
    <div style={{ display: "flex", gap: "0.35rem", justifyContent: "flex-end" }}>
      {can.resubmit ? (
        <Button size="sm" onClick={() => onPick("resubmit")}>
          Resubmit
        </Button>
      ) : null}
      {can.cancel ? (
        <Button size="sm" tone="tertiary" onClick={() => onPick("cancel")}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
