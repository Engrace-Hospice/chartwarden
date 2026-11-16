// apps/web/src/modules/10-hope — the one write of the SFV completion dialog: in flight, refused (shown, or sent through
// step-up with the answers kept), unconfirmed, or recorded.
import { HOPE_ATTESTATION_VERSION } from "@chartwarden/types";
import { useEffect, useRef, useState } from "react";
import { clearStepUpDraft, stashStepUpDraft } from "../../shell/step-up-redirect";
import {
  type RecordSfvBody,
  isClientRefusal,
  isRefusalBody,
  isStaleVersionRefusal,
  withRequestTimeout,
  writeOutcomeUnknown,
  writeSucceeded,
} from "./hope-api";
import { useStepUpRedirect } from "./hope-attestation";
import type { SfvDraft } from "./hope-sfv-draft";
import {
  SFV_RATE_LIMITED,
  SFV_REFUSED_WITHOUT_REASON,
  SFV_UNCONFIRMED,
  SFV_WORDING_CHANGED,
  type SfvError,
  isRateLimited,
  sfvErrorFrom,
} from "./hope-sfv-errors";
import type { SfvDialogAssessment, SfvForm } from "./hope-sfv-form";

/** What the write answers with: an openapi-fetch result (or a double of one). */
interface SfvSubmitReply {
  data?: unknown;
  error?: unknown;
  response?: { ok?: boolean; status?: number };
}

/** The one write the dialog makes. The workspace's client satisfies it. */
export interface SfvDialogApi {
  POST(path: string, init?: unknown): Promise<SfvSubmitReply>;
}

interface SubmitInputs {
  readonly assessment: SfvDialogAssessment;
  readonly api: SfvDialogApi;
  readonly form: SfvForm;
  /** The page already knows the attestation wording it shows is out of date: nothing can be sent from it. */
  readonly wordingChanged: boolean;
  readonly onWordingChanged: () => void;
  readonly onCompleted: () => Promise<void>;
  /**
   * The screen behind the dialog may be out of date: the write may have been applied (no usable answer, a fault of the server's
   * own) or the record changed under it (a stale-version 409). The caller re-reads it quietly; the dialog stays open with its
   * words. Never rejects.
   */
  readonly onReread: () => void;
}

export function useSfvSubmit(inputs: SubmitInputs): {
  saving: boolean;
  error: SfvError | null;
  submit: () => void;
} {
  const { assessment, api, form, wordingChanged, onWordingChanged, onCompleted, onReread } = inputs;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SfvError | null>(null);
  const redirectToStepUp = useStepUpRedirect();
  // A reply that arrives after the dialog is gone must not act: a stale step-up answer would otherwise navigate the
  // user away from wherever they went. This guards only what is observable beyond the dialog (that navigation, and the
  // parent's `onWordingChanged`); a state update after unmount is a no-op on React 18, so none is guarded.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run(): Promise<void> {
    const { discipline, canSubmit, date, answers } = form;
    if (!assessment.admissionId || !canSubmit || discipline === "" || saving || wordingChanged)
      return;
    setSaving(true);
    setError(null);
    // Typed against the generated contract, so a missing or misspelled field fails typecheck, not the server.
    const body: RecordSfvBody = {
      triggeringAssessmentId: assessment.id,
      targetDate: `${date}T12:00:00.000Z`,
      authorDiscipline: discipline,
      attestationConfirmed: true,
      attestationVersion: HOPE_ATTESTATION_VERSION,
      data: { J: { J2053: answers } },
    };
    let res: Awaited<ReturnType<SfvDialogApi["POST"]>>;
    try {
      // Bounded: the dialog is shut while this is out, and a request nobody answers must end as "could not confirm".
      const { admissionId } = assessment;
      res = await withRequestTimeout((signal) =>
        api.POST("/api/v1/admissions/{admissionId}/hope/sfv", {
          params: { path: { admissionId } },
          body,
          signal,
        }),
      );
    } catch {
      // No answer at all (offline, timeout): the write may have committed. The client keeps its idempotency key,
      // so a retry is safe, but the clinician is told to check before trying again.
      setSaving(false);
      setError(SFV_UNCONFIRMED);
      if (mounted.current) onReread();
      return;
    }
    if (writeSucceeded(res)) {
      clearStepUpDraft(form.draftKey);
      setSaving(false);
      await onCompleted();
      return;
    }
    if (!mounted.current) return; // before the step-up navigation, `onReread` and `onWordingChanged` below
    setSaving(false);
    // The words below tell the clinician to check the worklist or refresh the assessment: do that for them, behind the dialog, so
    // the card no longer says "Required" for a visit that was recorded and a conflict shows the record as it now is.
    if (writeOutcomeUnknown(res) || isStaleVersionRefusal(res)) onReread();
    if (!isRefusalBody(res.error)) {
      // No refusal body to read. A 4xx was still an answer (refused, reason not given); anything else (an empty or
      // gateway reply) leaves it unknown whether the write landed.
      const status = res.response?.status;
      if (isRateLimited(null, status)) setError(SFV_RATE_LIMITED);
      else setError(isClientRefusal(status) ? SFV_REFUSED_WITHOUT_REASON : SFV_UNCONFIRMED);
      return;
    }
    // A stale session is recoverable: keep what was typed, re-verify, then come back and complete the SFV.
    const typed: SfvDraft = { date, discipline, answers };
    if (redirectToStepUp(res.error, () => stashStepUpDraft(form.draftKey, typed))) return;
    const refusal = sfvErrorFrom(res.error, res.response?.status);
    if (refusal === SFV_WORDING_CHANGED) onWordingChanged();
    setError(refusal);
  }

  return { saving, error, submit: () => void run() };
}
