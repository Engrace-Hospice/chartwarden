// apps/web/src/modules/11-orders — the access layer of the Held Transmissions queue (GAP-125; F-201 / F-187 / F-188 /
// F-202). Every wire shape is a TYPE ALIAS into the generated `operations` map (the `orders-api.ts` rule), so a route or
// DTO drift is a compile error here.
//
// THE SERVER RULES THIS MIRRORS, READ FROM `routes/orders-routes.ts` AND `routes/held-transmissions-routes.ts`:
//   • GET  /orders/held-transmissions                      — `orders.transmission.view_held` (a PHI list read, audited).
//   • POST /orders/:id/recover-transmission                — `orders.transmission.recover` + order scope + a FRESH
//                                                            step-up (`order.recover_transmission`); 403
//                                                            STEP_UP_REQUIRED when it is stale.
//   • POST /orders/:id/recover-transmission/:rid/cosign    — `orders.transmission.recover` OR `.cosign_escalated`
//                                                            + the same step-up; a different USER than the requester.
//   • POST /orders/:id/recover-transmission/:rid/cancel    — `orders.transmission.recover`, no step-up.
// `resend-transmission` (F-182) is deliberately NOT offered here: it re-runs the producer for an order REFUSED before any
// message was built (`orm_refused:*` / `dispatch_refused:*`), and none of those is on this list — a held order may
// already be at the lab, which is exactly why only the attested recovery applies to it. The resend lives on the order
// detail instead (`resend-transmission.tsx`, offered by the server's `allowedActions.resend_transmission`).
import type { ApiClient, operations } from "@chartwarden/ui";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok200<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type HeldPage = Ok200<operations["getApiV1OrdersHeldtransmissions"]>;
export type HeldItem = HeldPage["items"][number];
export type HeldOrderDetail = Ok200<operations["getApiV1OrdersById"]>;
export type RecoveryRequest = NonNullable<HeldOrderDetail["pendingRecovery"]>;
export type TransmissionAttestation = HeldOrderDetail["transmissionAttestations"][number];
export type RecoverBody = ReqBody<operations["postApiV1OrdersByIdRecovertransmission"]>;
export type Attestation = RecoverBody["attestation"];
export type RecoverOutcome = Ok200<operations["postApiV1OrdersByIdRecovertransmission"]>;

/** The step-up operation key the recover + co-sign routes demand (`requireStepUp("order.recover_transmission")`). */
export const RECOVER_STEP_UP_ACTION = "order.recover_transmission";

/** Server patterns (orm-resend.ts `RECOVERY_CONTACT_NAME_PATTERN` / `RECOVERY_LAB_REFERENCE_PATTERN`). */
const CONTACT_NAME = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const LAB_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._#/-]{2,63}$/;

export interface EvidenceErrors {
  readonly contactName?: string;
  readonly labReference?: string;
}

export function validateEvidence(contactName: string, labReference: string): EvidenceErrors {
  return {
    ...(CONTACT_NAME.test(contactName.trim())
      ? {}
      : { contactName: "The lab contact's name: letters, spaces and . ' - only (2–80)." }),
    ...(LAB_REFERENCE.test(labReference.trim())
      ? {}
      : {
          labReference:
            "The lab's own call/confirmation reference: 3–64 letters, digits, . _ # / - and no spaces.",
        }),
  };
}

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number | null;
      readonly message: string;
      /** `/step-up?returnTo=…` when the refusal is STEP_UP_REQUIRED, else null. */
      readonly stepUp: string | null;
    };

/** The standard error envelope (`{ error: { code, message } }`) → copy the operator can act on. */
function failure(status: number | undefined, body: unknown, returnTo: string): ActionResult<never> {
  const code = typeof status === "number" ? status : null;
  const raw = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  const detail = typeof raw === "string" && raw.length > 0 ? raw : null;
  const message =
    code === 403
      ? "Not permitted — recovering a held transmission needs orders.transmission.recover for this order."
      : code === 409
        ? (detail ??
          "The order or the recovery request changed under you. Reload and check it again.")
        : code === 422
          ? (detail ?? "The server rejected the attestation details.")
          : code === 404
            ? "That order is no longer available to you."
            : (detail ?? "The action could not be completed.");
  return { ok: false, status: code, message, stepUp: stepUpRedirectFor(body, returnTo) };
}

