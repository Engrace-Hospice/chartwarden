// apps/admin/src/modules/34-saas-platform/onboarding — settle a step with evidence, on the tenant's behalf.
// The evidence and the reason are recorded on the step and in the audit trail the tenant can read, so the form says so and the server
// screens both for patient identifiers. A refusal keeps what was typed; a stale step-up offers Re-verify and carries the form through it.
import {
  Button,
  REASON_RULES,
  TextAreaField,
  TextField,
  checkReason,
  normalizeReason,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { useOpsWrite } from "./use-ops-write";

const EVIDENCE_NOTE_MAX = 2000;
const EVIDENCE_REF_MAX = 500;

interface Draft {
  evidenceNote: string;
  evidenceRef: string;
  reason: string;
}

export const attestDraftKey = (orgSlug: string, stepKey: string): string =>
  `wizard:${orgSlug}:${stepKey}:attest`;

export function AttestCard({
  ctx,
  onCancel,
}: {
  ctx: PanelContext;
  onCancel: () => void;
}): JSX.Element {
  const client = useApiClient();
  const { orgSlug, step } = ctx;
  const draftKey = attestDraftKey(orgSlug, step.key);
  const restored = useStepUpDraft<Draft>(draftKey);
  const [note, setNote] = useState(restored?.evidenceNote ?? "");
  const [ref, setRef] = useState(restored?.evidenceRef ?? "");
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const write = useOpsWrite();

  async function submit(): Promise<void> {
    const next: Partial<Record<keyof Draft, string>> = {};
    if (note.trim().length === 0) next.evidenceNote = "Say what was checked and by whom.";
    else if (note.trim().length > EVIDENCE_NOTE_MAX)
      next.evidenceNote = `At most ${EVIDENCE_NOTE_MAX} characters.`;
    if (ref.trim().length > EVIDENCE_REF_MAX)
      next.evidenceRef = `At most ${EVIDENCE_REF_MAX} characters.`;
    const reasonIssue = checkReason(reason, REASON_RULES.decision);
    if (reasonIssue) next.reason = reasonIssue;
    setErrors(next);
    if (Object.keys(next).length > 0 || !step.id) return;

    const body = {
      evidenceNote: note.trim(),
      ...(ref.trim() ? { evidenceRef: ref.trim() } : {}),
      reason: normalizeReason(reason),
    };
    const taskId = step.id;
    const outcome = await write.run(JSON.stringify(body), () =>
      client.POST("/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/attest", {
        params: { path: { orgSlug, taskId } },
        body,
      }),
    );
    if (outcome.ok) {
      await ctx.refresh();
      onCancel();
    }
  }

  const failure = write.failure;
  const stash = (): void =>
    stashStepUpDraft<Draft>(draftKey, { evidenceNote: note, evidenceRef: ref, reason });
  const fieldError = (field: string): string | undefined =>
    errors[field as keyof Draft] ?? failure?.fieldErrors[field];

  return (
    <section className="wx-drawer-card" aria-label="Mark this step done">
      <div className="wx-drawer-card-head">
        <h3>Mark this step done</h3>
      </div>
      <p className="wx-row-sub">
        You are settling this step on the tenant's behalf. The evidence and your reason are recorded
        and visible to the tenant. Describe what was checked without naming a patient.
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
      <TextAreaField
        label="Reason you are doing this for the tenant"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={fieldError("reason")}
      />
      {failure ? <FailureNotice failure={failure} orgSlug={orgSlug} onReverify={stash} /> : null}
      <div className="wx-drawer-actions">
        <Button tone="secondary" onClick={onCancel} disabled={write.busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={write.busy}>
          {write.busy ? "Saving…" : "Save and mark done"}
        </Button>
      </div>
    </section>
  );
}
