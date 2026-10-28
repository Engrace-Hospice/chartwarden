// apps/web/src/modules/16-bereavement — the COUNSELOR CASELOAD DASHBOARD (§5.1 #1 + #17, Track B /
// ADR-0030). Spec: docs/design/screens/clinical — "Use Worklist."
//
// Two reads compose this screen: route 30 (`/dashboard/counselor` — the caller's OWN caseload plus what is
// coming due; the counselor id comes from the session, never from a query param, so there is no
// "show me someone else's caseload" shape to abuse) and route 1 (the plan worklist itself, for the roster
// rows and their risk tiers).
//
// §5.1 #17 — the anniversary banner is derived from each plan's DEATH DATE, not from the presence of an
// anniversary-marked outreach row. Deriving it from the schedule would make the banner disappear exactly
// when a counselor cancelled the anniversary touchpoint and most needs reminding to re-schedule it.
import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  interactiveRowProps,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CounselorDashboard as CounselorDashboardView,
  type PlanListItem,
  errorMessage,
  getCounselorDashboard,
  listPlans,
} from "./bereavement-api";
import {
  PLAN_STATUS_TONE,
  anniversaryCountdown,
  dueLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Field,
  Notice,
  RiskTierPill,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
} from "./bereavement-ui";

const HORIZONS = [
  { value: "7", label: "next 7 days" },
  { value: "14", label: "next 14 days" },
  { value: "30", label: "next 30 days" },
  { value: "90", label: "next 90 days" },
];

const BEREAVEMENT_PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

type RiskFilter = "all" | "low" | "moderate" | "high" | "complicated" | "unscored" | "withheld";
type StatusFilter = "all" | PlanListItem["status"];

const thStyle: CSSProperties = {
  padding: "0.625rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  color: "var(--color-on-surface)",
  verticalAlign: "middle",
};

const drawerGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.75rem",
};

const drawerSectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const drawerLabelStyle: CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

const drawerActionStyle: CSSProperties = {
  ...ghostButtonStyle,
  display: "flex",
  justifyContent: "center",
};

