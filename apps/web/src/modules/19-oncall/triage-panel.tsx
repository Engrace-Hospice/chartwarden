// apps/web/src/modules/19-oncall — S19.2 THE TRIAGE PANEL (`/triage/calls/:triageCallId`, §5.1, Track B /
// ADR-0030). The Documentation-Workspace half of the §5.1 layout; the queue is the Work-Queue half.
//
// FIVE THINGS ON THIS SCREEN ARE THE SERVER'S, AND THE PANEL RENDERS THEM RATHER THAN DECIDING THEM:
//
//   1. `nextQuestionId` — D5's server-authoritative gating. The stepper renders the question the SERVER
//      says is next and offers no way to move the cursor. A client that could pick the next question could
//      skip a red-flag one, which is the failure this cursor exists to prevent; an out-of-order POST is a
//      typed refusal, not a rearrangement.
//   2. `redFlagHit` — computed at the same transaction as the answer and returned. It is never sent, and
//      the sticky banner below is fed only from what came BACK. §5.4 makes that banner
//      `aria-live="assertive"`, which is one of exactly two assertive regions in this module.
//   3. `permittedDispositions` — the §6 / §7.3 role × disposition matrix, evaluated server-side for THIS
//      actor. The selector offers exactly this set. An LPN sees two options because the server says two,
//      not because the panel knows what an LPN is; a forged POST for a third is a 403
//      `DISPOSITION_OUT_OF_SCOPE`.
//   4. `dispositionBlockedByMandatoryEscalation` — §7.2's block, rendered. Until the page is acknowledged,
//      the only move is the hand-off.
//   5. `redactedCategories` — §8.2. What is withheld is SHOWN as withheld, because a clinician who does not
//      know the medication list is incomplete reads "no opioid on file" as a clinical fact.
//
// THE AI BLOCK IS ADVISORY AND SAYS SO (D11 / D12 / §8.6). A suggestion is never auto-applied at any
// confidence; applying one is an explicit click. When M32 is deny-stubbed the block renders VISIBLY
// DISABLED rather than vanishing — an absent AI surface and a disabled one are different facts, and the
// governance review needs to be able to tell them apart.
//
// TWO §5.1 AFFORDANCES ARE NOT BUILT, AND THE SCREEN NAMES THEM. The "verbal-order seam button" is not a
// button: D9's verbal order is M11's write behind an M2 step-up asserted at the SEAM invocation, not at an
// M19 route — M19 publishes no route that mints one, and the `verbal_order_recorded` disposition names an
// order id M11 already returned. And the patient header strip carries only what M19's own DTO holds:
// allergies and code status live in M5/M7 and M19 publishes no reader for either, so inventing a strip
// from a second module's data would be a second, unaudited PHI path.
import {
  AiSuggestionCard,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { AdmissionLookupField, PatientLookupField } from "../../shell/entity-lookups";
import {
  type AnswerWriteResult,
  type EscalationTier,
  type TriageAnswerValue,
  type TriageCallDetail,
  type TriageCallProjection,
  type TriageDispositionData,
  type TriageProtocolView,
  abandonCall,
  applyProtocol,
  completeProtocol,
  documentCall,
  errorMessage,
  escalate,
  getProtocol,
  getTriageCall,
  identifyPatient,
  isMedicationContext,
  isStaffProjection,
  listProtocols,
  markAwaitingCallback,
  recordAnswer,
  resumeAfterCallback,
  selectDisposition,
} from "./oncall-api";
import {
  AI_OVERRIDE_REASON_MIN_CHARS,
  DEFAULT_ESCALATION_TIER,
  ESCALATION_STATE_TONE,
  ESCALATION_TIERS,
  RISK_BAND_TONE,
  dateTime,
  dispositionLabel,
  durationLabel,
  humanize,
  minutesSince,
  nowLocalInput,
  shortId,
  tierLabel,
  toInstant,
  toneOf,
} from "./oncall-status";
import {
  CallStatePill,
  Card,
  Field,
  Modal,
  Notice,
  RedactionNotice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  TierPill,
  Timeline,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  enumOptions,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./oncall-ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ceremony =
  | "identify"
  | "apply-protocol"
  | "callback"
  | "disposition"
  | "escalate"
  | "document"
  | "abandon"
  | null;

const TRANSPORT_ARRANGERS = ["family", "ems", "facility", "unknown"] as const;

/** Build the §4.2 `dispositionData` arm for the chosen disposition. Returns `null` when the arm's own
 *  required fields are not yet complete — the composer disables its commit rather than sending a body the
 *  server would 422, because a 422 at 2 a.m. reads as "the system is broken", not "field too short". */
function buildDispositionData(
  disposition: string,
  f: {
    summary: string;
    reason: string;
    instructions: string;
    discipline: string;
    arrivalBy: string;
    proposedForDate: string;
    followUpAt: string;
    orderRecordId: string;
    medicationOrderId: string;
    attendingPhysicianId: string;
    preferredFacility: string;
    transportArrangedBy: string;
  },
): TriageDispositionData | null {
  switch (disposition) {
    case "caregiver_education_only":
      return f.summary.trim().length >= 30
        ? {
            disposition,
            educationSummary: f.summary,
            followUpCallAt: f.followUpAt ? toInstant(f.followUpAt) : null,
          }
        : null;
    case "prn_intervention_authorized":
      return f.instructions.trim().length >= 20
        ? {
            disposition,
            orderRecordId: UUID_RE.test(f.orderRecordId) ? f.orderRecordId : null,
            medicationOrderId: UUID_RE.test(f.medicationOrderId) ? f.medicationOrderId : null,
            instructionsGiven: f.instructions,
          }
        : null;
    case "verbal_order_recorded":
      // The order id is REQUIRED and is M11's, not M19's: M19 mints no order (M19-T05's finding — M11
      // published a signature primitive over an EXISTING target). This arm attests to an order that
      // already exists and to nothing more.
      return UUID_RE.test(f.orderRecordId)
        ? {
            disposition,
            orderRecordId: f.orderRecordId,
            attendingPhysicianId: UUID_RE.test(f.attendingPhysicianId)
              ? f.attendingPhysicianId
              : null,
          }
        : null;
    case "visit_dispatched_now":
      return f.discipline.trim().length >= 2 && f.arrivalBy && f.reason.trim().length >= 30
        ? {
            disposition,
            requestedDiscipline: f.discipline,
            requestedArrivalBy: toInstant(f.arrivalBy),
            reason: f.reason,
          }
        : null;
    case "visit_scheduled_first_light":
      return f.discipline.trim().length >= 2 && f.proposedForDate && f.reason.trim().length >= 30
        ? {
            disposition,
            requestedDiscipline: f.discipline,
            proposedForDate: f.proposedForDate,
            reason: f.reason,
          }
        : null;
    case "gip_admission_proposed":
      return f.summary.trim().length >= 60
        ? {
            disposition,
            gipCriteriaSummary: f.summary,
            preferredFacility: UUID_RE.test(f.preferredFacility) ? f.preferredFacility : null,
          }
        : null;
    case "ed_transfer_acknowledged":
      return f.summary.trim().length >= 60
        ? {
            disposition,
            electionText: f.summary,
            // `f.transportArrangedBy` is always one of TRANSPORT_ARRANGERS — it is set only via the
            // <SelectField> below, whose options are that same closed, compile-time-known set.
            transportArrangedBy: f.transportArrangedBy as (typeof TRANSPORT_ARRANGERS)[number],
          }
        : null;
    case "pronouncement_scheduled":
      return f.discipline.trim().length >= 2
        ? {
            disposition,
            pronouncingDiscipline: f.discipline,
            expectedArrivalBy: f.arrivalBy ? toInstant(f.arrivalBy) : null,
          }
        : null;
    default:
      return null;
  }
}

export function TriageCallPanel(): JSX.Element {
  const client = useApiClient();
  const { triageCallId = "" } = useParams<{ triageCallId: string }>();

  const [call, setCall] = useState<TriageCallProjection | null>(null);
  const [protocol, setProtocol] = useState<TriageProtocolView | null>(null);
  const [catalog, setCatalog] = useState<TriageProtocolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The D5 verdict from the LAST answer — the §5.4 assertive banner is fed only from what came back. */
  const [lastAnswer, setLastAnswer] = useState<AnswerWriteResult | null>(null);

  // answer capture
  const [answerBool, setAnswerBool] = useState("true");
  const [answerInt, setAnswerInt] = useState("");
  const [answerText, setAnswerText] = useState("");

  // ceremony fields
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [protocolChoice, setProtocolChoice] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [callbackReason, setCallbackReason] = useState("");
  const [callbackTargetAt, setCallbackTargetAt] = useState("");
  const [tier, setTier] = useState<string>(DEFAULT_ESCALATION_TIER);
  const [escalationReason, setEscalationReason] = useState("");
  const [escalateTo, setEscalateTo] = useState("");
  const [handOff, setHandOff] = useState(false);
  const [narrative, setNarrative] = useState("");
  const [abandonReason, setAbandonReason] = useState("");
  const [callbackAttempts, setCallbackAttempts] = useState("1");
  const [disposition, setDisposition] = useState("");
  const [dSummary, setDSummary] = useState("");
  const [dReason, setDReason] = useState("");
  const [dInstructions, setDInstructions] = useState("");
  const [dDiscipline, setDDiscipline] = useState("");
  const [dArrivalBy, setDArrivalBy] = useState(nowLocalInput(60));
  const [dProposedForDate, setDProposedForDate] = useState("");
  const [dFollowUpAt, setDFollowUpAt] = useState("");
  const [dOrderRecordId, setDOrderRecordId] = useState("");
  const [dMedicationOrderId, setDMedicationOrderId] = useState("");
  const [dAttendingPhysicianId, setDAttendingPhysicianId] = useState("");
  const [dPreferredFacility, setDPreferredFacility] = useState("");
  const [dTransport, setDTransport] = useState<string>("family");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTriageCall(client, triageCallId);
    if (res.error || !res.call) {
      setError(errorMessage(res.error, "This call could not be loaded."));
      setLoading(false);
      return;
    }
    setCall(res.call);
    if (res.call.selectedProtocolId) {
      const p = await getProtocol(client, res.call.selectedProtocolId);
      setProtocol(p.protocol);
      setCatalog([]);
    } else {
      // No protocol pinned yet — offer the catalog. `effectiveOnly` defaults true server-side: a retired
      // protocol is catalog history, not a thing to apply at 2 a.m.
      setProtocol(null);
      const list = await listProtocols(client, { limit: 200 });
      setCatalog(list.page?.data ?? []);
    }
    setLoading(false);
  }, [client, triageCallId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !call) {
    return (
      <EmptyState title="Unavailable" description={error ?? "This call could not be loaded."} />
    );
  }

  const staff = isStaffProjection(call) ? (call as TriageCallDetail) : null;
  const medicationContext =
    staff && isMedicationContext(staff.medicationContext) ? staff.medicationContext : null;
  const activeMedications = medicationContext?.activeMedications ?? null;
  const pendingRefills = medicationContext?.pendingRefills ?? null;
  const sudRedactedCount = medicationContext?.sudRedactedCount ?? 0;
  const version = call.version;
  const answered = new Set(call.answers.map((a) => a.questionId));
  const nextQuestion =
    protocol && call.nextQuestionId
      ? (protocol.questions.find((q) => q.id === call.nextQuestionId) ?? null)
      : null;
  const openMandatory = call.escalations.filter((e) => e.mandatory && e.state !== "resolved");
  const blocked = staff?.dispositionBlockedByMandatoryEscalation ?? openMandatory.length > 0;

  async function run(fn: () => Promise<{ error: unknown }>, fallback: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, fallback));
      return;
    }
    setCeremony(null);
    await load();
  }

  async function submitAnswer(): Promise<void> {
    if (!nextQuestion) return;
    let value: TriageAnswerValue;
    if (nextQuestion.answerType === "boolean")
      value = { kind: "bool", value: answerBool === "true" };
    else if (nextQuestion.answerType === "integer" || nextQuestion.answerType === "scale_0_10")
      value = { kind: "int", value: Number(answerInt) };
    else value = { kind: "text", value: answerText };

    setBusy(true);
    setActionError(null);
    const res = await recordAnswer(client, triageCallId, version, {
      triageProtocolQuestionId: nextQuestion.id,
      value,
    });
    setBusy(false);
    if (res.error || !res.result) {
      setActionError(errorMessage(res.error, "That answer was not recorded."));
      return;
    }
    setLastAnswer(res.result);
    setAnswerInt("");
    setAnswerText("");
    setAnswerBool("true");
    await load();
  }

  const dispositionData = buildDispositionData(disposition, {
    summary: dSummary,
    reason: dReason,
    instructions: dInstructions,
    discipline: dDiscipline,
    arrivalBy: dArrivalBy,
    proposedForDate: dProposedForDate,
    followUpAt: dFollowUpAt,
    orderRecordId: dOrderRecordId,
    medicationOrderId: dMedicationOrderId,
    attendingPhysicianId: dAttendingPhysicianId,
    preferredFacility: dPreferredFacility,
    transportArrangedBy: dTransport,
  });

  const overrideNeedsReason =
    staff?.suggestedProtocolConfidence === "high" &&
    protocolChoice !== "" &&
    protocolChoice !== staff?.suggestedProtocolId;

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Triage call {shortId(call.id)}</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <CallStatePill state={call.state} />
            <Link to={`/triage/calls/${call.id}/history`} style={ghostButtonStyle}>
              History
            </Link>
            <Link to="/triage" style={ghostButtonStyle}>
              Queue
            </Link>
          </div>
        }
      />

      {/* ── §5.4's two assertive regions: a red-flag answer and a mandatory escalation ───────────────── */}
      {lastAnswer?.mandatoryEscalationTriggered ? (
        <Notice tone="error" assertive>
          <strong>Mandatory escalation raised.</strong> That answer matched a platform-floor
          red-flag predicate (
          {lastAnswer.tier ? tierLabel(lastAnswer.tier) : "tier resolved by policy"}). The page is
          out. This call takes no disposition other than the hand-off until a named human
          acknowledges it — a tenant policy cannot lower that floor, only raise it.
        </Notice>
      ) : lastAnswer?.redFlagHit ? (
        <Notice tone="error" assertive>
          <strong>Red flag.</strong> The server evaluated that answer as a red flag and recorded it
          in the same transaction. It cannot be suppressed from here — the evaluation is outside the
          audit denylist precisely so a suppression attempt is visible.
        </Notice>
      ) : null}

      {blocked ? (
        <Notice tone="error" live>
          A mandatory escalation on this call is unacknowledged. §7.2 permits no disposition until
          it is acknowledged; the hand-off ("escalate and pass the call") is the move.
        </Notice>
      ) : null}

      {staff ? <RedactionNotice categories={staff.redactedCategories} /> : null}

      {!staff ? (
        <Notice tone="info">
          You are reading the <strong>external-vendor projection</strong> of this call. It is a
          different record shape, not a filtered one: the caller's phone, the caller's own words,
          the transcript and the free-text complaint have no field here, and no later change to this
          screen can widen it into one. Three dispositions are also out of scope for a vendor
          session and will not appear below.
        </Notice>
      ) : null}

      {/* ── the call header ─────────────────────────────────────────────────────────────────────────── */}
      <Card title="Call">
        <SummaryGrid>
          <Field label="State" value={<CallStatePill state={call.state} />} />
          <Field label="Opened" value={dateTime(call.openedAt)} />
          {/* `closedAt` and `disposition` are STAFF-projection fields — the vendor DTO declares neither,
              which is the point of it being a different type rather than a filtered one. */}
          <Field
            label="Open for"
            value={staff?.closedAt ? "closed" : durationLabel(minutesSince(call.openedAt))}
          />
          <Field label="Provider entity" value={shortId(call.providerEntityId)} mono />
          <Field label="Covering shift" value={shortId(call.onCallShiftId)} mono />
          <Field label="Channel" value={humanize(call.inboundChannel)} />
          <Field label="Caller kind" value={humanize(call.callerKind)} />
          {staff ? <Field label="Source" value={humanize(staff.source)} /> : null}
          {staff ? (
            <Field
              label="Patient"
              value={staff.patientId ? shortId(staff.patientId) : "not yet identified"}
              mono={Boolean(staff.patientId)}
            />
          ) : null}
          {staff ? <Field label="Caller" value={staff.callerDisplayName ?? "—"} /> : null}
          {staff ? <Field label="Callback" value={staff.callerPhoneE164 ?? "—"} mono /> : null}
          {staff ? (
            <Field label="Relationship" value={staff.callerRelationshipLabel ?? "—"} />
          ) : null}
          <Field label="Version (If-Match)" value={String(version)} mono />
        </SummaryGrid>
        {staff?.chiefComplaintText ? (
          <p style={{ margin: 0, fontSize: "0.85rem", color: t.onSurface }}>
            <strong>Chief complaint.</strong> {staff.chiefComplaintText}
          </p>
        ) : null}
        {staff?.paperOriginFlag ? (
          <Notice tone="warning">
            This call was re-entered from paper after a §2.7 outage. Its original time was{" "}
            {dateTime(staff.paperOriginalOpenedAt)} — that back-dated instant is the one a coverage
            review reads, and it was bounded server-side by the outage window it was filed against.
          </Notice>
        ) : null}
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          {staff && !staff.patientId ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("identify")}>
              Identify the patient
            </button>
          ) : null}
          {call.state === "awaiting_callback" ? (
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() =>
                void run(
                  () => resumeAfterCallback(client, triageCallId, version),
                  "The call could not be resumed.",
                )
              }
            >
              Resume the walk
            </button>
          ) : (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("callback")}>
              Park on a callback
            </button>
          )}
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("escalate")}>
            Escalate
          </button>
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("abandon")}>
            Caller disconnected
          </button>
        </div>
      </Card>

      {/* ── D11 / D12 advisory block (§8.6) ─────────────────────────────────────────────────────────── */}
      {staff ? (
        <Card title="Advisory (AI)">
          {staff.suggestedProtocolId || staff.hospitalizationRiskBand ? (
            <AiSuggestionCard
              model="M32 clinical copilot"
              confidence={staff.suggestedProtocolConfidence ?? undefined}
              staticHalo
            >
              <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
                {staff.suggestedProtocolId ? (
                  <span style={{ fontSize: "0.85rem", color: t.onSurface }}>
                    Suggested protocol: <strong>{shortId(staff.suggestedProtocolId)}</strong>. It is
                    not applied. Applying a protocol is an explicit click below, at any confidence —
                    and above the governance floor, overriding it needs a written reason of at least{" "}
                    {AI_OVERRIDE_REASON_MIN_CHARS} characters.
                  </span>
                ) : null}
                {staff.hospitalizationRiskBand ? (
                  <span style={{ fontSize: "0.85rem", color: t.onSurface }}>
                    Hospitalization risk:{" "}
                    <StatusPill
                      label={humanize(staff.hospitalizationRiskBand)}
                      tone={toneOf(RISK_BAND_TONE, staff.hospitalizationRiskBand)}
                    />{" "}
                    — advisory only. It alters no disposition option, and it is excluded from the
                    family portal projection by construction.
                  </span>
                ) : null}
              </div>
            </AiSuggestionCard>
          ) : (
            <span style={mutedStyle}>
              No AI advisory is available for this call — either the tenant opted out on the on-call
              policy, or the M32 capability is deny-stubbed pending Part-A `ai.full`. The panel is
              fully functional without it; an absent advisory is not a missing answer.
            </span>
          )}
        </Card>
      ) : null}

      {/* ── the protocol walk (D4 / D5) ─────────────────────────────────────────────────────────────── */}
      <Card
        title="Protocol"
        actions={
          protocol ? (
            <Link to={`/triage/protocols/${protocol.id}`} style={linkStyle}>
              Open the catalog entry
            </Link>
          ) : undefined
        }
      >
        {!call.selectedProtocolId ? (
          <>
            <span style={mutedStyle}>
              No protocol is pinned. Pinning one FREEZES its version onto this call: a catalog edit
              published mid-call does not switch the questions under you.
            </span>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => setCeremony("apply-protocol")}
            >
              Apply a protocol
            </button>
          </>
        ) : (
          <>
            <SummaryGrid>
              <Field
                label="Protocol"
                value={protocol?.chiefComplaintLabel ?? shortId(call.selectedProtocolId)}
              />
              <Field
                label="Version (frozen at open)"
                value={call.selectedProtocolVersion ?? "—"}
                mono
              />
              <Field
                label="Answered"
                value={`${call.answers.length} of ${protocol?.questions.length ?? "?"}`}
              />
            </SummaryGrid>

            {call.answers.length > 0 ? (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>#</th>
                    <th style={th}>Question</th>
                    <th style={th}>Answer</th>
                    <th style={th}>Red flag</th>
                    <th style={th}>Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {[...call.answers]
                    .sort(
                      (a, b) =>
                        a.questionOrder - b.questionOrder ||
                        a.answeredAt.localeCompare(b.answeredAt),
                    )
                    .map((a) => (
                      <tr key={a.id} style={rowLine}>
                        <td style={td}>{a.questionOrder}</td>
                        <td style={td}>
                          {a.prompt}
                          {a.correctionOfAnswerId ? (
                            <>
                              <br />
                              <span style={mutedStyle}>
                                correction of {shortId(a.correctionOfAnswerId)} — the original row
                                is kept, because a "no" later corrected to "yes" means the call HAD
                                a red flag
                              </span>
                            </>
                          ) : null}
                        </td>
                        <td style={td}>
                          {a.valueBool !== null
                            ? a.valueBool
                              ? "Yes"
                              : "No"
                            : a.valueInt !== null
                              ? String(a.valueInt)
                              : (a.valueText ?? "—")}
                        </td>
                        <td style={td}>
                          {a.redFlagHit ? <StatusPill label="Red flag" tone="error" /> : "—"}
                        </td>
                        <td style={td}>{dateTime(a.answeredAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : null}

            {nextQuestion ? (
              <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
                <p style={{ margin: 0, fontSize: "0.9rem", color: t.onSurface }}>
                  <strong>
                    Q{nextQuestion.questionOrder}. {nextQuestion.prompt}
                  </strong>
                  {nextQuestion.isRedFlagQuestion ? (
                    <>
                      {" "}
                      <StatusPill label="Red-flag question" tone="critical" />
                    </>
                  ) : null}
                </p>
                {nextQuestion.answerType === "boolean" ? (
                  <SelectField
                    label="Answer"
                    value={answerBool}
                    options={[
                      { value: "true", label: "Yes" },
                      { value: "false", label: "No" },
                    ]}
                    onChange={setAnswerBool}
                  />
                ) : nextQuestion.answerType === "integer" ||
                  nextQuestion.answerType === "scale_0_10" ? (
                  <TextField
                    label={nextQuestion.answerType === "scale_0_10" ? "Answer (0–10)" : "Answer"}
                    value={answerInt}
                    onChange={setAnswerInt}
                    type="number"
                  />
                ) : nextQuestion.answerType === "enum" ? (
                  <SelectField
                    label="Answer"
                    value={answerText}
                    options={enumOptions(nextQuestion.answerEnumValues ?? [])}
                    onChange={setAnswerText}
                  />
                ) : (
                  <TextAreaField
                    label="Answer"
                    value={answerText}
                    onChange={setAnswerText}
                    rows={3}
                  />
                )}
                <div>
                  <button
                    type="button"
                    style={busy ? disabledButtonStyle : primaryButtonStyle}
                    disabled={busy}
                    onClick={() => void submitAnswer()}
                  >
                    Record the answer
                  </button>
                </div>
                <span style={mutedStyle}>
                  The server decides which question comes next and evaluates the red-flag predicate
                  in the same transaction as the answer. There is no way to skip ahead from here, by
                  design.
                </span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
                <span style={mutedStyle}>
                  {answered.size > 0
                    ? "The server's cursor has reached the end of the walk."
                    : "No question is outstanding."}
                </span>
                {call.state === "protocol_in_progress" ? (
                  <div>
                    <button
                      type="button"
                      style={busy ? disabledButtonStyle : primaryButtonStyle}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => completeProtocol(client, triageCallId, version),
                          "The protocol could not be completed.",
                        )
                      }
                    >
                      Complete the protocol
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── D15 medication context ──────────────────────────────────────────────────────────────────── */}
      {staff ? (
        <Card title="Medications & refills (read-only)">
          {!activeMedications || !pendingRefills ? (
            <span style={mutedStyle}>
              No medication context was loaded for this call — it is fetched once the caller is
              resolved to a served person.
            </span>
          ) : (
            <>
              {activeMedications.kind === "unavailable" ? (
                <Notice tone="warning" live>
                  <strong>Medication list unavailable</strong> — {activeMedications.reason}. This is
                  NOT "no active medications": an outage rendered as an empty list is how a
                  clinician authorizes against a chart they believe is empty.
                </Notice>
              ) : activeMedications.items.length === 0 ? (
                <span style={mutedStyle}>No active medications are on file for this patient.</span>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={th}>Medication</th>
                      <th style={th}>Route</th>
                      <th style={th}>PRN</th>
                      <th style={th}>Controlled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMedications.items.map((m) => (
                      <tr key={m.medicationOrderId} style={rowLine}>
                        <td style={td}>{m.display}</td>
                        <td style={td}>{m.route}</td>
                        <td style={td}>{m.asNeeded ? "PRN" : "—"}</td>
                        <td style={td}>
                          {m.isControlledSubstance ? (
                            <StatusPill label={m.deaSchedule ?? "Controlled"} tone="critical" />
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {sudRedactedCount > 0 ? (
                <Notice tone="warning" live>
                  {sudRedactedCount} medication
                  {sudRedactedCount === 1 ? " is" : "s are"} withheld under 42 CFR Part 2. The list
                  above is incomplete as shown — the count travels so the omission is visible
                  without the content being.
                </Notice>
              ) : null}
              {pendingRefills.kind === "unavailable" ? (
                <Notice tone="warning" live>
                  <strong>Refill inbox unavailable</strong> — {pendingRefills.reason}. M12 can be
                  half-up; the two slices are reported separately for exactly that reason.
                </Notice>
              ) : (
                <span style={mutedStyle}>
                  {pendingRefills.items.length} pending refill
                  {pendingRefills.items.length === 1 ? "" : "s"} on file. M19 reads M12 and never
                  writes it: an authorization taken on this call becomes the PRN disposition, and
                  M12's own consumer acts on the event that disposition emits.
                </span>
              )}
            </>
          )}
        </Card>
      ) : null}

      {/* ── escalations (D7) ────────────────────────────────────────────────────────────────────────── */}
      <Card
        title="Escalations"
        actions={
          <Link to="/triage/escalations" style={linkStyle}>
            Escalation inbox
          </Link>
        }
      >
        {call.escalations.length === 0 ? (
          <span style={mutedStyle}>No escalation has been raised on this call.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Tier</th>
                <th style={th}>Trigger</th>
                <th style={th}>State</th>
                <th style={th}>Mandatory</th>
                <th style={th}>Raised</th>
                <th style={th}>Acknowledged</th>
              </tr>
            </thead>
            <tbody>
              {call.escalations.map((e) => (
                <tr key={e.id} style={rowLine}>
                  <td style={td}>
                    <TierPill tier={e.tier} />
                  </td>
                  <td style={td}>{humanize(e.triggerKind)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(e.state)}
                      tone={toneOf(ESCALATION_STATE_TONE, e.state)}
                    />
                  </td>
                  <td style={td}>
                    {e.mandatory ? <StatusPill label="Platform floor" tone="critical" /> : "—"}
                  </td>
                  <td style={td}>{dateTime(e.escalatedAt)}</td>
                  <td style={td}>{dateTime(e.acknowledgedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {openMandatory.length > 0 ? (
          <span style={mutedStyle}>
            A mandatory row may only reach `resolved` through an explicit write by the escalated
            party, on the escalation inbox. Closing the call does not clear it — the whole point is
            that the agency can prove a named human answered.
          </span>
        ) : null}
      </Card>

      {/* ── disposition + documentation (D6 / D8) ───────────────────────────────────────────────────── */}
      <Card title="Disposition">
        {staff?.disposition ? (
          <SummaryGrid>
            <Field label="Selected" value={dispositionLabel(staff.disposition)} />
            {staff ? <Field label="Documented" value={dateTime(staff.documentedAt)} /> : null}
            {staff ? (
              <Field
                label="Linked encounter"
                value={
                  staff.linkedEncounterId ? shortId(staff.linkedEncounterId) : "not yet created"
                }
                mono={Boolean(staff?.linkedEncounterId)}
              />
            ) : null}
          </SummaryGrid>
        ) : (
          <span style={mutedStyle}>
            No disposition selected. Your selector below carries exactly the set the server
            evaluated for you — {call.permittedDispositions.length} of the eight. A disposition
            outside it is refused server-side, not merely hidden here.
          </span>
        )}
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button
            type="button"
            style={
              blocked || call.permittedDispositions.length === 0
                ? disabledButtonStyle
                : primaryButtonStyle
            }
            disabled={blocked || call.permittedDispositions.length === 0}
            title={
              blocked
                ? "A mandatory escalation on this call is unacknowledged (§7.2)."
                : call.permittedDispositions.length === 0
                  ? "Your role holds no disposition on this call."
                  : undefined
            }
            onClick={() => {
              setDisposition(call.permittedDispositions[0] ?? "");
              setCeremony("disposition");
            }}
          >
            Select a disposition
          </button>
          {call.state === "disposition_pending" || call.state === "documented_pending_encounter" ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("document")}>
              Create the encounter
            </button>
          ) : null}
        </div>
        <span style={mutedStyle}>
          Creating the encounter does NOT close the call: the record advances when the encounter is
          SIGNED, which is the `m8.encounter.signed` consumer's transition, not this button's.
          §5.1's verbal-order button is absent for a related reason — a verbal order is M11's write
          behind a step-up asserted at the seam invocation, and M19 publishes no route that mints
          one. Record the order in M11, then select the verbal-order disposition here with the id
          M11 returned.
        </span>
      </Card>

      {/* ── state narrative ─────────────────────────────────────────────────────────────────────────── */}
      {staff ? (
        <Card title="State history">
          {staff.stateHistory.length === 0 ? (
            <span style={mutedStyle}>No transition has been recorded yet.</span>
          ) : (
            <Timeline
              entries={staff.stateHistory.map((h) => ({
                label: `${h.fromState ? `${humanize(h.fromState)} → ` : ""}${humanize(h.toState)}`,
                at: dateTime(h.transitionedAt),
                by: h.systemActor
                  ? "system"
                  : h.actorMembershipId
                    ? shortId(h.actorMembershipId)
                    : null,
              }))}
            />
          )}
        </Card>
      ) : null}

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {/* ── ceremonies ──────────────────────────────────────────────────────────────────────────────── */}
      {ceremony === "identify" ? (
        <Modal
          title="Identify the patient"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy || !UUID_RE.test(patientId) || !UUID_RE.test(admissionId)}
              style={
                busy || !UUID_RE.test(patientId) || !UUID_RE.test(admissionId)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () => identifyPatient(client, triageCallId, version, { patientId, admissionId }),
                  "The patient could not be linked to this call.",
                )
              }
            >
              Link
            </button>
          }
        >
          <p style={mutedStyle}>
            Both ids are required: M8's encounter creator needs patient AND admission NOT NULL, so a
            call carrying only one of the two can never be documented.
          </p>
          <PatientLookupField
            label="Patient"
            value={patientId}
            onChange={(id) => {
              setPatientId(id);
              setAdmissionId("");
            }}
            appearance="modal"
          />
          <AdmissionLookupField
            label="Admission"
            value={admissionId}
            patientId={patientId}
            onChange={setAdmissionId}
            appearance="modal"
          />
        </Modal>
      ) : null}

      {ceremony === "apply-protocol" ? (
        <Modal
          title="Apply a protocol"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={
                busy ||
                !protocolChoice ||
                (overrideNeedsReason && overrideReason.trim().length < AI_OVERRIDE_REASON_MIN_CHARS)
              }
              style={
                busy ||
                !protocolChoice ||
                (overrideNeedsReason && overrideReason.trim().length < AI_OVERRIDE_REASON_MIN_CHARS)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    applyProtocol(client, triageCallId, version, {
                      triageProtocolId: protocolChoice,
                      ...(overrideReason.trim() ? { aiOverrideReason: overrideReason } : {}),
                    }),
                  "The protocol could not be applied.",
                )
              }
            >
              Apply
            </button>
          }
        >
          <SelectField
            label="Protocol"
            value={protocolChoice}
            options={[{ value: "", label: "select…" }].concat(
              [...catalog]
                .sort(
                  (a, b) =>
                    a.sortOrder - b.sortOrder ||
                    a.chiefComplaintLabel.localeCompare(b.chiefComplaintLabel),
                )
                .map((p) => ({
                  value: p.id,
                  label: `${p.chiefComplaintLabel}${p.isSystemLocked ? " ✓ platform" : ""}${
                    p.requiresMandatoryEscalation ? " · mandatory escalation" : ""
                  }`,
                })),
            )}
            onChange={setProtocolChoice}
          />
          {overrideNeedsReason ? (
            <TextAreaField
              label={`Why you are not using the suggested protocol (≥ ${AI_OVERRIDE_REASON_MIN_CHARS} chars)`}
              value={overrideReason}
              onChange={setOverrideReason}
              rows={3}
              hint="The suggestion was at or above the governance floor, so the override is recorded to the AI-governance audit channel with your reason."
            />
          ) : (
            <span style={mutedStyle}>
              No override reason is required here. Below the governance floor a reason is not
              demanded — that is deliberate: demanding a justification for ignoring a low-confidence
              guess is how a governance field becomes a field everyone types "n/a" into.
            </span>
          )}
          <span style={mutedStyle}>
            Applying a protocol whose catalog row demands it writes the mandatory escalation in the
            SAME transaction. A platform-floor protocol carries ✓ and cannot be edited by the
            tenant.
          </span>
        </Modal>
      ) : null}

      {ceremony === "callback" ? (
        <Modal
          title="Park on a callback"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy || callbackReason.trim().length < 20}
              style={
                busy || callbackReason.trim().length < 20 ? disabledButtonStyle : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    markAwaitingCallback(client, triageCallId, version, {
                      reason: callbackReason,
                      ...(callbackTargetAt
                        ? { callbackTargetAt: toInstant(callbackTargetAt) }
                        : {}),
                    }),
                  "The call could not be parked.",
                )
              }
            >
              Park
            </button>
          }
        >
          <TextAreaField
            label="Why (≥ 20 chars)"
            value={callbackReason}
            onChange={setCallbackReason}
            rows={3}
          />
          <TextField
            label="Call back by (optional)"
            value={callbackTargetAt}
            onChange={setCallbackTargetAt}
            type="datetime-local"
            hint="Left blank, the tenant policy's per-severity callback minutes apply. The call keeps its place on the board either way."
          />
        </Modal>
      ) : null}

      {ceremony === "escalate" ? (
        <Modal
          title="Escalate"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy || escalationReason.trim().length < 30}
              style={
                busy || escalationReason.trim().length < 30
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    escalate(client, triageCallId, version, {
                      // `tier` is always one of ESCALATION_TIERS — the SelectField below offers no other value.
                      tier: tier as EscalationTier,
                      reason: escalationReason,
                      ...(UUID_RE.test(escalateTo) ? { escalatedToMembershipId: escalateTo } : {}),
                      ...(handOff ? { handOffCall: true } : {}),
                    }),
                  "The escalation could not be raised.",
                )
              }
            >
              Raise the page
            </button>
          }
        >
          <SelectField
            label="Tier"
            value={tier}
            options={ESCALATION_TIERS.map((x) => ({ value: x, label: tierLabel(x) }))}
            onChange={setTier}
          />
          <TextAreaField
            label="Why (≥ 30 chars)"
            value={escalationReason}
            onChange={setEscalationReason}
            rows={3}
          />
          <TextField
            label="Escalate to (membership id, optional)"
            value={escalateTo}
            onChange={setEscalateTo}
            mono
            hint="Leave blank to let the tenant escalation ladder resolve the recipient. This is the ONE membership id a caller may supply — every attribution column is stamped from your session."
          />
          <SelectField
            label="Also hand the call off"
            value={handOff ? "yes" : "no"}
            options={[
              { value: "no", label: "No — record the rung, keep working the call" },
              { value: "yes", label: "Yes — move the call to escalated / unresolved" },
            ]}
            onChange={(v) => setHandOff(v === "yes")}
          />
        </Modal>
      ) : null}

      {ceremony === "document" ? (
        <Modal
          title="Create the encounter"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy}
              style={busy ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    documentCall(client, triageCallId, version, {
                      ...(narrative.trim() ? { narrativeSummary: narrative } : {}),
                    }),
                  "The encounter could not be created.",
                )
              }
            >
              Create
            </button>
          }
        >
          <p style={mutedStyle}>
            This invokes M8's encounter creator — the only path from M19 to a clinical record. The
            call does not reach `documented` here; it advances when the encounter is SIGNED.
          </p>
          <TextAreaField
            label="Narrative summary (optional)"
            value={narrative}
            onChange={setNarrative}
            rows={5}
          />
        </Modal>
      ) : null}

      {ceremony === "abandon" ? (
        <Modal
          title="The caller disconnected"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy || abandonReason.trim().length < 1}
              style={
                busy || abandonReason.trim().length < 1 ? disabledButtonStyle : primaryButtonStyle
              }
              onClick={() =>
                void run(
                  () =>
                    abandonCall(client, triageCallId, version, {
                      reason: abandonReason,
                      callbackAttempts: Math.max(0, Number(callbackAttempts) || 0),
                    }),
                  "The call could not be marked abandoned.",
                )
              }
            >
              Mark abandoned
            </button>
          }
        >
          <Notice tone="warning">
            A mandatory escalation still blocks this: "the caller hung up" is not an answer to "did
            a human respond to the suicidal-ideation page?".
          </Notice>
          <TextAreaField
            label="What happened"
            value={abandonReason}
            onChange={setAbandonReason}
            rows={3}
          />
          <TextField
            label="Callback attempts made"
            value={callbackAttempts}
            onChange={setCallbackAttempts}
            type="number"
          />
        </Modal>
      ) : null}

      {ceremony === "disposition" ? (
        <Modal
          title="Select a disposition"
          onClose={() => setCeremony(null)}
          footer={
            <button
              type="button"
              disabled={busy || !dispositionData}
              style={busy || !dispositionData ? disabledButtonStyle : primaryButtonStyle}
              title={
                dispositionData ? undefined : "This disposition's required fields are not complete."
              }
              onClick={() =>
                dispositionData
                  ? void run(
                      () => selectDisposition(client, triageCallId, version, dispositionData),
                      "The disposition could not be recorded.",
                    )
                  : undefined
              }
            >
              Commit
            </button>
          }
        >
          {/* §5.4 — a radio-group, keyboard-navigable, `aria-required`. The set is the SERVER's. */}
          <fieldset
            style={{
              border: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
            }}
          >
            <legend style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>Disposition</legend>
            {call.permittedDispositions.map((d) => (
              <label
                key={d}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  fontSize: "0.85rem",
                  color: t.onSurface,
                }}
              >
                <input
                  type="radio"
                  name="triage-disposition"
                  value={d}
                  aria-required="true"
                  checked={disposition === d}
                  onChange={() => setDisposition(d)}
                />
                {dispositionLabel(d)}
              </label>
            ))}
          </fieldset>

          {disposition === "caregiver_education_only" ? (
            <>
              <TextAreaField
                label="What you taught the caregiver (≥ 30 chars)"
                value={dSummary}
                onChange={setDSummary}
                rows={4}
              />
              <TextField
                label="Follow-up call at (optional)"
                value={dFollowUpAt}
                onChange={setDFollowUpAt}
                type="datetime-local"
              />
            </>
          ) : null}

          {disposition === "prn_intervention_authorized" ? (
            <>
              <TextAreaField
                label="Instructions given (≥ 20 chars)"
                value={dInstructions}
                onChange={setDInstructions}
                rows={3}
              />
              <TextField
                label="Order id (optional)"
                value={dOrderRecordId}
                onChange={setDOrderRecordId}
                mono
              />
              <TextField
                label="Medication order id (optional)"
                value={dMedicationOrderId}
                onChange={setDMedicationOrderId}
                mono
                hint="Carried on the outbox event M12's own consumer acts on. M19 never writes M12 directly."
              />
            </>
          ) : null}

          {disposition === "verbal_order_recorded" ? (
            <>
              <Notice tone="info">
                Record the verbal order in M11 first, under its own step-up. This arm attests to an
                order that already exists — M19 mints none.
              </Notice>
              <TextField
                label="Order id (required)"
                value={dOrderRecordId}
                onChange={setDOrderRecordId}
                mono
              />
              <TextField
                label="Attending physician id (optional)"
                value={dAttendingPhysicianId}
                onChange={setDAttendingPhysicianId}
                mono
              />
            </>
          ) : null}

          {disposition === "visit_dispatched_now" ||
          disposition === "visit_scheduled_first_light" ? (
            <>
              <TextField
                label="Discipline requested"
                value={dDiscipline}
                onChange={setDDiscipline}
              />
              {disposition === "visit_dispatched_now" ? (
                <TextField
                  label="Arrival by"
                  value={dArrivalBy}
                  onChange={setDArrivalBy}
                  type="datetime-local"
                />
              ) : (
                <TextField
                  label="Proposed for"
                  value={dProposedForDate}
                  onChange={setDProposedForDate}
                  type="date"
                />
              )}
              <TextAreaField
                label="Clinical reason (≥ 30 chars)"
                value={dReason}
                onChange={setDReason}
                rows={3}
              />
            </>
          ) : null}

          {disposition === "gip_admission_proposed" ? (
            <>
              <TextAreaField
                label="GIP criteria met (≥ 60 chars)"
                value={dSummary}
                onChange={setDSummary}
                rows={4}
              />
              <TextField
                label="Preferred facility id (optional)"
                value={dPreferredFacility}
                onChange={setDPreferredFacility}
                mono
              />
            </>
          ) : null}

          {disposition === "ed_transfer_acknowledged" ? (
            <>
              <TextAreaField
                label="The family's election, verbatim (≥ 60 chars)"
                value={dSummary}
                onChange={setDSummary}
                rows={4}
                hint="CMS 418.52 — the election against clinical recommendation is recorded in the family's own words, not summarised."
              />
              <SelectField
                label="Transport arranged by"
                value={dTransport}
                options={enumOptions(TRANSPORT_ARRANGERS)}
                onChange={setDTransport}
              />
            </>
          ) : null}

          {disposition === "pronouncement_scheduled" ? (
            <>
              <TextField
                label="Pronouncing discipline"
                value={dDiscipline}
                onChange={setDDiscipline}
              />
              <TextField
                label="Expected arrival by (optional)"
                value={dArrivalBy}
                onChange={setDArrivalBy}
                type="datetime-local"
              />
            </>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
