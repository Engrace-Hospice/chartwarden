import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  OffsetPagination,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Compliance Dashboard (M6 §5.2.11, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md — "Use Dashboard."
// Org-wide compliance windows (F2F / recert / NOR / late-CTI) read from GET /api/v1/compliance-windows
// via the generated typed client; a row deep-links to the owning admission's Compliance tab. The
// server enforces every scope (ADR-0030 — no authz on the frontend). Reconciled to Lantern (R1): §6.6
// status pills (overdue → error tone), mono ids. Lays out as a tab of the Admissions area (shared
// admissions-chrome: sub-tabs, stat cards that filter by state, filter panel, list table).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { WINDOW_TONE, stateLabel } from "./admission-status";
import { AdmissionsTabs, Filter, Stat } from "./admissions-chrome";
import { ADDENDUM_WINDOW_LABEL } from "./election-addendum-format";

interface WindowRow {
  id: string;
  state: string;
  version: number;
  /** The window kind, when the list read carries it (the FY2027 addendum kinds get plain labels). */
  windowKind?: string;
}

/** A window's kind label: the FY2027 addendum windows by name, others humanized, else the generic line. */
export function windowKindLabel(kind?: string): string {
  if (!kind) return "Admission compliance window";
  return ADDENDUM_WINDOW_LABEL[kind] ?? stateLabel(kind);
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
    // State filters client-side so the Open / Overdue / Closed cards keep their totals while one is picked.
    const query: { limit?: number } = { limit: 100 };
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
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = items.filter((w) => w.state === "open").length;
  const overdue = items.filter((w) => w.state === "overdue").length;
  const closed = items.filter((w) => w.state === "closed").length;
  const filtered = items.filter((w) => {
    const q = searchQuery.trim().toLowerCase();
    if (state && w.state !== state) return false;
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

  const pick = (next: string) => {
    setState((cur) => (cur === next ? "" : next));
    setPage(1);
  };

  return (
    <div className="wx-admissions">
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Admissions</h1>
            <p>
              Track admission compliance windows, overdue work, and closed readiness checkpoints.
            </p>
          </div>
        </header>

        <AdmissionsTabs current="/compliance/admissions" />

        <div className="wx-stat-grid" aria-label="Compliance windows summary">
          <Stat
            icon="clock"
            value={open}
            label="Open"
            hint="Active windows"
            onSelect={() => pick("open")}
            selected={state === "open"}
          />
          <Stat
            icon="alert-circle"
            value={overdue}
            label="Overdue"
            hint="Needs attention"
            color={overdue > 0 ? t.error : "var(--color-viz-amber)"}
            onSelect={() => pick("overdue")}
            selected={state === "overdue"}
          />
          <Stat
            icon="check-circle"
            value={closed}
            label="Closed"
            hint="Completed windows"
            color={t.success}
            onSelect={() => pick("closed")}
            selected={state === "closed"}
          />
          <Stat
            icon="filter"
            value={filtered.length}
            label="In View"
            hint="After filters"
            color="var(--color-viz-violet)"
          />
        </div>

        <div className="wx-filter-panel">
          <label className="wx-search-field">
            <Glyph name="search" size={16} />
            <input
              type="search"
              placeholder="Search windows by ID or state…"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setPage(1);
              }}
              aria-label="Search compliance windows"
            />
          </label>
          <Filter
            label="State"
            value={state}
            onChange={(v) => {
              setState(v);
              setPage(1);
            }}
            ariaLabel="Window state"
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="overdue">Overdue</option>
            <option value="closed">Closed</option>
          </Filter>
          {hasActiveFilters ? (
            <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
              <Glyph name="filter" size={15} /> Clear
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Compliance windows unavailable" description={error} />
            <button type="button" className="wx-btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : filtered.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title={
                hasActiveFilters ? "No matching compliance windows found" : "No compliance windows"
              }
              description={
                hasActiveFilters
                  ? "Try adjusting the search or state filter."
                  : "Windows open as admissions reach their compliance checkpoints."
              }
            />
            {hasActiveFilters ? (
              <button type="button" className="wx-btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <section
            className="wx-list-table-wrap"
            aria-label="Compliance windows"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard-focusable (axe scrollable-region-focusable).
            tabIndex={0}
          >
            <WindowTable items={pagedItems} />
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
          </section>
        )}
      </div>
    </div>
  );
}

function WindowTable({ items }: { items: WindowRow[] }): JSX.Element {
  return (
    <table className="wx-list-table">
      <caption className="wx-sr-only">Compliance windows</caption>
      <thead>
        <tr>
          <th scope="col" style={{ width: "58%" }}>
            Window
          </th>
          <th scope="col" style={{ width: "22%" }}>
            State
          </th>
          <th scope="col" style={{ width: "20%" }}>
            Version
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => (
          <tr key={w.id} style={{ cursor: "default" }}>
            <td>
              <span style={{ display: "flex", alignItems: "center", gap: "0.625rem", minWidth: 0 }}>
                <span style={rowIconStyle(w.state)} aria-hidden>
                  <Glyph name={w.state === "overdue" ? "alert" : "clock"} size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="wx-row-title wx-data-md" style={{ cursor: "default" }}>
                    {w.id}
                  </span>
                  <span className="wx-row-sub">{windowKindLabel(w.windowKind)}</span>
                </span>
              </span>
            </td>
            <td>
              <StatusPill label={stateLabel(w.state)} tone={WINDOW_TONE[w.state] ?? "neutral"} />
            </td>
            <td className="wx-nums">v{w.version}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
