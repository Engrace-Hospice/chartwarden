import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the DISCIPLINE PLANS INDEX (§5.1 #1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CARE_PLAN.md (M07 + M15) — "Use Patient Workspace."
//
// The four-plan grid for one patient: every CoP discipline plan with its status, its next-due clock and
// its last signed version. Reads GET /api/v1/discipline-plans?patientId= (route 1) — the server scopes the
// list, so a plan the caller may not read is simply absent (a non-leaking omission, never a frontend hide).
//
// A kind with no row is rendered as a real, named card, not dropped: the volunteer plan is bootstrapped on
// the FIRST volunteer assignment (§2.2.1), so "not started" is an ordinary state a coordinator must see.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { type PlanListItem, errorMessage, listPlans } from "./discipline-api";
import {
  CADENCE_STATUS_TONE,
  PLAN_STATUS_TONE,
  dueLabel,
  humanize,
  kindLabel,
  kindRegulation,
  shortDate,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Field,
  Notice,
  SummaryGrid,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
} from "./discipline-ui";

/** The §5.1 grid order — the three admission-bootstrapped plans, then the assignment-bootstrapped one. */
const KINDS = ["aide_poc", "msw_plan", "spiritual_plan", "volunteer_plan"] as const;

/** Each kind's own screen route (the §5.1 #2 / #6 / #8 / #9 views). */
const KIND_ROUTE: Record<string, string> = {
  aide_poc: "aide-poc",
  msw_plan: "msw-plan",
  spiritual_plan: "spiritual-plan",
  volunteer_plan: "volunteer-plan",
};

export function DisciplinePlansIndex(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [rows, setRows] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { page, error: err } = await listPlans(client, { patientId, limit: 25 });
    if (err) {
      setError(errorMessage(err, "The discipline plans for this patient could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const overdue = rows.filter(
    (r) => r.nextSupervisoryDueAt !== null && Date.parse(r.nextSupervisoryDueAt) < Date.now(),
  );

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Discipline plans</span>}
        breadcrumb="Clinical — the four CoP discipline plans of care"
        actions={
          <Link to={`/patients/${patientId}/discipline-plans/summary`} style={ghostButtonStyle}>
            Printable summary
          </Link>
        }
      />

      {overdue.length > 0 ? (
        <Notice tone="error">
          {overdue.length === 1 ? "One plan is" : `${overdue.length} plans are`} past the 42 CFR
          §418.76(h) supervisory due date. Past the grace mark a new aide visit cannot be signed
          without a documented Clinical-Supervisor override.
        </Notice>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
          gap: t.space4,
        }}
      >
        {KINDS.map((kind) => {
          const plan = byKind.get(kind);
          return (
            <Card
              key={kind}
              title={kindLabel(kind)}
              actions={
                plan ? (
                  <StatusPill
                    label={humanize(plan.status)}
                    tone={toneOf(PLAN_STATUS_TONE, plan.status)}
                  />
                ) : (
                  <StatusPill label="Not started" tone="neutral" />
                )
              }
            >
              <span style={mutedStyle}>{kindRegulation(kind)}</span>
              {plan ? (
                <>
                  <SummaryGrid>
                    <Field
                      label="Initial assessment"
                      value={
                        plan.initialAssessmentSignedAt
                          ? `signed ${shortDate(plan.initialAssessmentSignedAt)}`
                          : plan.initialAssessmentClockStartedAt
                            ? `clock started ${shortDate(plan.initialAssessmentClockStartedAt)}`
                            : "not started"
                      }
                    />
                    {kind === "aide_poc" ? (
                      <Field
                        label="Next supervisory visit"
                        value={
                          plan.nextSupervisoryDueAt ? (
                            <StatusPill
                              label={`${shortDate(plan.nextSupervisoryDueAt)} · ${dueLabel(plan.nextSupervisoryDueAt)}`}
                              tone={
                                Date.parse(plan.nextSupervisoryDueAt) < Date.now()
                                  ? toneOf(CADENCE_STATUS_TONE, "overdue")
                                  : toneOf(CADENCE_STATUS_TONE, "on_time")
                              }
                            />
                          ) : (
                            "not armed"
                          )
                        }
                      />
                    ) : null}
                    {kind === "spiritual_plan" && plan.spiritualCareDeclinedAt ? (
                      <Field
                        label="Spiritual care"
                        value={`declined ${shortDate(plan.spiritualCareDeclinedAt)}`}
                      />
                    ) : null}
                    <Field label="Last updated" value={shortDate(plan.updatedAt)} />
                  </SummaryGrid>
                  <div style={{ display: "flex", gap: t.space3, flexWrap: "wrap" }}>
                    <Link
                      to={`/patients/${patientId}/discipline-plans/${KIND_ROUTE[kind]}`}
                      style={linkStyle}
                    >
                      Open plan
                    </Link>
                    <Link
                      to={`/patients/${patientId}/discipline-plans/${kind}/versions`}
                      style={linkStyle}
                    >
                      Version history
                    </Link>
                  </div>
                </>
              ) : (
                <span style={mutedStyle}>
                  {kind === "volunteer_plan"
                    ? "A volunteer plan is created with the first volunteer assignment (§2.2.1)."
                    : "This plan is created when the admission is activated. It is not on this patient's record yet."}
                </span>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
