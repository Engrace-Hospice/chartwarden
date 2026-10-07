// @wardenx/messaging — vendor callback → delivery status mapping (M36 GAP-101, spec §2.4.4 / §4.9).
//
// Pure. A Twilio SMS/voice status callback or a Postmark event is mapped to the `notification_delivery`
// transition it implies, or to `null` when it implies none (an in-flight status, an open/click event, an
// unknown value — ignored, never guessed). {@link canTransition} makes the update IDEMPOTENT and replay-safe:
// a row only ever moves forward (`pending → sent → delivered | failed`), so a duplicate or out-of-order
// callback — or a replayed one inside the timestamp window — can never regress or re-settle a terminal row.
import type { NotificationStatus } from "../interfaces/kinds";

/** Which vendor callback a status string came from. */
export type VendorCallbackKind = "twilio_sms" | "twilio_voice" | "postmark_event";

/** The transition a vendor callback implies. */
export interface VendorTransition {
  readonly status: Extract<NotificationStatus, "sent" | "delivered" | "failed">;
  /** Set when `status === 'failed'` — vendor + status (+ error code when the callback carried one). */
  readonly failReason: string | null;
}

const TWILIO_SMS_STATUS: Readonly<Record<string, VendorTransition["status"] | undefined>> = {
  accepted: "sent",
  queued: "sent",
  sending: "sent",
  sent: "sent",
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
};

const TWILIO_VOICE_STATUS: Readonly<Record<string, VendorTransition["status"] | undefined>> = {
  completed: "delivered",
  busy: "failed",
  "no-answer": "failed",
  failed: "failed",
  canceled: "failed",
};

/** Postmark `RecordType` → status. Open/Click/SubscriptionChange imply no delivery transition. */
const POSTMARK_RECORD_TYPE: Readonly<Record<string, VendorTransition["status"] | undefined>> = {
  Delivery: "delivered",
  Bounce: "failed",
  SpamComplaint: "failed",
};

const MAX_FAIL_REASON_LENGTH = 120;

function failReasonFor(kind: VendorCallbackKind, status: string, errorCode?: string): string {
  const base = `${kind}:${status}${errorCode ? `:${errorCode}` : ""}`;
  return base.slice(0, MAX_FAIL_REASON_LENGTH);
}

/** Map a vendor callback to the transition it implies (or `null` = ignore). */
export function mapVendorStatus(
  kind: VendorCallbackKind,
  vendorStatus: string,
  errorCode?: string,
): VendorTransition | null {
  const table =
    kind === "twilio_sms"
      ? TWILIO_SMS_STATUS
      : kind === "twilio_voice"
        ? TWILIO_VOICE_STATUS
        : POSTMARK_RECORD_TYPE;
  const status = table[vendorStatus];
  if (status === undefined) return null;
  return {
    status,
    failReason: status === "failed" ? failReasonFor(kind, vendorStatus, errorCode) : null,
  };
}

const RANK: Readonly<Partial<Record<NotificationStatus, number>>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

/**
 * Whether a row in `current` may move to `next`. Strictly forward: `delivered`/`failed` are terminal (never
 * overwritten, so a late `failed` cannot un-deliver a delivered row and a replay is a no-op); `sent → sent`
 * and any state the row cannot be in out-of-band (`skipped_quiet_hours`, `forwarded`) are refused.
 */
export function canTransition(
  current: NotificationStatus,
  next: VendorTransition["status"],
): boolean {
  const from = RANK[current];
  const to = RANK[next];
  return from !== undefined && to !== undefined && to > from;
}
