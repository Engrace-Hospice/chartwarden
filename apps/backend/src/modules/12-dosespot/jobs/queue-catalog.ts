// apps/backend/src/modules/12-dosespot/jobs/queue-catalog.ts — GAP-037: the §4.8 BullMQ queue catalog, accounted
// for QUEUE BY QUEUE.
//
// WHY THIS EXISTS. The status matrix reports M12 as Implemented because its routes, tables and the
// `dosespot_sync_queue` drain exist. It cannot say that outbound e-prescribing transmission and the §4.8
// refill / IAL2 / transmission-timeout / EPCS-expiry crons do NOT exist, so "Implemented" was read as
// "e-prescribing transmits". They are not built on purpose, and the reason is not effort: there are no DoseSpot
// credentials, base URL, vendor documentation or recorded sample anywhere in this repository (F-230,
// docs/history/outbox-248-builds.md), so a transport would fabricate an integration, and each cron below scans
// data that only the vendor ingest produces — a cron that wakes hourly to scan a table nothing writes would be a
// green dashboard over a control that does not exist. Every order is therefore `not_required` and activates
// locally (see `dosespot-route-service-db.ts`), which is the honest Phase-1 posture until the vendor lands.
//
// This file is the explicit per-queue deferral the audit asked for: each of the ten spec queues is either BUILT
// (and names its worker) or DEFERRED with the exact upstream it is gated on. The unit test pins the catalog to
// the spec's queue list so a queue cannot silently drop out, and the composition root logs the deferrals at boot.
// When the vendor ingest lands, build the crons TOGETHER with it (the pure deciders already exist in
// `@wardenx/dosespot`: `refill/refill-sla.ts`, `epcs/ial2.ts`, `epcs/signing-session.ts`,
// `transmission/enqueue.ts`) and move the entry from DEFERRED to BUILT in the same change.

/** The ten §4.8 queue names, verbatim. */
export const M12_SPEC_QUEUE_NAMES = [
  "dosespot.transmit_newrx",
  "dosespot.transmit_queued_on_recovery",
  "dosespot.patient_sync",
  "dosespot.fetch_medhx",
  "dosespot.rx_benefit_prewarm",
  "dosespot.refill_sla",
  "dosespot.ial2_expiry_warn",
  "dosespot.transmission_timeout_sweep",
  "dosespot.epcs_attempt_expiry_sweep",
  "dosespot.dispatch_webhook",
] as const;

export type M12SpecQueueName = (typeof M12_SPEC_QUEUE_NAMES)[number];

export interface M12BuiltQueue {
  readonly queue: M12SpecQueueName;
  readonly status: "built";
  /** The live worker / route that runs it. */
  readonly builtBy: string;
}

export interface M12DeferredQueue {
  readonly queue: M12SpecQueueName;
  readonly status: "deferred";
  /** Why it is not built. */
  readonly blockedOn: string;
  /** What has to exist for the build to be real rather than a stub. */
  readonly unblockedBy: string;
  /** The data the job would read — and whether anything produces it today. */
  readonly upstreamData: string;
}

export type M12QueueEntry = M12BuiltQueue | M12DeferredQueue;

const NO_VENDOR =
  "no DoseSpot credentials, base URL, vendor documentation or recorded sample exist in this repository (F-230); the production client is createUnboundDoseSpotClient";

