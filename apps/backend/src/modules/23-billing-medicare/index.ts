// apps/backend/src/modules/23-billing-medicare — Module 23 (Billing — Medicare) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M23 at boot,
// mirroring the M27/M30/M33/M34 NN-module/index.ts precedent. P1 ships the CONTRACT surfaces only: the §4.10
// outbox-event catalog and the §4.6 contributed permission keys. The §4.7 ABAC predicate resolvers, the
// §4.1 route mount, the §4.8 BullMQ workers (claim/NOE/NOTR submit + retry, 999/277CA ack pulls, eligibility
// refresh, NOE/NOTR window-watch, MAC-portal health, the revalidate consumer), the §3.7 eraser registration,
// and the Drizzle-backed services land in P2/P3 (the M27 backend index is the shape this grows into).
//
// NB the §4.3 published reader seams (ClaimReader / ClaimDayProjectionProvider / ClaimSubmissionReader /
// ClaimMetricsProvider / MacCredentialAdmin) + the §4.4 consumed-seam bundle (M5/M6/M8/M18 readers, the M26
// CapProjectionProvider forward-seam deny-stub, M22/M36/M38/M40 seams, and the self-published
// `@wardenx/x12-837-client` X12WorkerClient) live in `@wardenx/billing` / `@wardenx/x12-837-client`. They are
// NOT wired into the M1 SeamRegistry here yet because M23's seam names are not yet members of the M1
// `SeamContracts` / `REQUIRED_SEAMS` (M1-owned); until then M23 is reachable cross-module via its §4.10 outbox
// events (the D2 outbox-only posture). Nothing here runs at import; the composition root opts M23 in at boot.
//
// AI-BLOCK (D13): Module 32 cannot create/modify/witness/resolve any M23 row. The dependency-cruiser boundary
// (no `packages/ai-platform/*` import from this module or `packages/billing` / `packages/x12-837-client`) and
// the per-route `actor_kind='ai_*'` reject land alongside the route mount in P3.
import { M23_OUTBOX_EVENTS } from "./events-by-m23";
import { M23_CONTRIBUTED_PERMISSIONS, M23_PERMISSION_KEY_LIST } from "./permission-keys";

// §4.10 — the M23 outbox-event catalog (the dispatcher validates each `m23.*` publish against it). The
// composition root merges this into the platform event catalog at boot (the M27/M30/M33/M34 precedent).
export { M23_OUTBOX_EVENTS } from "./events-by-m23";

