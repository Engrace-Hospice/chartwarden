// apps/web/src/modules/23-billing-medicare — the pure model behind sending a DDE queue item through the DDE access
// provider (ADR-0103, #761): how an item was recorded (provider-verified vs operator-attested), the provider badge,
// the plain-language outcome of each refusal code, and the provider-sync answer. The server is the authority on
// every rule; this only decides what to SHOW. No MBI, credential or note is read or logged here.
import type { StatusTone } from "@chartwarden/ui";
import type { DdeItem, DdeItemDetail, DdeProviderCapability } from "./dde-queue-model";
import { errorCode, errorMessage } from "./dde-queue-model";

export type ProviderState = "not_found" | "received" | "accepted" | "returned" | "rejected";

/** The badge describes submission provenance only; it never claims a final MAC outcome. */
export function providerBadge(
  item: Pick<DdeItem, "submissionMode"> & { state?: DdeItem["state"] },
): {
  label: string;
  tone: StatusTone;
} {
  if (item.submissionMode === "provider") return { label: "Provider receipt", tone: "progress" };
  if (item.submissionMode === "manual") return { label: "Manual submission", tone: "neutral" };
  // An item past submission with no mode (an older row) was keyed, so "Not sent" would be false.
  const keyed =
    item.state === "submitted" || item.state === "accepted" || item.state === "returned";
  return { label: keyed ? "Mode not recorded" : "Not sent", tone: "neutral" };
}

type OutcomeEvidenceItem = Pick<
  DdeItem,
  "submissionMode" | "state" | "macAcceptedOn" | "attemptNumber"
> &
  Partial<Pick<DdeItemDetail, "events">> & { providerReference?: string | null };

/** Outcome evidence is derived from the matching attempt's immutable event, never from submission mode or state alone. */
export function evidenceOf(item: OutcomeEvidenceItem): {
  label: string;
  verified: boolean;
} | null {
  const answered = item.state === "accepted" || item.state === "returned" || !!item.macAcceptedOn;
  if (!answered) {
    if (item.state !== "submitted") return null;
    if (item.submissionMode === "provider") {
      return { label: "Provider receipt recorded; outcome pending", verified: false };
    }
    if (item.submissionMode === "manual") {
      return { label: "Operator recorded submission; outcome pending", verified: false };
    }
    const submissionEvent = item.events
      ?.filter((event) => event.attemptNumber === item.attemptNumber && event.event === "submit")
      .at(-1);
    if (submissionEvent?.detail?.submissionSource === "operator_verified_existing") {
      return {
        label: "Operator confirmed existing submission; channel unknown; outcome pending",
        verified: false,
      };
    }
    return { label: "Submission source unknown; outcome pending", verified: false };
  }

  const outcome = item.events
    ?.filter(
      (event) =>
        event.attemptNumber === item.attemptNumber &&
        (event.event === "accept" || event.event === "return"),
    )
    .at(-1);
  if (!outcome) return { label: "Outcome source unknown", verified: false };

  const detail = outcome.detail ?? {};
  const currentReference = item.providerReference;
  const providerEvidence =
    detail.outcomeSource === "provider" ||
    (detail.submissionMode === "provider" &&
      typeof detail.providerReference === "string" &&
      detail.providerReference === currentReference);
  if (providerEvidence) {
    return { label: "Outcome reported by the DDE provider", verified: true };
  }
  if (detail.outcomeSource === "operator" || outcome.actorKind === "user") {
    return { label: "Outcome recorded by an operator", verified: false };
  }
  return { label: "Outcome source unknown", verified: false };
}

/** True when the item was sent through a provider, so a status sync is meaningful. */
export const canSyncProvider = (
  item: Pick<
    DdeItem,
    "submissionMode" | "providerReference" | "itemType" | "allowedActions" | "providerInDoubt"
  >,
  capability: DdeProviderCapability | null | undefined,
  authorized: boolean,
): boolean =>
  authorized &&
  capability?.statusCheckItemTypes.includes(item.itemType) === true &&
  item.providerInDoubt !== true &&
  item.submissionMode === "provider" &&
  !!item.providerReference &&
  item.allowedActions.includes("sync_provider");

export const canSubmitViaProvider = (
  itemType: DdeItem["itemType"],
  capability: DdeProviderCapability | null | undefined,
  authorized: boolean,
  assignedToOther: boolean,
): boolean =>
  authorized && !assignedToOther && capability?.submissionItemTypes.includes(itemType) === true;

export const UNKNOWN_PROVIDER_CAPABILITY: DdeProviderCapability = {
  mode: "unknown",
  label: "Provider readiness unknown",
  submissionItemTypes: [],
  statusCheckItemTypes: [],
  explanation: "Provider readiness could not be established. Use the manual DDE workflow.",
};

