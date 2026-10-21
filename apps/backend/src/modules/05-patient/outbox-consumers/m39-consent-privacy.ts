// apps/backend/src/modules/05-patient/outbox-consumers/m39-consent-privacy.ts — the §7.6/D10
// `patient_privacy_flag_snapshot` recompute this module's own `privacy/index.ts` has always been
// PURE for, with no live caller (F-167, #248, closing 4 of the m5 `handlers-unbound` group's six
// `m39.consent.*` events).
//
// F-138's original finding on this group said the six events "need both a real M39
// consent-type→PrivacyFlag mapping that exists nowhere in the codebase and a full per-delivery
// re-read of all the patient's current consents" — re-checked against current code and found HALF
// wrong: the mapping DOES exist (`apps/backend/src/modules/39-consent/consumers.ts`'s
// `TYPE_TO_PRIVACY_FLAG`, built at M39-T08/T09 and never called by anything), and only "42_cfr_part_2
// _release" → "sud" is real — M39's own spec §4.3.1 (CHARTWARDEN_MODULE_39_CONSENT_SPEC_v0_3.md:1433-1452)
// is explicit that HIV/mental_health/genetic are "M5-delegated": computed from `hipaa_release`
// consent-recipient SCOPE by a wholly different, unbuilt mechanism, never pushed by an M39 event. This
// consumer implements exactly the ONE real relationship — SUD/Part-2 — and nothing else.
//
// M5's manifest `dependsOn` is `[1, 2, 3, 4, 36, 38, 40]` — no edge to 39 — so
// `apps/backend/src/modules/39-consent/consumers.ts`'s `TYPE_TO_PRIVACY_FLAG` cannot be imported
// directly (`arch:boundaries`). The one-entry mapping is re-expressed here as a bare string-literal
// comparison against the untyped payload's `typeKey` field — DATA, not a cross-module code import,
// the `m6-admission-activated.ts` precedent one file over.
//
// FIVE of the six catalogued events are bound:
//   - `m39.consent.signed`     → the consent is newly active (§4.3.1's decisive trigger, verbatim).
//   - `m39.consent.revoked`    → the consent is no longer active (§4.3.1's decisive trigger, verbatim).
//   - `m39.consent.supersedes` → treated identically to `signed`: `consent-store-db.ts`'s `supersede`
//     route (~line 969) writes the NEW record `status: "active"` in the SAME transaction that emits
//     this event, so a superseded `42_cfr_part_2_release` consent is a live renewal of the
//     SUD-lifting grant. The event's own catalog description ("Re-render + snapshot + cache rebind")
//     names the snapshot explicitly, and M22's own `render-consumer.ts` already treats
//     signed/supersedes/renewed as the same "new active consent record" fact for its own render
//     trigger — the identical grouping, applied here to M5's recompute instead.
//   - `m39.consent.renewed`    → treated identically to `signed`, for the same reason: the `renew`
//     route (~line 1224) also writes the new record `status: "active"` in the same transaction.
//   - `m39.consent.expired`    → (F-216) the consent is no longer active, exactly like `revoked` — with
//     one renewal-safety exception: `renew` leaves the PRIOR record active until its expires_at passes, so
//     a renewed Part-2 consent ticks to `expired` while its successor is live. M39's expiration cron stamps
//     `remainingActiveConsentRecordId` on the payload when another active consent of the same patient+type
//     exists, and that delivery recomputes as ACTIVE (flag stays lifted) rather than re-restricting SUD.
//     Until F-216 NO PRODUCTION CODE PATH EMITTED this event (`M39_QUEUES`/`shouldExpire` had zero callers
//     under apps/backend), so the pair was deliberately unbound; the hourly `m39.consent_expiration` cron
//     (`39-consent/jobs/`) is now its producer, and without this binding a lapsed Part-2 consent left M5's
//     persisted `sud` flag lifted indefinitely.
//
// ONE event stays deliberately UNBOUND (see `scripts/outbox-deferred-consumers.ts` for the full finding,
// and the catalog correction that dropped `m5` from it):
//   - `m39.consent.recipient_removed` — its own catalog description says the fact is for
//     "disclosure-subsetter caches" (M22/M28's per-signed-URL cache), NOT M5's categorical,
//     patient-level snapshot (`packages/db/src/schema/patient/patient-privacy-flag-snapshots.ts` has
//     no recipient column at all), and its payload doesn't even carry `typeKey`. M22's own
//     `render-consumer.ts` (F-161) independently reached the identical conclusion for this exact event
//     under the identical reasoning (M39's `ConsentEvaluator` is resolved fresh on every signed-URL
//     mint — no persistent state to invalidate). `events-by-m39.ts` is corrected at the source to drop
//     `m5` from this event's `declaredConsumers` rather than leaving a permanent, unactionable
//     deferral — the F-134/F-138 "mechanical carry-over from a sibling event's consumer list" shape.
//
// MERGE, NOT OVERWRITE (see `privacy/index.ts`'s `mergeConsentSignal`): M39 only ever reports the ONE
// category it owns (`sud`). Writing `recomputePrivacyFlags([touchedSignal])` directly would silently
// clear every OTHER flag a future HIV/mental_health/genetic producer sets — this consumer reads the
// CURRENT snapshot first and merges the touched flag into it.
//
// NOT AN ERROR: an unresolvable patient id (cross-tenant/stale payload) or a consent type M5 does not
// track is a silent no-op, matching every other M5 consumer's convention
// (`m6-admission-activated.ts`, `m17-visit-assignment.ts`) — a later, correctly-scoped delivery still
// resolves fine.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { M5OutboxPort } from "../deceased-db";
import {
  type ConsentSignal,
  type PrivacyFlag,
  type PrivacySnapshotPorts,
  applyConsentChanged,
  mergeConsentSignal,
} from "../privacy/index";

