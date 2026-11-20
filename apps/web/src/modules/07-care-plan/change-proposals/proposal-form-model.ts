// apps/web/src/modules/07-care-plan/change-proposals — the form state of one proposal and its mapping to the request body. Pure.
// Fields mirror the manual Care Plans routes (and the server's TypeBox limits, enforced here by `maxLength` on the inputs); the server
// stays the judge: `toChange` only refuses what could not possibly be sent (a missing required field, a malformed day).
import type {
  ChangeProposal,
  Discipline,
  GoalSource,
  GoalStatus,
  ProblemKind,
  ProblemSource,
  ProposalChange,
  ProposalKind,
} from "./proposal-types";

/** Limits from the server's contract (change-proposal-typebox.ts). */
export const LIMITS = {
  text: 4000,
  frequencyText: 200,
  frequencyValue: 64,
  responsibleRole: 64,
  icd10Code: 16,
  snomedCode: 32,
} as const;

/** `problem:<id>` names an existing problem, `proposal:<id>` a problem proposed in the same visit. */
export const PROBLEM_REF_PREFIX = "problem:";
export const PROPOSAL_REF_PREFIX = "proposal:";

export interface FormState {
  readonly description: string;
  readonly problemKind: ProblemKind;
  readonly problemSource: ProblemSource;
  readonly icd10Code: string;
  readonly snomedCode: string;
  readonly sudRelated: boolean;
  readonly onsetAt: string;
  readonly resolutionNote: string;
  readonly problemRef: string;
  readonly originalText: string;
  readonly goalSource: GoalSource;
  readonly measurableOutcome: string;
  readonly targetAt: string;
  readonly revisedText: string;
  /** "" means the goal's status does not change. */
  readonly goalStatus: GoalStatus | "";
  readonly goalRef: string;
  readonly scopeText: string;
  readonly frequencyText: string;
  readonly frequencyValue: string;
  readonly discipline: Discipline;
  readonly responsibleRole: string;
  readonly reason: string;
}

export type FormErrors = Readonly<Partial<Record<keyof FormState, string>>>;

export const emptyForm = (overrides: Partial<FormState> = {}): FormState => ({
  description: "",
  problemKind: "related",
  problemSource: "clinical",
  icd10Code: "",
  snomedCode: "",
  sudRelated: false,
  onsetAt: "",
  resolutionNote: "",
  problemRef: "",
  originalText: "",
  goalSource: "clinical",
  measurableOutcome: "",
  targetAt: "",
  revisedText: "",
  goalStatus: "",
  goalRef: "",
  scopeText: "",
  frequencyText: "",
  frequencyValue: "",
  discipline: "rn",
  responsibleRole: "",
  reason: "",
  ...overrides,
});

const dayOf = (iso: string | null): string => (iso ? iso.slice(0, 10) : "");

/** An existing proposal's fields as form state (to edit a draft in place). */
export function formFromProposal(p: ChangeProposal): FormState {
  const c = p.change;
  const problemRef = p.target?.id
    ? `${PROBLEM_REF_PREFIX}${p.target.id}`
    : p.parentProposalId
      ? `${PROPOSAL_REF_PREFIX}${p.parentProposalId}`
      : "";
  return emptyForm({
    description: c.description ?? "",
    problemKind: c.problemKind ?? "related",
    problemSource: c.problemSource ?? "clinical",
    icd10Code: c.icd10Code ?? "",
    snomedCode: c.snomedCode ?? "",
    sudRelated: p.sudRelated,
    onsetAt: dayOf(c.onsetAt),
    resolutionNote: c.resolutionNote ?? "",
    problemRef,
    originalText: c.originalText ?? "",
    goalSource: c.goalSource ?? "clinical",
    measurableOutcome: c.measurableOutcome ?? "",
    targetAt: dayOf(c.targetAt),
    revisedText: c.revisedText ?? "",
    goalStatus: c.goalStatus ?? "",
    goalRef: c.goalRefs[0] ?? "",
    scopeText: c.scopeText ?? "",
    frequencyText: c.frequencyText ?? "",
    frequencyValue: c.frequencyValue ?? "",
    discipline: c.discipline ?? "rn",
    responsibleRole: c.responsibleRole ?? "",
    reason: c.reason ?? "",
  });
}

export type ChangeResult =
  | { readonly ok: true; readonly change: ProposalChange }
  | { readonly ok: false; readonly errors: FormErrors };

const REQUIRED = "This field is required.";
const BAD_DAY = "Enter a valid date.";
const GOAL_UPDATE_EMPTY =
  "Change at least one of the revised goal, outcome, status or target date.";
const PICK_PROBLEM = "Choose the problem this belongs to.";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day from a date input as the date-time the contract wants: that day at UTC midnight (like the manual goal form). */
function dayToIso(day: string): string | null {
  if (!DAY.test(day) || Number.isNaN(Date.parse(day))) return null;
  return new Date(day).toISOString();
}

