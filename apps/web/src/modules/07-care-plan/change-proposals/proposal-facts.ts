// apps/web/src/modules/07-care-plan/change-proposals — what one proposal says, as plain label/value facts and a one-line summary.
// Pure: shared by the review list's drawer and the composer's list of this visit's drafts.
import {
  DISCIPLINE_LABEL,
  DISMISSAL_REASON_LABEL,
  GOAL_SOURCE_LABEL,
  GOAL_STATUS_LABEL,
  KIND_LABEL,
  PROBLEM_KIND_LABEL,
  PROBLEM_SOURCE_LABEL,
} from "./proposal-labels";
import type { ChangeProposal } from "./proposal-types";

export interface ProposalFact {
  readonly label: string;
  readonly value: string;
}

const MISSING_NAME = "Name unavailable";
const NEW_PROBLEM_LABEL = "A new problem proposed in this visit";

/** A moment in the viewer's own time zone ("Nov 18, 2026"). */
export function dateOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A calendar day stored as a UTC date-time (a goal's target, a problem's onset): read in UTC so a US clinician's Dec 1 stays Dec 1. */
export function calendarDayOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

export const nameOf = (member: { displayName: string | null } | null | undefined): string =>
  member?.displayName?.trim() || MISSING_NAME;

/** The text a proposal mainly carries: what the reviewer reads first. */
export function proposalSummary(p: ChangeProposal): string {
  const c = p.change;
  switch (p.kind) {
    case "problem_add":
      return c.description ?? "";
    case "problem_resolve":
      return c.resolutionNote ?? "";
    case "goal_add":
      return c.originalText ?? "";
    case "goal_update":
      return (
        c.revisedText ??
        c.measurableOutcome ??
        (c.goalStatus ? `Status: ${GOAL_STATUS_LABEL[c.goalStatus]}` : "")
      );
    case "intervention_add":
      return c.scopeText ?? "";
    case "intervention_discontinue":
      return c.reason ?? "";
  }
}

/** What the plan calls the element this change touches ("" for a new problem). */
export function targetLabelOf(p: ChangeProposal): string {
  if (!p.target) return "";
  return p.target.label ?? (p.parentProposalId ? NEW_PROBLEM_LABEL : "");
}

function pushIf(out: ProposalFact[], label: string, value: string | null | undefined): void {
  if (value) out.push({ label, value });
}

/** The proposed fields in reading order; a field the kind does not carry (null) is left out. */
function changeFacts(p: ChangeProposal): ProposalFact[] {
  const c = p.change;
  const out: ProposalFact[] = [];
  const target = targetLabelOf(p);
  switch (p.kind) {
    case "problem_add":
      pushIf(out, "Problem", c.description);
      pushIf(out, "Type", c.problemKind && PROBLEM_KIND_LABEL[c.problemKind]);
      pushIf(out, "Source", c.problemSource && PROBLEM_SOURCE_LABEL[c.problemSource]);
      pushIf(out, "ICD-10 code", c.icd10Code);
      pushIf(out, "SNOMED code", c.snomedCode);
      pushIf(out, "Onset", calendarDayOf(c.onsetAt));
      break;
    case "problem_resolve":
      pushIf(out, "Problem", target);
      pushIf(out, "Resolution note", c.resolutionNote);
      break;
    case "goal_add":
      pushIf(out, "Linked problem", target);
      pushIf(out, "Goal", c.originalText);
      pushIf(out, "Source", c.goalSource && GOAL_SOURCE_LABEL[c.goalSource]);
      pushIf(out, "Measurable outcome", c.measurableOutcome);
      pushIf(out, "Target date", calendarDayOf(c.targetAt));
      break;
    case "goal_update":
      pushIf(out, "Goal", target);
      pushIf(out, "Revised goal", c.revisedText);
      pushIf(out, "Measurable outcome", c.measurableOutcome);
      pushIf(out, "New status", c.goalStatus && GOAL_STATUS_LABEL[c.goalStatus]);
      pushIf(out, "Target date", calendarDayOf(c.targetAt));
      break;
    case "intervention_add":
      pushIf(out, "Linked problem", target);
      pushIf(out, "Intervention", c.scopeText);
      pushIf(out, "Frequency", [c.frequencyText, c.frequencyValue].filter(Boolean).join(" · "));
      pushIf(out, "Discipline", c.discipline && DISCIPLINE_LABEL[c.discipline]);
      pushIf(out, "Responsible role", c.responsibleRole);
      if (c.goalRefs.length > 0) {
        pushIf(
          out,
          "Supports",
          `${c.goalRefs.length} existing goal${c.goalRefs.length === 1 ? "" : "s"}`,
        );
      }
      break;
    case "intervention_discontinue":
      pushIf(out, "Intervention", target);
      pushIf(out, "Reason", c.reason);
      break;
  }
  return out;
}

/** Every fact the reviewer needs: the change, then who proposed it and what became of it. */
export function proposalFacts(p: ChangeProposal): ProposalFact[] {
  const out = changeFacts(p);
  if (p.sudRelated)
    out.push({ label: "Sensitive content", value: "Substance use disorder related" });
  out.push({ label: "Proposed by", value: nameOf(p.proposedBy) });
  pushIf(out, "Recorded", dateOf(p.proposedAt));
  if (p.decidedBy || p.decidedAt) {
    const verb = p.status === "dismissed" ? "Dismissed by" : "Decided by";
    pushIf(out, verb, nameOf(p.decidedBy));
    pushIf(out, "Decided", dateOf(p.decidedAt));
  }
  pushIf(out, "Dismissal reason", p.dismissalReason && DISMISSAL_REASON_LABEL[p.dismissalReason]);
  return out;
}

/** "Add goal" or "Add goal: <what the plan calls the element>". */
export function proposalHeading(p: ChangeProposal): string {
  const target = targetLabelOf(p);
  return target ? `${KIND_LABEL[p.kind]}: ${target}` : KIND_LABEL[p.kind];
}