const P = schema.patients;
const PFS = schema.patientPrivacyFlagSnapshots;

/** §3.3-style consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID`
 *  convention — M6/M16/M23's outbox consumers all use the identical empty-string sentinel). */
const CONSUMER_USER_ID = "";

/** M39's own §4.3.1-decided type→flag mapping, re-expressed as data (see file header for why this
 *  cannot be a cross-module import). Widen this literal, never re-derive it independently, if M39
 *  ever adds a second privacy-flag-bearing consent type. */
const PRIVACY_FLAG_CONSENT_TYPE = "42_cfr_part_2_release";
const PRIVACY_FLAG_FOR_TYPE: PrivacyFlag = "sud";

export const M5_CONSENT_PRIVACY_CONSUMER = {
  eventNames: [
    "m39.consent.signed",
    "m39.consent.revoked",
    "m39.consent.supersedes",
    "m39.consent.renewed",
    "m39.consent.expired",
  ],
  consumerName: "m5.m39-consent-privacy",
} as const;

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract `{patientId, typeKey, active, sourceConsentVersion}` from one of the four bound event
 *  shapes. `active` is derived from the EVENT NAME, not a payload field — none of the four payloads
 *  carry an explicit boolean, and the event name IS the fact (see file header). */
function factsOf(
  eventType: string,
  payload: unknown,
): { patientId: string; typeKey: string; active: boolean; sourceConsentVersion: string } | null {
  const patientId = stringField(payload, "patientId");
  const typeKey = stringField(payload, "typeKey");
  if (patientId === null || typeKey === null) return null;
  switch (eventType) {
    case "m39.consent.signed": {
      const id = stringField(payload, "consentRecordId");
      return id === null ? null : { patientId, typeKey, active: true, sourceConsentVersion: id };
    }
    case "m39.consent.revoked": {
      const id = stringField(payload, "consentRecordId");
      return id === null ? null : { patientId, typeKey, active: false, sourceConsentVersion: id };
    }
    case "m39.consent.supersedes": {
      const id = stringField(payload, "newConsentRecordId");
      return id === null ? null : { patientId, typeKey, active: true, sourceConsentVersion: id };
    }
    case "m39.consent.renewed": {
      const id = stringField(payload, "newConsentRecordId");
      return id === null ? null : { patientId, typeKey, active: true, sourceConsentVersion: id };
    }
    case "m39.consent.expired": {
      const id = stringField(payload, "consentRecordId");
      if (id === null) return null;
      // A consent that merely lapsed while ANOTHER active consent of the same patient+type outlives it
      // (the normal renewal flow — `renew` leaves the prior record active until expires_at passes) does
      // not re-restrict SUD: the lifted state is still true, so recompute as active against that record.
      const remaining = stringField(payload, "remainingActiveConsentRecordId");
      return remaining === null
        ? { patientId, typeKey, active: false, sourceConsentVersion: id }
        : { patientId, typeKey, active: true, sourceConsentVersion: remaining };
    }
    default:
      return null;
  }
}

