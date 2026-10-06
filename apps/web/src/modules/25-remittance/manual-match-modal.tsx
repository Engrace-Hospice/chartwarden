import { TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — ERA MANUAL MATCH (GAP-074; server contract GAP-073). One unmatched 835
// line is matched to a claim the biller names. The UI sends ONLY `proposedClaimId` + `reason`: the server
// validates the claim exists within the line's provider entity (404 otherwise, shown verbatim), requires and
// records the rationale (20–500 chars) on the audit row, and derives the posting from the line itself.
import { useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { ActionModal, ErrorAlert, FormButtons, Hint, ReasonField } from "./action-ui";
import { MAX_MANUAL_MATCH_REASON, MIN_REASON, isUuid, manualMatchLine } from "./remittance-api";
import { money } from "./remittance-status";

export interface ManualMatchModalProps {
  readonly line: {
    readonly id: string;
    readonly clp03TotalChargeAmount: string;
    readonly clp04TotalPaymentAmount: string;
  };
  readonly onClose: () => void;
  readonly onMatched: () => void;
}

export const MANUAL_MATCH_DRAFT_ACTION = "m25-manual-match";

interface MatchDraft {
  readonly claimId: string;
  readonly reason: string;
}

export function ManualMatchModal({ line, onClose, onMatched }: ManualMatchModalProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const draftKey = stepUpDraftKey(session, MANUAL_MATCH_DRAFT_ACTION, line.id);
  const [restored] = useState(() => peekStepUpDraft<MatchDraft>(draftKey));
  const [claimId, setClaimId] = useState(restored?.claimId ?? "");
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = !isUuid(claimId) || reason.trim().length < MIN_REASON.manualMatch;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await manualMatchLine(client, line.id, {
      proposedClaimId: claimId.trim(),
      reason: reason.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.stepUp) {
        stashStepUpDraft(draftKey, { claimId, reason });
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      return;
    }
    clearStepUpDraft(draftKey);
    onMatched();
    onClose();
  }

  function cancel(): void {
    clearStepUpDraft(draftKey);
    onClose();
  }

  return (
    <ActionModal
      ariaLabel="Match remittance line to claim"
      onClose={busy ? () => undefined : cancel}
    >
      <Hint>
        Charge {money(line.clp03TotalChargeAmount)} · Paid {money(line.clp04TotalPaymentAmount)}.
        The claim must belong to the same provider entity as this remittance.
      </Hint>
      <TextField
        label="Claim ID"
        value={claimId}
        onChange={(e) => setClaimId(e.target.value)}
        error={claimId && !isUuid(claimId) ? "Enter a claim UUID." : undefined}
      />
      <ReasonField
        label="Match rationale"
        value={reason}
        min={MIN_REASON.manualMatch}
        max={MAX_MANUAL_MATCH_REASON}
        onChange={setReason}
      />
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Match claim"
        busy={busy}
        blocked={blocked}
        onSubmit={() => void submit()}
        onCancel={cancel}
      />
    </ActionModal>
  );
}
