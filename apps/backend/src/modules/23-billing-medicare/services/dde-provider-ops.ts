// apps/backend/src/modules/23-billing-medicare/services/dde-provider-ops.ts — the pure parts of sending a DDE work item
// through a DdeAccessProvider (ADR-0103, issue #760): the deterministic idempotency key, the stable typed refusal for
// each provider error code, and how a provider outcome maps onto the queue. No IO, no clock, no PHI.
import { isRealCalendarDate, medicareReceiptDay, validateDdeCodes } from "@chartwarden/billing";
import { ChartWardenError } from "@chartwarden/types";
import { DDE, type DdeOutcome } from "@chartwarden/x12-837-client";

/** The provider's opaque operation id as we store it (matches the `provider_reference` CHECK). */
export const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9:._-]{1,64}$/;
const RTP_CODE_PATTERN = /^[A-Z0-9]{1,8}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One key per queue item AND attempt. `controlNumber` is not unique per operation (repeat corrections of one claim
 * are legitimate) and a fresh key per click would key a second operation to FISS, so the key is derived, never minted:
 * a double click replays the first operation, a retry (a new attempt) is a new operation.
 */
export function ddeIdempotencyKey(itemId: string, attemptNumber: number): string {
  return `dde:${itemId}:${attemptNumber}`;
}

/**
 * How long one provider call may take before we stop waiting (and abort the signal handed to the port). A send that
 * hits this bound is IN DOUBT, not failed: the vendor may still have keyed it.
 */
export const DDE_PROVIDER_CALL_TIMEOUT_MS = 30_000;

export type BoundedCall<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "threw" };

/**
 * Run one provider call under a bound. The port's contract is to return a degraded envelope rather than throw, so a
 * throw is a defect we cannot interpret ("threw"); neither it nor a timeout says whether the vendor acted.
 */
export async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<BoundedCall<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const call = run(controller.signal).then(
    (value): BoundedCall<T> => ({ kind: "done", value }),
    (): BoundedCall<T> => ({ kind: "threw" }),
  );
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Refusal {
  readonly status: number;
  readonly message: string;
}

/** Stable HTTP shape per provider code. The provider's own `reason` is never echoed (callers branch on the code). */
const REFUSALS: Readonly<Record<string, Refusal>> = {
  [DDE.NOT_WIRED]: {
    status: 503,
    message: "no DDE access provider is bound for this platform; key the item manually",
  },
  [DDE.NOT_PROVISIONED]: {
    status: 503,
    message: "the DDE access provider account is not provisioned for this operation",
  },
  [DDE.OPERATOR_NOT_ENROLLED]: {
    status: 409,
    message: "you have no DDE ID enrolled with the DDE access provider; key the item manually",
  },
  [DDE.UNAVAILABLE]: {
    status: 503,
    message: "the DDE access provider is unavailable; try again shortly",
  },
  [DDE.IDEMPOTENCY_CONFLICT]: {
    status: 409,
    message: "the DDE access provider holds a different operation under this attempt's key",
  },
  [DDE.IN_DOUBT]: {
    status: 409,
    message:
      "the DDE access provider cannot confirm whether the operation reached FISS; check DDE and record the submission by hand",
  },
  [DDE.INVALID_REQUEST]: {
    status: 422,
    message: "the DDE access provider refused the operation as malformed",
  },
};

/** The typed refusal for a provider's degraded answer. Unknown codes become a generic 502 (the code still passes). */
export function ddeProviderRefusal(code: string): ChartWardenError {
  const known = REFUSALS[code];
  if (known) return new ChartWardenError(code, known.message, known.status);
  return new ChartWardenError(
    "DDE_PROVIDER_ERROR",
    "the DDE access provider returned an unexpected error",
    502,
  );
}

/** A provider answer we will not act on (wrong reference, unusable date); nothing is recorded. */
export function ddeProviderAnswerRejected(detail: string): ChartWardenError {
  return new ChartWardenError("DDE_PROVIDER_ANSWER_INVALID", detail, 502);
}

export type PlannedOutcome =
  | {
      readonly kind: "accepted";
      readonly macAcceptedOn: string;
      readonly dcn: string | null;
    }
  | {
      readonly kind: "returned";
      readonly rtpReasonCode: string | null;
      readonly outcomeCode: "rtp" | "rejected";
      readonly dcn: string | null;
    }
  | { readonly kind: "invalid"; readonly reason: string };

/** The MAC's own calendar day: a date-only answer as given, an instant read on the Eastern CMS clock. */
function macDay(occurredAt: string): string | null {
  if (DATE_ONLY.test(occurredAt)) return isRealCalendarDate(occurredAt) ? occurredAt : null;
  const parsed = new Date(occurredAt);
  return Number.isNaN(parsed.getTime()) ? null : medicareReceiptDay(parsed);
}

/** A DCN only if it passes the same screen as an operator-entered one (the column's CHECK would otherwise 500). */
function safeDcn(dcn: string | undefined): string | null {
  if (dcn === undefined) return null;
  return validateDdeCodes({ dcn }).ok ? dcn : null;
}

/**
 * Map a provider outcome onto the queue. Defensive: a date in the future, or a date we cannot read, is `invalid` and
 * nothing is recorded (the MAC is not ahead of us; a bad date would corrupt NOE timeliness). `today` is the Eastern day.
 */
export function planProviderOutcome(outcome: DdeOutcome, today: string): PlannedOutcome {
  const dcn = safeDcn(outcome.dcn);
  if (outcome.disposition === "accepted") {
    const day = macDay(outcome.occurredAt);
    if (!day) return { kind: "invalid", reason: "the provider's acceptance date is unreadable" };
    if (day > today) {
      return { kind: "invalid", reason: "the provider's acceptance date is in the future" };
    }
    return { kind: "accepted", macAcceptedOn: day, dcn };
  }
  const rtpReasonCode = outcome.reasonCodes.find((c) => RTP_CODE_PATTERN.test(c)) ?? null;
  return {
    kind: "returned",
    rtpReasonCode,
    outcomeCode: outcome.disposition === "rejected" ? "rejected" : "rtp",
    dcn,
  };
}
