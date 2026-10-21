// apps/backend/src/modules/12-dosespot/webhooks/ingest.ts — the `POST /webhooks/dosespot` ingest core
// (M12 spec §2.5 D7 / §7.4; F-230, #248). Transport-free: the route hands it the RAW body + the two security
// headers; it returns a verdict the route maps to an HTTP status.
//
// The §7.4 envelope, in order: (1) parse the envelope just enough to learn the tenant (the tenant id only
// selects WHICH secret to verify against); (2) verify timestamp (±5 min) + HMAC-SHA256 of the raw body with
// THAT tenant's secret (`verifyWebhookEnvelope`, constant-time) — a tenant with no secret is rejected exactly
// like a bad signature (no tenant-existence oracle); (3) inside ONE org-scoped transaction: dedup-insert the
// `dosespot_webhook_event` row on `(organization_id, dosespot_event_id)` (a redelivery returns `duplicate`,
// nothing re-processed), persist the body ONLY as a per-tenant DEK envelope + its SHA-256 digest, dispatch the
// typed handler, and record the processing outcome. One transaction on purpose: a receipt row that committed
// while its handler did not would make the dedup key swallow every redelivery forever.
//
// Handled: `script_status_update` Dispensed/PickedUp -> `medication_order_dispense` row +
// `m12.medication_order.dispensed_at_pharmacy`; Sent -> pharmacy ack (order activates); RxFillError/Rejected ->
// pharmacy nack; `refill_request` -> a pending `refill_request` + `m12.refill_request_received`;
// `prescriber_status_changed` -> the prescriber's IAL2 status (GAP-037, `./handlers.ts`). Every other
// (event_type, status) is PERSISTED and audited but its outcome is recorded honestly as `*_not_handled`
// (`medication_history_result`, `patient_mismatch`; see docs/history F-230 / m12-dosespot-adapter.md).
//
// NEVER emits without a verified, persisted, parsed vendor payload. The body is never logged in the clear.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import {
  isAckStatus,
  isDispenseStatus,
  isNackStatus,
  parsePrescriberStatusPayload,
  parseRefillRequestPayload,
  parseScriptStatusUpdate,
  parseWebhookEnvelope,
  verifyWebhookEnvelope,
} from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import type { WebhookBodyCipher } from "./body-crypto";
import { handleAckOrNack, handlePrescriberStatus, handleRefillRequest } from "./handlers";
import type { DoseSpotWebhookSecretResolver } from "./secrets";

const EVT = schema.dosespotWebhookEvents;
const MO = schema.medicationOrders;
const DISP = schema.medicationOrderDispenses;

export type DoseSpotWebhookVerdict =
  | { readonly kind: "malformed" } // 400
  | { readonly kind: "malformed_timestamp" } // 400
  | { readonly kind: "stale" } // 400
  | { readonly kind: "invalid_signature" } // 401
  | { readonly kind: "duplicate" } // 200, no reprocessing
  | { readonly kind: "accepted"; readonly outcome: string }; // 200

export interface DoseSpotWebhookIngestDeps {
  readonly db: DbClient;
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly secrets: DoseSpotWebhookSecretResolver;
  readonly cipher: WebhookBodyCipher;
  readonly now?: () => Date;
  /** Structured, PHI-free log sink (event type + outcome + correlation id only). */
  readonly log?: (event: string, context: Record<string, unknown>) => void;
}

export interface DoseSpotWebhookRequest {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
  readonly timestampHeader: string | undefined;
}

