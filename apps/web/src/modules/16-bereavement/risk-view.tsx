// apps/web/src/modules/16-bereavement — the RISK SCORE VIEW (§5.1 #12, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Record Detail."
//
// Route 29's append-only ledger plus route 28's recompute. Four things this screen is careful about:
//
//  1. D17 TRI-STATE. A factor is `true`, `false`, or `unknown` — and `unknown` is a REAL answer, not a
//     missing one. The recompute form offers all three, and the ledger renders `unknown` explicitly.
//     Coercing unknown to false would silently lower a survivor's score by asserting a fact nobody knows.
//  2. CONFIDENCE IS SURFACED, NOT BURIED. `dataCompleteness` + `confidenceBand` ride every row, because a
//     LOW-confidence `low` tier and a HIGH-confidence `low` tier are different clinical statements.
//     `evidenceDegraded` says the unknowns were an OUTAGE (a seam was unreadable) rather than an unasked
//     question — the two must not read the same.
//  3. THE LEDGER IS IMMUTABLE. `bereavement_risk_score` refuses UPDATE at the database. A §7.3 counselor
//     override does not edit a row: it APPENDS a new one whose `tier` differs from `deterministicTier`,
//     and this screen shows both so the rubric's own answer is never lost behind the override.
//  4. LAYER 2 IS GATED. The narrative is only produced when Part-A `ai.full` is on. The request checkbox
//     is offered; a server that has the flag off simply returns a deterministic-only row, which this
//     screen reports rather than pretending a narrative was suppressed for another reason.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { CompleteAssessmentModal } from "./assessment-completion";
import {
  type AssessmentTaskRow,
  type BereavementRiskFactors,
  type BereavementRiskTier,
  type PlanDetail,
  type PreDeathDraft,
  type RiskScoreRow,
  type TriState,
  errorMessage,
  getPlan,
  getPreDeathDraft,
  listAssessmentTasks,
  listRiskScores,
  recomputeRisk,
} from "./bereavement-api";
import {
  ASSESSMENT_TASK_STATUS_TONE,
  CONFIDENCE_BAND_TONE,
  DATA_COMPLETENESS_TONE,
  RISK_FACTOR_KEYS,
  assessmentTaskKindLabel,
  countLabel,
  dateTime,
  dueLabel,
  humanize,
  redactionLabel,
  riskFactorLabel,
  scoreLabel,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  CheckboxField,
  ErrorText,
  Field,
  FilterRow,
  Modal,
  Notice,
  RiskTierPill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
  useActionStatus,
} from "./bereavement-ui";

const TIERS = ["low", "moderate", "high", "complicated"];
const SCORE_LIMIT = 100;

export function BereavementRiskView(): JSX.Element {
  const { planId } = useParams<{ planId: string }>();
  // Keyed by plan: a route-param change remounts, so one plan's ledger is never shown under another's id.
  return <RiskViewForPlan key={planId ?? "none"} planId={planId} />;
}