export async function listHeldTransmissions(
  client: ApiClient,
  cursor: string | null,
): Promise<{ ok: true; page: HeldPage } | { ok: false; status: number | null }> {
  const { data, error, response } = await client.GET("/api/v1/orders/held-transmissions", {
    params: { query: { limit: 50, ...(cursor ? { cursor } : {}) } },
  });
  if (error || !data) return { ok: false, status: response?.status ?? null };
  return { ok: true, page: data };
}

export async function getHeldOrder(client: ApiClient, id: string): Promise<HeldOrderDetail | null> {
  const { data, error } = await client.GET("/api/v1/orders/{id}", { params: { path: { id } } });
  return error || !data ? null : data;
}

export async function recoverTransmission(
  client: ApiClient,
  id: string,
  body: RecoverBody,
  returnTo: string,
): Promise<ActionResult<RecoverOutcome>> {
  const { data, error, response } = await client.POST("/api/v1/orders/{id}/recover-transmission", {
    params: { path: { id } },
    body,
  });
  if (error || !data) return failure(response?.status, error, returnTo);
  return { ok: true, value: data };
}

export async function cosignRecovery(
  client: ApiClient,
  id: string,
  requestId: string,
  returnTo: string,
): Promise<ActionResult<RecoverOutcome>> {
  const { data, error, response } = await client.POST(
    "/api/v1/orders/{id}/recover-transmission/{requestId}/cosign",
    { params: { path: { id, requestId } } },
  );
  if (error || !data) return failure(response?.status, error, returnTo);
  return { ok: true, value: data };
}

export async function cancelRecovery(
  client: ApiClient,
  id: string,
  requestId: string,
  returnTo: string,
): Promise<ActionResult<true>> {
  const { data, error, response } = await client.POST(
    "/api/v1/orders/{id}/recover-transmission/{requestId}/cancel",
    { params: { path: { id, requestId } } },
  );
  if (error || !data) return failure(response?.status, error, returnTo);
  return { ok: true, value: true };
}

// ── display helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const humanize = (k: string): string => k.replace(/[_:]/g, " ").trim();

/** The fixed reason token → what it means for the operator. Never free text (the server says so). */
export function heldReasonLabel(reason: string): string {
  if (reason === "dlq_exhausted") return "Retries exhausted — delivery unconfirmed";
  if (reason === "application_reject") return "Rejected by the lab interface";
  if (reason.startsWith("recovery_blocked:"))
    return `Recovery blocked: ${humanize(reason.slice("recovery_blocked:".length))}`;
  return humanize(reason);
}

export function heldAge(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  if (hours >= 1) return `${hours} h ${Math.floor((seconds % 3600) / 60)} m`;
  return `${Math.max(0, Math.floor(seconds / 60))} m`;
}

export const STAGE_PILL: Record<
  HeldItem["stage"],
  { label: string; tone: "neutral" | "warning" | "critical" }
> = {
  none: { label: "New", tone: "neutral" },
  warn: { label: "Aging", tone: "warning" },
  critical: { label: "Critical", tone: "critical" },
};

export function outcomeMessage(outcome: RecoverOutcome): {
  tone: "success" | "info";
  text: string;
} {
  switch (outcome.outcome) {
    case "redispatched":
      return { tone: "success", text: "Re-sent to the lab. Watch for the acknowledgment." };
    case "marked_transmitted":
      return { tone: "success", text: "Marked transmitted — nothing was re-sent." };
    case "pending_cosign":
      return {
        tone: "info",
        text: "Recovery filed. A different person must co-sign within 24 hours before the order is re-sent.",
      };
    case "still_refused":
      return {
        tone: "info",
        text: `The producer still refused to send it${outcome.refusalReason ? ` (${humanize(outcome.refusalReason)})` : ""}. Correct the order instead.`,
      };
  }
}
