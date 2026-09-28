// apps/backend/src/modules/08-encounters/events-by-m8.ts — Module 8's outbox-event contributions
// (M8-T11, spec §4.4). The full `m8.*` taxonomy keyed on M8's own tables, under the `m8.` namespace
// (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m8'), and valid declared consumers (real module ids). The named cross-module
// consumers (M9/M10/M14/M17/M22/M23/M24/M27/M28/M30/M31/M32/M33/M36) subscribe when they land; M8
// publishes the events now. Per §4.7 ("outbox publication is the only cross-module communication M8
// performs at the boundary") every M8 event is outbox-only — M8 is not a Socket.IO producer (§4.3:
// M36 fans out to channels off these events).
//
// The event NAMES mirror `M8_EVENT_NAMES` in @wardenx/types (the lifecycle/cosignature/late-entry side-
// effect machines restrict their `outbox` effects to that closed set); this file adds the TypeBox
// `payloadSchema` + declared consumers the dispatcher validates each publish against (§4.4 catalog).
// `m8.encounter.signed` is the system's clinical-record nervous-system trigger — its payload is LOCKED.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** The fourteen §2.1 encounter types (mirrors `encounter_type`, §3.2). */
const encounterType = Type.String({ minLength: 1 });
/** The eight §2.1 disciplines (mirrors `encounter_discipline`, §3.2). */
const discipline = Type.String({ minLength: 1 });
/** The §2.5 D4 late-entry tier reified on the encounter at finalize (mirrors `late_entry_tier`). */
const lateEntryTier = Type.Union([
  Type.Literal("normal"),
  Type.Literal("late_entry"),
  Type.Literal("significant_late_entry"),
  Type.Literal("administrative_override"),
]);
/** Whether EVV bracketed the visit or the gap is documented (mirrors `evv_bracket_state`, §2.7 D9). */
const evvBracketState = Type.Union([
  Type.Literal("evv_present"),
  Type.Literal("evv_missing_documented"),
]);

