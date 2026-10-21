import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/11-orders — physician signature inbox (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ORDERS.md — "Use Patient Workspace + Work Queue" (signature
// inbox half). The global queue of orders awaiting a physician signature, KPI'd by kind, sorted by created.
// Priority (routine/stat/asap) is surfaced as a UX cue; the server owns the authoritative §2.2 D2 status
// (ADR-0030 — no frontend authz). Reads GET /api/v1/orders/pending-signature via the typed client, and —
// since #91 — SIGNS from the row: the queue's whole reason to exist was an action it did not offer. There
// is no step-up ceremony because the server does not ask for one (see screens.ts). Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { NameLabel, matchesAllTokens, patientNameOf } from "../../shell/name-display";
import { usePatientNames } from "../../shell/patient-names";
import { type OrderAction, OrderActionModal } from "./order-action-modal";
import { COSIGN_TONE, PRIORITY_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  priority: string;
  cosignStatus: "pending" | "attached" | null;
  createdAt: string;
}

export function OrdersSignInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/pending-signature", {});
    if (err) {
      setError("Could not load the signature inbox.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const patientNames = usePatientNames(items.map((o) => o.patientId));
  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const matchesKind = !kind || o.kind === kind;
      const matchesPriority = !priority || o.priority === priority;
      const matchesSearch = matchesAllTokens(
        [o.id, patientNames[o.patientId]?.name, patientNames[o.patientId]?.mrn, o.kind, o.status],
        q,
      );
      return matchesKind && matchesPriority && matchesSearch;
    });
    return [...visible].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [items, kind, priority, searchQuery, patientNames]);

  const activeFilters = [searchQuery.trim() !== "", kind !== "", priority !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const [acting, setActing] = useState<{ id: string; action: OrderAction } | null>(null);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setKind("");
    setPriority("");
    setPage(1);
  };

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Orders Awaiting Signature" breadcrumb="Clinical / Orders">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Review unsigned orders by urgency, order type, and patient context.
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
                <label className="wx-search-field">
                  <Glyph name="search" size={16} />
                  <input
                    type="search"
                    placeholder="Search order or patient..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Search orders awaiting signature"
                  />
                </label>
                <label className="wx-filter-field">
                  <span>Kind</span>
                  <select
                    className="wx-select"
                    aria-label="Order kind"
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="">All</option>
                    <option value="lab">Lab</option>
                    <option value="dme">DME</option>
                    <option value="level_of_care_change">Level of care</option>
                    <option value="recertification">Recertification</option>
                    <option value="comfort_kit">Comfort kit</option>
                    <option value="supply">Supply</option>
                    <option value="ancillary_service">Ancillary service</option>
                    <option value="idg_requested">IDG requested</option>
                  </select>
                </label>
                <label className="wx-filter-field">
                  <span>Priority</span>
                  <select
                    className="wx-select"
                    aria-label="Priority"
                    value={priority}
                    onChange={(e) => {
                      setPriority(e.target.value);
                      setPage(1);
                    }}
                    style={selectStyle}
                  >
                    <option value="">All</option>
                    <option value="stat">STAT</option>
                    <option value="asap">ASAP</option>
                    <option value="routine">Routine</option>
                  </select>
                </label>
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
                title={activeFilters > 0 ? "No matching orders" : "No orders awaiting signature"}
                description={
                  activeFilters > 0
                    ? "Try adjusting the queue filters."
                    : "The signature inbox is clear."
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
                    <th style={{ ...thStyle, width: "14%" }}>Priority</th>
                    <th style={{ ...thStyle, width: "14%" }}>Status</th>
                    <th style={{ ...thStyle, width: "10%" }}>Cosign</th>
                    <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Created</th>
                    <th style={{ ...thStyle, width: "9%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((o) => (
                    <tr
                      key={o.id}
                      {...interactiveRowProps(() => navigate(`/orders/${o.id}`), false, true)}
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
                        <span style={primaryTextStyle}>
                          <NameLabel value={patientNameOf(patientNames, o.patientId)} />
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={stateLabel(o.priority)}
                          tone={PRIORITY_TONE[o.priority] ?? "neutral"}
                        />
                      </td>
                      <td style={tdStyle}>
                        <StatusPill label={stateLabel(o.status)} tone="progress" />
                      </td>
                      <td style={tdStyle}>
                        {o.cosignStatus ? (
                          <StatusPill
                            label={stateLabel(o.cosignStatus)}
                            tone={COSIGN_TONE[o.cosignStatus] ?? "neutral"}
                          />
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>—</span>
                        )}
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
};

const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
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
