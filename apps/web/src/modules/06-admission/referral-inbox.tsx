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
// apps/web/src/modules/06-admission — Referral Inbox (M6 §5.2.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Work Queue."
// The queue of inbound referrals across sources, read from GET /api/v1/referrals via the generated
// typed client. A row opens the referral's admission (built later); the server enforces every scope
// (no authz on the frontend — ADR-0030). Reconciled to Lantern (R1): §6.6 status pills, mono ids,
// No-Line table. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate } from "react-router-dom";
import { REFERRAL_TONE, stateLabel } from "./admission-status";

interface ReferralRow {
  id: string;
  state: string;
  version: number;
}

const REFERRAL_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function ReferralInbox(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<ReferralRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: { cursor?: string; limit?: number } = { limit: 50 };
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/referrals", { params: { query } });
      if (err) {
        setError("Could not load the referral inbox.");
        setLoading(false);
        return;
      }
      const page = data?.items ?? [];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Faceted state filter is applied client-side over the loaded page (server stays the source of truth).
  const filtered = items.filter((r) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = !q || r.id.toLowerCase().includes(q) || r.state.toLowerCase().includes(q);
    const matchesState = !state || r.state === state;
    return matchesSearch && matchesState;
  });
  const openCount = items.filter((r) => r.state === "received" || r.state === "evaluated").length;
  const evaluatedCount = items.filter((r) => r.state === "evaluated").length;
  const acceptedCount = items.filter((r) => r.state === "accepted").length;
  const admittedCount = items.filter((r) => r.state === "admitted").length;
  const hasActiveFilters = searchQuery !== "" || state !== "";
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedItems = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);

  function clearFilters(): void {
    setSearchQuery("");
    setState("");
    setPage(1);
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Referral Inbox" breadcrumb="Admissions / Intake">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review inbound hospice referrals, triage readiness, and admission handoff status.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open referrals"
            value={openCount}
            detail="Received or evaluated"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Ready to decide"
            value={evaluatedCount}
            detail="Evaluated referrals"
            tone={evaluatedCount > 0 ? "warning" : "neutral"}
            accentColor={
              evaluatedCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Accepted"
            value={acceptedCount}
            detail="Pending admission"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Admitted"
            value={admittedCount}
            detail="Converted referrals"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="In view"
            value={filtered.length}
            detail="After filters"
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
          {error ? (
            <div
              role="alert"
              style={{
                padding: "0.625rem 1rem",
                borderRadius: "var(--radius-md)",
                background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                color: "var(--color-error)",
                fontSize: "0.85rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
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
            <div
              style={{
                display: "flex",
                gap: "0.25rem",
                background: "var(--color-surface-container)",
                padding: "0.2rem",
                borderRadius: "var(--radius-md)",
              }}
            >
              <button type="button" style={tabButtonStyle(true)}>
                Referrals ({items.length})
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ position: "relative", minWidth: "15rem" }}>
                <input
                  type="search"
                  placeholder="Search referrals by ID or state..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search referrals"
                  style={{
                    width: "100%",
                    paddingLeft: "2rem",
                    height: "2.25rem",
                    fontSize: "0.85rem",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: "0.625rem",
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "var(--color-on-surface-variant)",
                    pointerEvents: "none",
                  }}
                >
                  <Glyph name="search" size={14} />
                </div>
              </div>
              <select
                aria-label="Referral state"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setPage(1);
                }}
                style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
              >
                <option value="">State: All</option>
                <option value="received">Received</option>
                <option value="evaluated">Evaluated</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="withdrawn">Withdrawn</option>
                <option value="admitted">Admitted</option>
              </select>
              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      }
      table={
        loading && items.length === 0 ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching referrals found" : "No active referrals"}
              description={
                hasActiveFilters
                  ? "Try adjusting the search or state filter."
                  : "Referrals from HearthNote, phone, or fax appear here."
              }
              action={
                hasActiveFilters ? (
                  <Button tone="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <ReferralTable
              items={pagedItems}
              loading={loading}
              onOpen={(id) => navigate(`/referrals/${id}`)}
            />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={REFERRAL_PAGE_SIZES}
              noun="referrals"
            />
            {nextCursor ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "0 1.5rem 1.5rem",
                }}
              >
                <Button
                  type="button"
                  tone="secondary"
                  size="sm"
                  onClick={() => load(nextCursor)}
                  loading={loading}
                >
                  Load more referrals
                </Button>
              </div>
            ) : null}
          </>
        )
      }
    />
  );
}

function ReferralTable({
  items,
  loading,
  onOpen,
}: {
  items: ReferralRow[];
  loading: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
      <table
        style={{
          display: "table",
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.875rem",
        }}
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
            <th style={{ ...thStyle, width: "48%" }}>Referral</th>
            <th style={{ ...thStyle, width: "18%" }}>State</th>
            <th style={{ ...thStyle, width: "18%" }}>Version</th>
            <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onOpen(r.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onOpen(r.id);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <td style={tdStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                  <div
                    style={{
                      width: "2rem",
                      height: "2rem",
                      borderRadius: "var(--radius-md)",
                      background: "var(--color-primary-tint)",
                      color: "var(--color-primary)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Glyph name="file-text" size={16} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="wx-data-md" style={{ fontWeight: 650 }}>
                      {r.id}
                    </div>
                    <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.75rem" }}>
                      Referral intake record
                    </div>
                  </div>
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={stateLabel(r.state)}
                  tone={REFERRAL_TONE[r.state] ?? "neutral"}
                />
              </td>
              <td className="wx-data-md" style={tdStyle}>
                v{r.version}
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }}>
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(r.id);
                  }}
                  disabled={loading}
                >
                  Open
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    border: "none",
    borderRadius: "calc(var(--radius-md) - 2px)",
    background: active ? "var(--color-surface-lowest)" : "transparent",
    color: active ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
    padding: "0.4rem 0.8rem",
    fontSize: "0.85rem",
    fontWeight: active ? 650 : 500,
    cursor: "pointer",
    boxShadow: active ? "var(--shadow-soft)" : "none",
  };
}

const thStyle: CSSProperties = {
  padding: "0.75rem 1rem",
  fontSize: "0.75rem",
  fontWeight: 650,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
};

const tdStyle: CSSProperties = {
  padding: "0.875rem 1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
  verticalAlign: "middle",
};
