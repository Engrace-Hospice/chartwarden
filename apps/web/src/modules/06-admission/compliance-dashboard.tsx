import {
  Button,
  DashboardLayout,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Compliance Dashboard (M6 §5.2.11, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md — "Use Dashboard."
// Org-wide compliance windows (F2F / recert / NOR / late-CTI) read from GET /api/v1/compliance-windows
// via the generated typed client; a row deep-links to the owning admission's Compliance tab. The
// server enforces every scope (ADR-0030 — no authz on the frontend). Reconciled to Lantern (R1): §6.6
// status pills (overdue → error tone), mono ids, No-Line table. Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { WINDOW_TONE, stateLabel } from "./admission-status";

interface WindowRow {
  id: string;
  state: string;
  version: number;
}

const WINDOW_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function ComplianceDashboard(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<WindowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: { state?: string; limit?: number } = { limit: 100 };
    if (state) query.state = state;
    const { data, error: err } = await client.GET("/api/v1/compliance-windows", {
      params: { query },
    });
    if (err) {
      setError("Could not load compliance windows.");
      setLoading(false);
      return;
    }
    setItems(data?.items ?? []);
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = items.filter((w) => w.state === "open").length;
  const overdue = items.filter((w) => w.state === "overdue").length;
  const closed = items.filter((w) => w.state === "closed").length;
  const filtered = items.filter((w) => {
    const q = searchQuery.trim().toLowerCase();
    return !q || w.id.toLowerCase().includes(q) || w.state.toLowerCase().includes(q);
  });
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
    <DashboardLayout
      header={
        <PageHeader title="Compliance — Admissions" breadcrumb="Admissions / Compliance">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track admission compliance windows, overdue work, and closed readiness checkpoints.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open"
            value={open}
            detail="Active windows"
            tone="info"
            accentColor="var(--color-primary)"
            onSelect={() => {
              setState("open");
              setPage(1);
            }}
            selected={state === "open"}
          />
          <KpiCard
            label="Overdue"
            value={overdue}
            detail="Needs attention"
            tone={overdue > 0 ? "danger" : "neutral"}
            accentColor={overdue > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            onSelect={() => {
              setState("overdue");
              setPage(1);
            }}
            selected={state === "overdue"}
          />
          <KpiCard
            label="Closed"
            value={closed}
            detail="Completed windows"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
            onSelect={() => {
              setState("closed");
              setPage(1);
            }}
            selected={state === "closed"}
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
      charts={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {error ? (
            <div role="alert" style={alertStyle}>
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
            <div style={tabsShellStyle}>
              <button type="button" style={tabButtonStyle(true)}>
                Compliance windows ({items.length})
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ position: "relative", minWidth: "15rem" }}>
                <input
                  type="search"
                  placeholder="Search windows by ID or state..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search compliance windows"
                  style={searchInputStyle}
                />
                <div style={searchIconStyle}>
                  <Glyph name="search" size={14} />
                </div>
              </div>
              <select
                aria-label="Window state"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">State: All</option>
                <option value="open">Open</option>
                <option value="overdue">Overdue</option>
                <option value="closed">Closed</option>
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
          <div style={{ padding: "2rem 0", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={
              hasActiveFilters ? "No matching compliance windows found" : "No compliance windows"
            }
            description={
              hasActiveFilters
                ? "Try adjusting the search or state filter."
                : "No windows match the current filter."
            }
            action={
              hasActiveFilters ? (
                <Button tone="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <WindowTable items={pagedItems} loading={loading} />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              pageSizeOptions={WINDOW_PAGE_SIZES}
              noun="windows"
            />
          </>
        )
      }
    />
  );
}

function WindowTable({
  items,
  loading,
}: {
  items: WindowRow[];
  loading: boolean;
}): JSX.Element {
  return (
    <section
      aria-label="Compliance windows"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
      tabIndex={0}
      style={{ width: "100%", overflowX: "auto" }}
    >
      <table style={tableStyle}>
        <thead>
          <tr style={tableHeadRowStyle}>
            <th style={{ ...thStyle, width: "58%" }}>Window</th>
            <th style={{ ...thStyle, width: "22%" }}>State</th>
            <th style={{ ...thStyle, width: "20%" }}>Version</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id}>
              <td style={tdStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                  <div style={rowIconStyle(w.state)}>
                    <Glyph name={w.state === "overdue" ? "alert" : "clock"} size={16} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="wx-data-md" style={{ fontWeight: 650 }}>
                      {w.id}
                    </div>
                    <div style={rowSubtextStyle}>Admission compliance window</div>
                  </div>
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill label={stateLabel(w.state)} tone={WINDOW_TONE[w.state] ?? "neutral"} />
              </td>
              <td className="wx-data-md" style={tdStyle}>
                v{w.version}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const alertStyle: CSSProperties = {
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

const tabsShellStyle: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  background: "var(--color-surface-container)",
  padding: "0.2rem",
  borderRadius: "var(--radius-md)",
};

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

const searchInputStyle: CSSProperties = {
  width: "100%",
  paddingLeft: "2rem",
  height: "2.25rem",
  fontSize: "0.85rem",
};

const searchIconStyle: CSSProperties = {
  position: "absolute",
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none",
};

const selectStyle: CSSProperties = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const tableStyle: CSSProperties = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};

const tableHeadRowStyle: CSSProperties = {
  textAlign: "left",
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

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

function rowIconStyle(state: string): CSSProperties {
  const urgent = state === "overdue";
  return {
    width: "2rem",
    height: "2rem",
    borderRadius: "var(--radius-md)",
    background: urgent
      ? "color-mix(in srgb, var(--color-error) 12%, transparent)"
      : "var(--color-primary-tint)",
    color: urgent ? "var(--color-error)" : "var(--color-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

const rowSubtextStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
