// apps/web/src/modules/23-billing-medicare — the pure model behind sending a DDE queue item through the DDE access
// provider (ADR-0103, #761): how an item was recorded (provider-verified vs operator-attested), the provider badge,
// the plain-language outcome of each refusal code, and the provider-sync answer. The server is the authority on
// every rule; this only decides what to SHOW. No MBI, credential or note is read or logged here.
import type { StatusTone } from "@chartwarden/ui";
import type { DdeItem } from "./dde-queue-model";
import { errorCode, errorMessage } from "./dde-queue-model";

export type SubmissionMode = "manual" | "provider";
export type ProviderState = "not_found" | "received" | "accepted" | "returned" | "rejected";

/** The badge on a queue row: who keyed it, or "Not sent" while no submission mode is recorded (text, not colour). */
export function providerBadge(
  item: Pick<DdeItem, "submissionMode"> & { state?: DdeItem["state"] },
): {
  label: string;
  tone: StatusTone;
} {
  if (item.submissionMode === "provider") return { label: "Via provider", tone: "progress" };
  if (item.submissionMode === "manual") return { label: "Keyed by hand", tone: "neutral" };
  // An item past submission with no mode (an older row) was keyed, so "Not sent" would be false.
  const keyed =
    item.state === "submitted" || item.state === "accepted" || item.state === "returned";
  return { label: keyed ? "Mode not recorded" : "Not sent", tone: "neutral" };
}

/**
 * Whether the recorded result was verified by the provider or only attested by the operator. A manually recorded
 * outcome (or one with no mode: an older item) is the operator's word.
 */
export function evidenceOf(item: Pick<DdeItem, "submissionMode" | "state" | "macAcceptedOn">): {
  label: string;
  verified: boolean;
} | null {
  const answered = item.state === "accepted" || item.state === "returned" || !!item.macAcceptedOn;
  if (item.submissionMode === "provider") {
    return answered
      ? { label: "Verified by the DDE provider", verified: true }
      : { label: "Sent through the DDE provider; awaiting its answer", verified: false };
  }
  if (item.submissionMode === "manual" || answered || item.state === "submitted") {
    return { label: "Attested by the operator (not verified by a provider)", verified: false };
  }
  return null;
}

/** True when the item was sent through a provider, so a status sync is meaningful. */
export const canSyncProvider = (
  item: Pick<DdeItem, "submissionMode" | "allowedActions">,
): boolean => item.submissionMode === "provider" && item.allowedActions.includes("sync_provider");

export interface ProviderRefusal {
  message: string;
  /** Another send could succeed (a transient fault). Never true for an in-doubt send. */
  retryable: boolean;
  /** The provider may already hold the operation: do not send again, verify in DDE and record it by hand. */
  inDoubt: boolean;
}

/** Shown while the server holds the in-doubt marker (#760): the provider may already hold the operation. */
export const IN_DOUBT_GUIDANCE =
  "The provider did not confirm whether DDE received this item. Verify it in DDE, then record the submission manually.";

const MANUAL_HINT = "You can still key it in DDE yourself and record it as keyed.";

const REFUSALS: Record<string, ProviderRefusal> = {
  DDE_NOT_WIRED: {
    message: `No DDE provider is configured for this platform. Use manual keying. ${MANUAL_HINT}`,
    retryable: false,
    inDoubt: false,
  },
  DDE_NOT_PROVISIONED: {
    message: `The DDE provider is not set up for this organization yet. Use manual keying. ${MANUAL_HINT}`,
    retryable: false,
    inDoubt: false,
  },
  DDE_UNAVAILABLE: {
    message: `The DDE provider is unavailable right now. Nothing was sent. Try again shortly. ${MANUAL_HINT}`,
    retryable: true,
    inDoubt: false,
  },
  DDE_OPERATOR_NOT_ENROLLED: {
    message: `You do not have a DDE ID enrolled with the provider, so it cannot key under your name. Ask an administrator to enroll you. ${MANUAL_HINT}`,
    retryable: false,
    inDoubt: false,
  },
  DDE_IDEMPOTENCY_CONFLICT: {
    message:
      "This send conflicts with an earlier attempt on this item. Reload the item and check its state before doing anything else.",
    retryable: false,
    inDoubt: false,
  },
  DDE_IN_DOUBT: {
    message:
      "The provider did not confirm whether DDE received this. Do not send it again. Check DDE, then record the submission manually.",
    retryable: false,
    inDoubt: true,
  },
  DDE_PROVIDER_ERROR: {
    message: `The provider returned an error. Nothing was recorded. Try again later. ${MANUAL_HINT}`,
    retryable: true,
    inDoubt: false,
  },
  DDE_PROVIDER_ANSWER_INVALID: {
    message: `The provider's answer could not be trusted, so nothing was recorded. ${MANUAL_HINT}`,
    retryable: false,
    inDoubt: false,
  },
};

/** The operator-facing outcome of a failed provider call, from the envelope's `error.code`. Null when the code is not a provider code. */
export function providerRefusal(err: unknown, fallback: string): ProviderRefusal | null {
  const code = errorCode(err);
  if (code === "DDE_INVALID_REQUEST") {
    return {
      message: errorMessage(err, "The provider rejected the request as invalid. Nothing was sent."),
      retryable: false,
      inDoubt: false,
    };
  }
  if (code === "CONFLICT") {
    return {
      message: "This item is not in a state that allows that. Reload it and check its status.",
      retryable: false,
      inDoubt: false,
    };
  }
  if (code && REFUSALS[code]) return REFUSALS[code];
  return code?.startsWith("DDE_")
    ? { message: errorMessage(err, fallback), retryable: false, inDoubt: false }
    : null;
}

/** What a provider status check found. `accepted`/`returned`/`rejected` reload the item, so only the rest need words. */
export function syncMessage(state: ProviderState): string {
  switch (state) {
    case "received":
      return "The provider has the submission but DDE has not answered yet. Nothing changed. Check again later.";
    case "not_found":
      return "The provider has no record of this operation yet. Nothing changed. Check again later.";
    case "accepted":
      return "Accepted. The provider verified the acceptance and the item was updated.";
    case "returned":
    case "rejected":
      return "Returned. The provider reported the claim was not accepted; the reason code is on the item.";
  }
}

/** The platform status shown to administrators. */
export interface ProviderStatus {
  provider: "manual" | "in_memory" | "episode_alert";
  wired: boolean;
}

export function providerStatusText(s: ProviderStatus): string {
  if (!s.wired)
    return "Manual keying only. No DDE provider is bound, so Send via provider is refused.";
  if (s.provider === "in_memory")
    return "Test double bound (in_memory). Not a real DDE connection.";
  return "Episode Alert is bound. Operators need a DDE ID enrolled with the provider.";
}
