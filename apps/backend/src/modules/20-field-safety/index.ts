// apps/backend/src/modules/20-field-safety — Module 20 (Field Safety).
//
// M20-T02 lands the §3.7 `safety_record` eraser (`erasers/`) alongside the thirteen owned tables in
// `packages/db/src/schema/safety` (migrations 0110/0111). The eraser is here rather than in a feature
// package because M20 has none: Wave P2-2 acceptance #1 limits this wave's manifest changes to
// `packages/triage-vendors` and the two Track B web codePaths, so M20's CONTRACTS live in `@wardenx/types`
// (`safety.ts`, M20-T01) and its domain services under this path (the M6 / M19 precedent).
//
// The eraser is the one place this task had to decide something the spec states twice in different words.
// §3.7's retention table reads like a delete plan; read against §3.5 and §1.1 it is the opposite — M20 is a
// WORKFORCE-safety module, its patient surface is two logical M5 references, and almost everything else in
// it is the CLINICIAN's own record. So the erase redacts and unlinks and deletes nothing. The full argument
// is in `erasers/field-safety-eraser.ts`.
//
// M20-T03 lands the §2.2 domain core in `lifecycle/` — the thirteen-state SOS machine (§2.2.2) with the D5
// cancel window, the §4.8 SLA watchdog that walks the tier ladder into `emergency_terminus` and loops there,
// the D4 overdue-escalation rungs (§7.3), the D6 continuous-location gates (§7.9 / §8.7), the §7.8
// coverage-gap watchdog, and the §2.2.4 policy resolver they all read their thresholds from.
//
// FIVE THINGS THIS TASK DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • THE FAN-OUT IS AT THE PRESS, not at the end of the cancel window. §2.2.2's diagram says the latter;
//     D5 ("fire-immediate"), §7.4 (voice dialed at +800 ms) and §9.7 (300 ms budget) say the former.
//   • A REJECTED CANCEL DOES NOT MOVE THE LIFECYCLE — and the reason is migration 0110's `ssa_sla_scan_idx`,
//     which does not cover `cancel_attempted_but_rejected`: an alert parked there would never be scanned by
//     the SLA watchdog, so the hostile-actor SOS would stop escalating. §7.4's prose beats §2.2.2's diagram.
//   • §7.3 NAMES SCHEDULE STATES THE ENUM DOES NOT HAVE (`escalation_tier_1`, `sos_equivalent`). The stored
//     ladder is `proposed → overdue → escalated` and the D4 RUNG is derived from `expected_at`; the rung is
//     reconstructed from `escalated_at` so each fires exactly once with no new column.
//   • TWO §4.10 IDEMPOTENCY KEYS WOULD HAVE SUPPRESSED THE REPETITION THEY KEY — `check_in_escalated`
//     (once per rung) and `sos_terminus_reached` (once per loop). Both are composite now (@wardenx/types).
//   • THE TERMINUS LOOP WRITES NO STATE-HISTORY ROW: §3.3's `m20_ssash_no_self` CHECK refuses `from = to`,
//     so a loop that emitted one would die on a constraint at the moment nobody is answering.
//
// M20-T04 lands the §4.4 upstream bindings: `seams/consumed.ts` (M17 `VisitReader` /
// `VisitAssignmentReader`, M18 `EvvLocationProvider`, M19 `OnCallProvider`, M5 `PatientReader`) and the
// `consumers/` deciders they feed — the §7.1 cadence materializer, the EVV bracket re-anchors, the §4.8
// no-show inquiry, the §7.7 GPS-spoof badge and the §7.5 D14 after-hours parallel set. Binding
// `EvvLocationProvider` closes M18's Wave-F last-known-location deny-stub; binding `OnCallProvider`
// replaces the Phase-1 SOS degraded fallback (Wave P2-2 acceptance #2 and #3).
//
// SIX THINGS T04 DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • §4.4's `PatientAddressReader.geocodedAddressFor` DOES NOT EXIST anywhere on the platform, so D12's
//     pre-visit high-risk-area evaluation has NO address source and none is invented: there is no
//     accessor and no polygon evaluator. Fail-closed means the advisory is absent, never guessed.
//   • THE MID-VISIT CADENCE IS MEASURED FROM THE EVV ARRIVAL, not from the scheduled start (§7.1's own
//     arithmetic: 10:02 arrival → 11:02 prompt). Anchoring to the schedule prompts a late clinician at
//     minute twenty and then leaves her alone for the rest of the visit.
//   • AN EVV CHECK-IN CANNOT CLOSE AN UNANSWERED PRE-VISIT OBLIGATION: `m20_scis_recorded_fulfilled`
//     refuses `recorded` without a fulfilling check-in row, and minting one would forge an attestation.
//     D2 asks "are you OK", not "are you there", so the ladder keeps running.
//   • A NO-SHOW INQUIRY WITH NO SCHEDULE ROW IS UNEMITTABLE (`scheduleId` is non-nullable on both the
//     §4.10 payload and the §4.9 alert), so the consumer keeps ONE genuinely-overdue obligation as the
//     anchor, retires the rest, and emits nothing at all when every prompt was answered.
//   • RETIRING AN OBLIGATION IS A DELETE, because no member of `safety_check_in_state` can say "this plan
//     was invalidated" without lying — `recorded` is refused by a CHECK and `superseded` means
//     correction-of-record. The M4 write-audit trigger is what keeps the retirement on the record.
//   • THE D14 SET IS THREE-VALUED and carries external triage vendors on their own field: an
//     `OnCallProvider` outage is `unavailable` (never `[]`, which reads as a real coverage gap), and a
//     vendor-covered Saturday night has no membership to page but is NOT an uncovered night.
//
// M20-T05 lands the seven §4.3 PUBLISHED seams (`seams/store.ts` · `seams/providers.ts` ·
// `seams/store-drizzle.ts`), the §4.5 `field_safety_composed` recipient resolver M20 registers onto M36's
// open registry (`alert-rules.ts`), and the M20-F06 emergency-contact read (`seams/emergency-contact.ts`).
//
// SIX THINGS T05 DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • §4.5's SAMPLE RESOLVER RETURNS MEMBERSHIPS; M36's `RecipientResolverFn` RETURNS USER IDS. M20 binds
//     to the owner's contract (a re-declared seam is a permanently unbound one), so the membership→user
//     resolution happens inside the composed resolver — and the on-call arm uses M19's OWN `userId`
//     rather than re-resolving, because a second lookup could disagree about whose shift it is.
//   • A `string[]` CANNOT SAY "M19 DID NOT ANSWER", "THIS NIGHT IS COVERED BY A VENDOR M36 CANNOT PAGE"
//     or "THIS SET IS EMPTY" — all three are life-safety facts. `onCompositionGap` is therefore a
//     REQUIRED port, not an optional callback: optional is exactly the hole that degrades in silence at
//     3 a.m. with every test green.
//   • M20-F06's "emergency-contact OVERRIDE row" OVERRIDES NOTHING — M2 has no emergency-contact table,
//     so this row IS the record, and it is the CONSENT row: the contact lives in `consent_scope_detail`,
//     which `m20_secc_contact_present` requires for exactly that purpose. No fourteenth table, and no
//     shape in which a phone number M20 may not dial can exist.
//   • THE §8.6 PROJECTION REFUSES WITHOUT A DEK DECIPHER instead of answering `roundedCoordinates: null`.
//     Answering would tell M32's suggestion model that no incidents happened inside a polygon where they
//     did — a registered contract that denies and says why is the platform rule.
//   • THE BOARD'S `inHighRiskArea` IS STRUCTURALLY `null`, carried forward from T04: D12 has no address
//     source, M18's coordinates are projected away before any composer sees them, and a fabricated
//     advisory would tell a clinician a house is safe.
//   • `perHundredVisits` HAS NO M17 DENOMINATOR. M17 publishes no per-ProviderEntity visit count, so the
//     denominator is the visits M20 OBSERVED (materialized a check-in obligation for) — which biases the
//     rate upward when a consumer was down, and is why every rate method ships `visitCount` beside it.
//
// M20-T06 lands the §4.1 route surface (`routes/`), the §4.6 permission keys (`permission-keys.ts`, whose
// canonical map is `M20_CONTRIBUTED_PERMISSIONS` in @wardenx/auth), the six §4.7 ABAC predicates
// (`abac-predicates.ts` + its Drizzle resolver), the §4.9 M36 alert rules and payload builders
// (`alerts.ts`) and the §4.10 outbox catalog contribution (`events-by-m20.ts`).
//
// SEVEN THINGS T06 DECIDED THAT ARE NOT OBVIOUS FROM THE SPEC:
//   • §4.7's `org_scope` IS M3's INTRINSIC `inOrg`, VERBATIM ("session.organization_id ===
//     target.organization_id"), so M20 registers no second name for it. Two predicates that must never
//     disagree would satisfy `arch:abac-predicates` either way; the two §4.1 `org_scope` cells bind
//     `inOrg`. This is a deliberate NON-registration, and the gate cannot tell one from an omission.
//   • A `∨` CELL IS ONE PREHANDLER. §4.1 spells six cells as disjunctions and two `requireAbac` layers
//     would AND them (the M16-T06 finding) — which for `clinician_self ∨ supervises_clinician` denies
//     EVERYONE, because `m20_sss_no_self_supervision` makes a supervisor who is also the subject
//     unwritable. `ABAC_ANY` evaluates the names in order and passes on the first that allows.
//   • THE SOS PRESS TAKES NO IDEMPOTENCY KEY AND THE CANCEL TAKES NO `If-Match`. The first is §4.1's own
//     Idempotent column (`no`) and §2.6 / M20-F10: every press is a separate call for help. The second is
//     D5's five-second window — a version round-trip does not fit inside it, and the guards the cancel
//     needs (raiser, window, biometric) are stronger than a version compare anyway.
//   • AN INCIDENT CANNOT BE CREATED WITHOUT A BOUND DEK, AND THAT IS THE FAIL-CLOSED ANSWER.
//     `narrative_cipher` is NOT NULL and holds the substance of a workers-comp record; writing cleartext
//     into a column named `_cipher` would make the §3.7 erasure a lie. The SOS PRESS is the deliberate
//     asymmetry: it never refuses for a cipher, a consent or an attestation — the coordinate is replaced
//     by a recognisable sentinel (`routes/coordinates.ts`) and a warning rides the response.
//   • `acknowledgersDispatched` IS THREE-VALUED. `null` means the §4.5 composed resolver could not be
//     consulted, which the mobile client renders as the D15 `tel:` fallback; `0` means nobody is
//     subscribed, which is a real coverage gap. Collapsing them would hide M20-F01's degraded path.
//   • THE OSHA SIGN-OFF REFUSES ON A CLOSED INCIDENT rather than re-classifying it. §6 says the sign-off
//     "cannot be undone without a transition to `reopened` … and a second sign-off", so the refusal is
//     what forces the documented path instead of letting a filing land on a concluded review.
//   • DEACTIVATING A SUBSCRIPTION SUCCEEDS EVEN WHEN IT UNCOVERS SOMEBODY, and reports the gaps. Refusing
//     would leave a departed supervisor's row in place — the `all_subscriptions_deactivated` failure one
//     step earlier, a configuration that LOOKS complete and pages a membership that will not answer.
//
// Still to land: the §5 screens (T07).
export * from "./alert-rules";
export * from "./alerts";
export * from "./consumers";
export * from "./events-by-m20";
export * from "./lifecycle";
export * from "./permission-keys";
export * from "./routes/index";
export * from "./routes/mount";
export * from "./safety-crypto";
export * from "./sos-recipient-count";
export * from "./seams";
// F-111 (#249) — the §4.8 `m20.sos-sla-watchdog.cron` LIVE BullMQ Worker/Queue construction (the
// M9/M25/M7 precedent) + the platform-tenancy registration its active-org fan-out needs.
export {
  M20_DLQ,
  M20_COVERAGE_GAP_WATCHDOG_JOB_NAME,
  M20_JOB_SCHEDULES,
  M20_OVERDUE_DETECTOR_JOB_NAME,
  M20_QUEUES,
  M20_QUEUE_PARAMS,
  M20_SOS_WATCHDOG_JOB_NAME,
} from "./jobs/index";
export {
  type ActiveOrgListPort as M20ActiveOrgListPort,
  type M20WorkerDeps,
  buildM20WorkerDeps,
  registerM20CronWorkers,
  runCoverageGapWatchdogCron,
  runOverdueDetectorCron,
  runSosSlaWatchdogCron,
  scheduleM20Jobs,
} from "./jobs/cron-workers";
export {
  type SosTerminusPageInput,
  type SosTerminusPort,
  createWebhookOpsPager,
} from "./jobs/terminus-port";
export { M20_PLATFORM_JOB_ID, wireM20Tenancy } from "./wiring";
export {
  type M20RegisteredAbacPredicate,
  type SafetyAbacDeps,
  type SafetyAbacPorts,
  type SafetyAbacResolver,
  type SafetyCheckInAbacFacts,
  type SafetyClinicianScopeFacts,
  type SafetyIncidentAbacFacts,
  type SafetySosAbacFacts,
  type SafetySubscriptionAbacFacts,
  ACTIVE_SOS_RESPONDER_STATES,
  FIELD_ELIGIBLE_ROLE_KEYS,
  M20_ABAC_PREDICATES,
  SAFETY_OVERSIGHT_ROLES,
  buildFieldSafetyAbacPredicates,
  decideActiveSosResponder,
  decideFieldEligibleForSos,
  decideSafetySupervisorOrAbove,
  decideSupervisesClinician,
  denyStubSafetyAbacResolver,
  membershipIdOf,
  registerFieldSafetyAbacPredicates,
  seamSafetyAbacPorts,
  subscriptionCoversClinician,
} from "./abac-predicates";
export {
  type SafetyAbacResolverDeps,
  type SafetyRoleGrantReader,
  buildDrizzleSafetyAbacResolver,
} from "./abac-resolver-drizzle";
export {
  type InMemorySafetyEraseSeed,
  type SafetyEraseCounts,
  type SafetyEraseOptions,
  type SafetyEraseStore,
  type SafetyEraserDeps,
  SAFETY_REDACTED_CIPHER_SQL,
  SAFETY_REDACTED_TEXT,
  createDrizzleSafetyEraseStore,
  createInMemorySafetyEraseStore,
  createSafetyEraser,
  eraseSafetyRecord,
  registerSafetyErasers,
} from "./erasers/field-safety-eraser";
