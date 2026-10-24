// apps/backend/src/modules/08-encounters/events-by-m8.ts — Module 8's outbox-event contributions
// (M8-T11, spec §4.4). The full `m8.*` taxonomy keyed on M8's own tables, under the `m8.` namespace
// (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m8'), and valid declared consumers (real module ids). The named cross-module
// consumers (M9/M10/M14/M17/M22/M23/M24/M27/M28/M30/M31/M32/M33/M36) subscribe when they land; M8
// publishes the events now. Per §4.7 ("outbox publication is the only cross-module communication M8
// performs at the boundary") every M8 event is outbox-only — M8 is not a Socket.IO producer (§4.3:
// M36 fans out to channels off these events).
//
// The event NAMES mirror `M8_EVENT_NAMES` in @chartwarden/types (the lifecycle/cosignature/late-entry side-
// effect machines restrict their `outbox` effects to that closed set); this file adds the TypeBox
// `payloadSchema` + declared consumers the dispatcher validates each publish against (§4.4 catalog).
// `m8.encounter.signed` is the system's clinical-record nervous-system trigger — its payload is LOCKED.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@chartwarden/types";

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
      /** F-146 (#248) — the fact M18's real `closed_documented_at_encounter` resolution decider
       *  (`transitionMissingResolution`, `domain/missing-resolution.ts`) reads as
       *  `event.encounterEvvMissingReason`; present only when `evvBracketState ===
       *  'evv_missing_documented'` (`encounter_evv_missing_reason_len`, the same ≥20-char CHECK this
       *  field mirrors). Was missing from this LOCKED payload since the event existed — M18's consumer
       *  could not have closed a documented-missing resolution off this event without it. */
      evvMissingReason: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
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
    // F-140 (#248) — m24 ADDED: M24's own authoritative `M24_SUBSCRIPTION_MAP` names this event with a
    // real handler (`trigger-revalidate` → `handleUpstreamChange`); its `.cosigned` sibling below is NOT
    // in that map (M24 revalidates on sign, not on the separate cosign event).
    // F-141 (#248) — m18 ADDED: M18's own D6 (locked), job catalog (`m18.encounter-signed.consumer`, "on
    // m8.encounter.signed outbox"), and its §10 task-26 checklist all name a real, decisive consumer that
    // closes an open `evv_missing_resolution` row (`closed_documented_at_encounter`) when the encounter
    // signs with `evv_missing_reason` populated — genuinely undeclared until now.
    // F-146 (#248) — the payload gap F-141 flagged for a future pass is now fixed: `evvMissingReason` is
    // on the wire (both `sign()` emit sites). M18's own consumer binding stays unbuilt regardless — this
    // group is `handlers-unbound` for a reason, and wiring the live binding is composition-root work
    // outside this catalog/payload triage's scope — but a binding built against this payload can now
    // actually resolve the fact it needs, rather than being wired against a field that doesn't exist.
    // F-143 (#248) — m9 REMOVED: M9's own spec (line 61) states the relationship runs the OPPOSITE
    // direction — "M8 calls M9's `recordAssessment` API with `source_encounter_id`" and "encounter-sign
    // workflow consults M9's 'required scale' rules" — M8 calling INTO M9 synchronously, never M9
    // subscribing to this outbox event. m10 REMOVED: M10's own spec (line 9, and its own re-lock note
    // explicitly correcting the dep direction) is equally decisive the relationship is M8 → M10 (M8
    // calls M10's `recordHopeTimepoint` API), never a push M10 would consume.
    // GAP-058 — m19 ADDED: M19's own D8 / §2.2.1 name this event as THE trigger that advances a triage call
    // `documented_pending_encounter → documented`; the consumer is `19-oncall/consumers/
    // m8-encounter-signed.ts` (a decider since M19-T05, bound by GAP-058).
    // GAP-130 — m16 ADDED on the commit that binds it: M16 §4.5 / D15 / §7.5 name this event (filtered to
    // `encounterType='bereavement_contact'`) as what completes an in-person bereavement outreach; the
    // consumer is `16-bereavement/outbox-consumers/m8-encounter-signed.ts`.
    declaredConsumers: ["m14", "m16", "m17", "m18", "m19", "m22", "m24", "m31", "m36"],
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
    // F-140 (#248) — m24 removed: `M24_SUBSCRIPTION_MAP`'s exhaustive trigger-revalidate list names only
    // `m8.encounter.signed`, not `.cosigned` — M23 KEPT the same event (a different module with a
    // different subscription-map entry; not a transferable precedent).
    declaredConsumers: ["m23"],
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
      // F-168 (#248) — was missing from this LOCKED payload since the event existed, the same reason
      // `.signed`'s `documentRenderPayload` field exists: M22's render-consumer needed CONTENT to append
      // a new `document_version` with, and had nothing (the idempotency-granularity gate this bind
      // needed fixing first meant it was never reachable regardless). `final` stays the SAME PHI-safe
      // empty-string stand-in `.signed` already sends (the pinned narrative is DEK-sealed and never
      // copied into the outbox in the clear) — this is not a new gap, just the existing one repeated on
      // the append path rather than left unaddressed.
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
    // F-144 (#248) — m22 REMOVED: `ENCOUNTER_GRAPH` legalizes `void` only from `draft` — a voided
    // encounter can never have had a PDF rendered (M22 renders only off `.signed`), so there is nothing
    // to suppress. Not in M22's own §4.11 table either.
    declaredConsumers: [],
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
    // GAP-177 — emitted at sign time (beside `.signed`) when `visit_id` is NULL; record/seam-only.
    // F-164 (#248) — m17 REMOVED: this event had NO production emitter in `08-encounters/` when F-164
    // grep-confirmed it (against all 13 real `emit(...)` call sites), so binding an M17 consumer to it
    // would wire a line to a house never built. Independently redundant even if it were built: the
    // identical fact — a just-signed encounter with no `visit_id` — is already delivered to M17 TODAY
    // via the live `m17.m8-encounter-signed` consumer (`17-scheduling/consumers/index.ts`), whose own
    // `EncounterSignedConsumed` doc comment names this exact branch "M17 reconciliation, M8 D2" and
    // whose `planVisitCompletionFromEncounter` already returns `{kind:"skip", reason:"no_visit_link"}`
    // for it. M17's own later spec text additionally names the real reconciliation mechanism as a SEAM
    // PULL (`BillableEncounterReader`, "for retroactive reconciliation only") rather than this push —
    // registered at the M17 composition root but not yet called from any route, a separate, unrelated
    // gap. No `seamConsumers` replacement: the relationship this event's name gestures at is already
    // covered by `.signed`, not by the pulled seam.
    declaredConsumers: [],
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
    // F-142 (#248) — m32 dropped: M32's own spec is decisive the relationship runs the OPPOSITE
    // direction — M8 calls `NarrativeEnhancementProvider.enhance(...)` synchronously ("this is the v1
    // reason M32 exists") and M32 already returns the diff/token-count/model-id/template-version
    // directly to M8 in that call; this event's payload is exactly what M32 already produced.
    // F-149 (#248) — m30 dropped: unsupported. M30's own §1.1 entry for Module 8 names only
    // `EncounterStatisticsProvider`/`SignedEncountersReader` for the HCI visits-near-death/HVLDL/
    // late-entry-rate measures — no "AI involvement" tracking anywhere in M30's own text despite its
    // 19 lettered decisions covering every compliance surface it owns, and this event is NOT among the
    // D16 recompute-trigger list's ten named events (only the different, already-declared
    // `m8.encounter.signed` is). The event's own single terse table-cell citation ("M30 AI involvement
    // compliance register") is contradicted by M30's own more authoritative, structured D16 list.
    declaredConsumers: [],
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
    // F-143 (#248) — m9 moved to seamConsumers: M9's own spec (line 75) states M9 trending "may read
    // the encounter vital series via M8's seam ... but M9 does not own vital signs" — a documented
    // seam PULL M9 would perform, never an outbox push (confirmed unbuilt on both sides).
    declaredConsumers: [],
    seamConsumers: ["m9", "m36"],
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
  {
    eventName: "m8.chart_promotion.decided",
    moduleOwner: "m8",
    description:
      "A reviewer decided a secure-message proposal for the chart: the addendum they authored from it was signed (accepted, resultRef = the addendum id), or they declined it (rejected). PHI-free: ids, an outcome enum, a reason code and an instant; no patient id, no message text, no hash. Published in the same transaction as the record (WP 3.7, ADR-0063); M36 records the outcome on the proposal.",
    payloadSchema: Type.Object({
      organizationId: Type.String({ minLength: 1 }),
      promotionRequestId: Type.String({ minLength: 1 }),
      outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
      resultRef: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      decidedByUserId: Type.String({ minLength: 1 }),
      reasonCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      at: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
];
