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
// apps/web/src/modules/11-orders — lab results-pending-review queue (M11 §4.1/§5 D17, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (Lab flow). Result attachment does
// NOT auto-complete the order (D17 / 42 CFR 418.106); this queue surfaces every lab order whose results have
// been received and are awaiting the clinician's "Mark reviewed" acknowledgment. The Mark-reviewed action
// (the active → completed transition) fills in as its write surface hardens. Reads
// GET /api/v1/orders/results-pending-review via the typed client; the server enforces every scope incl. ABAC
// (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { type OrderAction, OrderActionModal } from "./order-action-modal";
import { RESULTS_TONE, TRANSMISSION_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  resultsStatus: string;
  transmissionStatus: string;
  signedAt: string | null;
}

export function ResultsReviewQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [resultsStatus, setResultsStatus] = useState("");
  const [transmissionStatus, setTransmissionStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/results-pending-review", {});
    if (err) {
      setError("Could not load the results-review queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const matchesResults = !resultsStatus || o.resultsStatus === resultsStatus;
      const matchesTransmission =
        !transmissionStatus || o.transmissionStatus === transmissionStatus;
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.kind.toLowerCase().includes(q) ||
        o.resultsStatus.toLowerCase().includes(q) ||
        o.transmissionStatus.toLowerCase().includes(q);
      return matchesResults && matchesTransmission && matchesSearch;
    });
    return [...visible].sort((a, b) => signedMs(a.signedAt) - signedMs(b.signedAt));
  }, [items, resultsStatus, searchQuery, transmissionStatus]);

  const activeFilters = [
    searchQuery.trim() !== "",
    resultsStatus !== "",
    transmissionStatus !== "",
  ].filter(Boolean).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const [acting, setActing] = useState<{ id: string; action: OrderAction } | null>(null);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setResultsStatus("");
    setTransmissionStatus("");
    setPage(1);
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Lab Results - Pending Review" breadcrumb="Clinical / Orders">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Triage lab orders with attached results that still need clinician review.
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
                <span style={toolbarEyebrowStyle}>Queue</span>
                <strong>{rows.length} matching results</strong>
              </div>
              <div style={controlGroupStyle}>
                <div style={searchWrapStyle}>
                  <input
                    type="search"
                    placeholder="Search order or patient..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search results pending review"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  aria-label="Results status"
                  value={resultsStatus}
                  onChange={(e) => {
                    setResultsStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Results: All</option>
                  <option value="results_received">Results received</option>
                  <option value="partial_results_received">Partial results</option>
                  <option value="awaiting_results">Awaiting results</option>
                  <option value="results_overdue">Results overdue</option>
                </select>
                <select
                  aria-label="Transmission status"
                  value={transmissionStatus}
                  onChange={(e) => {
                    setTransmissionStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Transmission: All</option>
                  <option value="transmitted">Transmitted</option>
                  <option value="pending">Pending</option>
                  <option value="pending_retry">Pending retry</option>
                  <option value="failed">Failed</option>
                  <option value="not_required">Not required</option>
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
                title={activeFilters > 0 ? "No matching results" : "No results to review"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the queue filters."
                    : "No lab results are awaiting clinician review."
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
                    <th style={{ ...thStyle, width: "32%" }}>Order</th>
                    <th style={{ ...thStyle, width: "22%" }}>Patient</th>
                    <th style={{ ...thStyle, width: "16%" }}>Results</th>
                    <th style={{ ...thStyle, width: "18%" }}>Transmission</th>
                    <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Signed</th>
                    <th style={{ ...thStyle, width: "9%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((o) => (
                    <tr
                      key={o.id}
                      // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/orders/${o.id}`)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          navigate(`/orders/${o.id}`);
                        }
                      }}
                      style={rowStyle}
                      className="wx-data-row-interactive"
                    >
                      <td style={tdStyle}>
                        <div style={primaryCellStyle}>
                          <span style={primaryTextStyle}>{stateLabel(o.kind)}</span>
                          <code className="wx-data-md" style={codeStyle}>
                            {shortId(o.id)}
                          </code>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(o.patientId)}
                        </code>
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(o.resultsStatus)}
                          tone={RESULTS_TONE[o.resultsStatus] ?? "neutral"}
                        />
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(o.transmissionStatus)}
                          tone={TRANSMISSION_TONE[o.transmissionStatus] ?? "neutral"}
                        />
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {formatDateTime(o.signedAt)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {/* The action this queue EXISTS for. Offered to everyone the queue is shown to; the
                            server decides who may take it (§4.7) and renders a 403 as the refusal it is. */}
                        <Button
                          size="sm"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setActing({ id: o.id, action: "complete" });
                          }}
                        >
                          Mark reviewed
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={rows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={ORDERS_PAGE_SIZES}
                noun="results"
              />
            </div>
          )
        }
        fullPageScroll
      />
      {acting ? (
        <OrderActionModal
          open
          action={acting.action}
          orderId={acting.id}
          onClose={() => setActing(null)}
          // Re-read rather than filtering the row out here: whether the order leaves this queue is
          // the server's answer, and a client that removed it optimistically would be asserting an
          // outcome it did not observe.
          onDone={() => {
            setActing(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

const ORDERS_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function signedMs(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

function formatDateTime(iso: string | null): string {
  const value = signedMs(iso);
  if (!Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  cursor: "pointer",
  transition: "background 0.15s ease",
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
