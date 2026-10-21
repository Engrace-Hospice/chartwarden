// apps/web/src/modules/11-orders — the access layer of the order detail's "Resend transmission" action (M11 F-182).
// Wire shapes are TYPE ALIASES into the generated `operations` map, so a route or DTO drift is a compile error here.
//
// THE SERVER RULE THIS MIRRORS (routes/orders-routes.ts + orm-request/orm-resend.ts):
//   POST /orders/:id/resend-transmission — `orders.transmission.recover` + the order's caseload scope, no body, no
//   step-up. It acts only on an ACTIVE lab order whose transmission was REFUSED before any message was built
//   (`orm_refused:*` other than the SUD gate and the immutable-order facts, or `dispatch_refused:*`). Those orders are
//   not on the Held Transmissions list, so the order detail is where the action lives. Whether to OFFER it is the
//   server's `allowedActions.resend_transmission`; whether it is PERMITTED is decided again by the route.
import type { ApiClient, operations } from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok200<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;

export type ResendOutcome = Ok200<operations["postApiV1OrdersByIdResendtransmission"]>;

export type ResendResult =
  | { readonly ok: true; readonly value: ResendOutcome }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

/** The standard error envelope (`{ error: { code, message } }`) → copy the user can act on. */
export function resendFailureMessage(status: number | null, body: unknown): string {
  const raw = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  const detail = typeof raw === "string" && raw.length > 0 ? raw : null;
  if (status === 403)
    return "Not permitted — resending a lab transmission needs orders.transmission.recover for this order.";
  if (status === 404) return "That order is no longer available to you.";
  if (status === 409)
    return (
      detail ?? "The order's transmission changed under you. Reload the order and check it again."
    );
  return detail ?? "The transmission could not be resent. Please try again.";
}

export async function resendTransmission(client: ApiClient, id: string): Promise<ResendResult> {
  try {
    const { data, error, response } = await client.POST("/api/v1/orders/{id}/resend-transmission", {
      params: { path: { id } },
    });
    if (error || !data) {
      const status = response?.status ?? null;
      return { ok: false, status, message: resendFailureMessage(status, error) };
    }
    return { ok: true, value: data };
  } catch {
    return { ok: false, status: null, message: resendFailureMessage(null, undefined) };
  }
}

const ORM_REFUSED = "orm_refused:";
const DISPATCH_REFUSED = "dispatch_refused:";

/** The producer's refusal token (the part after the prefix) → what is missing, in plain words. Never free text. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  patient_not_found: "the patient record could not be found",
  patient_merged: "the patient record was merged into another",
  sud_restricted: "the substance-use-disorder disclosure gate (42 CFR Part 2) applies",
  patient_mrn_missing: "the patient's MRN is missing",
  patient_name_missing: "the patient's legal name is incomplete",
  patient_dob_missing: "the patient's date of birth is missing",
  patient_sex_unrecorded: "the patient's sex is not recorded",
  patient_sex_unmappable: "the patient's recorded sex cannot be sent to the lab",
  physician_unresolved: "the ordering physician could not be resolved",
  physician_not_active: "the ordering physician is not active",
  physician_npi_unconfirmed: "the ordering physician's NPI is not confirmed",
  physician_name_missing: "the ordering physician's name is incomplete",
  lab_test_codes_missing: "the order has no lab test codes",
  multiple_test_codes_unsupported: "the order has more than one test code",
  no_routing_lab: "the order names no performing lab",
  lab_facility_unresolved: "the performing lab could not be resolved",
  no_active_feed: "there is no active lab interface",
  ambiguous_feed: "more than one lab interface matches",
  no_feed_for_destination: "no lab interface serves this lab",
  feed_identity_incomplete: "the lab interface's identity settings are incomplete",
  payload_invalid: "the lab message failed validation",
  dependency_unavailable: "a required service was unavailable",
};

const humanize = (token: string): string => token.replace(/[_:]/g, " ").trim();

/** The refusal token alone (no prefix) → plain words; an unknown token is shown humanized, never dropped. */
export function refusalLabel(token: string): string {
  return REFUSAL_COPY[token] ?? humanize(token);
}

/** Refusals that mean "nothing is set up to send this", not "a send went wrong" → the info-pill text. */
const NOT_SENT_INFO_LABEL: Readonly<Record<string, string>> = {
  no_active_feed: "Not sent — no lab interface configured",
  no_feed_for_destination: "Not sent — no lab interface configured",
  no_routing_lab: "Not sent — no performing lab on the order",
};

/** The informational pill text for a failed transmission that only lacks setup, else null (a real failure). */
export function notSentInfoLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const token = reason.startsWith(ORM_REFUSED)
    ? reason.slice(ORM_REFUSED.length)
    : reason.startsWith(DISPATCH_REFUSED)
      ? reason.slice(DISPATCH_REFUSED.length)
      : "";
  return NOT_SENT_INFO_LABEL[token] ?? null;
}

/** The order's `transmissionFailureReason` → one sentence for the order detail. */
export function transmissionFailureLabel(reason: string): string {
  if (reason.startsWith(ORM_REFUSED))
    return `Not sent: ${refusalLabel(reason.slice(ORM_REFUSED.length))}.`;
  if (reason.startsWith(DISPATCH_REFUSED))
    return `Not sent by the lab interface: ${refusalLabel(reason.slice(DISPATCH_REFUSED.length))}.`;
  if (reason === "dlq_exhausted") return "Retries exhausted — delivery unconfirmed.";
  if (reason === "application_reject") return "Rejected by the lab interface.";
  if (reason.startsWith("recovery_blocked:"))
    return `Recovery blocked: ${humanize(reason.slice("recovery_blocked:".length))}.`;
  return `${humanize(reason)}.`;
}

export function resendOutcomeMessage(outcome: ResendOutcome): {
  readonly tone: "success" | "info";
  readonly text: string;
} {
  if (outcome.outcome === "requested")
    return {
      tone: "success",
      text: "Sent to the lab interface again. The transmission status updates when the lab acknowledges it.",
    };
  return {
    tone: "info",
    text: `The order still could not be sent${
      outcome.refusalReason ? ` — ${refusalLabel(outcome.refusalReason)}` : ""
    }. Fix that and resend again.`,
  };
}