export function BereavementCounselorDashboard(): JSX.Element {
  const client = useApiClient();
  const [horizon, setHorizon] = useState("14");
  const [view, setView] = useState<CounselorDashboardView | null>(null);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [dash, worklist] = await Promise.all([
      getCounselorDashboard(client, { dueWithinDays: Number(horizon), limit: 100 }),
      listPlans(client, { limit: 50 }),
    ]);
    if (dash.error) {
      setError(errorMessage(dash.error, "Your bereavement caseload could not be loaded."));
      setLoading(false);
      return;
    }
    setView(dash.view);
    setPlans(worklist.page?.data ?? []);
    setLoading(false);
  }, [client, horizon]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!view)
    return <EmptyState title="No caseload" description="No bereavement caseload was returned." />;

  // §5.1 #17 — every plan inside the 30/14/7-day pre-anniversary marks, soonest first.
  const anniversaries = plans
    .map((p) => ({ plan: p, countdown: anniversaryCountdown(p.deathDate) }))
    .filter(
      (r): r is { plan: PlanListItem; countdown: { days: number; mark: 30 | 14 | 7 } } =>
        r.countdown !== null,
    )
    .sort((a, b) => a.countdown.days - b.countdown.days);

  const tiers = Object.entries(view.tierDistribution).map(([tier, value]) => ({
    label: humanize(tier),
    value,
  }));

  const hasActiveFilters = searchQuery !== "" || statusFilter !== "all" || riskFilter !== "all";
  const filteredPlans = plans.filter((p) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !q ||
      shortId(p.planId).toLowerCase().includes(q) ||
      p.planId.toLowerCase().includes(q) ||
      shortDate(p.deathDate).toLowerCase().includes(q);

    const matchesStatus = statusFilter === "all" || p.status === statusFilter;
    const matchesRisk =
      riskFilter === "all" ||
      (riskFilter === "unscored" && p.currentRiskTier === null) ||
      (riskFilter === "withheld" && p.currentRiskTier === undefined) ||
      p.currentRiskTier === riskFilter;

    return matchesSearch && matchesStatus && matchesRisk;
  });
  const pageCount = Math.max(1, Math.ceil(filteredPlans.length / pageSize));
  const activePage = Math.min(page, pageCount);
  const pagedPlans = filteredPlans.slice((activePage - 1) * pageSize, activePage * pageSize);
  const selectedPlan = plans.find((p) => p.planId === selectedPlanId) ?? null;

  const overduePlanCount = plans.filter((p) => p.overdueOutreachCount > 0).length;
  const dueSoonPlanIds = new Set(view.dueSoon.map((o) => o.planId));
  const dueSoonPlanCount = plans.filter((p) => dueSoonPlanIds.has(p.planId)).length;
  const riskAttentionCount = plans.filter(
    (p) => p.currentRiskTier === "high" || p.currentRiskTier === "complicated",
  ).length;

  const clearFilters = (): void => {
    setSearchQuery("");
    setStatusFilter("all");
    setRiskFilter("all");
    setPage(1);
  };

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="My bereavement caseload"
          actions={
            <Link to="/bereavement/eligible" style={ghostButtonStyle}>
              Intake queue
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Track survivor follow-up, due touchpoints, risk tiers, and 13-month window milestones.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Open Plans"
            value={view.caseloadCount}
            detail="Assigned caseload"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Overdue"
            value={view.overdue.length}
            detail={`${overduePlanCount} plans affected`}
            tone={view.overdue.length > 0 ? "danger" : "neutral"}
            accentColor={
              view.overdue.length > 0 ? "var(--color-error)" : "var(--color-outline-variant)"
            }
            onSelect={() => {
              setSearchQuery("");
              setRiskFilter("all");
              setStatusFilter("all");
              setPage(1);
            }}
          />
          <KpiCard
            label="Due Soon"
            value={view.dueSoon.length}
            detail={`${dueSoonPlanCount} plans in ${view.dueWithinDays} days`}
            tone={view.dueSoon.length > 0 ? "warning" : "neutral"}
            accentColor={
              view.dueSoon.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="High Risk"
            value={riskAttentionCount}
            detail="High or complicated"
            tone={riskAttentionCount > 0 ? "warning" : "neutral"}
            accentColor={
              riskAttentionCount > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
            }
            onSelect={() => {
              setRiskFilter("high");
              setSearchQuery("");
              setStatusFilter("all");
              setPage(1);
            }}
          />
          <KpiCard
            label="Risk Mix"
            value={tiers.reduce((sum, tier) => sum + tier.value, 0)}
            detail={`${tiers.length} tiers represented`}
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
          {view.externalSourceCosignPendingCount > 0 ? (
            <Notice tone="warning">
              {view.externalSourceCosignPendingCount === 1
                ? "One plan on your caseload is"
                : `${view.externalSourceCosignPendingCount} plans on your caseload are`}{" "}
              awaiting the medical-director cosign on an external (HL7 ADT) death notice. Counselor
              first contact stays locked on those plans until the cosign is received.
            </Notice>
          ) : null}

          {anniversaries.slice(0, 3).map(({ plan, countdown }) => (
            <Notice key={plan.planId} tone="warning" live>
              Anniversary of death for plan {shortId(plan.planId)} is in {countdown.days}{" "}
              {countdown.days === 1 ? "day" : "days"} ({countdown.mark}-day mark).{" "}
              <Link to={`/bereavement/plans/${plan.planId}/outreach`} style={linkStyle}>
                Schedule the anniversary contact
              </Link>
            </Notice>
          ))}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <label className="wx-search-field">
                <Glyph name="search" size={16} />
                <input
                  type="search"
                  placeholder="Search plans by ID or death date..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Search bereavement plans"
                />
              </label>

              <label className="wx-filter-field">
                <span>Due</span>
                <select
                  className="wx-select"
                  value={horizon}
                  onChange={(e) => {
                    setHorizon(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Due horizon"
                  style={{ height: "2.25rem", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  {HORIZONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="wx-filter-field">
                <span>Status</span>
                <select
                  className="wx-select"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as StatusFilter);
                    setPage(1);
                  }}
                  aria-label="Filter by plan status"
                >
                  <option value="all">All</option>
                  <option value="eligible">Eligible</option>
                  <option value="initiating">Initiating</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="closed_completed">Closed completed</option>
                  <option value="closed_declined">Closed declined</option>
                  <option value="closed_skipped">Closed skipped</option>
                  <option value="closed_legal_hold_extended">Legal hold</option>
                </select>
              </label>

              <label className="wx-filter-field">
                <span>Risk</span>
                <select
                  className="wx-select"
                  value={riskFilter}
                  onChange={(e) => {
                    setRiskFilter(e.target.value as RiskFilter);
                    setPage(1);
                  }}
                  aria-label="Filter by risk tier"
                >
                  <option value="all">All</option>
                  <option value="low">Low</option>
                  <option value="moderate">Moderate</option>
                  <option value="high">High</option>
                  <option value="complicated">Complicated</option>
                  <option value="unscored">Not yet scored</option>
                  <option value="withheld">Not disclosed</option>
                </select>
              </label>

              {hasActiveFilters ? (
                <Button size="sm" tone="tertiary" onClick={clearFilters}>
                  Clear
                </Button>
              ) : null}
            </div>

            <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
              {filteredPlans.length} of {plans.length} plans
            </span>
          </div>
        </div>
      }
      table={
        plans.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No bereavement plans assigned"
              description="Your bereavement caseload does not have assigned plans right now."
            />
          </div>
        ) : filteredPlans.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No matching plans"
              description="Try adjusting your search criteria or clearing active filters."
              action={
                <Button tone="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
            <PlanTable
              rows={pagedPlans}
              selectedPlanId={selectedPlanId}
              onSelectPlan={setSelectedPlanId}
            />
            <OffsetPagination
              page={activePage}
              pageSize={pageSize}
              totalItems={filteredPlans.length}
              onPageChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              }}
              pageSizeOptions={BEREAVEMENT_PAGE_SIZES}
              noun="plans"
            />
          </div>
        )
      }
      detail={
        selectedPlan ? (
          <RightDetailPanel
            open={selectedPlan !== null}
            title="Plan Summary"
            onClose={() => setSelectedPlanId(null)}
            hideScrollbar
          >
            <PlanDrawerContent plan={selectedPlan} />
          </RightDetailPanel>
        ) : null
      }
      fullPageScroll
    />
  );
}

