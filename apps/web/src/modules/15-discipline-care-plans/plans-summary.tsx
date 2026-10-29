import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
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
import {
  Card,
  Notice,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";

export function DisciplinePlansSummary(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
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

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Discipline plans — summary</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2 }}>
            <button type="button" style={ghostButtonStyle} onClick={() => window.print()}>
              Print
            </button>
            <Link to={`/patients/${patientId}/discipline-plans`} style={ghostButtonStyle}>
              Back
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        This is the shareable projection of the discipline plans — substance-use-disorder and
        family-violence content is excluded from it for every reader, including clinicians who are
        cleared to see it on the plan itself.
      </Notice>
      {partial.length > 0 ? (
        <p style={alertStyle}>
          Not included in this summary: {partial.join(", ")} — the summary for{" "}
          {partial.length === 1 ? "that plan" : "those plans"} could not be read in this session.
        </p>
      ) : null}

      {summaries.length === 0 ? (
        <EmptyState
          title="No plans to summarize"
          description="This patient has no discipline plan whose summary you can read."
        />
      ) : (
        summaries.map((s) => (
          <Card
            key={s.planId}
            title={kindLabel(s.kind)}
            actions={<span style={mutedStyle}>{kindRegulation(s.kind)}</span>}
          >
            <span style={mutedStyle}>Plan status: {humanize(s.status)}</span>

            {s.kind === "spiritual_plan" && s.spiritualCareDeclined ? (
              <Notice tone="info">
                Spiritual care: as the patient has requested. No spiritual-care goals are recorded.
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
              <span style={mutedStyle}>No goals recorded.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Goal</th>
                    <th style={th}>Target</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {s.goals.map((g) => (
                    <tr key={g.goalId} style={rowLine}>
                      <td style={td}>{g.text}</td>
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
              <span style={mutedStyle}>No interventions recorded.</span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Scope</th>
                    <th style={th}>Frequency</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {s.interventions.map((iv) => (
                    <tr key={iv.interventionId} style={rowLine}>
                      <td style={td}>{iv.scopeText}</td>
                      <td style={td}>{iv.frequencyText}</td>
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
        ))
      )}
    </div>
  );
}
