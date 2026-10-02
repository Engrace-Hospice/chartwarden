// @wardenx/dosespot — the inbound-webhook BODY contract (F-230, #248). Pure parsing, no IO, no clock.
//
// WHAT IS SPEC-DEFINED vs PROVISIONAL (read before trusting any field name here):
//   • The ENVELOPE (`dosespot_event_id`, `organization_id`, `event_type`, `occurred_at`, `payload`) and the
//     five `event_type` literals are M12 spec §4.2's `DoseSpotWebhookEnvelope` — taken verbatim.
//   • The `script_status_update` INNER payload is NOT defined by the repo: the M12 spec names only a `status`
//     string whose values include `Sent`, `RxFillError`, `Rejected` (§2.2 transition table) and
//     `Dispensed`/`PickedUp` (§4.4 event catalog row for `dispensed_at_pharmacy`). The field names
//     `dosespot_prescription_id`, `fill_number`, `status_at` below are OUR provisional wire mapping,
//     snake_case to match the envelope. They are the ONE place real DoseSpot webhook documentation/samples
//     must be checked when vendor access exists — `DOSESPOT_WIRE_MAPPING_VERIFIED` stays `false` until then.
//     Nothing here was taken from vendor documentation, because none exists in this repository.
//   • The HMAC scheme (SHA-256 over the raw body, `X-DoseSpot-Signature` / `X-DoseSpot-Timestamp` headers,
//     ±5 min) is M12 §7.4 / Integrations §3.7 as already implemented in `./verify.ts`; it likewise has never
//     been checked against a real DoseSpot delivery.
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** `true` only once the payload field names + signature scheme have been verified against real vendor
 *  documentation / recorded deliveries. Read by the route's startup log so an operator sees the caveat. */
export const DOSESPOT_WIRE_MAPPING_VERIFIED = false as const;

/** §4.2 — the five webhook `event_type` literals. */
export const DOSESPOT_WEBHOOK_EVENT_TYPES = [
  "script_status_update",
  "refill_request",
  "medication_history_result",
  "patient_mismatch",
  "prescriber_status_changed",
] as const;
export type DoseSpotWebhookEventType = (typeof DOSESPOT_WEBHOOK_EVENT_TYPES)[number];

/** §4.2 `DoseSpotWebhookEnvelope` (the wire shape, snake_case). */
export const DoseSpotWebhookEnvelopeSchema = Type.Object({
  dosespot_event_id: Type.String({ minLength: 1, maxLength: 200 }),
  organization_id: Type.String({ minLength: 1 }), // uuid shape is checked explicitly in parseWebhookEnvelope (no TypeBox format registry in this pure package)
  event_type: Type.Union(DOSESPOT_WEBHOOK_EVENT_TYPES.map((t) => Type.Literal(t))),
  occurred_at: Type.String({ minLength: 1 }),
  payload: Type.Unknown(),
});
export type DoseSpotWebhookEnvelope = Static<typeof DoseSpotWebhookEnvelopeSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookEnvelopeParseResult =
  | { readonly ok: true; readonly envelope: DoseSpotWebhookEnvelope }
  | { readonly ok: false; readonly reason: "MALFORMED_JSON" | "MALFORMED_ENVELOPE" };

/** Parse the RAW body into the §4.2 envelope. The caller must verify the HMAC over the same raw string
 *  BEFORE trusting anything in it (the tenant id read here only selects WHICH secret to verify against). */
export function parseWebhookEnvelope(rawBody: string): WebhookEnvelopeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "MALFORMED_JSON" };
  }
  if (!Value.Check(DoseSpotWebhookEnvelopeSchema, json)) {
    return { ok: false, reason: "MALFORMED_ENVELOPE" };
  }
  const envelope = json as DoseSpotWebhookEnvelope;
  // `format: "uuid"` is not enforced by TypeBox's default Value.Check (no format registry) — check directly.
  if (!UUID_RE.test(envelope.organization_id)) return { ok: false, reason: "MALFORMED_ENVELOPE" };
  return { ok: true, envelope };
}

/** PROVISIONAL (see the file header) — the `script_status_update` inner payload. */
export const DoseSpotScriptStatusUpdatePayloadSchema = Type.Object({
  dosespot_prescription_id: Type.String({ minLength: 1 }),
  status: Type.String({ minLength: 1 }),
  fill_number: Type.Optional(Type.Integer({ minimum: 0 })),
  status_at: Type.Optional(Type.String({ minLength: 1 })),
});
export type DoseSpotScriptStatusUpdatePayload = Static<
  typeof DoseSpotScriptStatusUpdatePayloadSchema
>;

/** §4.4 — the two script statuses that mean "the pharmacy dispensed" (`dispensed_at_pharmacy`). */
export const DOSESPOT_DISPENSE_STATUSES = ["Dispensed", "PickedUp"] as const;
export type DoseSpotDispenseStatus = (typeof DOSESPOT_DISPENSE_STATUSES)[number];

export function isDispenseStatus(status: string): status is DoseSpotDispenseStatus {
  return (DOSESPOT_DISPENSE_STATUSES as readonly string[]).includes(status);
}

export type ScriptStatusParseResult =
  | { readonly ok: true; readonly update: DoseSpotScriptStatusUpdatePayload }
  | { readonly ok: false };

export function parseScriptStatusUpdate(payload: unknown): ScriptStatusParseResult {
  return Value.Check(DoseSpotScriptStatusUpdatePayloadSchema, payload)
    ? { ok: true, update: payload as DoseSpotScriptStatusUpdatePayload }
    : { ok: false };
}
