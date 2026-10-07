// apps/backend/src/modules/16-bereavement — Module 16 (Bereavement).
//
// M16-T03 landed the §2.2–§2.6 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M6 death fact those machines decide over — the handshake that CLOSES M6's
// `m6.bereavement.eligible` outbox. M16-T04 adds `risk/`: the §4.3.4 evidence extractor over M15's
// `MswRiskFactorReader` + M9's `ScaleSeriesProvider`, the §4.3.3 deterministic D3/D17 scorer that turns it
// into the immutable `bereavement_risk_score` draft, and the `ai.full`-gated M32 Layer-2 narrative adapter.
//
// M16-T05 completes `seams/`: the seven §4.6 / D13 PUBLISHED surfaces (`registerBereavementSeams`) over one
// injected `BereavementSeamStore`, registered into the M1 registry from the composition root ahead of
// `validateSeams()` — six reads plus M32's Layer-2 write-back, which APPENDS to the immutable score ledger.
//
// M16-T06 lands the §4.1 route surface (`routes/`) over the Drizzle READ + WRITE services, the §4.7
// permission keys (`permission-keys.ts`), the §4.8 ABAC predicates (`abac-predicates.ts` + the Drizzle
// subject resolver), the §7.13 42 CFR Part 2 + D10 volunteer disclosure gates (`routes/disclosure.ts`),
// the §4.4 outbox catalog (`events-by-m16.ts` — whose `outreach_artifact_requested` IS the D14 M22
// letter/card render handshake), the §2.6 side-effect executor (`routes/effects-runner.ts`), and the §8.5
// `bereavement_record` eraser.
//
// Still to land: the §5 screens (M16-T07) and the §4.9 BullMQ workers.
export * from "./lifecycle/index";
export * from "./consumers/index";
export * from "./risk/index";
export * from "./seams/index";

// §4.4 — the M16 outbox-event catalog (the dispatcher validates each `m16.*` publish against it).
export { M16_OUTBOX_EVENTS } from "./events-by-m16";
export {
  M16_IDG_DECISION_CONSUMER,
  buildM16IdgDecisionConsumer,
} from "./outbox-consumers/m14-idg-decision-recorded";
export {
  type BereavementIntakeDeps,
  M16_BEREAVEMENT_ELIGIBLE_CONSUMER,
  buildM16BereavementIntakeConsumer,
} from "./outbox-consumers/m6-bereavement-eligible";
export {
  type ConsentRevocationDeps,
  M16_CONSENT_REVOKED_CONSUMER,
  buildM16ConsentRevokedConsumer,
} from "./outbox-consumers/m39-consent-revoked";
export {
  type DischargeDeathSecondaryDeps,
  M16_DISCHARGE_DEATH_SECONDARY_CONSUMER,
  buildM16DischargeDeathSecondaryConsumer,
} from "./outbox-consumers/m6-admission-discharged-death";
// F-159 (#248) — the §4.5 post-death-grant handler (`m39.consent.signed`) and the §2.6/D9 patient-level
// opt-out cascade (`m5.patient.bereavement_opt_out_changed`).
export {
  type ConsentSignedDeps,
  M16_CONSENT_SIGNED_CONSUMER,
  buildM16ConsentSignedConsumer,
} from "./outbox-consumers/m39-consent-signed";
// F-227 (#248) — the D18 external-source gate release (`m6.discharge.cosigned`).
export {
  type DischargeCosignedDeps,
  M16_DISCHARGE_COSIGNED_CONSUMER,
  buildM16DischargeCosignedConsumer,
} from "./outbox-consumers/m6-discharge-cosigned";
export {
  type PatientOptOutChangedDeps,
  M16_PATIENT_OPT_OUT_CHANGED_CONSUMER,
  buildM16PatientOptOutChangedConsumer,
} from "./outbox-consumers/m5-patient-opt-out-changed";

// §4.7 — the twenty-nine permission keys M16 contributes to M3's catalog.
export {
  type M16ContributedPermissionKey,
  type M16PermissionKey,
  M16_CONTRIBUTED_PERMISSIONS,
  M16_PERMISSION_KEY_LIST,
  M16_PORTAL_SELF_PERMISSION_KEYS,
} from "./permission-keys";

// §4.8 — the four ABAC predicates M16 owns + registers into M3's named-predicate registry.
export {
  type BereavedContactAbacFacts,
  type BereavementAbacDeps,
  type BereavementAbacResolver,
  type BereavementPlanAbacFacts,
  type M16RegisteredAbacPredicate,
  type VolunteerGatesProbe,
  BEREAVEMENT_CAPABLE_DISCIPLINES,
  BEREAVEMENT_OVERSIGHT_ROLES,
  BEREAVEMENT_VOLUNTEER_DISCIPLINE,
  DISCIPLINE_FOR_ROLE_KEY,
  M16_ABAC_PREDICATES,
  buildBereavementAbacPredicates,
  decideBereavementWindow,
  denyStubBereavementAbacResolver,
  disciplineForRoleKeys,
  hasBereavementOversight,
  registerBereavementAbacPredicates,
} from "./abac-predicates";
export {
  type BereavementAbacResolverDeps,
  type RoleGrantReader,
  buildDrizzleBereavementAbacResolver,
} from "./abac-resolver-drizzle";

// §4.1 — the route mount + the Drizzle-backed READ + WRITE service builders.
export {
  type M16ReadDeps,
  type M16ReadService,
  type M16RouteServices,
  type M16WriteDeps,
  type M16WriteService,
  type OutboxEmission as M16OutboxEmission,
  type WriteOutboxPort as M16WriteOutboxPort,
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
} from "./routes/index";
export { mountM16Routes } from "./routes/mount";

// GAP-129 — the per-tenant DEK envelope for the four `*_cipher` columns, the contact-channel reader and the roster seed.
export {
  type BereavementCipher,
  type BereavementCipherColumn,
  type BereavementKeyProvider,
  createBereavementCipher,
} from "./bereavement-crypto";
export { type BereavedContactChannels, openBereavedContactChannels } from "./contact-channels";
export { planCaregiverSeeds } from "./roster-seed";

// §8.5 — the M4 destruction-registry `bereavement_record` eraser.
export {
  type BereavementEraseCounts,
  type BereavementEraseOptions,
  type BereavementEraseStore,
  type BereavementEraserDeps,
  createBereavementEraser,
  createDrizzleBereavementEraseStore,
  createInMemoryBereavementEraseStore,
  eraseBereavementRecord,
  registerBereavementErasers,
} from "./erasers/bereavement-eraser";

// GAP-048 — the §4.9 time-driven crons (13-month auto-close, miss-deadline, anniversary lookahead): the live
// BullMQ Worker/Queue construction + the platform-tenancy registration their active-org fan-out needs.
export {
  M16_ANNIVERSARY_LOOKAHEAD_DAYS,
  M16_DLQ,
  M16_JOB_NAMES,
  M16_JOB_SCHEDULES,
  M16_QUEUES,
  M16_QUEUE_PARAMS,
} from "./jobs/index";
export {
  type ActiveOrgListPort as M16ActiveOrgListPort,
  type M16WorkerDeps,
  anniversaryLookaheadRange,
  buildM16WorkerDeps,
  closeCutoffDate,
  registerM16CronWorkers,
  runAnniversaryLookaheadCron,
  runClose13MonthsCron,
  runMissDeadlineCron,
  scheduleM16Jobs,
} from "./jobs/cron-workers";
export { M16_PLATFORM_JOB_ID, wireM16Tenancy } from "./wiring";
