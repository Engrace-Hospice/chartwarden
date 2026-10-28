import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/11-orders — standing-order admin (M11 §4.1/§5 §2.4 D5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ORDERS.md — "Use Work Queue" (Standing orders). A signed template
// spawns instances on cadence (spawned instances do NOT re-require signature — the template is the signature
// anchor, D5). This worklist lists every standing-order template with its cadence, status (active/paused/
// discontinued), next-spawn time, and spawn count. The create / pause / resume / discontinue / PRN-spawn write
// actions fill in as their write surfaces harden. Reads GET /api/v1/standing-orders via the typed client; the
// server enforces every scope (ADR-0030 — no frontend authz). Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { STANDING_TONE, stateLabel } from "./orders-status";

interface StandingOrderRow {
  id: string;
  patientId: string;
  kind: string;
  cadence: string;
  status: string;
  nextSpawnAt: string | null;
  spawnCount: number;
  maxSpawns: number | null;
}

export function StandingOrders(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<StandingOrderRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cadence, setCadence] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/standing-orders", {});
    if (err) {
      setError("Could not load standing orders.");
      setLoading(false);
      return;
    }
    setItems((data?.standingOrders ?? []) as StandingOrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const cadenceOptions = useMemo(
    () => [...new Set(items.map((o) => o.cadence).filter(Boolean))].sort(),
    [items],
  );

  const rows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((o) => {
      const matchesStatus = !status || o.status === status;
      const matchesCadence = !cadence || o.cadence === cadence;
      const matchesSearch =
        !q ||
        o.id.toLowerCase().includes(q) ||
        o.patientId.toLowerCase().includes(q) ||
        o.kind.toLowerCase().includes(q) ||
        o.cadence.toLowerCase().includes(q) ||
        o.status.toLowerCase().includes(q);
      return matchesStatus && matchesCadence && matchesSearch;
    });
    return [...visible].sort((a, b) => nextSpawnMs(a.nextSpawnAt) - nextSpawnMs(b.nextSpawnAt));
  }, [items, cadence, searchQuery, status]);

  const activeFilters = [searchQuery.trim() !== "", status !== "", cadence !== ""].filter(
    Boolean,
  ).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = rows.slice((activePage - 1) * pageSize, activePage * pageSize);

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatus("");
    setCadence("");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Standing Orders">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor recurring order templates, cadence, spawn limits, and next scheduled instance.
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
              <span style={toolbarEyebrowStyle}>Templates</span>
              <strong>{rows.length} matching standing orders</strong>
            </div>
            <div style={controlGroupStyle}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search template or patient..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search standing orders"
                />
              </label>
              <label className="wx-filter-field">
                <span>Status</span>
                <select
                  className="wx-select"
                  aria-label="Standing order status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">All</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="expired">Expired</option>
                  <option value="discontinued">Discontinued</option>
                </select>
              </label>
              <label className="wx-filter-field">
                <span>Cadence</span>
                <select
                  className="wx-select"
                  aria-label="Cadence"
                  value={cadence}
                  onChange={(e) => {
                    setCadence(e.target.value);
                    setPage(1);
                  }}
                  style={selectStyle}
                >
                  <option value="">All</option>
                  {cadenceOptions.map((option) => (
                    <option key={option} value={option}>
                      {stateLabel(option)}
                    </option>
                  ))}
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
              title={activeFilters > 0 ? "No matching standing orders" : "No standing orders"}
              description={
                activeFilters > 0
                  ? "Try adjusting the template filters."
                  : "No standing-order templates are defined."
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
                  <th style={{ ...thStyle, width: "30%" }}>Template</th>
                  <th style={{ ...thStyle, width: "22%" }}>Patient</th>
                  <th style={{ ...thStyle, width: "14%" }}>Cadence</th>
                  <th style={{ ...thStyle, width: "12%" }}>Status</th>
                  <th style={{ ...thStyle, width: "12%" }}>Next spawn</th>
                  <th style={{ ...thStyle, width: "10%", textAlign: "right" }}>Spawns</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((s) => (
                  <tr key={s.id} style={rowStyle}>
                    <td style={tdStyle}>
                      <div style={primaryCellStyle}>
                        <span style={primaryTextStyle}>{stateLabel(s.kind)}</span>
                        <code className="wx-data-md" style={codeStyle}>
                          {shortId(s.id)}
                        </code>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <code className="wx-data-md" style={codeStyle}>
                        {shortId(s.patientId)}
                      </code>
                    </td>
                    <td style={tdStyle}>{stateLabel(s.cadence)}</td>
                    <td style={tdStyle}>
                      <StatusPill
                        label={stateLabel(s.status)}
                        tone={STANDING_TONE[s.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                      {formatDateTime(s.nextSpawnAt)}
                    </td>
                    <td
                      style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                    >
                      {s.spawnCount}
                      {s.maxSpawns != null ? ` / ${s.maxSpawns}` : ""}
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
              noun="standing orders"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const ORDERS_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function nextSpawnMs(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

function isDueSoon(iso: string | null): boolean {
  const value = nextSpawnMs(iso);
  if (!Number.isFinite(value)) return false;
  const delta = value - Date.now();
  return delta >= 0 && delta <= 86_400_000;
}

function formatDateTime(iso: string | null): string {
  const value = nextSpawnMs(iso);
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