function RiskViewForPlan({ planId }: { planId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [scores, setScores] = useState<RiskScoreRow[]>([]);
  const [scoresHasMore, setScoresHasMore] = useState(false);
  const [contactFilter, setContactFilter] = useState("");
  // `loading` is the FIRST load only: after an action or a filter change the page stays up with its data (no unmount, no
  // lost focus) while the reload runs.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [recomputeOpen, setRecomputeOpen] = useState(false);
  // ADR-0109 — the checkpoints (null = unreadable), whether the D10 scope withheld them, the pre-death draft (null =
  // unreadable or none: provenance is then simply not claimed) and the checkpoint being completed.
  const [tasks, setTasks] = useState<AssessmentTaskRow[] | null>(null);
  const [tasksWithheld, setTasksWithheld] = useState(false);
  const [draft, setDraft] = useState<PreDeathDraft | null>(null);
  const [completing, setCompleting] = useState<AssessmentTaskRow | null>(null);
  const { announce, region } = useActionStatus();
  const latestRequest = useRef(0);
  const hasPlan = useRef(false);

  const load = useCallback(async () => {
    if (!planId) return;
    const mine = ++latestRequest.current;
    const stale = () => mine !== latestRequest.current; // a newer load (filter change, action) or an unmount superseded this one
    const fail = (message: string) => {
      if (hasPlan.current) setRefreshError(message);
      else setError(message);
      setLoading(false);
    };
    const [detail, page] = await Promise.all([
      getPlan(client, planId),
      listRiskScores(client, planId, { contactId: contactFilter || undefined, limit: SCORE_LIMIT }),
    ]);
    if (stale()) return;
    if (detail.error)
      return fail(errorMessage(detail.error, "This bereavement plan could not be loaded."));
    if (page.error)
      return fail(errorMessage(page.error, "The risk-score history could not be loaded."));
    // The checkpoints and the draft are context beside the ledger: neither failing hides the ledger itself.
    const [taskList, preDeath] = await Promise.all([
      listAssessmentTasks(client, planId),
      detail.plan?.admissionId
        ? getPreDeathDraft(client, detail.plan.admissionId)
        : Promise.resolve({ draft: null, error: null }),
    ]);
    if (stale()) return;
    hasPlan.current = true;
    setPlan(detail.plan);
    setScores(page.page?.data ?? []);
    setScoresHasMore(page.page?.has_more ?? false);
    setTasks(taskList.list?.items ?? null);
    setTasksWithheld((taskList.list?.redactedCategories ?? []).includes("clinical_risk"));
    setDraft(preDeath.draft);
    setError(null);
    setRefreshError(null);
    setLoading(false);
  }, [client, planId, contactFilter]);

  useEffect(() => {
    void load();
    return () => {
      latestRequest.current += 1;
    };
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan || !planId)
    return (
      <EmptyState
        title="Not found"
        description="This bereavement plan does not exist, or is not on your caseload."
      />
    );

  /** A write succeeded: reload (the page stays mounted) and say so, moving focus off a trigger that may be gone. */
  const acted = (message: string): void => {
    announce(message);
    void load();
  };

  const nameOf = (contactId: string | null) =>
    contactId === null
      ? "Plan-level rollup"
      : (plan.contacts.find((c) => c.contactId === contactId)?.displayName ?? shortId(contactId));

  const latest = scores[0];
  const anyRedacted = scores.some((s) => s.redactedCategories.length > 0);

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement risk</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} onClick={() => setRecomputeOpen(true)}>
              Recompute
            </button>
            <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
              Back to plan
            </Link>
          </div>
        }
      />

      {region}
      {refreshError ? <ErrorText>{refreshError}</ErrorText> : null}

      {latest ? (
        <Notice
          tone={
            latest.confidenceBand === "LOW"
              ? "error"
              : latest.confidenceBand === "MEDIUM"
                ? "warning"
                : "info"
          }
        >
          {latest.confidenceBand} confidence — data completeness {humanize(latest.dataCompleteness)}
          {latest.evidenceDegraded
            ? ". At least one evidence source was unreadable when this score was computed, so the unknown factors are an outage rather than an unasked question."
            : "."}
        </Notice>
      ) : null}

      {anyRedacted ? (
        <Notice tone="info">{redactionLabel(scores.flatMap((s) => s.redactedCategories))}</Notice>
      ) : null}

      <FilterRow>
        <SelectField
          label="Scope"
          value={contactFilter}
          options={[
            { value: "", label: "every score on this plan" },
            ...plan.contacts.map((c) => ({ value: c.contactId, label: c.displayName })),
          ]}
          onChange={setContactFilter}
        />
      </FilterRow>

      {latest ? (
        <Card title="Most recent score" actions={<RiskTierPill tier={latest.tier} />}>
          <SummaryGrid>
            <Field label="Scope" value={nameOf(latest.contactId)} />
            <Field label="Assessed" value={dateTime(latest.assessedAt)} />
            <Field label="Rule score" value={scoreLabel(latest.ruleScore)} />
            <Field
              label="Deterministic tier"
              value={<RiskTierPill tier={latest.deterministicTier} />}
            />
            <Field
              label="Data completeness"
              value={
                <StatusPill
                  label={humanize(latest.dataCompleteness)}
                  tone={toneOf(DATA_COMPLETENESS_TONE, latest.dataCompleteness)}
                />
              }
            />
            <Field
              label="Confidence"
              value={
                <StatusPill
                  label={latest.confidenceBand}
                  tone={toneOf(CONFIDENCE_BAND_TONE, latest.confidenceBand)}
                />
              }
            />
            <Field label="PG-13" value={scoreLabel(latest.pg13Score)} />
            <Field label="IPGR" value={scoreLabel(latest.ipgrScore)} />
            <Field label="Kind" value={humanize(latest.scoreKind)} />
          </SummaryGrid>
          {latest.tier !== latest.deterministicTier ? (
            <Notice tone="warning">
              A counselor override moved this score off the rubric's own tier (
              {humanize(latest.deterministicTier)}). The rubric answer is retained above — the
              ledger row carries both, because an override that erased what the rubric said would
              leave a surveyor with no way to see it was overridden.
            </Notice>
          ) : null}
          {latest.factors ? (
            <FactorTable factors={latest.factors} />
          ) : (
            <span style={mutedStyle}>
              The factor vector is not disclosed to you on this row. That is a confidentiality gate,
              not an empty rubric.
            </span>
          )}
        </Card>
      ) : (
        <Card title="Most recent score">
          <span style={mutedStyle}>
            No risk score has been computed for this plan yet. The rubric runs on the survivors'
            factors plus what Modules 9 and 15 publish; recomputing it here appends the first ledger
            row.
          </span>
        </Card>
      )}

      <Card
        title={
          tasks === null || tasksWithheld
            ? "Assessment checkpoints"
            : `Assessment checkpoints (${tasks.length})`
        }
      >
        {tasks === null ? (
          <span style={mutedStyle}>The assessment checkpoints could not be loaded.</span>
        ) : tasksWithheld ? (
          <span style={mutedStyle}>
            Assessment checkpoints are not shown in your scope — they hold clinical risk content.
          </span>
        ) : tasks.length === 0 ? (
          <span style={mutedStyle}>
            No assessment checkpoints are scheduled. Each survivor gets an initial assessment at day
            28 and a midpoint reassessment at day 180.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Survivor</th>
                <th style={th}>Checkpoint</th>
                <th style={th}>Due</th>
                <th style={th}>Status</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.taskId} style={rowLine}>
                  <td style={td}>{nameOf(task.contactId)}</td>
                  <td style={td}>{assessmentTaskKindLabel(task.taskKind)}</td>
                  <td style={td}>
                    {shortDate(task.dueAt)}
                    <div style={mutedStyle}>
                      {task.status === "completed"
                        ? `completed ${shortDate(task.completedAt)}`
                        : dueLabel(task.dueAt)}
                    </div>
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(task.status)}
                      tone={toneOf(ASSESSMENT_TASK_STATUS_TONE, task.status)}
                    />
                  </td>
                  <td style={td}>
                    {task.status === "scheduled" || task.status === "missed" ? (
                      <button
                        type="button"
                        style={ghostButtonStyle}
                        aria-label={`Complete assessment: ${assessmentTaskKindLabel(task.taskKind)} for ${nameOf(task.contactId)}`}
                        onClick={() => setCompleting(task)}
                      >
                        Complete assessment
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          A checkpoint is completed only by a score a clinician records here; the automatic initial
          score at plan opening does not complete one. A missed checkpoint can still be completed
          late.
        </span>
      </Card>

      <Card title={`Score ledger (${countLabel(scores.length, scoresHasMore)})`}>
        {scores.length === 0 ? (
          <span style={mutedStyle}>The append-only ledger is empty.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Assessed</th>
                <th style={th}>Scope</th>
                <th style={th}>Tier</th>
                <th style={th}>Rubric tier</th>
                <th style={thNum}>Score</th>
                <th style={th}>Completeness</th>
                <th style={th}>Confidence</th>
                <th style={th}>Kind</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.scoreId} style={rowLine}>
                  <td style={td}>{dateTime(s.assessedAt)}</td>
                  <td style={td}>{nameOf(s.contactId)}</td>
                  <td style={td}>
                    <RiskTierPill tier={s.tier} />
                  </td>
                  <td style={td}>
                    <RiskTierPill tier={s.deterministicTier} />
                  </td>
                  <td style={tdNum}>{scoreLabel(s.ruleScore)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(s.dataCompleteness)}
                      tone={toneOf(DATA_COMPLETENESS_TONE, s.dataCompleteness)}
                    />
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={s.confidenceBand}
                      tone={toneOf(CONFIDENCE_BAND_TONE, s.confidenceBand)}
                    />
                    {s.evidenceDegraded ? <div style={mutedStyle}>evidence degraded</div> : null}
                  </td>
                  <td style={td}>
                    {humanize(s.scoreKind)}
                    {draft?.carriedScoreId === s.scoreId ? (
                      <div>
                        <StatusPill label="from pre-death draft" tone="progress" />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          The ledger is append-only — the database refuses UPDATE on a score row outright. A
          correction is a new row, never an edit.
        </span>
      </Card>

      {completing ? (
        <CompleteAssessmentModal
          planId={planId}
          task={completing}
          contactName={nameOf(completing.contactId)}
          draft={draft}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null);
            acted("The assessment was recorded and the checkpoint is complete.");
          }}
        />
      ) : null}

      {recomputeOpen ? (
        <RecomputeModal
          planId={planId}
          contacts={plan.contacts.map((c) => ({ id: c.contactId, name: c.displayName }))}
          onClose={() => setRecomputeOpen(false)}
          onDone={() => {
            setRecomputeOpen(false);
            acted("The risk score was recomputed.");
          }}
        />
      ) : null}
    </div>
  );
}

