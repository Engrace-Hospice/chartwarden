// apps/admin/src/modules/34-saas-platform/onboarding — the reason prompt every wizard write goes through, wired to the write that
// runs behind it: the busy flag, the server's refusal (with Re-verify / a link to the earlier step), and a reason refused by the server
// shown on the reason box itself.
import { REASON_RULES, ReasonDialog, type ReasonRule } from "@chartwarden/ui";
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
  write: OpsWrite;
  orgSlug: string;
  /** Called just before leaving for Re-verify: stash what was typed (never a secret). */
  onReverify?: () => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const failure = write.failure;
  const fieldError = failure?.fieldErrors.reason;
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
      {...(failure
        ? {
            error: (
              <FailureNotice
                failure={failure}
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
