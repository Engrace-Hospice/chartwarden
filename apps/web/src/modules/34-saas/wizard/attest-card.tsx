// apps/web/src/modules/34-saas/wizard — mark a step done with evidence. The evidence is recorded on the step and in your organization's
// audit trail, so the form says so and the server screens it for patient identifiers. A refusal keeps what was typed; a stale step-up
// offers Re-verify and carries the form through it in this tab's memory only: free text never goes to Web Storage.
import { Button, type OpsFailure, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX, RefObject } from "react";
import { FailureNotice } from "./failure-notice";
import { useOpsWrite } from "./use-ops-write";
import { useWizardDraft } from "./wizard-drafts";
import { viewHasMoved } from "./wizard-errors";
import type { WizardStep } from "./wizard-model";

const EVIDENCE_NOTE_MAX = 2000;
const EVIDENCE_REF_MAX = 500;

interface Draft {
  evidenceNote: string;
  evidenceRef: string;
}

/** The name the evidence form is kept under through a Re-verify (the frame reads the same one to reopen the card). */
export const attestDraftName = (stepKey: string): string => `attest:${stepKey}`;

export function AttestCard({
  step,
  headingRef,
  onDone,
  onCancel,
  onMoved,
}: {
  step: WizardStep;
  /** Where focus goes when the card opens (the frame returns it to the "Mark done" button when the card closes). */
  headingRef?: RefObject<HTMLHeadingElement>;
  /** The view is read again (after the write landed, or when the step moved under the person). */
  onDone: () => Promise<void>;
  onCancel: () => void;
  /** The step moved under the person (settled elsewhere, the organization left onboarding): the view has been read again. */
  onMoved: (failure: OpsFailure) => void;
}): JSX.Element {
  const client = useApiClient();
  const { restored, stash } = useWizardDraft<Draft>(attestDraftName(step.key));
  const [note, setNote] = useState(restored?.evidenceNote ?? "");
  const [ref, setRef] = useState(restored?.evidenceRef ?? "");
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const write = useOpsWrite();

  async function submit(): Promise<void> {
    const next: Partial<Record<keyof Draft, string>> = {};
    if (note.trim().length === 0) next.evidenceNote = "Say what was checked and by whom.";
    else if (note.trim().length > EVIDENCE_NOTE_MAX)
      next.evidenceNote = `At most ${EVIDENCE_NOTE_MAX} characters.`;
    if (ref.trim().length > EVIDENCE_REF_MAX)
      next.evidenceRef = `At most ${EVIDENCE_REF_MAX} characters.`;
    setErrors(next);
    const taskId = step.id;
    if (Object.keys(next).length > 0 || !taskId) return;

    const body = {
      evidenceNote: note.trim(),
      ...(ref.trim() ? { evidenceRef: ref.trim() } : {}),
    };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) =>
        client.POST("/api/v1/tenant/onboarding/{taskId}/attest", {
          params: { path: { taskId } },
          body,
          headers: { "Idempotency-Key": key },
        }),
      // the reload runs inside the write's in-flight window: a submit during it is dropped
      onDone,
    );
    if (outcome.ok) onCancel();
    else if (viewHasMoved(outcome.failure)) {
      await onDone();
      onMoved(outcome.failure);
    }
  }

  const failure = write.failure;
  const fieldError = (field: keyof Draft): string | undefined =>
    errors[field] ?? failure?.fieldErrors[field];

  return (
    <form
      className="wx-drawer-card"
      aria-label="Mark this step done"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="wx-drawer-card-head">
        <h3 ref={headingRef} tabIndex={-1}>
          Mark this step done
        </h3>
      </div>
      <p className="wx-row-sub">
        The evidence is recorded on the step and in your organization's audit trail. Describe what
        was checked without naming a patient.
      </p>
      <TextAreaField
        label="What was checked, and by whom"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={fieldError("evidenceNote")}
      />
      <TextField
        label="Reference (optional)"
        hint="A ticket or a document title."
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        error={fieldError("evidenceRef")}
      />
      {failure ? (
        <FailureNotice
          failure={failure}
          inputFields={["evidenceNote", "evidenceRef"]}
          onReverify={() => stash({ evidenceNote: note, evidenceRef: ref })}
        />
      ) : null}
      <div className="wx-drawer-actions">
        <Button tone="secondary" onClick={onCancel} disabled={write.busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={write.busy}>
          {write.busy ? "Saving…" : "Save and mark done"}
        </Button>
      </div>
    </form>
  );
}