/** The D17 tri-state factor vector, rendered so `unknown` reads as an answer rather than a blank. */
function FactorTable({ factors }: { factors: Record<string, boolean | "unknown"> }): JSX.Element {
  const rows = RISK_FACTOR_KEYS.filter((k) => k in factors);
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>Factor</th>
          <th style={th}>Observation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => {
          const v = factors[k];
          return (
            <tr key={k} style={rowLine}>
              <td style={td}>{riskFactorLabel(k)}</td>
              <td style={td}>
                {v === "unknown" ? (
                  <StatusPill label="Unknown" tone="neutral" />
                ) : v ? (
                  <StatusPill label="Present" tone="warning" />
                ) : (
                  <StatusPill label="Absent" tone="success" />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Route 28 — recompute. §7.3's override needs BOTH a tier and a ≥40-char documented reason. */
function RecomputeModal({
  planId,
  contacts,
  onClose,
  onDone,
}: {
  planId: string;
  contacts: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [contactId, setContactId] = useState("");
  const [factors, setFactors] = useState<Record<string, TriState>>(
    Object.fromEntries(RISK_FACTOR_KEYS.map((k) => [k, "unknown" as TriState])),
  );
  const [supplyFactors, setSupplyFactors] = useState(false);
  const [requestAugmentation, setRequestAugmentation] = useState(false);
  const [overrideTier, setOverrideTier] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overrideIncomplete = overrideTier !== "" && overrideReason.trim().length < 40;

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `factors`'s keys are always exactly RISK_FACTOR_KEYS, and `overrideTier` is always "" or one of the
    // closed vocabulary the SelectField below offers.
    const { error: err } = await recomputeRisk(client, planId, {
      bereavedContactId: contactId || undefined,
      factors: supplyFactors ? (factors as unknown as BereavementRiskFactors) : undefined,
      requestAugmentation: requestAugmentation || undefined,
      overrideTier: (overrideTier || undefined) as BereavementRiskTier,
      overrideReason: overrideTier ? overrideReason : undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The risk score could not be recomputed."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Recompute bereavement risk"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || overrideIncomplete}
          onClick={submit}
        >
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      }
    >
      <SelectField
        label="Scope"
        value={contactId}
        options={[
          { value: "", label: "the whole plan" },
          ...contacts.map((c) => ({ value: c.id, label: c.name })),
        ]}
        onChange={setContactId}
      />

      <CheckboxField
        label="Supply the factor observations from this form"
        checked={supplyFactors}
        onChange={setSupplyFactors}
      />
      {supplyFactors ? (
        <>
          <Notice tone="info">
            `Unknown` is a real answer. The scorer adjusts its divisor to the knowable factors and
            lowers the confidence band accordingly — it never treats unknown as absent.
          </Notice>
          {RISK_FACTOR_KEYS.map((k) => (
            <SelectField
              key={k}
              label={riskFactorLabel(k)}
              value={factors[k] === "unknown" ? "unknown" : factors[k] ? "true" : "false"}
              options={[
                { value: "true", label: "Present" },
                { value: "false", label: "Absent" },
                { value: "unknown", label: "Unknown" },
              ]}
              onChange={(v) =>
                setFactors({ ...factors, [k]: v === "unknown" ? "unknown" : v === "true" })
              }
            />
          ))}
        </>
      ) : (
        <span style={mutedStyle}>
          Without supplied observations the rubric reads what Modules 9 and 15 publish. A source
          that is unreadable yields `unknown`, not `absent`.
        </span>
      )}

      <CheckboxField
        label="Request the narrative (Layer 2)"
        checked={requestAugmentation}
        onChange={setRequestAugmentation}
      />
      <span style={mutedStyle}>
        The narrative requires the platform's full-AI capability. With it off, the server returns a
        deterministic-only row — the rubric itself never depends on AI.
      </span>

      <SelectField
        label="Counselor override (optional)"
        value={overrideTier}
        options={[
          { value: "", label: "no override — use the rubric's tier" },
          ...TIERS.map((t2) => ({ value: t2, label: humanize(t2) })),
        ]}
        onChange={setOverrideTier}
      />
      {overrideTier ? (
        <TextAreaField
          label="Override reason"
          value={overrideReason}
          onChange={setOverrideReason}
          rows={4}
          hint={`${overrideReason.trim().length} / 40 characters minimum. The rubric's own tier is retained on the ledger row alongside your override.`}
        />
      ) : null}

      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
