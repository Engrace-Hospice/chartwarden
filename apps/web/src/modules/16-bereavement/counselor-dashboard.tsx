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
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type CounselorDashboard as CounselorDashboardView,
  type PlanListItem,
  errorMessage,
  getCounselorDashboard,
  listPlans,
} from "./bereavement-api";
import {
  OUTREACH_STATUS_TONE,
  PLAN_STATUS_TONE,
  anniversaryCountdown,
  dueLabel,
  humanize,
  outreachKindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  CountGrid,
  Field,
  FilterRow,
  Notice,
  RiskTierPill,
  SelectField,
  SummaryGrid,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./bereavement-ui";

const HORIZONS = [
  { value: "7", label: "next 7 days" },
  { value: "14", label: "next 14 days" },
  { value: "30", label: "next 30 days" },
  { value: "90", label: "next 90 days" },
];

export function BereavementCounselorDashboard(): JSX.Element {
  const client = useApiClient();
  const [horizon, setHorizon] = useState("14");
  const [view, setView] = useState<CounselorDashboardView | null>(null);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>My bereavement caseload</span>}
        breadcrumb="Bereavement — 42 CFR §418.64(d) survivor follow-up"
        actions={
          <Link to="/bereavement/eligible" style={ghostButtonStyle}>
            Intake queue
          </Link>
        }
      />

      {view.externalSourceCosignPendingCount > 0 ? (
        <Notice tone="warning">
          {view.externalSourceCosignPendingCount === 1
            ? "One plan on your caseload is"
            : `${view.externalSourceCosignPendingCount} plans on your caseload are`}{" "}
          awaiting the medical-director cosign on an external (HL7 ADT) death notice. Counselor
          first contact stays locked on those plans until the cosign is received.
        </Notice>
      ) : null}

      {anniversaries.map(({ plan, countdown }) => (
        <Notice key={plan.planId} tone="warning" live>
          Anniversary of death for plan {shortId(plan.planId)} is in {countdown.days}{" "}
          {countdown.days === 1 ? "day" : "days"} ({countdown.mark}-day mark).{" "}
          <Link to={`/bereavement/plans/${plan.planId}/outreach`} style={linkStyle}>
            Schedule the anniversary contact
          </Link>
        </Notice>
      ))}

      <FilterRow>
        <SelectField label="Due horizon" value={horizon} options={HORIZONS} onChange={setHorizon} />
      </FilterRow>

      <Card title="Caseload">
        <SummaryGrid>
          <Field label="Open plans" value={view.caseloadCount} />
          <Field label="Due horizon" value={`${view.dueWithinDays} days`} />
          <Field label="Due soon" value={view.dueSoon.length} />
          <Field label="Overdue" value={view.overdue.length} />
        </SummaryGrid>
        <span style={mutedStyle}>Risk-tier distribution across your caseload</span>
        <CountGrid entries={tiers} />
      </Card>

      <OutreachTable
        title="Overdue touchpoints"
        empty="Nothing on your caseload is past its due date."
        rows={view.overdue}
        tone="error"
      />
      <OutreachTable
        title={`Due in the next ${view.dueWithinDays} days`}
        empty="Nothing is coming due in this window."
        rows={view.dueSoon}
      />

      <Card title="My plans">
        {plans.length === 0 ? (
          <span style={mutedStyle}>No bereavement plans are assigned to you.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Plan</th>
                <th style={th}>Status</th>
                <th style={th}>Death date</th>
                <th style={th}>Risk</th>
                <th style={thNum}>Active contacts</th>
                <th style={th}>Next due</th>
                <th style={thNum}>Overdue</th>
                <th style={th}>Window ends</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.planId} style={rowLine}>
                  <td style={td}>
                    <Link to={`/bereavement/plans/${p.planId}`} style={linkStyle}>
                      {shortId(p.planId)}
                    </Link>
                    {p.externalSourceCosignPending ? (
                      <div style={mutedStyle}>Pending medical-director cosign</div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(p.status)}
                      tone={toneOf(PLAN_STATUS_TONE, p.status)}
                    />
                  </td>
                  <td style={td}>{shortDate(p.deathDate)}</td>
                  <td style={td}>
                    <RiskTierPill tier={p.currentRiskTier} />
                  </td>
                  <td style={tdNum}>{p.contactsActiveCount}</td>
                  <td style={td}>
                    {p.nextOutreachDueAt
                      ? `${shortDate(p.nextOutreachDueAt)} · ${dueLabel(p.nextOutreachDueAt)}`
                      : "—"}
                  </td>
                  <td style={tdNum}>{p.overdueOutreachCount}</td>
                  <td style={td}>{shortDate(p.windowEndsAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** The shared due/overdue touchpoint table — one vocabulary for both queues. */
function OutreachTable({
  title,
  empty,
  rows,
  tone,
}: {
  title: string;
  empty: string;
  rows: {
    outreachId: string;
    planId: string;
    contactId: string;
    kind: string;
    status: string;
    dueAt: string;
  }[];
  tone?: "error";
}): JSX.Element {
  return (
    <Card
      title={title}
      actions={
        rows.length > 0 && tone === "error" ? (
          <StatusPill label={`${rows.length} overdue`} tone="error" />
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <span style={mutedStyle}>{empty}</span>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Due</th>
              <th style={th}>Kind</th>
              <th style={th}>Status</th>
              <th style={th}>Plan</th>
              <th style={th}>Contact</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.outreachId} style={rowLine}>
                <td style={td}>
                  {shortDate(o.dueAt)}
                  <div style={{ ...mutedStyle, color: t.onSurfaceVariant }}>
                    {dueLabel(o.dueAt)}
                  </div>
                </td>
                <td style={td}>{outreachKindLabel(o.kind)}</td>
                <td style={td}>
                  <StatusPill
                    label={humanize(o.status)}
                    tone={toneOf(OUTREACH_STATUS_TONE, o.status)}
                  />
                </td>
                <td style={td}>
                  <Link to={`/bereavement/plans/${o.planId}`} style={linkStyle}>
                    {shortId(o.planId)}
                  </Link>
                </td>
                <td style={td}>{shortId(o.contactId)}</td>
                <td style={td}>
                  <Link to={`/bereavement/plans/${o.planId}/outreach`} style={linkStyle}>
                    Open planner
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
