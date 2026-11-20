import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  StickyFooterActions,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the AIDE POC EDITOR (§5.1 #3, Track B / ADR-0030).
//
// The RN Case Manager's authoring surface for the 42 CFR §418.76(b) aide task list: the interventions that
// ARE the tasks (scope + frequency) and the goals they serve, on the plan's open draft version.
//
// Three server rules the editor exposes rather than fights:
//   • `original_text` is IMMUTABLE (§2.3) — a goal's wording changes through a `revise` event that records
//     the revised text alongside the original, never by overwriting it. The form reflects that split.
//   • every edit is version-checked (§2.5): the row `version` read is sent as `If-Match`, so a concurrent
//     editor loses with a 409 instead of silently clobbering (the §7.10 acceptance).
//   • the plan's AIDE and SUPERVISING RN are chosen here (`./aide-assignment-panel`), by name from the plan
//     location's staff roster; nothing else sets them, and the plan cannot be finalized, nor a supervisory
//     visit recorded, until both are named.
//
// The screen wears the same chart shell as every sibling M15 screen (patient banner, Patient Summary rail,
// chart module rail), in its loading / error / empty states too.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";
import {
  ChartPatientBanner,
  PatientSummaryPanel,
  useChartIdentity,
} from "../../shell/patient-context";
import { AideAssignmentForm, aideTeamChanged, effectivePick } from "./aide-assignment-panel";
import {
  FREQUENCY_CODE_OPTIONS,
  FREQUENCY_WORD_OPTIONS,
  frequencyPresetFor,
} from "./aide-frequency";
import { useAideRoster } from "./aide-roster";
import {
  type GoalView,
  type InterventionView,
  type PlanDetail,
  errorMessage,
  getPlanByKind,
  writeHeaders,
} from "./discipline-api";
import {
  GOAL_STATUS_TONE,
  INTERVENTION_STATUS_TONE,
  goalSourceLabel,
  humanize,
  shortDate,
  toneOf,
} from "./discipline-status";
import {
  Field,
  Notice,
  SelectField,
  SummaryGrid,
  TableScroll,
  TextAreaField,
  TextField,
  columnStyle,
  ghostButtonStyle,
  guardLinkClicks,
  linkStyle,
  pageTitleStyle,
  useUnsavedChangesWarning,
} from "./discipline-ui";
import { useIpocProblems } from "./ipoc-problems";

/** The discipline an Aide POC entry is authored as. The plan's author matrix is `["rn"]` (the RN case manager
 *  maps onto it), whoever the aide is; the task's own `discipline` stays `aide`. Sending `aide` here was
 *  refused with `DISCIPLINE_SCOPE_VIOLATION` for every caller. */
const AUTHOR_DISCIPLINE = "rn";

/** `discipline_goal_source` values this form may send (`agent_stated` needs an acting consent this form does
 *  not collect). The route union and the pgEnum are pinned equal by `m15-goal-source-parity.test.ts`. */
const SOURCE_OPTIONS = ["clinical", "patient_stated", "family_stated"].map((value) => ({
  value,
  label: goalSourceLabel(value),
}));

/** The §4.2 `UpdateGoalBody.event.type` ladder. */
const GOAL_EVENTS = [
  { value: "", label: "No status change" },
  { value: "start", label: "Start" },
  { value: "meet", label: "Met" },
  { value: "missTarget", label: "Not met" },
  { value: "revise", label: "Revise" },
  { value: "discontinue", label: "Discontinue" },
];

export function AidePocEditor(): JSX.Element {
  const client = useApiClient();
  const { patientId, versionId } = useParams<{ patientId: string; versionId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const identity = useChartIdentity(patientId);
  const roster = useAideRoster(plan?.planId);
  const ipoc = useIpocProblems(patientId);

  // New intervention (the aide TASK) draft. The two frequency selects share ONE code, so they cannot disagree.
  const [scopeText, setScopeText] = useState("");
  const [frequencyCode, setFrequencyCode] = useState("");
  const frequencyPreset = frequencyPresetFor(frequencyCode);
  // New goal draft.
  const [goalText, setGoalText] = useState("");
  const [goalSource, setGoalSource] = useState("clinical");
  const [goalProblemId, setGoalProblemId] = useState("");
  // Care-team picks (null = not chosen: the plan's own binding shows). They live here so a reload keeps them and the
  // unsaved-changes guard covers them.
  const [aidePick, setAidePick] = useState<string | null>(null);
  const [rnPick, setRnPick] = useState<string | null>(null);
  const dirty =
    scopeText.trim() !== "" ||
    frequencyCode !== "" ||
    goalText.trim() !== "" ||
    goalProblemId.trim() !== "" ||
    goalSource !== "clinical" ||
    (plan !== null && aideTeamChanged(plan, aidePick, rnPick));
  const confirmDiscard = useUnsavedChangesWarning(dirty);

  // `silent` refreshes the plan behind the open screen (after an edit): no spinner swap, so unsaved picks and the
  // scroll position survive, and a failed refresh is an alert on the screen rather than a blank page.
  const load = useCallback(
    async (silent = false) => {
      if (!patientId) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const failure = (err: unknown) => {
        const message = errorMessage(err, "The Aide Plan of Care could not be loaded.");
        if (silent) setActionError(message);
        else setError(message);
      };
      try {
        const { plan: loaded, error: err } = await getPlanByKind(client, patientId, "aide_poc");
        if (err) failure(err);
        else setPlan(loaded);
      } catch (err) {
        failure(err);
      } finally {
        setLoading(false);
      }
    },
    [client, patientId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function addIntervention(): Promise<void> {
    if (!plan || !frequencyPreset) return;
    setActionError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/interventions", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        scopeText,
        frequencyText: frequencyPreset.words,
        frequencyValue: frequencyPreset.code,
        discipline: "aide",
        addedByDiscipline: AUTHOR_DISCIPLINE,
      },
    } as never);
    if (res.error) {
      setActionError(errorMessage(res.error, "The task could not be added."));
      return;
    }
    setScopeText("");
    setFrequencyCode("");
    await load(true);
  }

  async function addGoal(): Promise<void> {
    if (!plan) return;
    setActionError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/goals", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        parentProblemId: goalProblemId,
        source: goalSource,
        originalText: goalText,
        addedByDiscipline: AUTHOR_DISCIPLINE,
      },
    } as never);
    if (res.error) {
      setActionError(
        errorMessage(
          res.error,
          "The goal could not be added. A discipline goal must reference an IPOC problem.",
        ),
      );
      return;
    }
    setGoalText("");
    setGoalProblemId("");
    await load(true);
  }

  async function applyGoalEvent(goal: GoalView, type: string): Promise<void> {
    if (!plan || type === "") return;
    setActionError(null);
    const revisedText =
      type === "revise"
        ? (window.prompt("Revised goal text (the original is kept verbatim):") ?? "")
        : "";
    if (type === "revise" && revisedText.trim() === "") return;
    const reason =
      type === "discontinue" ? (window.prompt("Reason for discontinuing this goal:") ?? "") : "";
    if (type === "discontinue" && reason.trim() === "") return;
    const res = await client.PATCH("/api/v1/discipline-plans/{planId}/goals/{goalId}", {
      params: {
        path: { planId: plan.planId, goalId: goal.goalId },
        header: writeHeaders(goal.version),
      },
      body: {
        event: {
          type,
          ...(revisedText ? { revisedText } : {}),
          ...(reason ? { reason } : {}),
        },
      },
    } as never);
    if (res.error) {
      setActionError(errorMessage(res.error, "The goal status could not be changed."));
      return;
    }
    await load(true);
  }

  async function discontinueIntervention(iv: InterventionView): Promise<void> {
    if (!plan) return;
    const reason = window.prompt("Reason for discontinuing this task:") ?? "";
    if (reason.trim() === "") return;
    setActionError(null);
    const res = await client.PATCH(
      "/api/v1/discipline-plans/{planId}/interventions/{interventionId}",
      {
        params: {
          path: { planId: plan.planId, interventionId: iv.interventionId },
          header: writeHeaders(iv.version),
        },
        body: { event: { type: "discontinue", reason } },
      } as never,
    );
    if (res.error) {
      setActionError(errorMessage(res.error, "The task could not be discontinued."));
      return;
    }
    await load(true);
  }

  // The shared chart banner and Patient Summary rail, so this screen shows the same identity header as
  // every other chart tab.
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
  if (!plan) {
    return (
      <PatientChartBail banner={bailBanner} patientId={patientId} current="discipline-plans">
        <EmptyState
          title="No Aide Plan of Care yet"
          description="This plan is created when the admission is activated."
        />
      </PatientChartBail>
    );
  }

  const editingVersion = plan.versions.find((v) => v.versionId === versionId) ?? null;
  const sealed = editingVersion !== null && editingVersion.status !== "draft";
  const canAddIntervention = scopeText.trim() !== "" && frequencyPreset !== undefined;
  const problemOptions = [
    { value: "", label: ipoc.loading ? "Loading problems…" : "Select a problem…" },
    ...ipoc.problems.map((p) => ({ value: p.id, label: p.label })),
  ];
  const canAddGoal = goalText.trim() !== "" && goalProblemId !== "";
  const problemHint =
    !ipoc.loading && ipoc.problems.length === 0
      ? "No active IPOC problems on this patient's care plan. Add one under Care Plans first."
      : "Pick the problem on the patient's interdisciplinary plan of care (IPOC, under Care Plans) that this goal works toward.";

  return (
    // `display: contents`: the wrapper only carries the capture-phase guard; it adds no box.
    <div style={{ display: "contents" }} {...guardLinkClicks(confirmDiscard)}>
      <PatientWorkspaceLayout
        banner={
          <ChartPatientBanner
            patientId={patientId}
            identity={identity}
            actions={
              <Link to={`/patients/${patientId}/discipline-plans`} className="wx-btn-secondary">
                All discipline plans
              </Link>
            }
          />
        }
        rail={<PatientSummaryPanel identity={identity} />}
      >
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <ChartModuleRail patientId={patientId ?? ""} current="discipline-plans" />
          <section
            aria-label="Aide Plan of Care editor"
            className="wx-kit-column"
            style={{ ...columnStyle, flex: 1, minWidth: 0, overflow: "auto" }}
          >
            <PageHeader
              title={<span style={pageTitleStyle}>Aide Plan of Care — editor</span>}
              actions={
                <Link
                  to={`/patients/${patientId}/discipline-plans/aide-poc`}
                  style={ghostButtonStyle}
                >
                  Back to plan
                </Link>
              }
            />

            {sealed ? (
              <Notice tone="warning">
                Version {editingVersion?.sequence} is {humanize(editingVersion?.status)} — its
                snapshot is sealed. Edits made now belong to the next draft version, not to this
                one.
              </Notice>
            ) : null}
            {actionError ? (
              <p role="alert" aria-live="assertive" className="wx-text-error">
                {actionError}
              </p>
            ) : null}

            <Panel stack headingLevel={3} title="Assignment">
              <SummaryGrid>
                <Field label="Assigned aide" value={roster.nameOf(plan.aideMembershipId)} />
                <Field
                  label="Supervising RN"
                  value={roster.nameOf(plan.supervisingRnMembershipId)}
                />
                <Field
                  label="Supervisory cadence"
                  value={`${plan.supervisoryCadence?.cadenceDays ?? plan.supervisoryCadenceDaysOverride ?? 14} days`}
                />
              </SummaryGrid>
              {roster.error ? (
                <span className="wx-text-muted">Names could not be loaded; showing short ids.</span>
              ) : null}
              <AideAssignmentForm
                plan={plan}
                roster={roster}
                aideId={effectivePick(aidePick, plan.aideMembershipId)}
                rnId={effectivePick(rnPick, plan.supervisingRnMembershipId)}
                onAideChange={setAidePick}
                onRnChange={setRnPick}
                onSaved={async () => {
                  await load(true);
                  setAidePick(null);
                  setRnPick(null);
                }}
              />
            </Panel>

            <Panel stack headingLevel={3} title="Aide tasks">
              {plan.interventions.length === 0 ? (
                <span className="wx-text-muted">No tasks on this plan yet.</span>
              ) : (
                <TableScroll label="Aide tasks table">
                  <table>
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Frequency</th>
                        <th>Status</th>
                        <th>&nbsp;</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.interventions.map((iv) => (
                        <tr key={iv.interventionId}>
                          <td>{iv.scopeText}</td>
                          <td>
                            {iv.frequencyText}
                            <div className="wx-text-muted">{iv.frequencyValue}</div>
                          </td>
                          <td>
                            <StatusPill
                              label={humanize(iv.status)}
                              tone={toneOf(INTERVENTION_STATUS_TONE, iv.status)}
                            />
                          </td>
                          <td>
                            {iv.status === "active" ? (
                              <Button
                                tone="secondary"
                                type="button"
                                onClick={() => void discontinueIntervention(iv)}
                              >
                                Discontinue
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              <div
                style={{ display: "flex", flexWrap: "wrap", gap: t.space3, alignItems: "flex-end" }}
              >
                <TextField label="New task" value={scopeText} onChange={setScopeText} />
                <SelectField
                  label="Frequency (words)"
                  value={frequencyCode}
                  options={FREQUENCY_WORD_OPTIONS}
                  onChange={setFrequencyCode}
                />
                <SelectField
                  label="Frequency (coded)"
                  value={frequencyCode}
                  options={FREQUENCY_CODE_OPTIONS}
                  onChange={setFrequencyCode}
                />
                <Button
                  tone="primary"
                  type="button"
                  disabled={!canAddIntervention}
                  onClick={() => void addIntervention()}
                >
                  Add task
                </Button>
              </div>
            </Panel>

            <Panel stack headingLevel={3} title="Goals">
              {plan.goals.length === 0 ? (
                <span className="wx-text-muted">No goals on this plan yet.</span>
              ) : (
                <TableScroll label="Aide goals table">
                  <table>
                    <thead>
                      <tr>
                        <th>Goal</th>
                        <th>Source</th>
                        <th>Target</th>
                        <th>Status</th>
                        <th>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.goals.map((g) => (
                        <tr key={g.goalId}>
                          <td>
                            {g.revisedText ?? g.originalText}
                            {g.revisedText ? (
                              <div className="wx-text-muted">originally: {g.originalText}</div>
                            ) : null}
                          </td>
                          <td>{goalSourceLabel(g.source)}</td>
                          <td>{shortDate(g.targetAt)}</td>
                          <td>
                            <StatusPill
                              label={humanize(g.status)}
                              tone={toneOf(GOAL_STATUS_TONE, g.status)}
                            />
                          </td>
                          <td>
                            <SelectField
                              label={`Status change for goal ${g.goalId.slice(0, 8)}`}
                              value=""
                              options={GOAL_EVENTS}
                              onChange={(v) => void applyGoalEvent(g, v)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
              <div
                style={{ display: "flex", flexWrap: "wrap", gap: t.space3, alignItems: "flex-end" }}
              >
                <SelectField
                  label="IPOC problem"
                  value={goalProblemId}
                  options={problemOptions}
                  onChange={setGoalProblemId}
                  disabled={ipoc.loading || ipoc.problems.length === 0}
                  hint={ipoc.error ? undefined : problemHint}
                  error={ipoc.error ?? undefined}
                />
                <SelectField
                  label="Source"
                  value={goalSource}
                  options={SOURCE_OPTIONS}
                  onChange={setGoalSource}
                />
                <Button
                  tone="primary"
                  type="button"
                  disabled={!canAddGoal}
                  onClick={() => void addGoal()}
                >
                  Add goal
                </Button>
              </div>
              <TextAreaField
                label="Goal text"
                value={goalText}
                onChange={setGoalText}
                rows={3}
                hint="Recorded verbatim as the goal's original text, which is immutable — later wording changes are recorded as revisions alongside it."
              />
            </Panel>

            <StickyFooterActions>
              <Link to={`/patients/${patientId}/discipline-plans/aide-poc`} style={linkStyle}>
                Done editing — return to the plan to finalize and sign
              </Link>
            </StickyFooterActions>
          </section>
        </div>
      </PatientWorkspaceLayout>
    </div>
  );
}
