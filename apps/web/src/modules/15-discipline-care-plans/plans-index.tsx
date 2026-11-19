import {
  Button,
  EmptyState,
  LoadingSpinner,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the DISCIPLINE PLANS INDEX (§5.1 #1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_CARE_PLAN.md (M07 + M15) — "Use Patient Workspace."
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
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import { type PlanListItem, errorMessage, listPlans, openPlanVersion } from "./discipline-api";
import {
  disciplinePlanPath,
  openVersionIntent,
  overviewPresentation,
} from "./discipline-navigation";
import {
  CADENCE_STATUS_TONE,
  dueLabel,
  kindLabel,
  kindRegulation,
  shortDate,
  toneOf,
} from "./discipline-status";
import {
  Field,
  Notice,
  SummaryGrid,
  columnStyle,
  linkStyle,
  pageTitleStyle,
} from "./discipline-ui";

/** The §5.1 grid order — the three admission-bootstrapped plans, then the assignment-bootstrapped one. */
const KINDS = ["aide_poc", "msw_plan", "spiritual_plan", "volunteer_plan"] as const;

export function DisciplinePlansIndex(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [rows, setRows] = useState<PlanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingPlanId, setOpeningPlanId] = useState<string | null>(null);
  const canAuthor = useSession()?.permissions?.includes("discipline_plan.author") === true;

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { page, error: err } = await listPlans(client, {
      patientId,
      limit: 25,
    });
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

  const openVersion = async (plan: PlanListItem): Promise<void> => {
    const kind = openVersionIntent(plan);
    if (!kind || openingPlanId !== null) return;
    setOpeningPlanId(plan.planId);
    setActionError(null);
    const result = await openPlanVersion(client, plan.planId, plan.version, { kind });
    if (result.error) {
      setActionError(
        errorMessage(result.error, "The plan version could not be opened. Reload and try again."),
      );
      setOpeningPlanId(null);
      return;
    }
    await load();
    setOpeningPlanId(null);
  };

  // The shared chart banner and Patient Summary rail, so this tab shows the same identity header as
  // every other chart tab (Plan of care, Assessments, ...).
  const identity = useChartIdentity(patientId);
  const banner = (
    <ChartPatientBanner
      patientId={patientId}
      identity={identity}
      actions={
        <Link to={`/patients/${patientId}/discipline-plans/summary`} className="wx-btn-secondary">
          Printable summary
        </Link>
      }
    />
  );
  const rail = <PatientSummaryPanel identity={identity} />;
  // While loading or on an error the page has no title of its own yet, so the patient's name is its heading.
  const bailBanner = <ChartPatientBanner patientId={patientId} identity={identity} nameAsHeading />;

  if (loading) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="discipline-plans">
        <LoadingSpinner />
      </PatientChartBail>
    );
  }

  if (error) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="discipline-plans">
        <EmptyState title="Unavailable" description={error} />
      </PatientChartBail>
    );
  }

  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const overdue = rows.filter(
    (r) => r.nextSupervisoryDueAt !== null && Date.parse(r.nextSupervisoryDueAt) < Date.now(),
  );

  return (
    <PatientWorkspaceLayout banner={banner} rail={rail}>
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
        }}
      >
        <ChartModuleRail patientId={patientId ?? ""} current="discipline-plans" />

        <section
          aria-labelledby="discipline-plans-title"
          style={{
            ...columnStyle,
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            padding: t.space6,
          }}
        >
          <div>
            <h1 id="discipline-plans-title" style={pageTitleStyle}>
              Discipline plans
            </h1>
            <span className="wx-text-muted">
              The Aide, MSW, Spiritual and Volunteer plans of care for this patient.
            </span>
          </div>

          {overdue.length > 0 ? (
            <Notice tone="error">
              {overdue.length === 1 ? "One plan is" : `${overdue.length} plans are`} past the 42 CFR
              §418.76(h) supervisory due date. Past the grace mark a new aide visit cannot be signed
              without a documented Clinical-Supervisor override.
            </Notice>
          ) : null}

          {actionError ? <Notice tone="error">{actionError}</Notice> : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(20rem, 100%), 1fr))",
              gap: t.space4,
            }}
          >
            {KINDS.map((kind) => {
              const plan = byKind.get(kind);
              const presentation = overviewPresentation(kind, plan);
              const versionIntent = plan ? openVersionIntent(plan) : null;
              return (
                <Panel
                  stack
                  key={kind}
                  title={kindLabel(kind)}
                  headingLevel={2}
                  action={
                    plan ? (
                      <StatusPill label={presentation.statusLabel} tone={presentation.statusTone} />
                    ) : (
                      <StatusPill label={presentation.statusLabel} tone={presentation.statusTone} />
                    )
                  }
                >
                  <span className="wx-text-muted">{kindRegulation(kind)}</span>
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
                        <Field label="Next action" value={presentation.nextAction} />
                        <Field
                          label="Latest signed version"
                          value={
                            plan.actionSummary.latestSignedVersion
                              ? `v${plan.actionSummary.latestSignedVersion.sequence} · ${shortDate(plan.actionSummary.latestSignedVersion.signedAt)}`
                              : "none"
                          }
                        />
                        <Field
                          label="Assigned team"
                          value={
                            plan.actionSummary.ownerMembershipIds.length > 0
                              ? `${plan.actionSummary.ownerMembershipIds.length} assigned`
                              : "not assigned"
                          }
                        />
                        {plan.actionSummary.missingSignerRoles.length > 0 ? (
                          <Field
                            label="Signatures still needed"
                            value={plan.actionSummary.missingSignerRoles
                              .map((role) => role.replaceAll("_", " "))
                              .join(", ")}
                          />
                        ) : null}
                        {plan.actionSummary.idgDecisionId ? (
                          <Field label="IDG provenance" value="Decision linked" />
                        ) : null}
                        <Field label="Last updated" value={shortDate(plan.updatedAt)} />
                      </SummaryGrid>
                      <div
                        style={{
                          display: "flex",
                          gap: t.space3,
                          flexWrap: "wrap",
                        }}
                      >
                        <Link to={disciplinePlanPath(patientId ?? "", kind)} style={linkStyle}>
                          Open {kindLabel(kind)}
                        </Link>
                        <Link
                          to={`/patients/${patientId}/discipline-plans/${kind}/versions`}
                          style={linkStyle}
                        >
                          Version history
                        </Link>
                        {canAuthor && versionIntent ? (
                          <Button
                            size="sm"
                            loading={openingPlanId === plan.planId}
                            disabled={openingPlanId !== null}
                            onClick={() => void openVersion(plan)}
                          >
                            {versionIntent === "initial" ? "Start plan" : "Start revision"}
                          </Button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div style={columnStyle}>
                      <Field label="Next action" value={presentation.nextAction} />
                      <span className="wx-text-muted">{presentation.description}</span>
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </section>
      </div>
    </PatientWorkspaceLayout>
  );
}
