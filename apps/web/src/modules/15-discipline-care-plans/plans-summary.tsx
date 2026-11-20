import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the PRINTABLE PLAN SUMMARY (§5.1 #15, Track B).
//
// The survey-friendly single page: every discipline plan's goals and interventions in one document that
// mirrors the M22-rendered PDF. Backed by route 3 (`GET /discipline-plans/:planId/summary`), read once per
// plan — the SAME endpoint the M31 patient portal reads (§5.3), which is why BOTH confidential categories
// are always stripped from it server-side, for every caller, regardless of consent.
//
// That is the important property of this screen and it is stated on the page: a surveyor reading this
// summary is not reading a redacted-for-them view, they are reading the shareable projection. The full
// clinical record lives on each plan's own view, where the §7.8/§7.9 gates apply per caller.
//
// §7.3: a declined spiritual plan surfaces as an acknowledged care decision, never as the patient's words.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import {
  type PlanListItem,
  type PlanSummary,
  errorMessage,
  getPlanSummary,
  listPlans,
} from "./discipline-api";
import {
  GOAL_STATUS_TONE,
  INTERVENTION_STATUS_TONE,
  humanize,
  kindLabel,
  kindRegulation,
  shortDate,
  toneOf,
} from "./discipline-status";
import { Notice, columnStyle, ghostButtonStyle, pageTitleStyle } from "./discipline-ui";

export function DisciplinePlansSummary(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const identity = useChartIdentity(patientId);
  const [summaries, setSummaries] = useState<PlanSummary[]>([]);
  const [partial, setPartial] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    setPartial([]);
    const { page, error: err } = await listPlans(client, { patientId, limit: 25 });
    if (err) {
      setError(errorMessage(err, "The discipline plans for this patient could not be loaded."));
      setLoading(false);
      return;
    }
    const rows: PlanListItem[] = page?.data ?? [];
    const loaded: PlanSummary[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      const { summary, error: sErr } = await getPlanSummary(client, row.planId);
      if (sErr || !summary) failed.push(kindLabel(row.kind));
      else loaded.push(summary);
    }
    setSummaries(loaded);
    // A plan whose summary the caller may not read is NAMED as missing rather than silently dropped —
    // a survey document that omits a plan without saying so is a worse artefact than an honest gap.
    setPartial(failed);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The shared chart banner and Patient Summary rail, so this screen shows the same identity header as
  // every other discipline-plan screen.
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

  return (
    <PatientWorkspaceLayout
      banner={<ChartPatientBanner patientId={patientId} identity={identity} />}
      rail={<PatientSummaryPanel identity={identity} />}
    >
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="discipline-plans" />
        <section
          aria-label="Discipline plans summary"
          className="wx-kit-column"
          style={{ ...columnStyle, flex: 1, minWidth: 0, overflow: "auto" }}
        >
          <PageHeader
            title={<span style={pageTitleStyle}>Discipline plans — summary</span>}
            actions={
              // The page's own controls do not print. The class sits on a wrapper with no inline display: an
              // inline `display: flex` would beat the print stylesheet's `display: none`.
              <div className="wx-print-hide">
                <div style={{ display: "flex", gap: t.space2 }}>
                  <Button tone="secondary" type="button" onClick={() => window.print()}>
                    Print
                  </Button>
                  <Link to={`/patients/${patientId}/discipline-plans`} style={ghostButtonStyle}>
                    Back
                  </Link>
                </div>
              </div>
            }
          />

          <Notice tone="info">
            This is the shareable projection of the discipline plans — substance-use-disorder and
            family-violence content is excluded from it for every reader, including clinicians who
            are cleared to see it on the plan itself.
          </Notice>
          {partial.length > 0 ? (
            <p className="wx-text-error">
              Not included in this summary: {partial.join(", ")} — the summary for{" "}
              {partial.length === 1 ? "that plan" : "those plans"} could not be read in this
              session.
            </p>
          ) : null}

          {summaries.length === 0 ? (
            <EmptyState
              title="No plans to summarize"
              description="This patient has no discipline plan whose summary you can read."
            />
          ) : (
            summaries.map((s) => (
              <Panel
                stack
                headingLevel={3}
                key={s.planId}
                title={kindLabel(s.kind)}
                action={<span className="wx-text-muted">{kindRegulation(s.kind)}</span>}
              >
                <span className="wx-text-muted">Plan status: {humanize(s.status)}</span>

                {s.kind === "spiritual_plan" && s.spiritualCareDeclined ? (
                  <Notice tone="info">
                    Spiritual care: as the patient has requested. No spiritual-care goals are
                    recorded.
                  </Notice>
                ) : null}

                <h4
                  style={{
                    margin: 0,
                    fontFamily: t.fontDisplay,
                    fontSize: "0.85rem",
                    color: t.onSurface,
                  }}
                >
                  Goals
                </h4>
                {s.goals.length === 0 ? (
                  <span className="wx-text-muted">No goals recorded.</span>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Goal</th>
                        <th>Target</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.goals.map((g) => (
                        <tr key={g.goalId}>
                          <td>{g.text}</td>
                          <td>{shortDate(g.targetAt)}</td>
                          <td>
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

                <h4
                  style={{
                    margin: 0,
                    fontFamily: t.fontDisplay,
                    fontSize: "0.85rem",
                    color: t.onSurface,
                  }}
                >
                  Interventions
                </h4>
                {s.interventions.length === 0 ? (
                  <span className="wx-text-muted">No interventions recorded.</span>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Scope</th>
                        <th>Frequency</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.interventions.map((iv) => (
                        <tr key={iv.interventionId}>
                          <td>{iv.scopeText}</td>
                          <td>{iv.frequencyText}</td>
                          <td>
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
              </Panel>
            ))
          )}
        </section>
      </div>
    </PatientWorkspaceLayout>
  );
}
