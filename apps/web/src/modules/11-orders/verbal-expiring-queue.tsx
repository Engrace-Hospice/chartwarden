import {
  Button,
  CountdownChip,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — verbal-expiring queue (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (verbal-order workflow). The RN's
// queue of verbal_pending orders inside the 48h signature window (42 CFR 418.104(b)), sorted by deadline.
// Each row shows a live countdown with pre-expiry colour tiers at 12h (amber) and 2h (red); past-deadline
// rows are flagged red (the server flips them to expired_unsigned — this is a UX cue only, ADR-0030, no
// frontend authz). Reads GET /api/v1/orders/verbal-expiring via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { type OrderAction, OrderActionModal } from "./order-action-modal";
import { stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  verbalDeadlineAt: string | null;
}

export function VerbalExpiringQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [deadlineFilter, setDeadlineFilter] = useState<"all" | "overdue" | "alert" | "warning">(
    "all",
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/verbal-expiring", {});
    if (err) {
      setError("Could not load the verbal-expiring queue.");
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
    const now = Date.now();
    const visible = items.filter((o) => {
      const hours = hoursUntil(o.verbalDeadlineAt, now);
      const matchesDeadline =
        deadlineFilter === "all" ||
        (deadlineFilter === "overdue" && hours < 0) ||
        (deadlineFilter === "alert" && hours >= 0 && hours <= 2) ||
        (deadlineFilter === "warning" && hours > 2 && hours <= 12);
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.kind.toLowerCase().includes(q) ||
        o.status.toLowerCase().includes(q);
      return matchesDeadline && matchesSearch;
    });

    return [...visible].sort(
      (a, b) => deadlineMs(a.verbalDeadlineAt) - deadlineMs(b.verbalDeadlineAt),
    );
  }, [items, deadlineFilter, searchQuery]);

  const activeFilters = [searchQuery.trim() !== "", deadlineFilter !== "all"].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const [acting, setActing] = useState<{ id: string; action: OrderAction } | null>(null);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setDeadlineFilter("all");
    setPage(1);
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Verbal Orders - Expiring" breadcrumb="Clinical / Orders">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Track verbal orders inside the signature window by deadline urgency.
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
                <strong>{rows.length} matching verbal orders</strong>
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
                    aria-label="Search verbal orders"
                    style={searchInputStyle}
                  />
                </div>
                <select
                  aria-label="Deadline window"
                  value={deadlineFilter}
                  onChange={(e) => {
                    setDeadlineFilter(e.target.value as typeof deadlineFilter);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="all">Deadline: All</option>
                  <option value="overdue">Overdue</option>
                  <option value="alert">Under 2h</option>
                  <option value="warning">Under 12h</option>
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
                title={activeFilters > 0 ? "No matching verbal orders" : "No verbal orders pending"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the queue filters."
                    : "No verbal orders are awaiting signature."
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
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "14%" }}>Deadline</th>
                    <th style={{ ...thStyle, width: "14%", textAlign: "right" }}>Time left</th>
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
                        <StatusPill label={stateLabel(o.status)} tone="warning" />
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDateTime(o.verbalDeadlineAt)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {/* §2.3 verbal-order 48h window (42 CFR 418.104) — amber <=12h, alert <=2h, overdue past. */}
                        {o.verbalDeadlineAt ? (
                          <CountdownChip
                            dueAt={o.verbalDeadlineAt}
                            warnWithinHours={12}
                            alertWithinHours={2}
                            label="Sign"
                          />
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>—</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {/* The action this queue EXISTS for. Offered to everyone the queue is shown to; the
                            server decides who may take it (§4.7) and renders a 403 as the refusal it is. */}
                        <Button
                          size="sm"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setActing({ id: o.id, action: "sign" });
                          }}
                        >
                          Sign
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
                noun="verbal orders"
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

function deadlineMs(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

function hoursUntil(iso: string | null, now: number): number {
  return (deadlineMs(iso) - now) / 3_600_000;
}

function formatDateTime(iso: string | null): string {
  const value = deadlineMs(iso);
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
  position: "relative" as const,
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