const text = (value: string): string => value.trim();
const optional = (value: string): string | undefined => text(value) || undefined;

/** Build the body for `kind` from the form, or say which fields cannot be sent. `targetId` is the element a resolve / update / discontinue names. */
export function toChange(kind: ProposalKind, form: FormState, targetId = ""): ChangeResult {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const need = (field: keyof FormState, value: string): string => {
    if (!text(value)) errors[field] = REQUIRED;
    return text(value);
  };
  const day = (field: "onsetAt" | "targetAt"): string | undefined => {
    const raw = form[field];
    if (!raw) return undefined;
    const iso = dayToIso(raw);
    if (!iso) errors[field] = BAD_DAY;
    return iso ?? undefined;
  };
  const problemTarget = (): { problemId?: string; parentProposalId?: string } => {
    if (form.problemRef.startsWith(PROBLEM_REF_PREFIX)) {
      return { problemId: form.problemRef.slice(PROBLEM_REF_PREFIX.length) };
    }
    if (form.problemRef.startsWith(PROPOSAL_REF_PREFIX)) {
      return { parentProposalId: form.problemRef.slice(PROPOSAL_REF_PREFIX.length) };
    }
    errors.problemRef = PICK_PROBLEM;
    return {};
  };

  let change: ProposalChange | null = null;
  switch (kind) {
    case "problem_add": {
      const description = need("description", form.description);
      const onsetAt = day("onsetAt");
      change = {
        kind,
        description,
        problemKind: form.problemKind,
        problemSource: form.problemSource,
        ...(optional(form.icd10Code) ? { icd10Code: text(form.icd10Code) } : {}),
        ...(optional(form.snomedCode) ? { snomedCode: text(form.snomedCode) } : {}),
        ...(form.sudRelated ? { sudRelated: true } : {}),
        ...(onsetAt ? { onsetAt } : {}),
      };
      break;
    }
    case "problem_resolve":
      change = {
        kind,
        problemId: targetId,
        resolutionNote: need("resolutionNote", form.resolutionNote),
      };
      break;
    case "goal_add": {
      const originalText = need("originalText", form.originalText);
      const targetAt = day("targetAt");
      change = {
        kind,
        ...problemTarget(),
        originalText,
        goalSource: form.goalSource,
        ...(optional(form.measurableOutcome)
          ? { measurableOutcome: text(form.measurableOutcome) }
          : {}),
        ...(targetAt ? { targetAt } : {}),
      };
      break;
    }
    case "goal_update": {
      const targetAt = day("targetAt");
      const revisedText = optional(form.revisedText);
      const measurableOutcome = optional(form.measurableOutcome);
      if (!revisedText && !measurableOutcome && !form.goalStatus && !form.targetAt) {
        errors.revisedText = GOAL_UPDATE_EMPTY;
      }
      change = {
        kind,
        goalId: targetId,
        ...(revisedText ? { revisedText } : {}),
        ...(measurableOutcome ? { measurableOutcome } : {}),
        ...(form.goalStatus ? { goalStatus: form.goalStatus } : {}),
        ...(targetAt ? { targetAt } : {}),
      };
      break;
    }
    case "intervention_add": {
      const scopeText = need("scopeText", form.scopeText);
      const frequencyText = need("frequencyText", form.frequencyText);
      const frequencyValue = need("frequencyValue", form.frequencyValue);
      change = {
        kind,
        ...problemTarget(),
        ...(form.goalRef ? { goalRefs: [form.goalRef] } : {}),
        scopeText,
        frequencyText,
        frequencyValue,
        discipline: form.discipline,
        ...(optional(form.responsibleRole) ? { responsibleRole: text(form.responsibleRole) } : {}),
      };
      break;
    }
    case "intervention_discontinue":
      change = { kind, interventionId: targetId, reason: need("reason", form.reason) };
      break;
  }
  return Object.keys(errors).length > 0 || !change ? { ok: false, errors } : { ok: true, change };
}

/** The server names the body's properties; the form names its own fields. These are the properties that differ. */
const SERVER_FIELD_TO_FORM: Readonly<Record<string, keyof FormState>> = {
  problemId: "problemRef",
  parentProposalId: "problemRef",
  goalId: "revisedText",
};

/** The server's per-property refusals (`fieldErrorsOf`) as errors beside the form's own fields; a property the form has no field for is left out. */
export function formErrorsFromServer(fields: Readonly<Record<string, string>>): FormErrors {
  const known = emptyForm();
  const out: Partial<Record<keyof FormState, string>> = {};
  for (const [property, message] of Object.entries(fields)) {
    const field =
      SERVER_FIELD_TO_FORM[property] ?? (property in known ? (property as keyof FormState) : null);
    if (field && !(field in out)) out[field] = message;
  }
  return out;
}
