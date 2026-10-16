// apps/backend/src/modules/25-remittance — M25 Remittance & Denials backend surface. The pure
// revenue-cycle domain (Phase 2) is in ./domain; the X12 5010 835 sidecar adapter is
// @wardenx/x12-835-client. Phase 3 adds the contract surfaces (the §4.5 outbox catalog + the §4.6
// permission keys), then services (ingest/parse/post/match/classify/state), routes, workers, the eight
// reader seams, the M36 recipient resolver, the two ABAC predicates, the destruction eraser, and boot
// wiring. The composition root opts M25 in at boot (the M23/M27 NN-module/index.ts precedent).
export * as domain from "./domain";

// §4.5 — the M25 outbox-event catalog (the dispatcher validates each `m25.*` publish against it). The
// composition root merges this into the platform event catalog at boot.
export { M25_OUTBOX_EVENTS } from "./events-by-m25";

// §4.6 — the twenty-three permission keys M25 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M25_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M25ContributedPermissionKey,
  type M25PermissionKey,
  M25_CONTRIBUTED_PERMISSIONS,
  M25_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 — the two ABAC predicate resolvers (`claim_assigned_to_actor`, `appeal_within_deadline`) M25 owns
// + registers into M3's named-predicate registry. `registerM25AbacPredicates` is invoked at boot by the
// composition root; passing `{ db }` resolves facts under RLS, else the fail-closed deny-stub (M27 precedent).
export {
  type ReadingM25AbacDeps,
  type ReadingM25AbacResolver,
  type M25RegisteredAbacPredicate,
  M25_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM25AbacResolver,
  buildM25AbacPredicates,
  denyStubM25AbacResolver,
  registerM25AbacPredicates,
} from "./abac-predicates";

// §4.1 — the route plugins + the Drizzle-backed read/write service builders. The composition root mounts
// these over the Drizzle services when a DB client is present (the M27 `mountM27Routes` precedent); the
// write service's outbox port + the read service's M38 terminology lookup are injected at boot (deny-stub /
// no-op until wired).
export {
  type M25RouteServices,
  type M25ReadService,
  type M25WriteService,
  type WriteOutboxPort,
  type OutboxEmission,
  type TerminologyLookupPort,
  buildDrizzleAdrService,
  buildDrizzleDenialRouteService,
  buildDrizzleQicService,
  buildDrizzleReopeningService,
  buildDrizzleM25ReadService,
  buildDrizzleM25WriteService,
} from "./routes/index";
export { mountM25Routes } from "./routes/mount";
export { buildSeamAppealSourcePorts } from "./routes/appeal-packet-sources";

// §4.8 platform tenancy — the cron job id + the PLATFORM_CONTEXT_ALLOWLIST registration the active-org
// enumerator's `withPlatformContext` fan-out requires (the M30/M33/M34 wiring.ts precedent).
export { M25_PLATFORM_JOB_ID, wireM25Tenancy } from "./wiring";

// §4.4 — the M25→M27 cost-report published seam (ClaimSettlementProvider): the actual interim Medicare
// payments (835 CLP04) the cost-report E-1 settlement tie reconciles against. Registered into the M1
// SeamRegistry by the composition root in `wireModuleSeams` (the M23/M26 register…PublishedSeams precedent).
export {
  type ClaimSettlementProvider,
  buildM25ClaimSettlementProvider,
  registerM25PublishedSeams,
} from "./cost-report-seams";

// §4.4 — the upstream outbox consumers (m23.claim.rejected, m18.evv.aggregator_rejected,
// m22.document.rendered → denial seed / EVV back-link / document back-reference). The pure handlers + the
// frozen subscription-map (the former `registerM25Consumers` registrar is deleted, GAP-205; live
// topics bind through `./outbox-consumers/*`).
export {
  type DenialSeedStore,
  type DenialOpenedEmission,
  M25_OUTBOX_SUBSCRIPTIONS,
  handleClaimRejected,
  handleEvvAggregatorRejected,
  handleDocumentRendered,
} from "./consumers/handlers";
export {
  type M25ConsumerPorts,
  type M25ConsumeReport,
  M25_SUBSCRIPTION_MAP,
  M25_UPSTREAM_SUBSCRIPTIONS,
  dispatchM25UpstreamEvent,
} from "./consumers/index";