export async function ingestDoseSpotWebhook(
  deps: DoseSpotWebhookIngestDeps,
  req: DoseSpotWebhookRequest,
): Promise<DoseSpotWebhookVerdict> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);

  const parsed = parseWebhookEnvelope(req.rawBody);
  if (!parsed.ok) return { kind: "malformed" };
  const envelope = parsed.envelope;
  const organizationId = envelope.organization_id;

  const secret = await deps.secrets.resolve(organizationId);
  if (secret === null) {
    // Indistinguishable from a bad signature on the wire (no tenant oracle); logged as its own cause.
    log("dosespot.webhook.rejected", { reason: "NO_TENANT_SECRET" });
    return { kind: "invalid_signature" };
  }
  const verdict = verifyWebhookEnvelope({
    rawBody: req.rawBody,
    signatureHeader: req.signatureHeader,
    timestampHeader: req.timestampHeader,
    webhookSecret: secret,
    nowMs: now.getTime(),
  });
  if (!verdict.ok) {
    log("dosespot.webhook.rejected", { reason: verdict.reason });
    if (verdict.reason === "INVALID_SIGNATURE") return { kind: "invalid_signature" };
    if (verdict.reason === "STALE_REQUEST") return { kind: "stale" };
    return { kind: "malformed_timestamp" };
  }

  const correlationId = randomUUID();
  const encrypted = await deps.cipher.encrypt(organizationId, req.rawBody);

  const result = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (txRaw): Promise<DoseSpotWebhookVerdict> => {
      const tx = txRaw as unknown as DbClient;
      const [receipt] = await tx
        .insert(EVT)
        .values({
          organizationId,
          dosespotEventId: envelope.dosespot_event_id,
          eventType: envelope.event_type,
          rawBodyCipher: encrypted.cipher,
          rawBodyDek: encrypted.dekRef,
          bodyDigest: verdict.bodyDigest,
          signatureVerifiedAt: now,
          correlationId,
        })
        .onConflictDoNothing({ target: [EVT.organizationId, EVT.dosespotEventId] })
        .returning({ id: EVT.id });
      if (!receipt) return { kind: "duplicate" };

      let outcome: string;
      let errorClass: string | null = null;
      const at = envelope.occurred_at ? new Date(envelope.occurred_at) : now;
      const eventAt = Number.isNaN(at.getTime()) ? now : at;
      if (envelope.event_type === "script_status_update") {
        const update = parseScriptStatusUpdate(envelope.payload);
        if (!update.ok) {
          outcome = "malformed_payload";
          errorClass = "PAYLOAD_SHAPE";
        } else if (isDispenseStatus(update.update.status)) {
          outcome = await handleDispense(tx, deps.outbox, {
            organizationId,
            webhookEventId: receipt.id,
            dosespotEventId: envelope.dosespot_event_id,
            dosespotPrescriptionId: update.update.dosespot_prescription_id,
            status: update.update.status,
            occurredAt: update.update.status_at ?? envelope.occurred_at,
            fillNumber: update.update.fill_number,
          });
        } else if (isAckStatus(update.update.status) || isNackStatus(update.update.status)) {
          outcome = await handleAckOrNack(tx, deps.outbox, {
            organizationId,
            update: update.update,
            kind: isAckStatus(update.update.status) ? "ack" : "nack",
            at: now,
          });
        } else {
          outcome = "status_not_handled";
        }
      } else if (envelope.event_type === "refill_request") {
        const refill = parseRefillRequestPayload(envelope.payload);
        if (!refill.ok) {
          outcome = "malformed_payload";
          errorClass = "PAYLOAD_SHAPE";
        } else {
          outcome = await handleRefillRequest(tx, deps.outbox, {
            organizationId,
            dosespotEventId: envelope.dosespot_event_id,
            refill: refill.refill,
            receivedAt: eventAt,
          });
        }
      } else if (envelope.event_type === "prescriber_status_changed") {
        const status = parsePrescriberStatusPayload(envelope.payload);
        if (!status.ok) {
          outcome = "malformed_payload";
          errorClass = "PAYLOAD_SHAPE";
        } else {
          outcome = await handlePrescriberStatus(tx, {
            organizationId,
            status: status.status,
            at: now,
          });
          if (outcome === "malformed_payload") errorClass = "PAYLOAD_SHAPE";
        }
      } else {
        // medication_history_result / patient_mismatch: persisted + audited, no handler yet.
        outcome = "event_type_not_handled";
      }
      await tx
        .update(EVT)
        .set({ processedAt: now, processingOutcome: outcome, processingErrorClass: errorClass })
        .where(eq(EVT.id, receipt.id));
      return { kind: "accepted", outcome };
    },
  );
  log("dosespot.webhook.processed", {
    eventType: envelope.event_type,
    verdict: result.kind,
    outcome: result.kind === "accepted" ? result.outcome : undefined,
    correlationId,
  });
  return result;
}

async function handleDispense(
  tx: DbClient,
  outbox: DoseSpotWriteOutboxPort,
  input: {
    readonly organizationId: string;
    readonly webhookEventId: string;
    readonly dosespotEventId: string;
    readonly dosespotPrescriptionId: string;
    readonly status: "Dispensed" | "PickedUp";
    readonly occurredAt: string;
    readonly fillNumber: number | undefined;
  },
): Promise<string> {
  const dispensedAt = new Date(input.occurredAt);
  if (Number.isNaN(dispensedAt.getTime())) return "malformed_payload";

  // Resolve the ChartWarden order from the vendor prescription id M12 recorded at transmission time. An unknown
  // prescription id is recorded as such — never guessed, never matched loosely.
  const [order] = await tx
    .select({
      id: MO.id,
      patientId: MO.patientId,
      pharmacyMdmId: MO.dispensingPharmacyMdmId,
    })
    .from(MO)
    .where(
      and(
        eq(MO.organizationId, input.organizationId),
        eq(MO.dosespotPrescriptionId, input.dosespotPrescriptionId),
      ),
    )
    .limit(1);
  if (!order) return "order_not_found";

  const [dispense] = await tx
    .insert(DISP)
    .values({
      organizationId: input.organizationId,
      patientId: order.patientId,
      medicationOrderId: order.id,
      dosespotPrescriptionId: input.dosespotPrescriptionId,
      webhookEventId: input.webhookEventId,
      dosespotEventId: input.dosespotEventId,
      scriptStatus: input.status,
      dispensedAt,
      fillNumber: input.fillNumber ?? null,
      dispensingPharmacyMdmId: order.pharmacyMdmId ?? null,
    })
    .onConflictDoNothing({ target: [DISP.organizationId, DISP.dosespotEventId] })
    .returning({ id: DISP.id });
  if (!dispense) return "dispense_duplicate";

  await outbox.publish(tx, {
    eventName: "m12.medication_order.dispensed_at_pharmacy",
    organizationId: input.organizationId,
    aggregateKind: "medication_order",
    aggregateId: order.id,
    payload: {
      orderId: order.id,
      dosespotPrescriptionId: input.dosespotPrescriptionId,
      dispensedAt: dispensedAt.toISOString(),
      // The pharmacy OF RECORD on the order — the webhook's own pharmacy identity (NCPDP) is not mapped
      // (wire mapping pending vendor docs), so this is the ordered pharmacy, not a vendor-confirmed one.
      dispensingPharmacyMdmId: order.pharmacyMdmId ?? null,
      ...(input.fillNumber !== undefined ? { fillNumber: input.fillNumber } : {}),
    },
  });
  return "dispense_recorded";
}
