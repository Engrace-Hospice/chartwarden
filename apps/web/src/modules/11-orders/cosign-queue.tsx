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
// apps/web/src/modules/11-orders — cosign-pending queue (M11 §4.1/§5 §2.5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (cosignature). LPN-drafted kinds
// (per tenant policy) require an RN / Clinical-Supervisor cosignature before the order may go Active; this is
// the queue of orders with cosign_status='pending', showing the cosigner role needed. The cosign step-up
// action fills in as its write surface hardens. Reads GET /api/v1/orders/cosign-pending via the typed client;
// the server enforces the §4.7 cosigner_role_match ABAC (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { type OrderAction, OrderActionModal } from "./order-action-modal";
import { ORDER_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  drafterDiscipline: string;
  createdAt: string;
}

export function CosignQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/cosign-pending", {});
    if (err) {
      setError("Could not load the cosign-pending queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const disciplineOptions = useMemo(
    () => [...new Set(items.map((o) => o.drafterDiscipline).filter(Boolean))].sort(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const matchesDiscipline = !discipline || o.drafterDiscipline === discipline;
      const matchesStatus = !status || o.status === status;
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.kind.toLowerCase().includes(q) ||
        o.status.toLowerCase().includes(q) ||
        o.drafterDiscipline.toLowerCase().includes(q);
      return matchesDiscipline && matchesStatus && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [items, discipline, searchQuery, status]);

  const activeFilters = [searchQuery.trim() !== "", discipline !== "", status !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const [acting, setActing] = useState<{ id: string; action: OrderAction } | null>(null);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setDiscipline("");
    setStatus("");
    setPage(1);
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Orders - Cosign Pending" breadcrumb="Clinical / Orders">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review orders waiting for the required clinical cosignature.
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
                <strong>{rows.length} matching orders</strong>
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
                    aria-label="Search cosign pending orders"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  aria-label="Drafting discipline"
                  value={discipline}
                  onChange={(e) => {
                    setDiscipline(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Discipline: All</option>
                  {disciplineOptions.map((option) => (
                    <option key={option} value={option}>
                      {stateLabel(option)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Order status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">Status: All</option>
                  <option value="pending_signature">Pending signature</option>
                  <option value="verbal_pending">Verbal pending</option>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
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
                title={activeFilters > 0 ? "No matching cosignatures" : "No cosignatures pending"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the queue filters."
                    : "No orders are awaiting cosignature."
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
                    <th style={{ ...thStyle, width: "34%" }}>Order</th>
                    <th style={{ ...thStyle, width: "24%" }}>Patient</th>
                    <th style={{ ...thStyle, width: "16%" }}>Drafted by</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "12%", textAlign: "right" }}>Created</th>
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
                      <td style={tdStyle}>{stateLabel(o.drafterDiscipline)}</td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(o.status)}
                          tone={ORDER_TONE[o.status] ?? "neutral"}
                        />
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {formatDateTime(o.createdAt)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {/* The action this queue EXISTS for. Offered to everyone the queue is shown to; the
                            server decides who may take it (§4.7) and renders a 403 as the refusal it is. */}
                        <Button
                          size="sm"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setActing({ id: o.id, action: "cosign" });
                          }}
                        >
                          Cosign
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
                noun="orders"
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

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
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