export const M8_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── encounter lifecycle ─────────────────────────────────────────────────────────────────────────
  {
    eventName: "m8.encounter.created",
    moduleOwner: "m8",
    description:
      "A draft encounter was created (route 1, or seeded by M17 visit-scheduling / M16 reuse).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      visitId: Type.Optional(Type.String({ minLength: 1 })),
      encounterType,
      discipline,
      authoredByMembershipId: Type.String({ minLength: 1 }),
      serviceDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.finalized",
    moduleOwner: "m8",
    description: "Finalize succeeded (Layer-3 gate passed); the vocab version is pinned (D11).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      vocabVersionId: Type.String({ minLength: 1 }),
      layer2Involved: Type.Boolean(),
      lateEntryTier,
    }),
    // F-115 (#248) — m30 moved to seamConsumers: it reads the org-level late-entry tally via
    // `SignedEncountersReader.lateEntryCountsForOrg` (late_encounter_entry_rate) on its nightly cadence,
    // not by reacting to this event — no consumer binds it or ever will.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.signed",
    moduleOwner: "m8",
    description:
      "Sign succeeded — the LOCKED clinical-record trigger half the clinical phase keys off.",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      visitId: Type.Optional(Type.String({ minLength: 1 })),
      encounterType,
      discipline,
      signedByMembershipId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
      lateEntryTier,
      layer2Involved: Type.Boolean(),
      evvBracketState,
      requiresCosign: Type.Boolean(),
      hopeRelevant: Type.Optional(
        Type.Object({
          timepoint: Type.String({ minLength: 1 }),
          suspectedJ2051Severity: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      careplanLinks: Type.Array(
        Type.Object({
          problemId: Type.Optional(Type.String({ minLength: 1 })),
          goalId: Type.Optional(Type.String({ minLength: 1 })),
          interventionId: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      documentRenderPayload: Type.Object({
        final: Type.String(),
        addenda: Type.Array(
          Type.Object({
            addendumId: Type.String({ minLength: 1 }),
            reason: Type.String(),
            text: Type.String(),
          }),
        ),
      }),
    }),
    // F-115 (#248) — m28/m30 removed: m28 never subscribes to anything (F-035, request-time-only reads);
    // m30 reads signed-encounter data via `SignedEncountersReader` (HVLDL / HCI-10 / the late-entry
    // tally) on its nightly cadence, not by reacting to this event.
    declaredConsumers: ["m9", "m10", "m14", "m17", "m22", "m31", "m36"],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.cosigned",
    moduleOwner: "m8",
    description:
      "Cosign succeeded — `BillableEncounterReader` flips to billable for the held visit (§7.2).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      cosignedByMembershipId: Type.String({ minLength: 1 }),
      cosignedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m23", "m24"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.addendum_signed",
    moduleOwner: "m8",
    description:
      "An addendum on a signed encounter was signed (D2); M22 re-renders the PDF appended.",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      addendumId: Type.String({ minLength: 1 }),
      signedByMembershipId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: ["m22"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── cosignature SLA chain (§2.4 D3) ───────────────────────────────────────────────────────────────
  {
    eventName: "m8.encounter.cosignature_routed",
    moduleOwner: "m8",
    description: "A cosignature request was created and routed to the assigned cosigner (§7.2).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      routedToMembershipId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.cosignature_overdue",
    moduleOwner: "m8",
    description: "The 12h cosignature SLA tick fired with no cosignature (warn).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      routedToMembershipId: Type.String({ minLength: 1 }),
      hoursOverdue: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.cosignature_escalated",
    moduleOwner: "m8",
    description: "The 24h cosignature SLA tick escalated the request to the supervisor (warn).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      routedToMembershipId: Type.String({ minLength: 1 }),
      supervisorMembershipId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.cosignature_hard_cap_reached",
    moduleOwner: "m8",
    description:
      "The 48h cosignature hard cap was reached; the supervisor must release/sign (critical).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      routedToMembershipId: Type.String({ minLength: 1 }),
      supervisorMembershipId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── late-entry overrides (§2.5 D4) ────────────────────────────────────────────────────────────────
  {
    eventName: "m8.encounter.late_entry_override",
    moduleOwner: "m8",
    description: "A significant-late (72h–14d) tier engaged with a supervisor override (warn).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      overrideBy: Type.String({ minLength: 1 }),
      overrideReason: Type.String({ minLength: 1 }),
      daysLate: Type.Integer({ minimum: 0 }),
    }),
    // F-115 (#248) — m30 moved to seamConsumers: part of the same late-entry tally as
    // `m8.encounter.finalized` above, read on M30's nightly cadence.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.administrative_override",
    moduleOwner: "m8",
    description:
      "An administrative (>14d) override was applied — director permission + step-up (critical).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      overrideBy: Type.String({ minLength: 1 }),
      overrideReason: Type.String({ minLength: 1 }),
      daysLate: Type.Integer({ minimum: 0 }),
    }),
    // F-115 (#248) — same as `late_entry_override` just above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.voided",
    moduleOwner: "m8",
    description:
      "A draft encounter was voided (admin-only terminal state; never flows to `signed`).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      voidedBy: Type.String({ minLength: 1 }),
      voidedReason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.encounter.orphan_recorded",
    moduleOwner: "m8",
    description:
      "A signed encounter with NULL `visit_id` (ad-hoc/retroactive) — M17 reconciliation (D2).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      recordedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
  // ── HearthNote Layer 2 (§2.6 D5) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m8.hearthnote.layer2_enhanced",
    moduleOwner: "m8",
    description:
      "A Layer-2 LLM enhancement call completed; carries token + hard-block/soft-warn counts.",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      modificationId: Type.String({ minLength: 1 }),
      modelId: Type.String({ minLength: 1 }),
      promptTemplateVersion: Type.String({ minLength: 1 }),
      tokensInput: Type.Integer({ minimum: 0 }),
      tokensOutput: Type.Integer({ minimum: 0 }),
      hardBlockedCount: Type.Integer({ minimum: 0 }),
      softWarnCount: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: ["m30", "m32"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── vitals / mileage capture (§2.2 D10) ───────────────────────────────────────────────────────────
  {
    eventName: "m8.vitals.captured",
    moduleOwner: "m8",
    description: "Vitals were committed for an encounter; abnormal flags drive M36 tenant alerts.",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      vitalsId: Type.String({ minLength: 1 }),
      fieldsCaptured: Type.Array(Type.String({ minLength: 1 })),
      abnormalFlags: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    declaredConsumers: ["m9"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m8.mileage.captured",
    moduleOwner: "m8",
    description:
      "Mileage was committed for an encounter; payroll/AP reads the authoritative miles (D10).",
    payloadSchema: Type.Object({
      encounterId: Type.String({ minLength: 1 }),
      milesDriven: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
    }),
    // F-130 (#248) — m27 REMOVED: M27's own §1.1 relationship inventory + manifest-patch dependsOn list
    // never names M8 mileage anywhere (only `EncounterStatisticsProvider`'s visit-count-by-discipline/FTE
    // for Worksheet S-3 Part III), and no worksheet or allocation basis in `packages/cost-report` reads
    // mileage — "payroll/AP" in the description above is Gusto-side, which M27 pulls via a separate
    // `wage-data-pull` job, not this event.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
];