export interface ProviderRefusal {
  message: string;
  /** Another send could succeed (a transient fault). Never true for an in-doubt send. */
  retryable: boolean;
  /** The provider may already hold the operation: do not send again, verify in DDE and record it by hand. */
  inDoubt: boolean;
}

/** Shown while the server holds the in-doubt marker (#760): the provider may already hold the operation. */
export const IN_DOUBT_GUIDANCE =
  "The provider did not confirm whether DDE received this item. Do not resend or key it again. Verify the transaction in DDE before recording a confirmed submission or outcome; if it is absent or unclear, leave this item unresolved and reconcile it.";

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
    message:
      "The provider did not confirm the result. The operation may have reached DDE. Verify it in DDE; do not send it again.",
    retryable: false,
    inDoubt: true,
  },
  DDE_OPERATOR_NOT_ENROLLED: {
    message: `You do not have a DDE ID enrolled with the provider, so it cannot key under your name. Ask an administrator to enroll you. ${MANUAL_HINT}`,
    retryable: false,
    inDoubt: false,
  },
  DDE_IDEMPOTENCY_CONFLICT: {
    message:
      "The provider reported a conflict for this attempt. It may already hold an operation. Verify it in DDE; do not send it again.",
    retryable: false,
    inDoubt: true,
  },
  DDE_IN_DOUBT: {
    message:
      "The provider did not confirm whether DDE received this. Do not send or key it again. Verify the transaction in DDE before recording it.",
    retryable: false,
    inDoubt: true,
  },
  DDE_PROVIDER_ERROR: {
    message:
      "The provider did not confirm the result. The operation may have reached DDE. Verify it in DDE; do not send it again.",
    retryable: false,
    inDoubt: true,
  },
  DDE_PROVIDER_ANSWER_INVALID: {
    message:
      "The provider's answer could not be trusted. It is not proof that DDE has no transaction. Verify the item in DDE before resolving it.",
    retryable: false,
    inDoubt: true,
  },
};

/** The operator-facing outcome of a failed provider call, from the envelope's `error.code`. Null when the code is not a provider code. */
export function providerRefusal(
  err: unknown,
  fallback: string,
  operation: "submission" | "status" = "submission",
): ProviderRefusal | null {
  const code = errorCode(err);
  if (operation === "status") {
    const invalid = code === "DDE_PROVIDER_ANSWER_INVALID";
    const knownUnavailable =
      code === "DDE_NOT_READY" ||
      code === "DDE_NOT_WIRED" ||
      code === "DDE_NOT_PROVISIONED" ||
      code === "DDE_OPERATOR_NOT_ENROLLED" ||
      code === "DDE_INVALID_REQUEST";
    const statusRefusalMessages: Record<string, string> = {
      DDE_NOT_READY:
        "Electronic status checks are not enabled for this operation. Verify the transaction in manual DDE.",
      DDE_NOT_WIRED:
        "No DDE provider is configured to check status. Verify the transaction in manual DDE.",
      DDE_NOT_PROVISIONED:
        "The provider is not provisioned for this status check. Contact an administrator and verify in DDE.",
      DDE_OPERATOR_NOT_ENROLLED:
        "Your DDE identity is not enrolled for this provider status check. Contact an administrator and verify in DDE.",
      DDE_INVALID_REQUEST:
        "The provider rejected the status request. Review it and verify the transaction in DDE.",
    };
    const unavailableMessage = code ? statusRefusalMessages[code] : undefined;
    return {
      message: invalid
        ? "The provider's status response could not be trusted. The recorded submission is unchanged; verify it in DDE before taking further action."
        : knownUnavailable
          ? `${unavailableMessage ?? "The provider cannot check this item."} The original submission and outcome are unchanged.`
          : "The status check did not complete. The original submission and outcome are unchanged. You can try this read-only check again later.",
      retryable: !invalid && !knownUnavailable,
      inDoubt: false,
    };
  }
  if (code === "DDE_INVALID_REQUEST") {
    return {
      message: errorMessage(err, "The provider rejected the request as invalid. Nothing was sent."),
      retryable: false,
      inDoubt: false,
    };
  }
  if (code === "DDE_NOT_READY") {
    return {
      message:
        "The electronic DDE provider is not enabled for this operation. Continue with manual DDE.",
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
    ? {
        message:
          "The provider did not confirm the result. The operation may have reached DDE. Verify it in DDE; do not send it again.",
        retryable: false,
        inDoubt: true,
      }
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
  return "Episode Alert adapter is bound. This status does not establish vendor qualification or operator authorization.";
}
