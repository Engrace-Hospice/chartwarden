import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the SHARED DISCIPLINE PLAN WORKSPACE (§5.1 #2/#6/#8/#9).
// Spec: docs/design/screens/clinical/WARDENX_UI_CARE_PLAN.md (M07 + M15) — "Use Patient Workspace."
//
// The four kind views differ in their EXTRAS (aide → supervisory ledger; volunteer → assignments), not in
// their spine: every discipline plan is goals + interventions + assessments over a signed version chain.
// That spine lives here once; `aide-poc-view` / `msw-plan` / `spiritual-plan` / `volunteer-plan` are thin
// wrappers that pass their kind and their extra panels.
//
// Confidentiality (§7.8 / §7.9) is SERVER-side: a SUD or family-violence row the caller is not cleared for
// is excluded in SQL and reported through `redacted_categories`. This screen therefore renders the marker
// honestly — "content is withheld" — and never hides a row it received. There is no frontend authz here.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  type PlanDetail,
  type RequiredSignerSlot,
  type VersionDetail,
  errorMessage,
  getPlanByKind,
  getVersion,
  normalizeSignerSet,
  writeHeaders,
} from "./discipline-api";
import {
  ASSESSMENT_STATUS_TONE,
  GOAL_STATUS_TONE,
  INTERVENTION_STATUS_TONE,
  PLAN_STATUS_TONE,
  VERSION_STATUS_TONE,
  assessmentKindLabel,
  dateTime,
  humanize,
  kindLabel,
  kindRegulation,
  redactionLabel,
  shortDate,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Field,
  Notice,
  SummaryGrid,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";
import { SignVersionModal } from "./sign-version-modal";

interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export interface PlanWorkspaceProps {
  /** `discipline_plan_kind` — which of the four CoP plans this screen renders. */
  kind: string;
  /** Chart-section highlight for the M1 module rail. */
  section?: "discipline-plans";
  /** Kind-specific panels rendered above the shared spine (supervisory ledger, assignments, …). */
  renderExtras?: (plan: PlanDetail, reload: () => Promise<void>) => ReactNode;
  /** Kind-specific banner/notice rendered directly under the page header. */
  renderNotice?: (plan: PlanDetail) => ReactNode;
}

export function DisciplinePlanWorkspace({
  kind,
  renderExtras,
  renderNotice,
}: PlanWorkspaceProps): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signing, setSigning] = useState<{
    version: VersionDetail;
    signerSet: RequiredSignerSlot[];
  } | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const [planResult, patRes] = await Promise.all([
      getPlanByKind(client, patientId, kind),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (patRes.data) setPatient(patRes.data as unknown as PatientSummary);
    if (planResult.error) {
      setError(errorMessage(planResult.error, `The ${kindLabel(kind)} could not be loaded.`));
      setLoading(false);
      return;
    }
    setPlan(planResult.plan);
    setLoading(false);
  }, [client, patientId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Finalize a draft version: seals the snapshot + the D11 quorum (`draft → in_review`). */
  async function finalize(versionId: string, rowVersion: number): Promise<void> {
    if (!plan) return;
    setActionError(null);
    const res = await client.POST(
      "/api/v1/discipline-plans/{planId}/versions/{versionId}/finalize",
      {
        params: {
          path: { planId: plan.planId, versionId },
          header: writeHeaders(rowVersion),
        },
        body: {},
      } as never,
    );
    if (res.error) {
      setActionError(errorMessage(res.error, "This version could not be finalized."));
      return;
    }
    await load();
  }

  /** Open the §5.1 #4 sign ceremony — needs the SEALED quorum, which only route 5 carries. */
  async function openSign(versionId: string): Promise<void> {
    if (!plan) return;
    setActionError(null);
    const { version, error: err } = await getVersion(client, plan.planId, versionId);
    if (err || !version) {
      setActionError(errorMessage(err, "This version could not be opened for signing."));
      return;
    }
    setSigning({ version, signerSet: normalizeSignerSet(version.requiredSignerSet) });
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan)
    return (
      <EmptyState
        title={`No ${kindLabel(kind)} yet`}
        description={
          kind === "volunteer_plan"
            ? "A volunteer plan is created with this patient's first volunteer assignment."
            : "This plan is created when the admission is activated."
        }
      />
    );

  const redaction = redactionLabel(plan.redacted_categories ?? []);
  const signedVersion = plan.versions.find((v) => v.status === "signed") ?? null;
  const openVersion = plan.versions.find((v) => v.status === "draft" || v.status === "in_review");

  return (
    <PatientWorkspaceLayout
      banner={
        patient ? (
          <PatientBanner
            name={`${patient.firstName} ${patient.lastName}`}
            meta={`DOB ${patient.dob}`}
            chips={
              <>
                <span
                  style={{ fontFamily: t.fontMono, fontSize: "0.75rem", color: t.onSurfaceVariant }}
                >
                  {patient.mrn}
                </span>
                <StatusPill
                  label={humanize(plan.status)}
                  tone={toneOf(PLAN_STATUS_TONE, plan.status)}
                />
                {redaction ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.25rem",
                      fontSize: "0.75rem",
                      color: t.onSurfaceVariant,
                    }}
                  >
                    <Glyph name="lock" size={12} /> some content restricted
                  </span>
                ) : null}
              </>
            }
            actions={
              <Link to={`/patients/${patientId}/discipline-plans`} style={ghostButtonStyle}>
                All discipline plans
              </Link>
            }
          />
        ) : (
          <PatientBanner name={kindLabel(kind)} />
        )
      }
    >
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="discipline-plans" />
        <div style={{ ...columnStyle, flex: 1, overflow: "auto" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: t.space4,
            }}
          >
            <div>
              <h1 style={pageTitleStyle}>{kindLabel(kind)}</h1>
              <span style={mutedStyle}>{kindRegulation(kind)}</span>
            </div>
            <div style={{ display: "flex", gap: t.space3 }}>
              <Link
                to={`/patients/${patientId}/discipline-plans/${kind}/versions`}
                style={linkStyle}
              >
                Version history
              </Link>
              <Link to={`/patients/${patientId}/discipline-plans/summary`} style={linkStyle}>
                Printable summary
              </Link>
            </div>
          </div>

          {redaction ? <Notice tone="warning">{redaction}</Notice> : null}
          {renderNotice?.(plan)}
          {actionError ? <p style={alertStyle}>{actionError}</p> : null}

          {renderExtras?.(plan, load)}

          <Card title="Goals">
            {plan.goals.length === 0 ? (
              <span style={mutedStyle}>No goals on this plan.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Goal</th>
                    <th style={th}>Source</th>
                    <th style={th}>Frequency</th>
                    <th style={th}>Target</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.goals.map((g) => (
                    <tr key={g.goalId} style={rowLine}>
                      <td style={td}>
                        {g.revisedText ?? g.originalText}
                        {g.revisedText ? (
                          <div style={mutedStyle}>originally: {g.originalText}</div>
                        ) : null}
                        {g.measurableOutcome ? (
                          <div style={mutedStyle}>outcome: {g.measurableOutcome}</div>
                        ) : null}
                      </td>
                      <td style={td}>{humanize(g.source)}</td>
                      <td style={td}>{g.frequencyText ?? "—"}</td>
                      <td style={td}>{shortDate(g.targetAt)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(g.status)}
                          tone={toneOf(GOAL_STATUS_TONE, g.status)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Interventions">
            {plan.interventions.length === 0 ? (
              <span style={mutedStyle}>No interventions on this plan.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Scope</th>
                    <th style={th}>Frequency</th>
                    <th style={th}>Discipline</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.interventions.map((iv) => (
                    <tr key={iv.interventionId} style={rowLine}>
                      <td style={td}>
                        {iv.scopeText}
                        {iv.discontinuationReason ? (
                          <div style={mutedStyle}>discontinued: {iv.discontinuationReason}</div>
                        ) : null}
                      </td>
                      <td style={td}>{iv.frequencyText}</td>
                      <td style={td}>{humanize(iv.discipline)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(iv.status)}
                          tone={toneOf(INTERVENTION_STATUS_TONE, iv.status)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Assessments">
            {plan.assessments.length === 0 ? (
              <span style={mutedStyle}>No assessments captured on this plan.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Kind</th>
                    <th style={th}>Captured</th>
                    <th style={th}>Initial</th>
                    <th style={th}>Signed</th>
                    <th style={th}>Status</th>
                    <th style={th}>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.assessments.map((a) => (
                    <tr key={a.assessmentId} style={rowLine}>
                      <td style={td}>{assessmentKindLabel(a.kind)}</td>
                      <td style={td}>{dateTime(a.capturedAt)}</td>
                      <td style={td}>{a.isInitial ? "Yes" : "—"}</td>
                      <td style={td}>{dateTime(a.signedAt)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(a.status)}
                          tone={toneOf(ASSESSMENT_STATUS_TONE, a.status)}
                        />
                      </td>
                      <td style={td}>
                        <Link
                          to={`/patients/${patientId}/discipline-plans/msw-plan/${plan.planId}/assessments/${a.assessmentId}`}
                          style={linkStyle}
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card
            title="Version chain"
            actions={
              openVersion ? (
                <div style={{ display: "flex", gap: t.space2 }}>
                  {openVersion.status === "draft" ? (
                    <button
                      type="button"
                      style={ghostButtonStyle}
                      onClick={() => void finalize(openVersion.versionId, openVersion.version)}
                    >
                      Finalize v{openVersion.sequence}
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={ghostButtonStyle}
                      onClick={() => void openSign(openVersion.versionId)}
                    >
                      Sign v{openVersion.sequence}
                    </button>
                  )}
                </div>
              ) : null
            }
          >
            <SummaryGrid>
              <Field
                label="Current signed version"
                value={signedVersion ? `v${signedVersion.sequence}` : "none yet"}
              />
              <Field label="Signed at" value={dateTime(signedVersion?.signedAt)} />
              <Field label="Plan row version" value={String(plan.version)} />
            </SummaryGrid>
            {plan.versions.length === 0 ? (
              <span style={mutedStyle}>No versions yet.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Version</th>
                    <th style={th}>Kind</th>
                    <th style={th}>Finalized</th>
                    <th style={th}>Signed</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.versions.map((v) => (
                    <tr key={v.versionId} style={rowLine}>
                      <td style={td}>v{v.sequence}</td>
                      <td style={td}>{humanize(v.kind)}</td>
                      <td style={td}>{dateTime(v.finalizedAt)}</td>
                      <td style={td}>{dateTime(v.signedAt)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(v.status)}
                          tone={toneOf(VERSION_STATUS_TONE, v.status)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>

      {signing ? (
        <SignVersionModal
          planId={plan.planId}
          version={signing.version}
          requiredSignerSet={signing.signerSet}
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            void load();
          }}
        />
      ) : null}
    </PatientWorkspaceLayout>
  );
}
