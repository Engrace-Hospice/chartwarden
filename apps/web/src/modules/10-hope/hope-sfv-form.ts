// apps/web/src/modules/10-hope — the state of the SFV completion form: what the clinician has entered and whether
// the form may be submitted. A hook rather than component state so the dialog's parts stay small.
import { useMemo, useState } from "react";
import { useSession } from "../../shell/session";
import { peekStepUpDraft } from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import { type SfvAuthorDiscipline, authorDisciplinesForRoles, localToday } from "./hope-api";
import { type SfvDraft, sfvDraftKey } from "./hope-sfv-draft";

/** The triggering assessment the SFV is completed against. */
export interface SfvDialogAssessment {
  readonly id: string;
  readonly admissionId?: string;
}

/** One J2053 question: the workspace item the dialog asks and answers. */
export interface SfvDialogItem {
  readonly itemCode: string;
  readonly label: string;
  /** The workspace item's own CMS answer options (a workspace item carries them); the J2053 set stands in when there are none. */
  readonly options?: readonly {
    readonly valueCode: string;
    readonly label: string;
    readonly sortOrder?: number;
  }[];
}

/** What is still missing from the form, each as a short phrase that completes "To complete: …". */
function missingFor(state: {
  hasAdmission: boolean;
  date: string;
  discipline: string;
  canAuthor: boolean;
  questionCount: number;
  answeredCount: number;
  attested: boolean;
}): string[] {
  const left = state.questionCount - state.answeredCount;
  return [
    state.hasAdmission ? null : "an admission for this record",
    state.canAuthor
      ? state.discipline === ""
        ? "choose the author discipline"
        : null
      : "a role that may author an SFV",
    state.date === "" ? "enter the visit date" : null,
    state.questionCount === 0
      ? "reassessment questions for this record"
      : left > 0
        ? `answer ${left} more item${left === 1 ? "" : "s"}`
        : null,
    state.attested ? null : "tick the attestation",
  ].filter((phrase): phrase is string => phrase !== null);
}

export function useSfvForm(assessment: SfvDialogAssessment, items: readonly SfvDialogItem[]) {
  // Returning from /step-up: start from what the clinician had typed (read, not taken, so StrictMode's double
  // render is harmless; it is cleared on submit or cancel). The attestation is never restored.
  const draftKey = sfvDraftKey(useStepUpOwner(), assessment.id);
  const [restored] = useState(() => peekStepUpDraft<SfvDraft>(draftKey));
  const [initialDate] = useState(() => restored?.date ?? localToday());

  // The server binds the author to the caller's OWN role keys (403 M10_DISCIPLINE_NOT_PERMITTED otherwise), so only
  // those are offered: one is preselected, two or more make the clinician choose, none says so.
  const session = useSession();
  const authorRoles = useMemo(
    () => authorDisciplinesForRoles(session?.roles ?? [], { sfv: true }),
    [session],
  );
  const [initialDiscipline] = useState<SfvAuthorDiscipline | "">(() =>
    restored && authorRoles.includes(restored.discipline)
      ? restored.discipline
      : authorRoles.length === 1
        ? (authorRoles[0] ?? "")
        : "",
  );

  const [date, setDate] = useState(initialDate);
  const [discipline, setDiscipline] = useState<SfvAuthorDiscipline | "">(initialDiscipline);
  const [answers, setAnswers] = useState<Record<string, string>>({ ...restored?.answers });
  // R-05: completing an SFV records a signed record, so the signer attests first.
  const [attested, setAttested] = useState(false);

  const questions = useMemo(
    () => items.filter((item) => /^J2053[A-H]$/.test(item.itemCode)),
    [items],
  );
  const answeredCount = questions.filter((q) => Boolean(answers[q.itemCode])).length;
  const missing = missingFor({
    hasAdmission: Boolean(assessment.admissionId),
    date,
    discipline,
    canAuthor: authorRoles.length > 0,
    questionCount: questions.length,
    answeredCount,
    attested,
  });
  const dirty = answeredCount > 0 || date !== initialDate || discipline !== initialDiscipline;

  return {
    draftKey,
    authorRoles,
    date,
    setDate,
    discipline,
    setDiscipline,
    answers,
    setAnswer: (itemCode: string, value: string) =>
      setAnswers((previous) => ({ ...previous, [itemCode]: value })),
    attested,
    setAttested,
    questions,
    answeredCount,
    /** What stands between the clinician and a submittable form, as phrases the dialog shows. Empty: ready. */
    missing,
    canSubmit: missing.length === 0,
    dirty,
  };
}

export type SfvForm = ReturnType<typeof useSfvForm>;
