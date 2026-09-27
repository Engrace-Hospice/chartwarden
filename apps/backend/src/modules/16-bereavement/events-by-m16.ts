// apps/backend/src/modules/16-bereavement/events-by-m16.ts — Module 16's outbox-event contributions
// (spec §4.4). The `m16.*` taxonomy under the `m16.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m16')
// and valid declared consumers; the composition root merges it into the platform catalog at boot (the
// M15/M23/M24/M25/M26/M27 events-by-mN precedent), and the dispatcher validates each `m16.*` publish
// against the TypeBox payloadSchema inside the SAME transaction as the mutation (transactional outbox).
//
// The shapes MIRROR the §4.4 payload interfaces frozen in `@wardenx/types`
// (packages/types/src/bereavement.ts, M16-T01) — those are the contract M22/M28/M30/M31/M32/M33/M36
// type-check against; this file is their runtime validator. The envelope carries `organizationId`, so no
// payload repeats it — with ONE deliberate exception, `external_source_cosign_received`, whose §4.4 row
// lists `organizationId` explicitly because the D18 coordinator UI refreshes over the M1 realtime bridge
// (a Socket.IO room key, not an outbox subscriber, so it does not see the envelope).
//
// NO PHI in any payload: ids, enum tokens, counts and instants only. The two structurally-open fields are
// `outreach_artifact_requested.payloadJsonb` — the §7.6 letter/card body context M22 renders from, whose
// per-template shape M22 owns (D14) — and nothing else. Notably `plan_opened` carries `deathDate`: a date
// of death IS identifying, which is why the event's `declaredConsumers` is a closed list and the payload
// carries no name, address or contact channel.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const Id = Type.String({ minLength: 1 });
const IdN = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });
const Str = Type.String();
const Count = Type.Integer({ minimum: 0 });

/** The §7.11 closeout counts frozen onto the closure row (`M16OutreachStats`). */
const OutreachStats = Type.Object({
  completedCount: Count,
  missedCount: Count,
  contactsActiveCount: Count,
  contactsOptedOutCount: Count,
});

