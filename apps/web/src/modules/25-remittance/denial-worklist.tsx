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
// apps/web/src/modules/25-remittance — M25, the DENIAL WORKLIST (R2, §5 / §1.1). The operational heart: the
// CARC/RARC denial cases with their plain-language action, assignee, aging bucket, and dollar value. Reads
// are org-scoped + provider-scoped server-side (RLS + provider_entity_scope); the server is the only authz
// point (ADR-0030). Lantern: WorkQueueLayout + FilterBar + No-Line table + §6.6 aging/category/state pills.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  AGING_BUCKET_TONE,
  DENIAL_CATEGORY_TONE,
  DENIAL_STATE_TONE,
  humanize,
  money,
  toneOf,
} from "./remittance-status";

interface DenialRow {
  id: string;
  carcCode: string;
  rarcCode: string | null;
  category: string;
  source: string;
  state: string;
  assigneeMembershipId: string | null;
  agingBucketLabel: string;
  dollarValue: string;
  taxonomyStatus: string;
}

const STATE_FILTERS = ["all", "open", "in_progress", "escalated", "appealed", "resolved", "closed"];
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

export function DenialWorklist(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DenialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/denials");
    if (res.error) {
      setError("Denial worklist unavailable — you may lack provider scope.");
      setLoading(false);
      return;
    }
    setRows(res.data?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((r) => {
      const matchesState = stateFilter === "all" || r.state === stateFilter;
      const matchesSearch =
        !q ||
        [
          r.id,
          r.carcCode,
          r.rarcCode ?? "",
          r.category,
          r.source,
          r.state,
          r.assigneeMembershipId ?? "",
          r.agingBucketLabel,
          r.dollarValue,
          r.taxonomyStatus,
        ].some((value) => value.toLowerCase().includes(q));
      return matchesState && matchesSearch;
    });
  }, [rows, searchQuery, stateFilter]);
  const openValue = useMemo(
    () =>
      rows
        .filter((r) => r.state === "open" || r.state === "in_progress" || r.state === "escalated")
        .reduce((n, r) => n + Number(r.dollarValue), 0),
    [rows],
  );
  const openCount = rows.filter((r) => r.state !== "resolved" && r.state !== "closed").length;
  const escalatedCount = rows.filter((r) => r.state === "escalated").length;
  const agedCount = rows.filter((r) => r.agingBucketLabel === "91+").length;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = visible.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || stateFilter !== "all";

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Denials" breadcrumb="Revenue Cycle — Worklist">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Prioritize CARC/RARC denial cases by state, aging, category, assignee, and dollars at
            risk.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Total Cases"
            value={loading || error ? "—" : rows.length}
            detail="All states"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Open"
            value={loading || error ? "—" : openCount}
            detail="Incl. escalated"
            tone={openCount > 0 ? "warning" : "neutral"}
            accentColor={openCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Open At Risk"
            value={loading || error ? "—" : money(openValue)}
            detail="Unresolved value"
            tone={openValue > 0 ? "warning" : "neutral"}
            accentColor={openValue > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Escalated"
            value={loading || error ? "—" : escalatedCount}
            detail="Needs action"
            tone={escalatedCount > 0 ? "danger" : "neutral"}
            accentColor={escalatedCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
            selected={stateFilter === "escalated"}
            onSelect={() => {
              setStateFilter("escalated");
              setPage(1);
            }}
          />
          <KpiCard
            label="91+ Days"
            value={loading || error ? "—" : agedCount}
            detail="Oldest bucket"
            tone={agedCount > 0 ? "danger" : "neutral"}
            accentColor={agedCount > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
        </KpiStrip>
      }
      filters={
        <div style={filterPanelStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <div style={{ position: "relative", minWidth: "16rem" }}>
              <input
                type="search"
                placeholder="Search CARC, RARC, source, assignee..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search denials"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>State</span>
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => {
                  setStateFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {STATE_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All states" : humanize(s)}
                  </option>
                ))}
              </select>
            </label>
            {hasActiveFilters ? (
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setSearchQuery("");
                  setStateFilter("all");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {visible.length} of {rows.length} denials
            </span>
          </div>
        </div>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No denials"
              description={
                hasActiveFilters
                  ? "No denial case matches these filters."
                  : "No denial cases are currently open."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setStateFilter("all");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <table style={tableStyle}>
              <thead>
                <tr style={headerRowStyle}>
                  <th style={headStyle}>CARC / RARC</th>
                  <th style={headStyle}>Category</th>
                  <th style={headStyle}>Source</th>
                  <th style={headStyle}>Aging</th>
                  <th style={headNumStyle}>Value</th>
                  <th style={headStyle}>State</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td style={tdCodeStyle}>
                      {r.carcCode}
                      {r.rarcCode ? ` / ${r.rarcCode}` : ""}
                    </td>
                    <td style={cellStyle}>
                      <StatusPill
                        label={humanize(r.category)}
                        tone={toneOf(DENIAL_CATEGORY_TONE, r.category)}
                      />
                    </td>
                    <td style={cellStyle}>{humanize(r.source)}</td>
                    <td style={cellStyle}>
                      <StatusPill
                        label={r.agingBucketLabel}
                        tone={toneOf(AGING_BUCKET_TONE, r.agingBucketLabel)}
                      />
                    </td>
                    <td style={tdNumStyle}>{money(r.dollarValue)}</td>
                    <td style={cellStyle}>
                      <StatusPill
                        label={humanize(r.state)}
                        tone={toneOf(DENIAL_STATE_TONE, r.state)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={visible.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="denials"
            />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.875rem" };
const cellStyle = {
  padding: "0.55rem 0.75rem",
  textAlign: "left" as const,
  verticalAlign: "middle" as const,
  color: "var(--color-on-surface)",
};
const tdCodeStyle = { ...cellStyle, fontVariantNumeric: "tabular-nums" as const };
const tdNumStyle = {
  ...cellStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums" as const,
};
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
const headNumStyle = { ...headStyle, textAlign: "right" as const };
const rowStyle = { borderTop: "1px solid var(--color-surface-container)" };
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const filterPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
};
const filterLabelStyle = { display: "flex", flexDirection: "column" as const, gap: "0.25rem" };
const searchInputStyle = {
  width: "100%",
  paddingLeft: "2rem",
  height: "2.25rem",
  fontSize: "0.85rem",
};
const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};
const selectStyle = {
  height: "2.25rem",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error-pill-fg)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