// §4.6 — the twenty-eight permission keys M23 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M23_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M23ContributedPermissionKey,
  type M23PermissionKey,
  M23_CONTRIBUTED_PERMISSIONS,
  M23_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 — the four ABAC predicate resolvers (`provider_entity_billing_scope`,
// `claim_in_billing_manager_caseload`, `override_role_eligible`, `regulatory_required_rule_protected`)
// M23 owns + registers into M3's named-predicate registry. `registerM23AbacPredicates` is invoked at boot by
// the composition root, idempotently; passing `{ db }` resolves owner facts via the Drizzle resolver under
// RLS. With no db handle it defaults to the fail-closed deny-stub (the M27 precedent).
export {
  type ReadingM23AbacDeps,
  type ReadingM23AbacResolver,
  type M23RegisteredAbacPredicate,
  M23_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM23AbacResolver,
  denyStubM23AbacResolver,
  registerM23AbacPredicates,
} from "./abac-predicates";

// §4.1 — the route plugins + the Drizzle-backed READ + WRITE route-service builders + the boot-time
// claim-assembly service. The composition root mounts these over the Drizzle services when a DB client is
// present (the M27 `mountM27Routes` precedent). The assembly service's cross-module reader seams are
// fail-closed deny-stubs at boot (RULE 4) until they register in the M1 SeamRegistry.
export {
  type M23CombinedRouteService,
  type M23RouteServices,
  type M23ReadRouteService,
  type M23WriteRouteService,
  type M23ReadServicePorts,
  type M23WriteServicePorts,
  type WriteOutboxPort,
  buildDrizzleM23ReadService,
  buildDrizzleM23WriteService,
} from "./routes/index";
export { mountM23Routes } from "./routes/mount";
export { buildM23BootAssemblyService } from "./services/boot-assembly";

// §3.7 / §8.4 — the M4 destruction-registry `billing_record` eraser. Registered over the Phase-0 deny-stub by
// the composition root's `registerModuleErasers` hook; M23 cannot import the M1 bootstrap registry, so the
// `registerEraser` hook is INJECTED by the composition root (the eraser import-boundary note).
export {
  type BillingEraserDeps,
  type BillingSurveyorHoldProbe,
  type DrizzleBillingEraseStoreOptions,
  type RegisterEraserHook,
  BILLING_DATA_CLASS,
  createBillingEraser,
  createDrizzleBillingEraseStore,
  registerBillingErasers,
} from "./erasers/billing-eraser";

// §4.4 / §4.10 — the upstream outbox consumers (M5/M6/M8/M18/M40 LIVE; M25/M26 forward-seam deny-stubs). Like
// the M27 consumers posture, `registerM23Consumers` ships module-only (NOT wired into the boot dispatcher
// subscription from the composition root — conservative until the dispatcher subscription is active).
export {
  type M23ConsumerPorts,
  type M23UpstreamSubscription,
  M23_OUTBOX_SUBSCRIPTIONS,
  dispatchM23UpstreamEvent,
  registerM23Consumers,
} from "./consumers/index";

// §4.8 — the LIVE BullMQ worker/cron boot surface. The composition root constructs the §4.8 work-queue
// Workers + the cron consumers + the repeatable cron-schedule Queues over the injected Valkey connection,
// binding only `{ connection, db }`; every infra/seam/x12/portal port stays fail-closed-unbound at boot
// (RULE 4 — the typed thunks throw only when a JOB RUNS, so boot stays green). Nothing here runs at import.
export {
  M23_CRON_QUEUES,
  type M23CronQueueName,
  M23_IDEMPOTENCY_KEYS,
  M23_JOB_SCHEDULES,
  type M23QueueName,
  type M23QueueParam,
  M23_QUEUE_PARAMS,
  M23_QUEUES,
  type M23WorkerDeps,
  buildM23WorkerDeps,
  buildM23SubmissionQueuePort,
  buildM23RevalidateEnqueuePort,
  registerM23CronWorkers,
  registerM23Workers,
  registerM23LaunchWorkers,
  scheduleM23Jobs,
  scheduleM23LaunchJobs,
} from "./jobs/index";

export {
  createM23LaunchGateway,
  m23LaunchGatewayConfigFromEnv,
} from "./jobs/launch-gateway";
export type { M23LaunchGatewayConfig } from "./jobs/launch-gateway";

export {
  buildM23OutboxBackedSubmissionGate,
  buildM23SubmissionRequestConsumer,
  M23_SUBMISSION_REQUEST_EVENTS,
} from "./outbox-consumers/submit-requests";

// F-106 — M23's live NOE-draft consumer: the first writer `noe_record` has ever had.
export {
  type M23NoeDraftConsumerDeps,
  M23_NOE_DRAFT_CONSUMER,
  NOE_FILING_WINDOW_DAYS,
  buildM23NoeDraftConsumer,
  noeWindowTargetAt,
} from "./outbox-consumers/m6-election-period-started";

// F-107 — M23's live NOTR-draft consumer: the first writer `notr_record` has ever had.
export {
  type M23NotrDraftConsumerDeps,
  M23_NOTR_DRAFT_CONSUMER,
  M23_NOTR_TRIGGER_BY_EVENT,
  NOTR_FILING_WINDOW_DAYS,
  buildM23NotrDraftConsumer,
  notrWindowTargetAt,
  planNotrDraft,
} from "./outbox-consumers/m6-notr-triggers";

// GAP-037 — M23's live `m25.remittance.claim_*` consumer: the 835 → claim-adjudication feedback loop.
export {
  buildM23RemittanceConsumer,
  M23_REMITTANCE_CONSUMER,
} from "./outbox-consumers/m25-remittance";

// F-153 (#248) — the §4.8 `revalidate.consumer` producer side: six live bindings for the M6/M8 facts that
// can re-open a VALIDATING/READY claim's validation.
export {
  type M23RevalidateTriggerConsumerDeps,
  type M23RevalidateTriggerEventName,
  M23_REVALIDATE_TRIGGER_EVENTS,
  buildM23RevalidateTriggerConsumerFor,
  buildM23RevalidateTriggerConsumers,
  type RevalidateEnqueuePort,
} from "./outbox-consumers/m23-revalidate-triggers";
export { buildDrizzleRevalidationTargetResolver } from "./outbox-consumers/m23-revalidation-target-resolver";

// §4.4 — the M23→M27 cost-report published seam (PatientDaysProvider): the billed-and-accepted patient-day
// census the cost-report Worksheet-D reconciliation reads. The composition root registers it into the M1
// SeamRegistry in `wireModuleSeams` (the M26 `registerM26PublishedSeams` precedent — M23's first M1 publish).
export {
  type PatientDaysProvider,
  buildM23PatientDaysProvider,
  registerM23PublishedSeams,
} from "./cost-report-seams";

// §D13 — the AI-block surfaces: the boot validator over M32's prompt-template registry (empty-safe, NOT
// boot-wired — no precedent module wires one; exported + tested directly), the owned-table matcher, the
// only-admitted read-only `validation_ai_advisory` reader seam + its deny-stub, and the AI-governance audit
// channel classifier. The per-route `actor_kind='ai_*'` reject lives in ./routes/actor.ts; the import
// boundary is the `m23-billing-no-ai-platform` dependency-cruiser rule.
export {
  type AiAdvisoryReader,
  type BillingAuditChannel,
  type M23OwnedTableFamily,
  type PromptTemplateDescriptor,
  type PromptTemplateRegistry,
  type ValidationAiAdvisoryDto,
  ADVISORY_DISPLAY_EVENT_TYPE,
  AiBlockViolationError,
  M23_OWNED_TABLE_EXACT,
  M23_OWNED_TABLE_FAMILIES,
  auditChannelForBillingEvent,
  buildAdvisoryDisplayAuditEvent,
  denyAiAdvisoryReader,
  outputTypeTargetsBilling,
  validateAiBlockForBilling,
} from "./ai-block";

/**
 * Boot-contract accessor — returns the §4.10 + §4.6 contract surfaces for boot-catalog UPSERT convenience
 * (the M27 precedent). The composition root imports `M23_OUTBOX_EVENTS` + the permission catalog directly;
 * this helper keeps a single named accessor for tests/tooling.
 */
export function getM23BootContracts() {
  return {
    outboxEvents: M23_OUTBOX_EVENTS,
    contributedPermissions: M23_CONTRIBUTED_PERMISSIONS,
    permissionKeyList: M23_PERMISSION_KEY_LIST,
  } as const;
}
