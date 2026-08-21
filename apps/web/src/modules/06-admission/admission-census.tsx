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
// apps/web/src/modules/06-admission — Admission Census (M6 §5.2.12 entry, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Work Queue."
// Org-scoped admissions queue read from GET /api/v1/admissions (optional state filter) via the
// generated typed client; a row opens the Admission Detail (§5.2.4). The server enforces every scope
// (ADR-0030 — no authz on the frontend). Reconciled to Lantern (R1): §6.6 status pills, mono ids,
// No-Line table (global index.css styles carry the tokens). Imports only leaves (@wardenx/ui). The
// header's "New admission" link is the entry point into the direct-intake form (TASK-031).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ADMISSION_TONE, stateLabel } from "./admission-status";

interface AdmissionRow {
  id: string;
  state: string;
  version: number;
}

const ADMISSION_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function AdmissionCensus(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [items, setItems] = useState<AdmissionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: { state?: string; cursor?: string; limit?: number } = { limit: 50 };
      if (state) query.state = state;
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/admissions", { params: { query } });
      if (err) {
        setError("Could not load the admission census.");
        setLoading(false);
        return;
      }
      const page = data?.items ?? [];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, state],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = items.filter((a) => {
    const q = searchQuery.trim().toLowerCase();
    return !q || a.id.toLowerCase().includes(q) || a.state.toLowerCase().includes(q);
  });
  const activeCount = items.filter((a) => a.state === "active").length;
  const pendingCount = items.filter(
    (a) => a.state === "pending" || a.state === "notice_of_rights_acknowledged",
  ).length;
  const holdCount = items.filter((a) => a.state === "on_hold").length;
  const dischargedCount = items.filter(
    (a) => a.state === "discharged" || a.state === "bereavement" || a.state === "closed",
  ).length;
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
        <PageHeader
          title="Admissions"
          breadcrumb="Admissions / Census"
          actions={
            <Link to="/admissions/new" style={newAdmissionLink}>
              <Glyph name="check" size={14} />
              <span>New admission</span>
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Monitor admission records from pending intake through active care and discharge.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Active"
            value={activeCount}
            detail="Current census"
            tone="success"
            accentColor="var(--color-success)"
          />
          <KpiCard
            label="Pending"
            value={pendingCount}
            detail="Intake in progress"
            tone={pendingCount > 0 ? "info" : "neutral"}
            accentColor={pendingCount > 0 ? "var(--color-primary)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="On hold"
            value={holdCount}
            detail="Paused records"
            tone={holdCount > 0 ? "warning" : "neutral"}
            accentColor={holdCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Closed flow"
            value={dischargedCount}
            detail="Discharged or closed"
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
                Admissions ({items.length})
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <div style={{ position: "relative", minWidth: "15rem" }}>
                <input
                  type="search"
                  placeholder="Search admissions by ID or state..."
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  aria-label="Search admissions"
                  style={searchInputStyle}
                />
                <div style={searchIconStyle}>
                  <Glyph name="search" size={14} />
                </div>
              </div>
              <select
                aria-label="Admission state"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                <option value="">State: All</option>
                <option value="pending">Pending</option>
                <option value="notice_of_rights_acknowledged">Notice acknowledged</option>
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="discharged">Discharged</option>
                <option value="bereavement">Bereavement</option>
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
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title={hasActiveFilters ? "No matching admissions found" : "No admissions"}
              description={
                hasActiveFilters
                  ? "Try adjusting the search or state filter."
                  : "No admissions match the current filters."
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
            <AdmissionTable
              items={pagedItems}
              loading={loading}
              onOpen={(id) => navigate(`/admissions/${id}`)}
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
              pageSizeOptions={ADMISSION_PAGE_SIZES}
              noun="admissions"
            />
            {nextCursor ? (
              <div
                style={{ display: "flex", justifyContent: "center", padding: "0 1.5rem 1.5rem" }}
              >
                <Button
                  type="button"
                  tone="secondary"
                  size="sm"
                  onClick={() => load(nextCursor)}
                  loading={loading}
                >
                  Load more admissions
                </Button>
              </div>
            ) : null}
          </>
        )
      }
    />
  );
}

function AdmissionTable({
  items,
  loading,
  onOpen,
}: {
  items: AdmissionRow[];
  loading: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
      <table style={tableStyle}>
        <thead>
          <tr style={tableHeadRowStyle}>
            <th style={{ ...thStyle, width: "48%" }}>Admission</th>
            <th style={{ ...thStyle, width: "18%" }}>State</th>
            <th style={{ ...thStyle, width: "18%" }}>Version</th>
            <th style={{ ...thStyle, width: "16%", textAlign: "right" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr
              key={a.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onOpen(a.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onOpen(a.id);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <td style={tdStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                  <div style={rowIconStyle}>
                    <Glyph name="clipboard-check" size={16} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="wx-data-md" style={{ fontWeight: 650 }}>
                      {a.id}
                    </div>
                    <div style={rowSubtextStyle}>Admission record</div>
                  </div>
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={stateLabel(a.state)}
                  tone={ADMISSION_TONE[a.state] ?? "neutral"}
                />
              </td>
              <td className="wx-data-md" style={tdStyle}>
                v{a.version}
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }}>
                <Button
                  size="sm"
                  tone="secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(a.id);
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

const newAdmissionLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.45rem 0.9rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
  gap: "0.4rem",
};

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

const rowIconStyle: CSSProperties = {
  width: "2rem",
  height: "2rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const rowSubtextStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
