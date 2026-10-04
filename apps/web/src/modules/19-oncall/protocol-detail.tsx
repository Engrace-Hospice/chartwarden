// apps/web/src/modules/19-oncall — S19.8 SINGLE-PROTOCOL DETAIL (`/triage/protocols/:protocolId`, §5.1,
// Track B / ADR-0030). The question-set editor, with the D5 red-flag predicate beside each question.
//
// THE RED-FLAG PREDICATE IS A CLOSED, DECLARATIVE UNION — never an expression string — and this editor
// composes it arm by arm. That is the whole design: `redFlagMatch` decides whether a suicidal-ideation
// answer writes a mandatory escalation, and if it were a snippet the catalog evaluated, a tenant-authored
// protocol would be arbitrary code running inside the escalation path, failing at 2 a.m. in the direction
// of NOT escalating. Each arm also names exactly one typed answer column, so the editor offers only the
// arms that match the question's answer type — a predicate can never be evaluated against a column the
// question does not write.
//
// A SYSTEM-LOCKED QUESTION HAS NO EDIT AFFORDANCE, rather than an affordance that fails. It is the D5
// predicate behind a platform-floor mandatory escalation, and editing it is the cheapest way to disable
// one; the server refuses, and this screen does not offer.
//
// §5.1's "version history" is not a panel here: `triage_protocol` keeps one row per version with effective
// dates, and the catalog list — filtered to include retired rows — IS the history. A second, prettier
// rendering of the same rows on this page would be a second answer to "which version was in force".
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type EscalationTier,
  type TriageAnswerType,
  type TriageProtocolView,
  type TriageRedFlagMatch,
  addProtocolQuestion,
  errorMessage,
  getProtocol,
  patchProtocol,
  patchProtocolQuestion,
} from "./oncall-api";
import {
  ANSWER_TYPES,
  DEFAULT_ANSWER_TYPE,
  DEFAULT_ESCALATION_TIER,
  ESCALATION_TIERS,
  disciplineLabel,
  humanize,
  redFlagMatchLabel,
  shortDate,
  tierLabel,
} from "./oncall-status";
import {
  Card,
  CheckboxField,
  Field,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
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
} from "./oncall-ui";

/** Which predicate arms may be evaluated against which answer type. This mirrors the server's
 *  compile-time-checked mapping; offering an arm the column cannot carry would compose a predicate that
 *  never fires — the silent failure mode a red-flag question must not have. */
const ARMS_FOR: Record<string, readonly string[]> = {
  boolean: ["bool_is"],
  integer: ["int_at_least", "int_at_most"],
  scale_0_10: ["int_at_least", "int_at_most"],
  enum: ["enum_in"],
  free_text: ["text_any"],
};

const ARM_LABEL: Record<string, string> = {
  bool_is: "fires when the answer is…",
  int_at_least: "fires at or above…",
  int_at_most: "fires at or below…",
  enum_in: "fires on any of…",
  text_any: "fires when any text is recorded",
};

function buildMatch(
  arm: string,
  boolValue: string,
  threshold: string,
  values: string,
): TriageRedFlagMatch | null {
  switch (arm) {
    case "bool_is":
      return { kind: "bool_is", value: boolValue === "true" };
    case "int_at_least":
    case "int_at_most":
      return Number.isFinite(Number(threshold)) && threshold !== ""
        ? { kind: arm, threshold: Number(threshold) }
        : null;
    case "enum_in": {
      const list = values
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      return list.length > 0 ? { kind: "enum_in", values: list } : null;
    }
    case "text_any":
      return { kind: "text_any" };
    default:
      return null;
  }
}

