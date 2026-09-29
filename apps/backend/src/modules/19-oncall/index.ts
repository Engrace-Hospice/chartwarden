// apps/backend/src/modules/19-oncall — Module 19 (On-Call Triage).
//
// M19-T02 lands the §3.7 `triage_record` eraser (`erasers/`) alongside the ten owned tables in
// `packages/db/src/schema/oncall` (migrations 0107/0108). The eraser is here rather than in a feature
// package because M19 has none: Wave P2-2 acceptance #1 limits this wave's manifest changes to
// `packages/triage-vendors` and the two Track B web codePaths, so M19's CONTRACTS live in
// `@wardenx/types` (`oncall.ts`, M19-T01) and its domain services under this path (the M6 precedent).
//
// M19-T03 lands the §2.2–§2.7 domain core in `lifecycle/` — the nine-state triage-call machine, the
// protocol engine (apply-and-pin, the server-authoritative ordered walk, the D5 red-flag evaluator), the
// D7 escalation ladder, the D6 disposition scope matrix, the §2.7 BCP paper-re-entry path, and the 28
// platform-floor protocols migration 0109 seeds (§3.2 Phase E, deferred out of T02 because the seed
// encodes the `red_flag_match` predicate shape the engine owns).
//
// M19-T04 lands the on-call roster and the two D10 inbound triggers — the first cross-module BINDS this
// module makes. `roster/` holds the §2.2.2 shift machine and the §4.5 reconciliation of M17's
// `VisitAssignmentReader.tonightsOnCallRoster` into `on_call_shift` rows (closing M17's Wave-F on-call
// roster deny-stub); `consumers/` holds the `m17.visit.no_show_detected` (§7.6) and
// `m18.evv.late_check_out_detected` (§4.8) deciders that open a proactive welfare-check call, closing M17's
// and M18's Phase-1 inert consumers. `seams/consumed.ts` is the only place M19 reaches across a module
// boundary, and it does so through the M1 registry — never a schema import.
//
// M19-T05 lands `clinical/` — the three bindings a call reaches into once it is running: M8's
// `EncounterCreator` (D8, plus the `m8.encounter.signed` consumer that is the only thing which advances a
// call to `documented`), M11's `OrderSignatureProvider` behind the §7.7 verbal order with its M2 step-up
// gate (D9), and M12's `RefillInboxProvider`/`MedicationOrderProvider` read surface the disposition is
// chosen against (D15). Three published contracts disagreed with the spec's sketch of them and the OWNER
// won each time — see the file headers in `clinical/`.
//
// M19-T06 lands `seams/` — the five §4.3 PUBLISHED reader seams (`OnCallProvider` · `TriageCallReader` ·
// `TriageCallProvider` · `PortalTriageReader` · `TriageCallMetricsProvider`) registered into the M1
// registry over their boot deny-stubs, all five composed over ONE injected `OncallSeamStore` (Drizzle in
// production). `OnCallProvider` is what M36's `on_call` channel membership + alert routing and M20's
// after-hours SOS parallel recipient (M20 §7.5 D14) resolve through. The same task registers the two
// ADVISORY M32 seams (§8.6 D11/D12) as the platform's only NON-THROWING deny-stubs — an advisory that
// gates nothing must degrade to a disabled AI block, not to a failed call-open.
//
// M19-T07 lands the ROUTE LAYER — the §4.1 surface plus the three things that only exist once there is a
// request to attach them to. `routes/` holds the five plugins (calls · escalations · shifts+policy ·
// protocols+vendors · portal) over a split Drizzle READ/WRITE service; `permission-keys.ts` re-exports the
// seventeen §4.6 keys M19 contributes to M3's catalog; `abac-predicates.ts` registers the six §4.7
// predicates M19 OWNS; `alerts.ts` turns the machines' declared `{kind:'alert'}` effects into the §4.9
// typed M36 payloads; `vendor/` is the §8.5 adapter mandate made operational plus the §7.10 PHI boundary
// every outbound byte leaves through; and `consumers/m36-delivery-failed.ts` closes the §4.8 trigger.
//
// FOUR THINGS THIS TASK DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • §4.1's per-call ABAC cell is ONE predicate chosen by SESSION CLASS, not two ANDed — ANDing
//     `triage_call_owner_or_supervisor` with `external_triage_actor` denies every caller.
//   • The vendor projection is a DIFFERENT TYPE (`VendorTriageCallView`), not a filtered one, so §8.3.1's
//     "not bypassable by route-level code" is structural.
//   • The M8 seam call runs AFTER the disposition commits — a probe inside our own transaction
//     self-deadlocks the pool, and §2.7 class D-B needs the transition to survive an M8 outage.
//   • The §8.5 adapter registry ships EMPTY and that is the correct state: Phase 1 has no signed BAA, so
//     every `hybrid`/`centralized` handoff refuses and the call stays in-agency.
//
// Still to land: the §5 screens (T08).
export * from "./lifecycle";
export * from "./roster";
export * from "./consumers";
export * from "./clinical";
export * from "./seams/index";
export * from "./alerts";
export * from "./vendor/index";
export {
  M19_CONTRIBUTED_PERMISSIONS,
  M19_PERMISSION_KEY_LIST,
  M19_STEP_UP_PERMISSION_KEYS,
  M19_VENDOR_SESSION_PERMISSION_KEYS,
  type M19PermissionKey,
} from "./permission-keys";
export {
  type OncallAbacDeps,
  type OncallAbacPorts,
  type OncallAbacResolver,
  type OnCallShiftAbacFacts,
  type TriageCallAbacFacts,
  type TriageEscalationAbacFacts,
  ESCALATION_TIER_ROLES,
  M19_ABAC_PREDICATES,
  ONCALL_OVERSIGHT_ROLES,
  PORTAL_SESSION_CLASSES,
  ROLES_BY_ESCALATION_TIER,
  TRIAGE_DISCIPLINE_FOR_ROLE_KEY,
  VENDOR_SESSION_CLASSES,
  buildOncallAbacPredicates,
  decideEscalationRecipient,
  decideEscalationRecipientScope,
  decideExternalTriageActor,
  decideOnCallEligible,
  denyStubOncallAbacResolver,
  registerOncallAbacPredicates,
  seamOncallAbacPorts,
  triageDisciplineForRoleKeys,
} from "./abac-predicates";
export {
  type OncallAbacResolverDeps,
  type OncallRoleGrantReader,
  buildDrizzleOncallAbacResolver,
} from "./abac-resolver-drizzle";
export * from "./routes/index";
export { mountM19Routes } from "./routes/mount";
// F-030 — the vendor-session bind surface (the route mounts only when this reader is supplied).
export {
  buildDrizzleVendorSessionBindReader,
  registerVendorSessionRoutes,
  type VendorBindingFacts,
  type VendorSessionBindReader,
  type VendorSessionRouteDeps,
} from "./routes/mount";
export { M19_OUTBOX_EVENTS } from "./events-by-m19";
// §4.8 `m19.shift-sync.debounced` — the roster-sync debounce table's queue catalog + live BullMQ
// construction + platform-tenancy wiring (m19 `handlers-unbound` group, #248; F-155's own finding, now
// built). Named re-exports rather than `export * from "./jobs"`: `./jobs/index.ts` is deliberately pure
// data with no BullMQ import (see its own header), and `./jobs/worker.ts`/`./jobs/wiring.ts` are the live
// construction the composition root binds at boot.
export {
  M19_DLQ,
  M19_JOB_SCHEDULES,
  M19_QUEUE_PARAMS,
  M19_QUEUES,
  M19_ROSTER_SYNC_CATCHUP_JOB_NAME,
  M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS,
  M19_ROSTER_SYNC_DRAIN_JOB_NAME,
} from "./jobs/index";
export {
  type M19WorkerDeps,
  registerM19CronWorkers,
  runOnCallRosterSyncCatchupTick,
  runOnCallRosterSyncDrainTick,
  scheduleM19Jobs,
} from "./jobs/worker";
export { M19_PLATFORM_JOB_ID, wireM19Tenancy } from "./jobs/wiring";
export {
  type EnsureCatchUpPendingInput,
  type TriggerDebounceInput,
  OnCallRosterSyncQueueRepository,
} from "./jobs/repository";
export {
  type OrgReconcileResult,
  type OrgRosterReadPort,
  type ProviderEntityPolicyRow,
  reconcileOrgOnCallRoster,
} from "./jobs/reconcile";
export {
  type InMemoryTriageEraseSeed,
  type TriageEraseCounts,
  type TriageEraseOptions,
  type TriageEraseStore,
  type TriageEraserDeps,
  createDrizzleTriageEraseStore,
  createInMemoryTriageEraseStore,
  createTriageEraser,
  eraseTriageRecord,
  registerTriageErasers,
} from "./erasers/oncall-eraser";