export const M12_QUEUE_CATALOG: readonly M12QueueEntry[] = [
  {
    queue: "dosespot.transmit_newrx",
    status: "deferred",
    blockedOn: `${NO_VENDOR}, so there is no transmitNewRx transport to call`,
    unblockedBy:
      "a real DoseSpotClient.transmitNewRx binding plus the enqueue-transmission service moving signed orders to queued_for_transmission (packages/dosespot transmission/enqueue.ts has the pure decisions)",
    upstreamData:
      "medication_order rows in queued_for_transmission — nothing produces them today: every order is dosespot_send_state not_required and activates locally",
  },
  {
    queue: "dosespot.transmit_queued_on_recovery",
    status: "deferred",
    blockedOn:
      "it drains on m12.dosespot_recovered (circuit close), and with no vendor transport the breaker never opens or closes",
    unblockedBy: "the transmit_newrx worker and a breaker driven by real DoseSpot calls",
    upstreamData: "queued_for_transmission rows accumulated during an outage — none exist",
  },
  {
    queue: "dosespot.patient_sync",
    status: "built",
    builtBy:
      "m12 dosespot_sync_queue drain (dosespot.sync_queue_drain, jobs/worker.ts) — fails closed with DegradedError against the unbound client",
  },
  {
    queue: "dosespot.fetch_medhx",
    status: "built",
    builtBy:
      "the medhx_fetch kind of the same dosespot_sync_queue drain (jobs/worker.ts + history/ingest.ts) — records nothing against the unbound client",
  },
  {
    queue: "dosespot.rx_benefit_prewarm",
    status: "deferred",
    blockedOn: `${NO_VENDOR}, and the rx-benefit lookup it would prewarm is itself a vendor call`,
    unblockedBy: "a real DoseSpotClient rx-benefit binding and the rx_benefit_cache write path",
    upstreamData: "rx_benefit_cache — empty; the lookup route answers from the unbound client",
  },
  {
    queue: "dosespot.refill_sla",
    status: "deferred",
    blockedOn:
      "there is no refill ingest: the webhook route records receipts but nothing folds a refill-request event into refill_request",
    unblockedBy:
      "the vendor refill-request ingest (the §4.2 refill-request handler); the clock math is already in packages/dosespot refill/refill-sla.ts",
    upstreamData: "refill_request rows with a pending status — none are ever written",
  },
  {
    queue: "dosespot.ial2_expiry_warn",
    status: "deferred",
    blockedOn:
      "nothing writes dosespot_prescriber.ial2_expires_at: IAL2 proofing completes at the vendor, and no enrollment callback exists",
    unblockedBy:
      "the prescriber-enrollment / IAL2 vendor callback that records ial2_expires_at; the tiering is already in packages/dosespot epcs/ial2.ts",
    upstreamData: "dosespot_prescriber.ial2_expires_at — always NULL",
  },
  {
    queue: "dosespot.transmission_timeout_sweep",
    status: "deferred",
    blockedOn: "no order ever reaches the transmitted state, because nothing transmits",
    unblockedBy: "the transmit_newrx worker and the script-status-update webhook handler",
    upstreamData: "medication_order rows in transmitted with no webhook — none exist",
  },
  {
    queue: "dosespot.epcs_attempt_expiry_sweep",
    status: "deferred",
    blockedOn:
      "EPCS signing is gated off (ADR-006, EPCS_NOT_CERTIFIED), so no epcs_signing_attempt row is ever written",
    unblockedBy: "EPCS certification (21 CFR 1311.300) and the signing-session writer",
    upstreamData: "epcs_signing_attempt rows with outcome pending — none exist",
  },
  {
    queue: "dosespot.dispatch_webhook",
    status: "built",
    builtBy:
      "POST /webhooks/dosespot (webhooks/webhook-route.ts + webhooks/ingest.ts): verified, encrypted receipt, dedup, then dispatched inline — PARTIAL: only script_status_update Dispensed/PickedUp has a handler; refill-request, ack/nack, MedHx-result and patient-mismatch are recorded as *_not_handled (the refill_sla / transmission_timeout deferrals below depend on those handlers)",
  },
];

export const M12_DEFERRED_QUEUES: readonly M12DeferredQueue[] = M12_QUEUE_CATALOG.filter(
  (q): q is M12DeferredQueue => q.status === "deferred",
);

/** The boot-time warning text: names every deferred queue and the posture it leaves the tenant in. */
export function describeM12DeferredQueues(): string {
  const names = M12_DEFERRED_QUEUES.map((q) => q.queue).join(", ");
  return `M12 §4.8 queues DEFERRED until the DoseSpot vendor integration exists (every order stays dosespot_send_state not_required and activates locally): ${names}`;
}
