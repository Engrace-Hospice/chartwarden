// apps/backend/src/modules/39-consent/events-by-m39.ts — Module 39's outbox-event contributions
// (M39-T08, spec §4.5). The fourteen `m39.consent.*` events keyed on M39's own tables, under the
// `m39.` namespace (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming
// (`mN.<resource>.<verb>`), ownership (moduleOwner='m39'), and valid declared consumers (real module
// ids). M39-F08: these are emitted from the SERVICE layer via the M1 outbox helper in the same
// transaction as the write — NEVER from a DB trigger. The named cross-module consumers subscribe when
// they land; the events are published now. `m39.consent.signed`/`revoked` drive M5's
// privacy_flag_snapshot recompute (M5 D10); `expiring_soon` drives the M36 reminder alert (§4.10).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** Shared minimal payload core — every consent event carries the patient + org id. */
const core = {
  patientId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
};
const typeKey = Type.String({ minLength: 1 });

export const M39_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m39.consent.created",
    moduleOwner: "m39",
    description:
      "A consent draft was created (route 6). Internal — drafts carry no regulatory force.",
    payloadSchema: Type.Object({ ...core, consentRecordId: Type.String(), typeKey }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.signed",
    moduleOwner: "m39",
    description:
      "A consent was signed (route 8). Drives the M22 PDF render (D15), M5 privacy_flag_snapshot recompute when SUD (D10), and the M16 post-mortem grant when bereavement.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      typeKey,
      signedAt: Type.String(),
      signedBy: Type.String(),
      captureMethod: Type.String(),
      expiresAt: Type.Optional(Type.String()),
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers: M30's own spec (docs/modules/
    // WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md's §8.1 Part-2-redisclosure text) and its own blanket
    // §1.1 principle ("Outbox publication is the only cross-module communication M30 performs at the
    // boundary") both frame the real relationship as `ConsentEvaluator.evaluate`/`.evaluateBulk`,
    // consulted fresh per-actor on every access — confirmed ACTIVE, not aspirational:
    // `apps/backend/src/modules/30-quality/abac-predicates.ts:407` calls
    // `getSeam("ConsentEvaluator")` for the `part2Redisclosure` predicate. A live per-request seam pull
    // has nothing to invalidate from a "consent was signed" push.
    declaredConsumers: ["m22", "m5", "m16"],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.supersedes",
    moduleOwner: "m39",
    description:
      "A new consent superseded a prior one (route 9). Re-render + snapshot + cache rebind.",
    payloadSchema: Type.Object({
      ...core,
      newConsentRecordId: Type.String(),
      supersededConsentRecordId: Type.String(),
      typeKey,
      supersededAt: Type.String(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035; M28's D3 egress consent gate
    // reads M39 live at request time via `ConsentEvaluator`, not via subscription).
    // F-143 (#248) — m3 REMOVED: M3's own spec (line 74) states it CONSUMES a consent attribute only
    // via the boot-registered `ConsentEvaluator` seam PULL, consulted fresh per ABAC evaluation — never
    // an outbox subscription; M3 has no `consumers/` directory and no consent-keyed cache to rebind
    // (its one cache, the effective-permission cache, invalidates only on role/permission changes per
    // §4.5.1/D6). "cache rebind" in this event's own description reads as a carry-over from the
    // sibling `consent.signed` consumer list rather than an independent M3 decision.
    declaredConsumers: ["m22", "m5"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.revoked",
    moduleOwner: "m39",
    description: "A consent was revoked (route 10/27). Fans out the typed §2.4 per-type cascade.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      revocationId: Type.String(),
      typeKey,
      revokedAt: Type.String(),
      revokedByKind: Type.String(),
      cascadeKind: Type.String(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-139 (#248) — m31 ADDED: M31's own §4.10 "M31 consumes" table names this event ("any consent type
    // backing an active grant") with a real consumer file (`m39-consent-revoked.ts`) that cascades
    // grant revocation and closes active sessions — a genuinely broader fact than
    // `m39.consent.delegated_access.revoked` (which covers only the `family_caregiver_access`
    // projection row), so this is not redundant with that kept declaration.
    // GAP-171 — m22 / m28 / m36 RE-ADDED as cascade ACKers. The F-197 / F-115 analyses below stand (their effect is
    // a PULL at mint/read time, not a push), but M39's own revocation-cascade ledger (§2.2.3) needs each of the four
    // spec'd consumers to ACK for a cascade to reach `completed` — without it every cascade burned its retry budget
    // or sat `pending` forever. Each consumer's header states its real effect (M22 additionally restricts
    // disclosure-attached documents on `media_release`; M28 / M36 attest the pull path).
    // F-197 (#248) — m22 REMOVED. The #248 declared-but-unbound registry's prior reason for this pair
    // ("`media_release` unseeded") was stale/unclear; the REAL gap, found and fixed this round, is that
    // M22's §7.16 SUD-consent gate (`consent-gate.ts`'s `resolveSudConsentPresent`) only ever ran ONCE, at
    // document RENDER time — nothing re-checked consent at any LATER signed-URL MINT, so a document
    // rendered while consent was active stayed freely downloadable after a later revocation. That is a
    // PULL at mint time (`signed-url-service.ts`'s `mint()`, and the portal `mintPortalDownloadUrl` path),
    // not a push reaction to `.revoked` — the identical reasoning this event's siblings `.expired`/
    // `.recipient_added`/`.recipient_removed` already used to drop `m22` here in F-176 ("M22 keeps no
    // signed-URL/subsetter state a push could act on; the real control gap is a consent re-check at URL
    // mint, in M22's mint path"). `m5`/`m16`/`m2`/`m31` are unaffected — each has its own real, separately
    // verified reason to stay declared.
    declaredConsumers: ["m5", "m16", "m2", "m31", "m22", "m28", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.expired",
    moduleOwner: "m39",
    description: "A consent passed its expires_at and ticked to expired (consent-expiration cron).",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      typeKey,
      expiredAt: Type.String(),
      // F-216 — set when ANOTHER active consent of the same patient + type outlives this one (the normal
      // renewal flow: `renew` leaves the prior record active until its expires_at passes). M5's privacy
      // snapshot consumer keeps the flag lifted in that case instead of re-restricting SUD.
      remainingActiveConsentRecordId: Type.Optional(Type.String()),
      // GAP-110 — set to `patient_deceased_consent_terminated` when the D13 post-death cascade (the
      // `m5.patient.deceased` consumer) flipped the row, so a reader can tell a death from a lapse.
      expiredReason: Type.Optional(Type.String()),
    }),
    // F-176 (#248) — m22 REMOVED: M22 keeps no signed-URL/subsetter state a push could act on (the real control gap is a
    // consent re-check at URL mint, in M22's mint path).
    declaredConsumers: ["m5"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.expiring_soon",
    moduleOwner: "m39",
    description:
      "A consent entered the 90/30/14/7/1-day reminder window (expiration-reminder cron). Drives the M36 alert.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      typeKey,
      expiresAt: Type.String(),
      reminderKind: Type.String(),
    }),
    // F-215 (#248) — m14 DROPPED: M14's own spec never mentions consent expiry; it reads consent only
    // through `consent.evaluate` at packet-build time (a read-time seam pull, nothing for a push to act on).
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.renewal_cycle_opened",
    moduleOwner: "m39",
    description: "A renewal cycle opened on the first 30-day reminder with no open cycle (D8).",
    payloadSchema: Type.Object({
      ...core,
      cycleId: Type.String(),
      sourceConsentRecordId: Type.String(),
      typeKey,
      nextActionDueAt: Type.Optional(Type.String()),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.renewed",
    moduleOwner: "m39",
    description:
      "A consent was renewed (route 20) — a new record pointing at the expired/revoked prior (D13).",
    payloadSchema: Type.Object({
      ...core,
      newConsentRecordId: Type.String(),
      renewedFromConsentRecordId: Type.String(),
      typeKey,
      signedAt: Type.String(),
    }),
    // F-134 (#248) — `m16` removed: unlike `m39.consent.signed`'s post-death-grant handshake (M16's
    // own §4.5 table, under the name `consent.created`) and `.revoked`'s opt-out cascade (§2.6, a
    // real pure decider in `lifecycle/cascades.ts`), neither M16's spec nor its cascades file
    // mentions a renewal-triggered action anywhere; this looks like a mechanical carry-over from the
    // signed/revoked consumer lists rather than an independent decision.
    declaredConsumers: ["m22", "m5"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.recipient_added",
    moduleOwner: "m39",
    description:
      "A recipient was added to a per-recipient consent (route 12; D6 — no supersession).",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      recipientId: Type.String(),
      recipientKind: Type.String(),
      recipientEntityId: Type.Optional(Type.String()),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-176 (#248) — m22 REMOVED: M22 owns no disclosure-subsetter state to invalidate (`subsetter_dirty_at` is in no schema).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.recipient_removed",
    moduleOwner: "m39",
    description: "A recipient was removed (route 13) — disclosure-subsetter caches go stale.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      recipientId: Type.String(),
      removedAt: Type.String(),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-167 (#248) — m5 removed: the fact is for M22/M28's per-signed-URL disclosure-subsetter cache
    // (this event's own description), not M5's categorical, patient-level `patient_privacy_flag_
    // snapshot` (no recipient dimension exists in that schema at all — `packages/db/src/schema/
    // patient/patient-privacy-flag-snapshots.ts`), and the payload doesn't even carry `typeKey`.
    // M22's own `outbox-consumers/render-consumer.ts` (F-161) independently reached the identical
    // "no persistent state to invalidate" conclusion for this exact event.
    // F-176 (#248) — m22 REMOVED: M22 owns no disclosure-subsetter state to invalidate (`subsetter_dirty_at` is in no schema).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.dpoa.agent_appointed",
    moduleOwner: "m39",
    description:
      "A DPOA agent was appointed (route 15). Banner + signing-authority attribution refresh.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      dpoaAgentId: Type.String(),
      agentKind: Type.String(),
      agentName: Type.String(),
    }),
    // F-129 (#248) — m14 dropped: the packet's `patientCover.activeDpoa` is documented in
    // `packages/idg/src/packet/builder.ts`'s `PacketCoverInput` as read fresh "from M5 `PatientReader` +
    // M6 recert/F2F reader + M7/M39 (raw, pre-redaction)" at build time — a seam pull, not a push cache.
    // F-142 (#248) — m7 dropped: M7's own D7 (locked) is decisive — "single ABAC seam to Module 39...
    // DPOA attribution captured at write time via `acting_consent_id`" — the same seam-pull shape.
    // F-198 (#248) — m11 dropped, the last holdout of this same pattern. Every order in M11's own catalog
    // (`events-by-m11.ts`) carries only `orderingPhysicianMdmId`/`certifyingPhysicianMdmId` — every order
    // is physician-signed, never patient/representative-signed, and an exhaustive grep of `11-orders/` and
    // `packages/orders/` for any consent/authorization/decision-making concept returns nothing. Unlike M7
    // (a real, wired `acting_consent_id` write-time field) and M14 (a real build-time seam pull), M11 has
    // no analogous mechanism to point to, at write time or read time — there is nothing for this fact to
    // attach to in an order-signing flow that never involves patient consent in the first place.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.dpoa.agent_removed",
    moduleOwner: "m39",
    description:
      "A DPOA agent was removed (route 16). Re-routes signing authority to patient/alternate.",
    payloadSchema: Type.Object({
      ...core,
      consentRecordId: Type.String(),
      dpoaAgentId: Type.String(),
      agentKind: Type.String(),
    }),
    // F-129 (#248) — m14 dropped: same reasoning as `dpoa.agent_appointed` above (build-time seam pull).
    // F-142 (#248) — m7 dropped: same D7 seam-pull reasoning as `dpoa.agent_appointed` above.
    // F-198 (#248) — m11 dropped, same reasoning as `dpoa.agent_appointed` above (no consent/DPOA concept
    // anywhere in M11's orders module).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.delegated_access.granted",
    moduleOwner: "m39",
    description:
      "A delegated_access projection row was granted (family_caregiver_access sign/supersede, D10).",
    payloadSchema: Type.Object({
      ...core,
      delegatedAccessId: Type.String(),
      consentRecordId: Type.String(),
      delegateCaregiverId: Type.String(),
      scopeKind: Type.String(),
      effectiveFrom: Type.String(),
      effectiveUntil: Type.Optional(Type.String()),
    }),
    // F-140 (#248) — m19 removed: M19's own spec gates portal-caregiver access via a live
    // `ConsentEvaluator.isActive({consentKind: 'family_caregiver_access'})` SEAM PULL inside the
    // `portal_session_consent_active` ABAC predicate, evaluated per-request — never an outbox push.
    // F-141 (#248) — m18 removed: M18's own D16 manifest-patch text lists M39 among the modules it never
    // dependsOn ("M18 reads from M1/2/3/4/5/17/36/38/40 ... M6/M7/M8/M14/M15/M22/M23/M24/M30/M31/M33 are
    // *not* direct dependsOn"), and M18's exhaustive D14 consumed-events list never names an M39 event.
    // F-158 (#248) — m17 removed: M17's own spec is decisive (twice) that portal-caregiver visit access
    // is a live seam PULL via M31's `ConsentEvaluator`-backed ABAC predicate, never a push to M17; M17's
    // manifest `dependsOn` excludes 39 entirely, and no M17 table stores anything delegated-access-shaped.
    // F-176 (#248) — m31 moved to seamConsumers: M31's §4.10 table names no delegated_access event; the projection is a
    // forward-seam PULL (route 21), and nothing publishes this event.
    declaredConsumers: [],
    seamConsumers: ["m31"],
    isOutboxOnly: true,
  },
  {
    eventName: "m39.consent.delegated_access.revoked",
    moduleOwner: "m39",
    description: "A delegated_access projection row was revoked — portal scope removal cascade.",
    payloadSchema: Type.Object({
      ...core,
      delegatedAccessId: Type.String(),
      consentRecordId: Type.String(),
      delegateCaregiverId: Type.String(),
      revokedAt: Type.String(),
    }),
    // F-140 (#248) — m19 removed: same seam-pull reasoning as `.granted` above.
    // F-141 (#248) — m18 removed: same D14/D16 reasoning as `.granted` above.
    // F-158 (#248) — m17 removed: same seam-pull reasoning as `.granted` above (no M17-side grant state
    // exists to invalidate either — the gate is a live M31 ABAC predicate, not an M17 cache).
    // F-176 (#248) — m31 REMOVED: M31's §4.10 table names no delegated_access event, its bound broad
    // `m39.consent.revoked` consumer already revokes grants by `source_consent_record_id`, and nothing publishes this.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
];