export const M16_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m16.bereavement.plan_opened",
    moduleOwner: "m16",
    description:
      "The roster + 13-month D4 schedule seeded and the bereavement plan reached `active`. M36 opens the `bereavement` channel with the pre-computed `archivesAt`; M22 renders the welcome packet (§2.2).",
    payloadSchema: Type.Object({
      planId: Id,
      patientId: Id,
      admissionId: Id,
      deathDate: Str,
      assignedCounselorUserId: Id,
      archivesAt: Iso,
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: ["m22"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_paused",
    moduleOwner: "m16",
    description:
      "The plan moved to `paused`; future-dated outreach was cancelled and M36 write-disables the channel (§2.2).",
    payloadSchema: Type.Object({ planId: Id, pauseKind: Str, pausedAt: Iso }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_resumed",
    moduleOwner: "m16",
    description:
      "The plan returned to `active`; the forward schedule was regenerated FROM NOW, never replayed from the death date (§2.2).",
    payloadSchema: Type.Object({ planId: Id, resumedAt: Iso }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_closed_completed",
    moduleOwner: "m16",
    description:
      "The 13-month CoP 418.64(d) clock ran out (or a pre-death patient opt-out closed the program as completed). M22 renders the closeout summary; M36's channel auto-archives (§7.11).",
    payloadSchema: Type.Object({ planId: Id, closedAt: Iso, outreachStats: OutreachStats }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035). m30 stays declared: the seam's
    // `BereavementComplianceProvider.planClosureCounts` method exists for this domain but no currently-
    // registered M30 measure calls it (only `copOutreachCounts`, for `bereavement_coverage_rate`, is
    // wired) — a dormant capability is not a seam relationship yet ("bound is not computing", F-042).
    declaredConsumers: ["m22", "m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_closed_declined",
    moduleOwner: "m16",
    description:
      "EVERY enrollee opted out (D6) — distinct from `closed_completed` because the survey record must show the family refused, not that the program ran its course.",
    payloadSchema: Type.Object({ planId: Id, closedAt: Iso }),
    // F-115 (#248) — same as `plan_closed_completed` above: `planClosureCounts` exists, unused.
    declaredConsumers: ["m22", "m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_closed_early",
    moduleOwner: "m16",
    description:
      "A D7 early close. `cosignedByUserId` is null ONLY on the D9 patient-opt-out-post-creation cascade, which §2.6 makes cosign-exempt.",
    payloadSchema: Type.Object({
      planId: Id,
      reason: Str,
      closedAt: Iso,
      cosignedByUserId: IdN,
    }),
    // F-115 (#248) — same as `plan_closed_completed` above: `planClosureCounts` exists, unused.
    declaredConsumers: ["m22", "m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.plan_skipped_per_patient_opt_out",
    moduleOwner: "m16",
    description:
      "M6 declared the admission bereavement-eligible but the M5 patient-level directive said no (D9). Carries NO planId: nothing opened, and no M36 channel was created.",
    payloadSchema: Type.Object({ patientId: Id, admissionId: Id, deathDate: Str }),
    // F-115 (#248) — m30 stays declared: whether an opt-out-skipped case belongs in
    // `copOutreachCounts`'s denominator is a real product question (F-099 shape), not a settled seam
    // relationship — left as a genuine gap rather than guessed.
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.external_source_cosign_received",
    moduleOwner: "m16",
    description:
      "D18 — an `m6.discharge.cosigned` released the external-source first-contact gate. The plan's STATE does not move; only `external_source_metadata.cosignStatus` does.",
    payloadSchema: Type.Object({
      planId: Id,
      organizationId: Id,
      cosignedAt: Iso,
      medicalDirectorMembershipId: Id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.counselor_assigned",
    moduleOwner: "m16",
    description:
      "A counselor whose discipline may provide bereavement took the plan (§7.2). M36 adds them to the channel and M3's `bereavement_window` predicate cache invalidates (§7.12).",
    payloadSchema: Type.Object({ planId: Id, counselorUserId: Id, assignedAt: Iso }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.volunteer_assigned",
    moduleOwner: "m16",
    description:
      "A bereavement volunteer whose 418.78 gates are satisfied joined the plan with the D10 reduced-PHI scope.",
    payloadSchema: Type.Object({ planId: Id, volunteerUserId: Id, assignedAt: Iso }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_active",
    moduleOwner: "m16",
    description:
      "A bereaved person confirmed with a verified M39 bereavement-outreach consent (D6). M36 adds their portal account to the channel; M28 projects the FHIR `RelatedPerson` (F-115/#248: at request time, not via this event).",
    payloadSchema: Type.Object({ planId: Id, contactId: Id, portalAccountId: IdN }),
    declaredConsumers: ["m31"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_opted_out",
    moduleOwner: "m16",
    description:
      "D9 — a survivor left the program. `source` distinguishes the portal-self path from the M39 revocation cascade, which is what keeps the §8.1 audit story truthful about whose decision it was.",
    payloadSchema: Type.Object({ planId: Id, contactId: Id, optOutKind: Str, source: Str }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_opt_out_rescinded",
    moduleOwner: "m16",
    description:
      "An opt-out was undone inside the D9 90-day self-service window (or by a counselor with a documented reason); the forward schedule regenerated.",
    payloadSchema: Type.Object({ planId: Id, contactId: Id }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_deceased",
    moduleOwner: "m16",
    description:
      "The bereaved contact themselves died (verified date + source). The only terminal §2.3 state — there is no way back.",
    payloadSchema: Type.Object({ planId: Id, contactId: Id }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_unreachable",
    moduleOwner: "m16",
    description:
      "The 3-strikes no-response detector's proposal was accepted by a counselor (§2.3); M36 raises the counselor alert.",
    payloadSchema: Type.Object({ planId: Id, contactId: Id, missedTouchpointCount: Count }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.contact_referred_external",
    moduleOwner: "m16",
    description:
      "§7.7 — complicated grief / suicidal ideation routed to an M40 external mental-health resource. M36 raises the `clinical_urgent` alert; M30 treats it as incident-potential.",
    payloadSchema: Type.Object({ planId: Id, contactId: Id, externalResourceId: Id }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.outreach_scheduled",
    moduleOwner: "m16",
    description:
      "One D4 schedule-generator row landed, so M33 can chart the forward book without reading M16's tables (§2.4).",
    payloadSchema: Type.Object({
      planId: Id,
      contactId: Id,
      outreachId: Id,
      kind: Str,
      dueAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.outreach_completed",
    moduleOwner: "m16",
    description:
      "A touchpoint reached a terminal outcome — the CoP 418.64(d) numerator. `sourceEncounterId` is present for exactly `in_person_visit` (D15).",
    payloadSchema: Type.Object({
      planId: Id,
      contactId: Id,
      outreachId: Id,
      outcome: Str,
      sourceEncounterId: Type.Optional(Id),
    }),
    // F-115 (#248) — m30 moved to seamConsumers: this outcome is literally the numerator/denominator
    // `copOutreachCounts` sums (bereavement_coverage_rate), read on M30's nightly cadence — same for
    // `outreach_missed` just below.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.outreach_missed",
    moduleOwner: "m16",
    description:
      "The hourly worker's verdict once `late_grace_until` passed with no state change — the M30 rate denominator and the M36 counselor alert (§2.4).",
    payloadSchema: Type.Object({ planId: Id, contactId: Id, outreachId: Id, dueAt: Iso }),
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.outreach_artifact_requested",
    moduleOwner: "m16",
    description:
      "D14 — the outbox-only handoff to M22 for a sympathy card / letter / anniversary letter. M16 never renders a PDF and imports no M22 schema; M22 answers with `m22.document.rendered`. `outreachId` is nullable: the plan-opened transition that fires the welcome-packet request happens BEFORE `seedRosterAndSchedule`'s per-contact loop materializes any `bereavement_outreach` rows (`write-service-drizzle.ts`), so no single outreach row exists yet to name — the write path previously passed a literal `''`, which this schema's own `minLength:1` (via `Id`) rejected on every single call, rolling back the whole roster-seed transaction. Confirmed live.",
    payloadSchema: Type.Object({
      planId: Id,
      /** The DECEDENT — the chart M22 files the rendered artifact against (F-099). Distinct from
       *  `contactId`, which is the bereaved recipient the letter is addressed to. */
      patientId: Id,
      contactId: Id,
      outreachId: Type.Union([Id, Type.Null()]),
      templateKey: Str,
      payloadJsonb: Type.Unknown(),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.risk_score_computed",
    moduleOwner: "m16",
    description:
      "An immutable D3/D8 `bereavement_risk_score` row was appended. M30's screening measure filters `dataCompleteness === 'minimal'` out of its DENOMINATOR (D17), which is why both bands ride the payload.",
    payloadSchema: Type.Object({
      planId: Id,
      contactId: Type.Optional(Id),
      scoreKind: Str,
      tier: Str,
      scoreId: Id,
      dataCompleteness: Str,
      confidenceBand: Str,
    }),
    // F-115 (#248) — m30 stays declared, not moved to seamConsumers: `BereavementComplianceProvider.
    // riskScreeningCompletenessCounts` exists for exactly this D17 filter, but no measure code in
    // `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts`'s registered set calls it yet — a screening-
    // completeness measure is not among the eleven currently bound. The description's "M30's screening
    // measure" describes a capability that exists on the seam, not one wired to a running recompute.
    declaredConsumers: ["m30", "m32"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m16.bereavement.anniversary_due_in_14_days",
    moduleOwner: "m16",
    description:
      "The daily §4.9 lookahead cron found an unfired `bereavement_anniversary_reminder` landing inside 14 days; M36 nudges the plan's counselor.",
    payloadSchema: Type.Object({
      planId: Id,
      mark: Str,
      targetDate: Str,
      anniversaryReminderId: Id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
];
