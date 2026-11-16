// apps/web/src/modules/10-hope — the dialog that completes a Symptom Follow-Up Visit (R-05, R-01).
//
// Completing an SFV records a signed RFA-04: the server requires the J2053A-H answers, the signer's attestation, a
// fresh step-up, and an author discipline that is one of the caller's own roles. This file composes the dialog; the
// form state is `hope-sfv-form.ts`, the write `hope-sfv-submit.ts`, the questions `hope-sfv-answers.tsx`, the fixed
// parts `hope-sfv-dialog-parts.tsx`. What the clinician types is held in memory only, on purpose (it is clinical
// content): it survives a step-up round trip, not a page reload.
import { HOPE_SFV_ATTESTATION_STATEMENT } from "@chartwarden/types";
import { Modal } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { clearStepUpDraft } from "../../shell/step-up-redirect";
import { HopeAttestation } from "./hope-attestation";
import { sfvDialogFrame, sfvModalBody } from "./hope-dialog-styles";
import { SfvAnswersSection } from "./hope-sfv-answers";
import {
  SfvCloseControl,
  SfvDialogFooter,
  SfvDialogHeader,
  SfvDialogStatus,
  SfvVisitDetails,
} from "./hope-sfv-dialog-parts";
import { SFV_WORDING_CHANGED } from "./hope-sfv-errors";
import { type SfvDialogAssessment, type SfvDialogItem, useSfvForm } from "./hope-sfv-form";
import { type SfvDialogApi, useSfvSubmit } from "./hope-sfv-submit";

export type { SfvDialogApi } from "./hope-sfv-submit";

interface CompleteSfvDialogProps {
  readonly assessment: SfvDialogAssessment;
  readonly api: SfvDialogApi;
  readonly items: readonly SfvDialogItem[];
  /** The page knows the attestation wording it shows is out of date (this or the Sign dialog was refused for it). */
  readonly wordingChanged: boolean;
  readonly onWordingChanged: () => void;
  readonly onCancel: () => void;
  /** Called once the SFV is recorded. The caller owns refreshing what it shows, and must not reject. */
  readonly onCompleted: () => Promise<void>;
}

const WORDING_CHANGED_BLOCKER = "reload the page to review the new attestation wording";

export function CompleteSfvDialog(props: CompleteSfvDialogProps): JSX.Element {
  const form = useSfvForm(props.assessment, props.items);
  const { saving, error, submit } = useSfvSubmit({ ...props, form });
  const close = useCloseGuard(form.dirty, saving, form.draftKey, props.onCancel);
  const blockers = props.wordingChanged ? [WORDING_CHANGED_BLOCKER, ...form.missing] : form.missing;
  const shownError = props.wordingChanged ? SFV_WORDING_CHANGED : error;
  // The error the dialog opened with (the page already knew the wording changed) is announced, not given focus.
  const errorAtOpen = useRef(shownError);

  return (
    // The kit Modal moves focus in, traps Tab, restores focus on close and closes on Escape. A completion in flight
    // passes no onClose, and the scrim never dismisses: the card holds typed answers a stray click must not lose.
    <Modal
      open
      onClose={saving ? undefined : () => close.request(null)}
      dismissOnScrim={false}
      ariaLabel="Complete SFV"
      width="51.25rem"
    >
      <div style={sfvDialogFrame}>
        <SfvDialogHeader />
        <section style={sfvModalBody} aria-label="Visit details and symptom reassessment">
          <SfvVisitDetails form={form} saving={saving} />
          <SfvAnswersSection
            questions={form.questions}
            answers={form.answers}
            answeredCount={form.answeredCount}
            onAnswer={form.setAnswer}
            disabled={saving}
          />
          <HopeAttestation
            checked={form.attested}
            onChange={form.setAttested}
            statement={HOPE_SFV_ATTESTATION_STATEMENT}
            disabled={saving}
          />
        </section>
        <SfvDialogStatus
          error={shownError}
          errorTakesFocus={shownError !== errorAtOpen.current}
          confirmingDiscard={close.confirming}
          closeTrigger={close.trigger}
          onKeepEditing={close.keepEditing}
          onDiscard={close.discard}
        />
        <SfvDialogFooter
          blockers={blockers}
          saving={saving}
          onCancel={close.request}
          onSubmit={submit}
        />
        <SfvCloseControl disabled={saving} onClose={close.request} />
      </div>
    </Modal>
  );
}

/**
 * Closing a form that holds entered answers asks first; a clean one closes at once; a completion in flight ignores it.
 * `trigger` remembers the control that asked, so Keep editing can give it the focus back when nothing had it.
 */
function useCloseGuard(
  dirty: boolean,
  saving: boolean,
  draftKey: string | null,
  onCancel: () => void,
) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const discard = (): void => {
    clearStepUpDraft(draftKey);
    onCancel();
  };
  const request = (from: HTMLElement | null): void => {
    if (saving) return;
    trigger.current = from;
    if (confirming) setConfirming(false);
    else if (dirty) setConfirming(true);
    else discard();
  };
  return { confirming, trigger, request, keepEditing: () => setConfirming(false), discard };
}