/**
 * M5's LIVE `m39.consent.{signed,revoked,supersedes,renewed}` binding — recomputes
 * `patient_privacy_flag_snapshot` (§7.6/D10) for the ONE consent type (`42_cfr_part_2_release`) M39
 * authoritatively drives, merging into whatever the snapshot's OTHER flags currently hold. One
 * `withOrgContext` transaction per delivery: the read, the merge, the UPSERT and the
 * `m5.patient.privacy_flag_changed` emit all commit or roll back together.
 */
export function buildM5ConsentPrivacyConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
}): OutboxConsumerBinding {
  return {
    consumerName: M5_CONSENT_PRIVACY_CONSUMER.consumerName,
    consumerModule: "m5",
    eventTypes: M5_CONSENT_PRIVACY_CONSUMER.eventNames,
    async handle(event): Promise<void> {
      const facts = factsOf(event.eventType, event.payload);
      // A malformed/unexpected payload shape is a genuine defect — dead-letter for a human rather
      // than silently dropping a consent-privacy fact.
      if (facts === null) {
        throw new Error(
          `${M5_CONSENT_PRIVACY_CONSUMER.consumerName}: '${event.eventType}' payload missing a required field`,
        );
      }
      // A consent type M39 does not authoritatively map to a privacy flag (e.g. `portal_access`,
      // `dpoa_healthcare`) drives no M5 recompute — not an error, the common case for these events.
      if (facts.typeKey !== PRIVACY_FLAG_CONSENT_TYPE) return;

      const organizationId = event.organizationId;
      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          // No-leak: a cross-tenant/stale patientId resolves nothing under RLS and this is a silent
          // no-op, matching `m6-admission-activated.ts`'s convention.
          const patientRow = await tx
            .select({ id: P.id })
            .from(P)
            .where(eq(P.id, facts.patientId))
            .limit(1);
          if (!patientRow[0]) return;

          const existing = await tx
            .select({ flags: PFS.flags, invalidatedAt: PFS.invalidatedAt })
            .from(PFS)
            .where(eq(PFS.patientId, facts.patientId))
            .limit(1);
          const currentFlags: readonly PrivacyFlag[] =
            existing[0] && existing[0].invalidatedAt === null
              ? (existing[0].flags as PrivacyFlag[])
              : [];
          const touched: ConsentSignal = { flag: PRIVACY_FLAG_FOR_TYPE, active: facts.active };
          const signals = mergeConsentSignal(currentFlags, touched);

          const ports: PrivacySnapshotPorts = {
            async writeSnapshot(orgId, patientId, flags) {
              await tx
                .insert(PFS)
                .values({
                  patientId,
                  organizationId: orgId,
                  flags: [...flags],
                  capturedAt: new Date(),
                  sourceConsentVersion: facts.sourceConsentVersion,
                  // F-237 — M39's consent state now governs `sud`; a DocLens interim origin no longer applies.
                  sudFlagOrigin: null,
                  invalidatedAt: null,
                })
                .onConflictDoUpdate({
                  target: PFS.patientId,
                  set: {
                    organizationId: orgId,
                    flags: [...flags],
                    capturedAt: new Date(),
                    sourceConsentVersion: facts.sourceConsentVersion,
                    sudFlagOrigin: null,
                    invalidatedAt: null,
                  },
                });
            },
            async emitPrivacyFlagChanged(orgId, patientId, flags) {
              await deps.outbox.publish(tx, {
                eventName: "m5.patient.privacy_flag_changed",
                payload: { patientId, organizationId: orgId, flags: [...flags] },
                organizationId: orgId,
                aggregateKind: "patient",
                aggregateId: patientId,
              });
            },
          };

          await applyConsentChanged({ organizationId, patientId: facts.patientId, signals }, ports);
        },
      );
    },
  };
}
