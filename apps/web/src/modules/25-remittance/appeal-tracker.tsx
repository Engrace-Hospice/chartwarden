import {
  Button,
  CountdownChip,
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
// apps/web/src/modules/25-remittance — M25, the APPEAL TRACKER (R2, §5 / §1.1). The five-tier Medicare
// appeal hierarchy with its per-tier filing deadline — the §6.6 CountdownChip is the anchor (the most
// expensive billing mistake is a missed 60-day window). Reads org-scoped server-side (RLS); the hard T-0
// submit block is the `appeal_within_deadline` ABAC predicate on the server, surfaced here as the chip tone.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { findStepUpDraftResourceId } from "../../shell/step-up-redirect";
import { APPEAL_DRAFT_ACTION, AppealDetailPanel } from "./appeal-detail-panel";
import { APPEAL_OUTCOME_TONE, APPEAL_STATE_TONE, humanize, toneOf } from "./remittance-status";

interface AppealRow {
  id: string;
  tier: string;
  state: string;
  decisionOutcome: string | null;
  tierDeadlineAt: string;
  /** True on the ALJ case an escalation opened: filed by the QIC forwarding it, so it has no filing deadline. */
  filedByEscalation?: boolean;
}

const TIER_LABEL: Record<string, string> = {
  redetermination: "Redetermination",
  reconsideration: "Reconsideration (QIC)",
  alj: "ALJ Hearing",
  council: "Appeals Council",
  federal_court: "Federal Court",
};

const STATE_FILTERS = [
  "all",
  "draft",
  "submitted",
  "under_review",
  "decided",
  "escalated",
  "withdrawn",
  "closed",
];
const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;
const isOpen = (s: string): boolean => s === "draft" || s === "submitted" || s === "under_review";

export function AppealTracker(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<AppealRow[]>([]);
  const [stateFilter, setStateFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const session = useSession();
  // Coming back from /step-up: reopen the appeal whose typed narrative was stashed.
  const [workingId, setWorkingId] = useState<string | null>(() =>
    findStepUpDraftResourceId(session, APPEAL_DRAFT_ACTION),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/appeals");
    if (res.error) {
      setError("Appeal tracker unavailable — you may lack provider scope.");
      setLoading(false);
      return;
    }
    setRows(res.data?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const tierOptions = useMemo(
    () => [
      { value: "", label: "Any tier" },
      ...Array.from(new Set(rows.map((r) => r.tier)))
        .sort()
        .map((value) => ({ value, label: TIER_LABEL[value] ?? humanize(value) })),
    ],
    [rows],
  );
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows
      .filter((r) => {
        const matchesState = stateFilter === "all" || r.state === stateFilter;
        const matchesTier = !tierFilter || r.tier === tierFilter;
        const matchesSearch =
          !q ||
          [
            r.id,
            r.tier,
            TIER_LABEL[r.tier] ?? "",
            r.state,
            r.decisionOutcome ?? "",
            r.tierDeadlineAt,
          ].some((value) => value.toLowerCase().includes(q));
        return matchesState && matchesTier && matchesSearch;
      })
      .sort((a, b) => a.tierDeadlineAt.localeCompare(b.tierDeadlineAt));
  }, [rows, searchQuery, stateFilter, tierFilter]);

  // A case filed by escalation has no filing deadline to meet, so it never counts as due soon or overdue.
  const open = rows.filter((r) => isOpen(r.state) && !r.filedByEscalation);
  const dueSoon = open.filter(
    (r) => new Date(r.tierDeadlineAt).getTime() - Date.now() < 7 * 86_400_000,
  ).length;
  const overdue = open.filter((r) => new Date(r.tierDeadlineAt).getTime() < Date.now()).length;
  const favorable = rows.filter((r) => r.decisionOutcome === "favorable").length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedRows = filtered.slice((activePage - 1) * pageSize, activePage * pageSize);
  const hasActiveFilters = searchQuery !== "" || stateFilter !== "all" || tierFilter !== "";

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Appeals" breadcrumb="Revenue Cycle — Appeals">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track appeal tiers, filing deadlines, current state, and decision outcomes.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Total Appeals"
            value={loading || error ? "—" : rows.length}
            detail="All tiers"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="In Flight"
            value={loading || error ? "—" : open.length}
            detail="Draft/submitted/review"
            tone={open.length > 0 ? "warning" : "neutral"}
            accentColor={open.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Due ≤ 7 Days"
            value={loading || error ? "—" : dueSoon}
            detail="Open deadlines"
            tone={dueSoon > 0 ? "danger" : "neutral"}
            accentColor={dueSoon > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Overdue"
            value={loading || error ? "—" : overdue}
            detail="Past deadline"
            tone={overdue > 0 ? "danger" : "neutral"}
            accentColor={overdue > 0 ? "var(--color-error)" : "var(--color-outline-variant)"}
          />
          <KpiCard
            label="Favorable"
            value={loading || error ? "—" : favorable}
            detail="Decisions won"
            tone={favorable > 0 ? "success" : "neutral"}
            accentColor={favorable > 0 ? "var(--color-success)" : "var(--color-outline-variant)"}
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
            <label className="wx-search-field">
              <Glyph name="search" size={16} />
              <input
                type="search"
                placeholder="Search tier, state, outcome..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                aria-label="Search appeals"
              />
            </label>
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
            <label style={filterLabelStyle}>
              <span style={mutedStyle}>Tier</span>
              <select
                aria-label="Filter by tier"
                value={tierFilter}
                onChange={(e) => {
                  setTierFilter(e.target.value);
                  setPage(1);
                }}
                style={selectStyle}
              >
                {tierOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
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
                  setTierFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
            <span style={mutedStyle}>
              {filtered.length} of {rows.length} appeals
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
        ) : filtered.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No appeals"
              description={
                hasActiveFilters
                  ? "No appeal case matches these filters."
                  : "No appeal cases have been opened."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery("");
                      setStateFilter("all");
                      setTierFilter("");
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
                  <th style={headStyle}>Tier</th>
                  <th style={headStyle}>State</th>
                  <th style={headStyle}>Outcome</th>
                  <th style={headStyle}>Filing deadline</th>
                  <th style={headStyle}>Work</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r) => (
                  <tr key={r.id} style={rowStyle}>
                    <td style={cellStyle}>{TIER_LABEL[r.tier] ?? humanize(r.tier)}</td>
                    <td style={cellStyle}>
                      <StatusPill
                        label={humanize(r.state)}
                        tone={toneOf(APPEAL_STATE_TONE, r.state)}
                      />
                    </td>
                    <td style={cellStyle}>
                      {r.decisionOutcome ? (
                        <StatusPill
                          label={humanize(r.decisionOutcome)}
                          tone={toneOf(APPEAL_OUTCOME_TONE, r.decisionOutcome)}
                        />
                      ) : (
                        <span style={mutedStyle}>—</span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {r.filedByEscalation ? (
                        <span style={mutedStyle}>Filed by escalation</span>
                      ) : isOpen(r.state) ? (
                        <CountdownChip
                          dueAt={r.tierDeadlineAt}
                          label="files"
                          warnWithinHours={14 * 24}
                          alertWithinHours={3 * 24}
                        />
                      ) : (
                        <span style={mutedStyle}>
                          {new Date(r.tierDeadlineAt).toLocaleDateString()}
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      <Button
                        size="sm"
                        tone="secondary"
                        aria-label={`Open appeal ${TIER_LABEL[r.tier] ?? humanize(r.tier)}`}
                        onClick={() => setWorkingId(r.id)}
                      >
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
              pageSizeOptions={PAGE_SIZES}
              noun="appeals"
            />
          </div>
        )
      }
      detail={
        workingId ? (
          <AppealDetailPanel
            appealId={workingId}
            onClose={() => setWorkingId(null)}
            onChanged={() => void load()}
          />
        ) : null
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
const headStyle = {
  ...cellStyle,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
  fontWeight: 600,
};
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
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
