import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  StickyFooterActions,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/15-discipline-care-plans — the AIDE POC EDITOR (§5.1 #3, Track B / ADR-0030).
//
// The RN Case Manager's authoring surface for the 42 CFR §418.76(b) aide task list: the interventions that
// ARE the tasks (scope + frequency) and the goals they serve, on the plan's open draft version.
//
// Three server rules the editor exposes rather than fights:
//   • `original_text` is IMMUTABLE (§2.3) — a goal's wording changes through a `revise` event that records
//     the revised text alongside the original, never by overwriting it. The form reflects that split.
//   • every edit is version-checked (§2.5): the row `version` read is sent as `If-Match`, so a concurrent
//     editor loses with a 412 instead of silently clobbering (the §7.10 acceptance).
//   • the AIDE ASSIGNMENT itself is not editable here. M15 publishes no route that re-points a plan's
//     aide/supervising RN — that binding is set by the bootstrap worker and moved by an IDG decision — so
//     it is shown read-only rather than faked with a control that cannot save.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
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
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./discipline-status";
import {
  Card,
  Field,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./discipline-ui";

/** `discipline_goal_source` as the §4.2 `CreateGoalBody` accepts it (the route's union, not the pgEnum —
 *  the route layer is the contract the browser talks to). */
const SOURCE_OPTIONS = [
  { value: "clinician_authored", label: "Clinician authored" },
  { value: "patient_stated", label: "Patient stated" },
  { value: "family_stated", label: "Family stated" },
  { value: "idg_directed", label: "IDG directed" },
];

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

  // New intervention (the aide TASK) draft.
  const [scopeText, setScopeText] = useState("");
  const [frequencyText, setFrequencyText] = useState("");
  const [frequencyValue, setFrequencyValue] = useState("");
  // New goal draft.
  const [goalText, setGoalText] = useState("");
  const [goalSource, setGoalSource] = useState("clinician_authored");
  const [goalProblemId, setGoalProblemId] = useState("");

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { plan: loaded, error: err } = await getPlanByKind(client, patientId, "aide_poc");
    if (err) {
      setError(errorMessage(err, "The Aide Plan of Care could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(loaded);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addIntervention(): Promise<void> {
    if (!plan) return;
    setActionError(null);
    const res = await client.POST("/api/v1/discipline-plans/{planId}/interventions", {
      params: { path: { planId: plan.planId }, header: writeHeaders() },
      body: {
        scopeText,
        frequencyText,
        frequencyValue,
        discipline: "aide",
        addedByDiscipline: "aide",
      },
    } as never);
    if (res.error) {
      setActionError(errorMessage(res.error, "The task could not be added."));
      return;
    }
    setScopeText("");
    setFrequencyText("");
    setFrequencyValue("");
    await load();
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
        addedByDiscipline: "aide",
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
    await load();
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
    await load();
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
    await load();
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan)
    return (
      <EmptyState
        title="No Aide Plan of Care yet"
        description="This plan is created when the admission is activated."
      />
    );

  const editingVersion = plan.versions.find((v) => v.versionId === versionId) ?? null;
  const sealed = editingVersion !== null && editingVersion.status !== "draft";
  const canAddIntervention =
    scopeText.trim() !== "" && frequencyText.trim() !== "" && frequencyValue.trim() !== "";

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Aide Plan of Care — editor</span>}
        breadcrumb="Clinical — 42 CFR §418.76(b) aide task list"
        actions={
          <Link to={`/patients/${patientId}/discipline-plans/aide-poc`} style={ghostButtonStyle}>
            Back to plan
          </Link>
        }
      />

      {sealed ? (
        <Notice tone="warning">
          Version {editingVersion?.sequence} is {humanize(editingVersion?.status)} — its snapshot is
          sealed. Edits made now belong to the next draft version, not to this one.
        </Notice>
      ) : null}
      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card title="Assignment">
        <SummaryGrid>
          <Field label="Assigned aide" value={shortId(plan.aideMembershipId)} mono />
          <Field label="Supervising RN" value={shortId(plan.supervisingRnMembershipId)} mono />
          <Field
            label="Supervisory cadence"
            value={`${plan.supervisoryCadence?.cadenceDays ?? plan.supervisoryCadenceDaysOverride ?? 14} days`}
          />
        </SummaryGrid>
        <span style={mutedStyle}>
          The aide and supervising RN bindings are set at bootstrap and moved by an IDG decision;
          they are not editable from this screen.
        </span>
      </Card>

      <Card title="Aide tasks">
        {plan.interventions.length === 0 ? (
          <span style={mutedStyle}>No tasks on this plan yet.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Task</th>
                <th style={th}>Frequency</th>
                <th style={th}>Status</th>
                <th style={th}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {plan.interventions.map((iv) => (
                <tr key={iv.interventionId} style={rowLine}>
                  <td style={td}>{iv.scopeText}</td>
                  <td style={td}>
                    {iv.frequencyText}
                    <div style={mutedStyle}>{iv.frequencyValue}</div>
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(iv.status)}
                      tone={toneOf(INTERVENTION_STATUS_TONE, iv.status)}
                    />
                  </td>
                  <td style={td}>
                    {iv.status === "active" ? (
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        onClick={() => void discontinueIntervention(iv)}
                      >
                        Discontinue
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: t.space3, alignItems: "flex-end" }}>
          <TextField label="New task" value={scopeText} onChange={setScopeText} />
          <TextField
            label="Frequency (words)"
            value={frequencyText}
            onChange={setFrequencyText}
            placeholder="three times weekly"
          />
          <TextField
            label="Frequency (coded)"
            value={frequencyValue}
            onChange={setFrequencyValue}
            placeholder="3/week"
          />
          <button
            type="button"
            disabled={!canAddIntervention}
            style={{ ...primaryButtonStyle, opacity: canAddIntervention ? 1 : 0.5 }}
            onClick={() => void addIntervention()}
          >
            Add task
          </button>
        </div>
      </Card>

      <Card title="Goals">
        {plan.goals.length === 0 ? (
          <span style={mutedStyle}>No goals on this plan yet.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Goal</th>
                <th style={th}>Source</th>
                <th style={th}>Target</th>
                <th style={th}>Status</th>
                <th style={th}>Change</th>
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
                  </td>
                  <td style={td}>{humanize(g.source)}</td>
                  <td style={td}>{shortDate(g.targetAt)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(g.status)}
                      tone={toneOf(GOAL_STATUS_TONE, g.status)}
                    />
                  </td>
                  <td style={td}>
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
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: t.space3, alignItems: "flex-end" }}>
          <TextField
            label="IPOC problem id"
            value={goalProblemId}
            onChange={setGoalProblemId}
            describedBy="goal-problem-hint"
          />
          <SelectField
            label="Source"
            value={goalSource}
            options={SOURCE_OPTIONS}
            onChange={setGoalSource}
          />
          <button
            type="button"
            disabled={goalText.trim() === "" || goalProblemId.trim() === ""}
            style={{
              ...primaryButtonStyle,
              opacity: goalText.trim() === "" || goalProblemId.trim() === "" ? 0.5 : 1,
            }}
            onClick={() => void addGoal()}
          >
            Add goal
          </button>
        </div>
        <TextAreaField
          label="Goal text"
          value={goalText}
          onChange={setGoalText}
          rows={3}
          hint="Recorded verbatim as the goal's original text, which is immutable — later wording changes are recorded as revisions alongside it."
        />
        <span id="goal-problem-hint" style={mutedStyle}>
          A discipline goal refines an IPOC problem owned by the interdisciplinary care plan (M7);
          the problem id comes from that plan.
        </span>
      </Card>

      <StickyFooterActions>
        <Link to={`/patients/${patientId}/discipline-plans/aide-poc`} style={linkStyle}>
          Done editing — return to the plan to finalize and sign
        </Link>
      </StickyFooterActions>
    </div>
  );
}