// §4.8 — the nightly cron handlers + the LIVE BullMQ cron-worker boot surface. The composition root
// constructs the §4.8 cron Workers + the repeatable schedules over the injected Valkey connection +
// Drizzle db; the M2 active-org enumerator + M36 alert router ports stay fail-closed-unbound at boot (RULE
// 4 — the typed thunks throw only when a CRON TICK RUNS, so boot stays green). Nothing runs at import.
export {
  type DenialAgingStore,
  type AppealDeadlineStore,
  type AlertEmission,
  type M25WorkerDeps,
  type WorkerAlertPort,
  type ActiveOrgListPort,
  M25_CRON_QUEUES,
  M25_JOB_SCHEDULES,
  buildM25WorkerDeps,
  registerM25CronWorkers,
  runAppealDeadlineWatch,
  runDenialAging,
  scheduleM25Jobs,
} from "./jobs/index";

// WX-PR-012 — the 835 receive → parse → post pipeline (spec Tasks #7/#8). `receiveAdvice` (dedup insert +
// `m25.edi.835_received` emit) and `postAdvice` (parse + transactional post + denial-seed + PR-ledger +
// posting-outcome events) — the latter driven by the LIVE dispatcher consumer below, which the EXISTING
// `remittance.replay` route naturally re-triggers (it already re-emits the same event).
export {
  type M25IngestActor,
  type M25IngestService,
  type ReceiveAdviceInput,
  type ReceiveAdviceResult,
  type PostAdviceResult,
  type ClaimMatchCandidateProvider,
  type ClaimMatchCandidateProviderByPayer,
  type TerminologyLookupPort as IngestTerminologyLookupPort,
  NO_CLAIM_MATCH_CANDIDATES,
} from "./ingest/service";
export { type M25IngestDrizzleDeps, buildDrizzleM25IngestService } from "./ingest/service-drizzle";
export {
  buildM23BackedClaimMatchCandidateProvider,
  buildM24BackedClaimMatchCandidateProvider,
} from "./ingest/claim-match-adapter";
export {
  type M25X12WorkerConfig,
  createFetchX12835HttpPort,
  m25X12WorkerConfigFromEnv,
  m25X12WorkerPortFromEnv,
} from "./ingest/x12-worker-transport";
export {
  type M25EdiReceivedConsumerBinding,
  buildM25EdiReceivedConsumer,
} from "./outbox-consumers/live-binding";
export {
  type M23ClaimRejectedConsumerBinding,
  buildM23ClaimRejectedConsumer,
} from "./outbox-consumers/m23-claim-rejected";
export {
  type M18EvvAggregatorRejectedConsumerBinding,
  buildM18EvvAggregatorRejectedConsumer,
} from "./outbox-consumers/m18-evv-aggregator-rejected";
export { buildDrizzleDenialSeedStore } from "./outbox-consumers/denial-seed-store-drizzle";

// §3.7 / §8.4 — the M4 `remittance` destruction eraser (PR-ledger per-patient erase; the line history rolls
// off via the M4 partition manager). Registered over the Phase-0 deny-stub via the injected registerEraser
// hook by the composition root's registerModuleErasers (the M23 import-boundary posture).
export {
  type RemittanceEraseStore,
  type RemittanceEraserDeps,
  type RegisterEraserHook,
  REMITTANCE_DATA_CLASS,
  createDrizzleRemittanceEraseStore,
  createInMemoryRemittanceEraseStore,
  createRemittanceEraser,
  registerRemittanceErasers,
} from "./erasers/remittance-eraser";
