// apps/backend/src/modules/41-billing-commercial/domain/ack-event.ts - the boundary validation of a vendor acknowledgment event
// (ADR-0053 D5: vendor JSON is not typed). PURE. Every field is checked before any of it is used, stored or compared; an event
// that fails is QUARANTINED by the caller (stored by id and reason, skipped, never thrown), so one poison event cannot stall a
// provider entity's stream. The result is rebuilt from the known keys only: nothing extra the vendor sent is carried further.
import type { AckDisposition, AckStage } from "./ack-transition";

const MAX_EVENT_ID = 256;
const MAX_CONTROL_NUMBER = 64;
const MAX_REASON_CODES = 50;
const MAX_PAYER_CLAIM_NUMBER = 128;

/** Reason codes are X12 / vendor codes (STC, AK9, edit ids). Nothing free-text, nothing with a NUL or whitespace. */
export const REASON_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CONTROL_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PAYER_CLAIM_NUMBER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
/** A full ISO 8601 instant, or a bare ISO day (what the direct-MAC portal gives). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidAckEvent {
  readonly eventId: string;
  readonly controlNumber: string;
  readonly stage: AckStage;
  readonly disposition: AckDisposition;
  readonly reasonCodes: readonly string[];
  readonly payerClaimNumber: string | null;
  /** The authority's own time, or null when it gave none we can read. */
  readonly occurredAt: Date | null;
}

export type AckEventValidation =
  | { readonly ok: true; readonly event: ValidAckEvent }
  | {
      readonly ok: false;
      /** Fixed text naming the failed FIELD, never its value. */
      readonly reason: string;
      /** The event id when it is itself usable, else null (the caller derives a stable one). */
      readonly eventId: string | null;
      readonly controlNumber: string | null;
    };

const hasNul = (s: string): boolean => s.includes("\u0000");
const isText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max && !hasNul(v);

function parseInstant(value: unknown): Date | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || hasNul(value)) return "invalid";
  if (!ISO_INSTANT.test(value) && !ISO_DAY.test(value)) return "invalid";
  const parsed = new Date(ISO_DAY.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
}

export function validateAckEvent(raw: unknown): AckEventValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "event is not an object", eventId: null, controlNumber: null };
  }
  const e = raw as Record<string, unknown>;
  const eventId = isText(e.eventId, MAX_EVENT_ID) ? e.eventId : null;
  const controlNumber =
    typeof e.controlNumber === "string" &&
    CONTROL_NUMBER_PATTERN.test(e.controlNumber) &&
    e.controlNumber.length <= MAX_CONTROL_NUMBER
      ? e.controlNumber
      : null;
  const bad = (reason: string): AckEventValidation => ({
    ok: false,
    reason,
    eventId,
    controlNumber,
  });

  if (eventId === null) return bad("eventId is missing or unusable");
  if (controlNumber === null) return bad("controlNumber is missing or unusable");
  if (e.stage !== "clearinghouse" && e.stage !== "payer") return bad("stage is unknown");
  if (e.disposition !== "accepted" && e.disposition !== "rejected" && e.disposition !== "partial") {
    return bad("disposition is unknown");
  }
  if (e.disposition === "partial" && e.stage === "clearinghouse") {
    return bad("a partial disposition is payer-stage only");
  }
  if (!Array.isArray(e.reasonCodes) || e.reasonCodes.length > MAX_REASON_CODES) {
    return bad("reasonCodes is not a bounded array");
  }
  for (const code of e.reasonCodes) {
    if (typeof code !== "string" || !REASON_CODE_PATTERN.test(code)) {
      return bad("a reason code is malformed");
    }
  }
  const occurredAt = parseInstant(e.occurredAt);
  if (occurredAt === "invalid") return bad("occurredAt is not an ISO date");
  let payerClaimNumber: string | null = null;
  if (e.payerClaimNumber !== undefined && e.payerClaimNumber !== null) {
    if (
      typeof e.payerClaimNumber !== "string" ||
      e.payerClaimNumber.length > MAX_PAYER_CLAIM_NUMBER ||
      !PAYER_CLAIM_NUMBER_PATTERN.test(e.payerClaimNumber)
    ) {
      return bad("payerClaimNumber is malformed");
    }
    payerClaimNumber = e.payerClaimNumber;
  }
  return {
    ok: true,
    event: {
      eventId,
      controlNumber,
      stage: e.stage,
      disposition: e.disposition,
      reasonCodes: [...(e.reasonCodes as string[])],
      payerClaimNumber,
      occurredAt,
    },
  };
}