function PlanTable({
  rows,
  selectedPlanId,
  onSelectPlan,
}: {
  rows: PlanListItem[];
  selectedPlanId: string | null;
  onSelectPlan: (planId: string) => void;
}): JSX.Element {
  return (
    <table
      style={{ display: "table", width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}
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
          <th style={{ ...thStyle, width: "24%" }}>Plan</th>
          <th style={{ ...thStyle, width: "13%" }}>Status</th>
          <th style={{ ...thStyle, width: "13%" }}>Risk</th>
          <th style={{ ...thStyle, width: "14%" }}>Death date</th>
          <th style={{ ...thStyle, width: "18%" }}>Next due</th>
          <th style={{ ...thStyle, width: "9%", textAlign: "right" }}>Contacts</th>
          <th style={{ ...thStyle, width: "9%", textAlign: "right" }}>Overdue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const isSelected = selectedPlanId === p.planId;
          return (
            <tr
              key={p.planId}
              {...interactiveRowProps(() => onSelectPlan(p.planId), isSelected, true)}
              className="wx-data-row-interactive"
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
                background: isSelected ? "var(--color-primary-tint)" : "transparent",
                cursor: "pointer",
                transition: "background 0.15s ease",
              }}
            >
              <td style={tdStyle}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <Link
                    to={`/bereavement/plans/${p.planId}`}
                    style={{ ...linkStyle, fontWeight: 600 }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {shortId(p.planId)}
                  </Link>
                  {p.externalSourceCosignPending ? (
                    <span style={mutedStyle}>Pending medical-director cosign</span>
                  ) : null}
                </div>
              </td>
              <td style={tdStyle}>
                <StatusPill label={humanize(p.status)} tone={toneOf(PLAN_STATUS_TONE, p.status)} />
              </td>
              <td style={tdStyle}>
                <RiskTierPill tier={p.currentRiskTier} />
              </td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {shortDate(p.deathDate)}
              </td>
              <td style={tdStyle}>
                {p.nextOutreachDueAt ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                    <span>{shortDate(p.nextOutreachDueAt)}</span>
                    <span style={mutedStyle}>{dueLabel(p.nextOutreachDueAt)}</span>
                  </div>
                ) : (
                  "—"
                )}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {p.contactsActiveCount}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {p.overdueOutreachCount > 0 ? (
                  <StatusPill label={String(p.overdueOutreachCount)} tone="error" glyph="alert" />
                ) : (
                  "0"
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PlanDrawerContent({ plan }: { plan: PlanListItem }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <StatusPill label={humanize(plan.status)} tone={toneOf(PLAN_STATUS_TONE, plan.status)} />
          <RiskTierPill tier={plan.currentRiskTier} />
        </div>
        <code style={{ fontFamily: t.fontMono, fontSize: "0.75rem", color: t.onSurfaceVariant }}>
          {plan.planId}
        </code>
      </div>

      <div style={drawerGridStyle}>
        <Field label="Death date" value={shortDate(plan.deathDate)} />
        <Field label="Window ends" value={shortDate(plan.windowEndsAt)} />
        <Field label="Active contacts" value={plan.contactsActiveCount} />
        <Field label="Overdue touchpoints" value={plan.overdueOutreachCount} />
      </div>

      <div style={drawerSectionStyle}>
        <span style={drawerLabelStyle}>Next due</span>
        <span style={{ color: "var(--color-on-surface)", fontSize: "0.875rem" }}>
          {plan.nextOutreachDueAt
            ? `${shortDate(plan.nextOutreachDueAt)} · ${dueLabel(plan.nextOutreachDueAt)}`
            : "No scheduled touchpoint"}
        </span>
      </div>

      {plan.externalSourceCosignPending ? (
        <Notice tone="warning">
          Counselor first contact is locked until external-source cosign.
        </Notice>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Link to={`/bereavement/plans/${plan.planId}`} style={drawerActionStyle}>
          Open plan
        </Link>
        <Link to={`/bereavement/plans/${plan.planId}/outreach`} style={drawerActionStyle}>
          Open planner
        </Link>
        <Link to={`/bereavement/plans/${plan.planId}/risk`} style={drawerActionStyle}>
          Review risk
        </Link>
      </div>
    </div>
  );
}