export function TriageProtocolDetailScreen(): JSX.Element {
  const client = useApiClient();
  const { protocolId = "" } = useParams<{ protocolId: string }>();
  const [protocol, setProtocol] = useState<TriageProtocolView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // question fields
  const [order, setOrder] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [answerType, setAnswerType] = useState(DEFAULT_ANSWER_TYPE);
  const [enumValues, setEnumValues] = useState("");
  const [isRequired, setIsRequired] = useState(true);
  const [isRedFlag, setIsRedFlag] = useState(false);
  const [arm, setArm] = useState("bool_is");
  const [armBool, setArmBool] = useState("true");
  const [armThreshold, setArmThreshold] = useState("");
  const [armValues, setArmValues] = useState("");

  // header fields
  const [label, setLabel] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [tier, setTier] = useState(DEFAULT_ESCALATION_TIER);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getProtocol(client, protocolId);
    if (res.error || !res.protocol) {
      setError(errorMessage(res.error, "This protocol could not be loaded."));
      setLoading(false);
      return;
    }
    setProtocol(res.protocol);
    setLabel(res.protocol.chiefComplaintLabel);
    setMandatory(res.protocol.requiresMandatoryEscalation);
    setTier(res.protocol.mandatoryEscalationTier ?? DEFAULT_ESCALATION_TIER);
    setOrder(String(res.protocol.questions.length + 1));
    setLoading(false);
  }, [client, protocolId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !protocol) {
    return (
      <EmptyState title="Unavailable" description={error ?? "This protocol could not be loaded."} />
    );
  }

  const isPlatform = protocol.organizationId === null;
  const questions = [...protocol.questions].sort((a, b) => a.questionOrder - b.questionOrder);
  const allowedArms = ARMS_FOR[answerType] ?? [];
  const match = isRedFlag ? buildMatch(arm, armBool, armThreshold, armValues) : null;
  const canAdd = prompt.trim().length >= 3 && (!isRedFlag || match !== null) && !busy;

  async function run(fn: () => Promise<{ error: unknown }>, fallback: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await fn();
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, fallback));
      return;
    }
    setAdding(false);
    setEditingHeader(false);
    setPrompt("");
    setIsRedFlag(false);
    await load();
  }

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{protocol.chiefComplaintLabel}</span>}
        breadcrumb="On-call triage · protocol"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            {isPlatform ? (
              <StatusPill label="✓ Platform floor — read-only" tone="critical" />
            ) : (
              <>
                <button
                  type="button"
                  style={ghostButtonStyle}
                  onClick={() => setEditingHeader(true)}
                >
                  Edit
                </button>
                <button type="button" style={ghostButtonStyle} onClick={() => setAdding(true)}>
                  Add a question
                </button>
              </>
            )}
            <Link to="/triage/protocols" style={ghostButtonStyle}>
              Catalog
            </Link>
          </div>
        }
      />

      {isPlatform ? (
        <Notice tone="warning">
          This is a platform-floor protocol. It cannot be edited, its questions cannot be removed,
          and a question cannot be added to it — the row is org-less, so a tenant write is refused
          by the database as well as by the service. Author your own protocol if you need a stricter
          walk.
        </Notice>
      ) : null}

      {protocol.requiresMandatoryEscalation ? (
        <Notice tone="error">
          Applying this protocol raises a mandatory escalation
          {protocol.mandatoryEscalationTier
            ? ` at ${tierLabel(protocol.mandatoryEscalationTier)}`
            : ""}
          , written in the same transaction as the protocol is pinned. A tenant policy may raise
          that tier and may never lower it.
        </Notice>
      ) : null}

      <Card title="Protocol">
        <SummaryGrid>
          <Field label="Key" value={protocol.key} mono />
          <Field label="SNOMED" value={protocol.snomedCode} mono />
          <Field label="Discipline required" value={disciplineLabel(protocol.disciplineRequired)} />
          <Field label="Layer" value={isPlatform ? "Platform floor" : "Tenant-authored"} />
          <Field label="Version" value={protocol.version} mono />
          <Field label="Effective from" value={shortDate(protocol.effectiveFrom)} />
          <Field
            label="Effective to"
            value={protocol.effectiveTo ? shortDate(protocol.effectiveTo) : "in force"}
          />
          <Field label="Sort order" value={String(protocol.sortOrder)} />
        </SummaryGrid>
      </Card>

      <Card title="Questions">
        {questions.length === 0 ? (
          <span style={mutedStyle}>
            This protocol has no questions. A protocol with no questions can be pinned to a call but
            has no walk — add at least one before it is used at 2 a.m.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thNum}>#</th>
                <th style={th}>Prompt</th>
                <th style={th}>Answer type</th>
                <th style={th}>Required</th>
                <th style={th}>Red flag</th>
                <th style={th}>Predicate</th>
                <th style={th}>Locked</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id} style={rowLine}>
                  <td style={tdNum}>{q.questionOrder}</td>
                  <td style={td}>{q.prompt}</td>
                  <td style={td}>{humanize(q.answerType)}</td>
                  <td style={td}>{q.required ? "Yes" : "No"}</td>
                  <td style={td}>
                    {q.isRedFlagQuestion ? <StatusPill label="Red flag" tone="error" /> : "—"}
                  </td>
                  <td style={td}>
                    {q.isRedFlagQuestion ? redFlagMatchLabel(q.redFlagMatch) : "—"}
                  </td>
                  <td style={td}>
                    {q.isSystemLocked ? <StatusPill label="System locked" tone="critical" /> : "—"}
                  </td>
                  <td style={td}>
                    {q.isSystemLocked || isPlatform ? (
                      <span style={mutedStyle}>not editable</span>
                    ) : (
                      <button
                        type="button"
                        style={busy ? disabledButtonStyle : ghostButtonStyle}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => patchProtocolQuestion(client, q.id, { required: !q.required }),
                            "That question could not be updated.",
                          )
                        }
                      >
                        {q.required ? "Make optional" : "Make required"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          A question's order, prompt, answer type and predicate are set when it is added. The one
          in-place toggle offered here is required/optional, because it is the only edit that cannot
          change what a red-flag predicate is evaluated against — changing the answer type of an
          answered question would leave existing answers in a column the new predicate never reads.
        </span>
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {editingHeader ? (
        <Modal
          title="Edit the protocol"
          onClose={() => setEditingHeader(false)}
          footer={
            <button
              type="button"
              disabled={busy || label.trim().length < 3}
              style={busy || label.trim().length < 3 ? disabledButtonStyle : primaryButtonStyle}
              onClick={() =>
                void run(
                  () =>
                    patchProtocol(client, protocol.id, {
                      chiefComplaintLabel: label,
                      requiresMandatoryEscalation: mandatory,
                      // `tier` is always one of ESCALATION_TIERS — the SelectField below offers no other value.
                      mandatoryEscalationTier: mandatory ? (tier as EscalationTier) : null,
                    }),
                  "The protocol could not be updated.",
                )
              }
            >
              Save
            </button>
          }
        >
          <Notice tone="warning">This write needs a recent step-up.</Notice>
          <TextField label="Chief complaint label" value={label} onChange={setLabel} />
          <CheckboxField
            label="This protocol always escalates"
            checked={mandatory}
            onChange={setMandatory}
          />
          {mandatory ? (
            <SelectField
              label="Escalation tier"
              value={tier}
              options={ESCALATION_TIERS.map((x) => ({ value: x, label: tierLabel(x) }))}
              onChange={setTier}
            />
          ) : null}
        </Modal>
      ) : null}

      {adding ? (
        <Modal
          title="Add a question"
          onClose={() => setAdding(false)}
          footer={
            <button
              type="button"
              disabled={!canAdd}
              style={canAdd ? primaryButtonStyle : disabledButtonStyle}
              title={
                canAdd
                  ? undefined
                  : "A prompt of at least 3 characters is required, and a red-flag question needs a complete predicate."
              }
              onClick={() =>
                void run(
                  () =>
                    addProtocolQuestion(client, protocol.id, {
                      questionOrder: Math.max(1, Number(order) || 1),
                      prompt,
                      // `answerType` is always one of ANSWER_TYPES — the SelectField below offers no other value.
                      answerType: answerType as TriageAnswerType,
                      ...(answerType === "enum"
                        ? {
                            answerEnumValues: enumValues
                              .split(",")
                              .map((v) => v.trim())
                              .filter((v) => v.length > 0),
                          }
                        : {}),
                      required: isRequired,
                      isRedFlagQuestion: isRedFlag,
                      ...(isRedFlag && match ? { redFlagMatch: match } : {}),
                    }),
                  "The question could not be added.",
                )
              }
            >
              Add
            </button>
          }
        >
          <Notice tone="warning">This write needs a recent step-up.</Notice>
          <TextField label="Order" value={order} onChange={setOrder} type="number" />
          <TextField label="Prompt" value={prompt} onChange={setPrompt} />
          <SelectField
            label="Answer type"
            value={answerType}
            options={ANSWER_TYPES.map((a) => ({ value: a, label: humanize(a) }))}
            onChange={(v) => {
              setAnswerType(v);
              // Re-seat the predicate arm onto one this answer type can actually carry.
              setArm((ARMS_FOR[v] ?? [])[0] ?? "text_any");
            }}
          />
          {answerType === "enum" ? (
            <TextField
              label="Allowed values (comma-separated)"
              value={enumValues}
              onChange={setEnumValues}
            />
          ) : null}
          <CheckboxField label="Required" checked={isRequired} onChange={setIsRequired} />
          <CheckboxField
            label="This is a red-flag question"
            checked={isRedFlag}
            onChange={setIsRedFlag}
          />
          {isRedFlag ? (
            <>
              <SelectField
                label="Predicate"
                value={arm}
                options={allowedArms.map((a) => ({ value: a, label: ARM_LABEL[a] ?? a }))}
                onChange={setArm}
              />
              {arm === "bool_is" ? (
                <SelectField
                  label="…this answer"
                  value={armBool}
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  onChange={setArmBool}
                />
              ) : null}
              {arm === "int_at_least" || arm === "int_at_most" ? (
                <TextField
                  label="Threshold"
                  value={armThreshold}
                  onChange={setArmThreshold}
                  type="number"
                />
              ) : null}
              {arm === "enum_in" ? (
                <TextField
                  label="Fires on these values (comma-separated)"
                  value={armValues}
                  onChange={setArmValues}
                />
              ) : null}
              <span style={mutedStyle}>
                Only the predicate arms this answer type can carry are offered — a predicate
                evaluated against a column the question does not write would never fire, which is
                the one way a red-flag question can fail silently.
              </span>
            </>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
