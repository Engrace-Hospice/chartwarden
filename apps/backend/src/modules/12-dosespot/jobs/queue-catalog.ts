// apps/backend/src/modules/12-dosespot/jobs/queue-catalog.ts — GAP-037: the §4.8 BullMQ queue catalog, accounted
// for QUEUE BY QUEUE, with the honest state of each.
//
// HISTORY. The first GAP-037 pass could only record the seven vendor-gated queues as DEFERRED (no DoseSpot
// credentials, docs or samples existed). The close-out round BUILT them against the `DoseSpotClient` port: the
// live HTTP adapter (`@chartwarden/dosespot` `createHttpDoseSpotClient`, written from the public v2 swagger and proven
// against a recorded fake transport), the per-tenant configuration source, the seven crons, the sign-time enqueue
// and the webhook handlers. All ten §4.8 queues are therefore BUILT.
//
// WHAT "BUILT" DOES AND DOES NOT MEAN. Each queue runs only for a tenant whose DoseSpot configuration is complete
// (`DOSESPOT_TENANT_CONFIGS`); with none, the adapter is UNBOUND, nothing is queued for transmission and orders keep
// activating locally (`not_required`). And nothing here has ever spoken to a real DoseSpot: the endpoints and field
// names that no readable spec confirmed are flagged in `client/endpoints.ts` / `client/mappers.ts` and listed in
// `docs/history/m12-dosespot-adapter.md` under "requires sandbox verification". `adapterCaveats` carries the one
// per-queue fact an operator needs before enabling it.
import { M12_CRON_QUEUES } from "./queues";

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
  /** What must still be confirmed against a DoseSpot sandbox before this queue is trusted in production. */
  readonly adapterCaveats: string;
}

/** Retained for the boot log / tests: nothing is deferred any more, but the shape stays so a future regression
 * (a queue dropping back to deferred) is a typed, visible change. */
export interface M12DeferredQueue {
  readonly queue: M12SpecQueueName;
  readonly status: "deferred";
  readonly blockedOn: string;
  readonly unblockedBy: string;
  readonly upstreamData: string;
}

export type M12QueueEntry = M12BuiltQueue | M12DeferredQueue;

export const M12_QUEUE_CATALOG: readonly M12QueueEntry[] = [
  {
    queue: "dosespot.transmit_newrx",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.transmitNewRx} (jobs/transmit-newrx.ts) — claims queued orders, calls DoseSpotClient.transmitNewRx with the D8 key, settles the order + transmission row`,
    adapterCaveats:
      "coded-prescription body field names and the send confirmation shape (requires sandbox verification)",
  },
  {
    queue: "dosespot.transmit_queued_on_recovery",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.transmitQueuedOnRecovery} (jobs/transmit-newrx.ts) — reclaims crashed in-flight claims and drains the backlog an outage accumulated; poll-driven rather than event-driven`,
    adapterCaveats: "none beyond transmit_newrx",
  },
  {
    queue: "dosespot.patient_sync",
    status: "built",
    builtBy:
      "dosespot.sync_queue_drain (jobs/worker.ts) — edits an already-known DoseSpot patient, creates otherwise, drops the RxBenefit cache on a demographic change",
    adapterCaveats: "add/edit patient body field names (requires sandbox verification)",
  },
  {
    queue: "dosespot.fetch_medhx",
    status: "built",
    builtBy:
      "the medhx_fetch kind of dosespot.sync_queue_drain (jobs/worker.ts + history/ingest.ts)",
    adapterCaveats: "medication-history item field names; paging parameters not sent (one page)",
  },
  {
    queue: "dosespot.rx_benefit_prewarm",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.rxBenefitPrewarm} (jobs/rx-benefit-prewarm.ts) — fills rx_benefit_cache from real lookups only`,
    adapterCaveats:
      "NO RxBenefit endpoint exists in the public v2 swagger: lookupRxBenefit fails closed, so the cache stays empty until a sandbox-verified endpoint is added to client/endpoints.ts",
  },
  {
    queue: "dosespot.refill_sla",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.refillSla} (jobs/refill-sla.ts) — once-per-stage 48h/72h events over pending refill_request rows`,
    adapterCaveats:
      "rows come from the webhook refill_request handler, whose payload is provisional (WARNING: DOSESPOT_WIRE_MAPPING_VERIFIED=false); respondToRefillRequest has no verified endpoint",
  },
  {
    queue: "dosespot.ial2_expiry_warn",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.ial2ExpiryWarn} (jobs/ial2-and-epcs-sweeps.ts) — 30d/7d stages, expired prescribers lose EPCS`,
    adapterCaveats:
      "ial2_expires_at is written by the prescriber_status_changed webhook handler (provisional payload); no IDP polling exists",
  },
  {
    queue: "dosespot.transmission_timeout_sweep",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.transmissionTimeoutSweep} (jobs/transmission-sweep.ts) — polls getPrescriptionStatus for ack/nack and times out an unacknowledged order after 24h`,
    adapterCaveats:
      "Prescription.Status enum is swagger-verified; the list response envelope key is read tolerantly",
  },
  {
    queue: "dosespot.epcs_attempt_expiry_sweep",
    status: "built",
    builtBy: `${M12_CRON_QUEUES.epcsAttemptExpirySweep} (jobs/ial2-and-epcs-sweeps.ts) — pending epcs_signing_attempt past expires_at => failed_timeout and the order back to pending_signature`,
    adapterCaveats:
      "EPCS signing itself stays gated off (EPCS_NOT_CERTIFIED, ADR-006); this sweep only closes attempts that exist",
  },
  {
    queue: "dosespot.dispatch_webhook",
    status: "built",
    builtBy:
      "POST /webhooks/dosespot (webhooks/webhook-route.ts + webhooks/ingest.ts): verified, encrypted receipt, dedup, then dispatched inline by event type — script_status_update (dispensed / ack / nack), refill_request, prescriber_status_changed",
    adapterCaveats:
      "inner payload field names are OUR provisional mapping until a recorded DoseSpot delivery exists; medication_history_result and patient_mismatch are recorded as *_not_handled",
  },
];

export const M12_DEFERRED_QUEUES: readonly M12DeferredQueue[] = M12_QUEUE_CATALOG.filter(
  (q): q is M12DeferredQueue => q.status === "deferred",
);

/** The boot-time line: honest about the adapter being unbound until credentials are configured. */
export function describeM12AdapterPosture(configuredOrganizationIds: readonly string[]): string {
  const built = M12_QUEUE_CATALOG.filter((q) => q.status === "built").length;
  if (configuredOrganizationIds.length === 0) {
    return `M12 §4.8: ${built} of ${M12_QUEUE_CATALOG.length} queues built; the DoseSpot adapter is UNBOUND until per-tenant credentials are configured (DOSESPOT_TENANT_CONFIGS) — nothing is queued for transmission and orders keep activating locally; vendor endpoints/field names are unverified until a sandbox run`;
  }
  return `M12 §4.8: ${built} of ${M12_QUEUE_CATALOG.length} queues built; DoseSpot adapter bound for ${configuredOrganizationIds.length} tenant(s); vendor endpoints/field names are unverified until a sandbox run (see docs/history/m12-dosespot-adapter.md)`;
}

/** Back-compat for the first pass's boot line (kept so an unexpected deferral is still reported). */
export function describeM12DeferredQueues(): string {
  return M12_DEFERRED_QUEUES.length === 0
    ? "M12 §4.8: no deferred queues"
    : `M12 §4.8 queues DEFERRED: ${M12_DEFERRED_QUEUES.map((q) => q.queue).join(", ")}`;
}
