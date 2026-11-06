// apps/admin/src/modules/34-saas-platform/onboarding — the reason prompt every wizard write goes through, wired to the write that
// runs behind it: the busy flag, the server's refusal (with Re-verify / a link to the earlier step), and a reason refused by the server
// shown on the reason box itself. A PINNED write (an If-Match on a record the operator read) passes `record` (what is being acted on) and
// `stale` (it changed since it was read): the dialog then says so in place of the server's refusal and re-words the confirm button.
import {
  REASON_RULES,
  ReasonDialog,
  type ReasonDialogRecordLine,
  type ReasonRule,
} from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { FailureNotice } from "./failure-notice";
import type { OpsWrite } from "./use-ops-write";

export function RecordSaveDialog({
  open,
  title,
  description,
  confirmLabel,
  rule = REASON_RULES.onboardingData,
  tone,
  record,
  stale = false,
  write,
  orgSlug,
  onReverify,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  rule?: ReasonRule;
  tone?: "primary" | "danger";
  /** The record being acted on (a pinned write). */
  record?: readonly ReasonDialogRecordLine[];
  /** The record changed since the operator read it: the caller has re-read it and `record` is what it says now. */
  stale?: boolean;
  write: OpsWrite;
  orgSlug: string;
  /** Called just before leaving for Re-verify: stash what was typed (never a secret). */
  onReverify?: () => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const failure = write.failure;
  const fieldError = failure?.fieldErrors.reason;
  // The stale notice already says what a conflict or a missing pin means; showing the refusal beside it would say it twice.
  const pinRefusal = failure?.kind === "conflict" || failure?.kind === "precondition";
  const shownFailure = stale && pinRefusal ? null : failure;
  return (
    <ReasonDialog
      open={open}
      title={title}
      {...(description ? { description } : {})}
      rule={rule}
      confirmLabel={confirmLabel}
      {...(tone ? { tone } : {})}
      busy={write.busy}
      {...(fieldError ? { fieldError } : {})}
      {...(record ? { record } : {})}
      stale={stale}
      {...(shownFailure
        ? {
            error: (
              <FailureNotice
                failure={shownFailure}
                orgSlug={orgSlug}
                {...(onReverify ? { onReverify } : {})}
              />
            ),
          }
        : {})}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
