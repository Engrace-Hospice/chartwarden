// apps/backend/src/modules/16-bereavement/outbox-consumers/m39-consent-signed.ts — the §4.5 "post-death
// grant handler" (the M16 spec's stale name for this event is `consent.created`; the real, catalogued name
// is `m39.consent.signed`) — F-159, #248.
//
// M16's §4.5 outbox-subscriptions table names this relationship: "`m39.consent.created` (filtered to
// `bereavement_outreach_consent` post-death of decedent_patient) | M39 | post-death-grant handler |
// enables previously proposed contacts to confirm." A counselor proposes a bereaved contact
// (`bereaved_contact.status = 'proposed'`) and — per `write-service-drizzle.ts`'s own `consentRecordId`
// write paths — may link the M39 `bereavement_outreach_consent` record that was REQUESTED for them at
// roster-seed or update time (`bereaved_contact.consent_record_id`, a logical uuid, §D6). Once M39 signs
// that exact consent, the contact should auto-confirm onto the roster (`proposed → active`,
// `confirmContact`) rather than sit invisible until a counselor manually re-checks M39 by hand.
//
// F-153's prior finding on this pair ("its full effect list needs `appendScore` … a private closure
// requiring a real acting membership the consumer's system-actor convention doesn't fit, plus M38
// relationship/SUD-disclosure seam calls") was checked against the actual code, not re-asserted, and two
// of its three claims do not hold:
//
//   • `appendScore` (`../routes/write-service-drizzle.ts`) is indeed private and unexported, and its own
//     TS parameter type (`actor: M16WriteActor`) DOES require a non-null `membershipId` — but that is a
//     restriction the CLOSURE imposes, not one the underlying mechanism needs. The function it calls,
//     `scoreBereavementRisk` (`../risk/index`, genuinely exported), takes `RiskScoreRequest
//     .assessedByUserId: string | null`, and `bereavement_risk_score.assessed_by_user_id`'s own schema
//     comment says outright: "NULL for the cron/system scorer." This file reimplements `appendScore`'s
//     body locally (below, `appendContactScore`) against `assessedByUserId: null` — the documented
//     system-scorer case — rather than importing the private closure or widening its type.
//   • The "M38 relationship … seam calls" a contact CONFIRM needs are already done, at PROPOSAL time —
//     `createBereavedContact` (`../lifecycle/contact.ts`) requires `relationshipInValueSet` before a
//     `proposed` row can exist at all. Confirming one needs no fresh M38 call.
//
// What the prior finding got right, and what this file actually needs, is the SUD-disclosure gate:
// `gatherRiskEvidence` (`../risk/extract.ts`) reads M15's `MswRiskFactorReader` and M9's
// `ScaleSeriesProvider`, BOTH already resolved through M16's own `../seams/consumed` (`getSeam`, no
// manifest edge needed — the same "M16-T04's two additions are READ-ONLY consumers of seams M9 and M15
// already publish live" precedent the file header there documents) and BOTH fail-SOFT to `unknown` on any
// seam error — so even an unestablished request scope degrades the score rather than blocking the confirm.
// `sudDisclosureAllowed` (§7.13, the 42 CFR Part 2 posture) has no bound resolver anywhere in this module
// either (`write-service-drizzle.ts`'s own default is `async () => false`, the conservative reading) — this
// file's `Deps.sudDisclosureAllowed` mirrors that same optional port with the same conservative default,
// so a future M38/M39 SUD-posture resolver can bind here without a second decision.
//
// AMBIENT REQUEST CONTEXT: `MswRiskFactorReader.riskFactorsForAdmission`'s Drizzle backing
// (`15-discipline-care-plans/seams/drizzle-store.ts`) opens `withOrgContextFromRequest`, which throws
// outside an active `runWithRequestContext` scope — a dispatcher tick is not a request, the
// `19-oncall`/`20-field-safety`/M25-F-158 precedent for this exact shape. The whole handler runs inside
// `runWithRequestContext({organizationId, userId: CONSUMER_USER_ID}, …)` so the seam call — reached only
// inside `gatherRiskEvidence`, itself wrapped in try/catch — resolves for real rather than merely
// degrading to `unknown` for want of a scope nobody established. (`readMswFactors`/`readPpsPoints` still
// degrade honestly to `unknown` on a genuine seam failure, unrelated to this scope requirement.)
//
// NO CATALOG EDIT NEEDED ANYWHERE: the two M16-OWNED events this handler publishes
// (`m16.bereavement.contact_active`, `m16.bereavement.risk_score_computed`) are established M16 events
// with existing declaredConsumers, unchanged by adding this producer. `m39.consent.signed`'s OWN catalog
// entry (`apps/backend/src/modules/39-consent/events-by-m39.ts`) already declares
// `declaredConsumers: ["m22", "m5", "m16"]` — `"m16"` was added there already, so only the composition-root
// binding (a shared file this module is not permitted to touch) is needed to make this consumer live.
//
// IDEMPOTENT BY CONSTRUCTION, the `m39-consent-revoked.ts` precedent: `BEREAVED_CONTACT_GRAPH` accepts
// `confirmContact` only from `proposed`, and this handler pre-filters on `status = 'proposed'` before ever
// calling the machine — a redelivery after the first delivery already confirmed the contact finds it
// `active` and is a silent no-op, never a second confirm or a second score row.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  AdmissionId,
  BereavedContactId,
  BereavementRiskTier,
  ConsentId,
  IsoInstant,
  PatientId,
} from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import { transitionBereavedContact } from "../lifecycle/index";
import { scoreBereavementRisk } from "../risk/index";
import { type EffectContext, runEffects } from "../routes/effects-runner";
import type { WriteOutboxPort } from "../routes/write-service";

const CONTACT = schema.bereavedContact;
const PLAN = schema.bereavementPlan;
const SCORE = schema.bereavementRiskScore;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

/** M39's own literal for the bereavement-outreach consent type (`consent-store-db.ts:1318`) — no shared
 *  constant exists anywhere in `@chartwarden/types` to import instead. */
const BEREAVEMENT_OUTREACH_CONSENT_TYPE_KEY = "bereavement_outreach_consent";

export const M16_CONSENT_SIGNED_CONSUMER = {
  eventName: "m39.consent.signed",
  consumerName: "m16.m39-consent-signed",
} as const;

export interface ConsentSignedDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
  /** §7.13 — the reader's 42 CFR Part 2 posture. Defaults to false, matching `write-service-drizzle.ts`'s
   *  own conservative default (an unresolved consent leaves the SUD factor `unknown`, never `false`). */
  readonly sudDisclosureAllowed?: (input: {
    organizationId: string;
    patientId: string;
  }) => Promise<boolean>;
}

interface ConsentSignedFacts {
  readonly consentRecordId: ConsentId;
  readonly typeKey: string;
}

function factsOf(payload: unknown): ConsentSignedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const consentRecordId = p.consentRecordId;
  const typeKey = p.typeKey;
  if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
    throw new Error(`${M16_CONSENT_SIGNED_CONSUMER.consumerName}: payload has no consentRecordId`);
  }
  if (typeof typeKey !== "string" || typeKey.length === 0) {
    throw new Error(`${M16_CONSENT_SIGNED_CONSUMER.consumerName}: payload has no typeKey`);
  }
  return { consentRecordId: consentRecordId as ConsentId, typeKey };
}

/**
 * M16's live `m39.consent.signed` binding (filtered to `bereavement_outreach_consent`) — the §4.5
 * post-death-grant handler: `proposed → active` for the one contact this org tracks against the signed
 * consent, plus the §2.6 `recompute_risk` per-contact score append that transition declares.
 */
export function buildM16ConsentSignedConsumer(deps: ConsentSignedDeps) {
  const sudAllowed = deps.sudDisclosureAllowed ?? (async () => false);

  return {
    consumerName: M16_CONSENT_SIGNED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_CONSENT_SIGNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.typeKey !== BEREAVEMENT_OUTREACH_CONSENT_TYPE_KEY) return;

      const organizationId = event.organizationId;

      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () =>
        withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [contact] = await tx
            .select()
            .from(CONTACT)
            .where(
              and(
                eq(CONTACT.organizationId, organizationId),
                eq(CONTACT.consentRecordId, facts.consentRecordId),
                eq(CONTACT.status, "proposed"),
              ),
            )
            .limit(1);
          // No contact this org tracks against this exact consent record, or it already left `proposed`
          // (confirmed some other way, or the roster moved on) — a true no-op, not an error.
          if (!contact) return;

          const [plan] = await tx.select().from(PLAN).where(eq(PLAN.id, contact.planId)).limit(1);
          if (!plan) return; // orphaned contact row — refuse silently rather than guess a plan.

          const at = new Date().toISOString() as IsoInstant;

          const transition = transitionBereavedContact(contact.status, {
            type: "confirmContact",
            at,
            hasBereavementOutreachConsent: true,
            isPrimaryCaregiverWithFamilyAccess: false,
          });

          const effectCtx: EffectContext = {
            organizationId,
            at: new Date(at),
            outbox: deps.outbox,
            aggregateKind: "bereavement_plan",
            aggregateId: plan.id,
            payloads: {
              "m16.bereavement.contact_active": {
                planId: plan.id,
                contactId: contact.id,
                portalAccountId: contact.portalAccountId ?? null,
              },
            },
          };
          const patch = await runEffects(tx, transition.effects, effectCtx);

          const [updatedContact] = await tx
            .update(CONTACT)
            .set({
              status: transition.to,
              confirmedAt: patch.confirmedAt ?? new Date(at),
              version: contact.version + 1,
              updatedAt: new Date(at),
            })
            .where(eq(CONTACT.id, contact.id))
            .returning();
          if (!updatedContact) throw new Error("m16: the confirm update returned no row");

          // §2.6 `recompute_risk` — the confirmed survivor now has a per-contact score. Local
          // reimplementation of `appendScore` (write-service-drizzle.ts) against `assessedByUserId:
          // null` — see file header for why the private closure is not imported.
          await appendContactScore(
            tx,
            deps,
            organizationId,
            plan as PlanRowShape,
            updatedContact as ContactRowShape,
            await sudAllowed({ organizationId, patientId: plan.patientId }),
            at,
          );
        }),
      );
    },
  };
}

// ── local `appendScore` reimplementation, system-actor scoped (assessedByUserId: null) ────────────────

interface PlanRowShape {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly patientId: string;
  readonly admissionId: string;
  readonly deathDate: string;
  readonly deathTime: Date | null;
  readonly currentRiskTier: BereavementRiskTier | null;
}

interface ContactRowShape {
  readonly id: string;
  readonly planId: string;
  readonly relationshipCode: string;
  readonly currentRiskTier: BereavementRiskTier | null;
}

async function appendContactScore(
  tx: DbClient,
  deps: ConsentSignedDeps,
  organizationId: string,
  plan: PlanRowShape,
  contact: ContactRowShape,
  sudDisclosureAllowed: boolean,
  assessedAt: string,
): Promise<void> {
  const [prior] = await tx
    .select({ id: SCORE.id })
    .from(SCORE)
    .where(eq(SCORE.bereavedContactId, contact.id))
    .orderBy(desc(SCORE.assessedAt), desc(SCORE.id))
    .limit(1);

  const rosterCountRows = await tx
    .select({ id: CONTACT.id })
    .from(CONTACT)
    .where(and(eq(CONTACT.planId, plan.id), eq(CONTACT.status, "active")));
  const rosterCount = rosterCountRows.length;

  const result = await scoreBereavementRisk(
    {
      organizationId,
      admissionId: plan.admissionId as AdmissionId,
      patientId: plan.patientId as PatientId,
      deathAt: (plan.deathTime
        ? plan.deathTime.toISOString()
        : `${plan.deathDate}T00:00:00.000Z`) as IsoInstant,
      // F-159 — `BereavementRosterEvidence`'s real fields are `isPrimaryCaregiver`/`enrolledSurvivorCount`,
      // not `activeContactCount`/`relationshipCode` (a mismatch also present in the private `appendScore`
      // this reimplements — fixed there too in the same pass, see write-service-drizzle.ts). No bound seam
      // resolves M5's `patient_caregiver.is_primary` for this survivor (the extract.ts header's own
      // "KNOWN GAP" pattern for `preExistingMentalHealth`), so `isPrimaryCaregiver` is honestly `null`
      // rather than guessed — `deriveRiskFactors` falls back to the MSW-derived value for that slot, per
      // its own documented `!== null` check. `enrolledSurvivorCount` is the real, already-computed
      // `rosterCount` under its correct name.
      roster: {
        isPrimaryCaregiver: null,
        enrolledSurvivorCount: rosterCount,
      },
      sudDisclosureAllowed,
    },
    {
      planId: plan.id as never,
      contactId: contact.id as BereavedContactId as never,
      providerEntityId: plan.providerEntityId,
      locationId: plan.locationId,
      assessedByUserId: null,
      assessedAt: assessedAt as IsoInstant,
      amendmentKind: "scheduled_reassessment",
      amendedFromScoreId: prior?.id ?? null,
      priorTier: contact.currentRiskTier ?? plan.currentRiskTier ?? null,
    },
  );

  const [row] = await tx
    .insert(SCORE)
    .values({
      organizationId,
      providerEntityId: plan.providerEntityId,
      locationId: plan.locationId,
      planId: plan.id,
      bereavedContactId: result.draft.bereavedContactId,
      scoreKind: result.draft.scoreKind,
      assessedAt: new Date(result.draft.assessedAt),
      assessedByUserId: result.draft.assessedByUserId,
      riskFactorsJsonb: result.draft.riskFactorsJsonb,
      ruleScore: result.draft.ruleScore,
      ruleTier: result.draft.ruleTier,
      dataCompleteness: result.draft.dataCompleteness,
      confidenceBand: result.draft.confidenceBand,
    })
    .returning();
  if (!row) throw new Error("m16: the risk-score append returned no row");

  await tx
    .update(CONTACT)
    .set({ currentRiskTier: row.ruleTier, currentRiskScoreId: row.id })
    .where(eq(CONTACT.id, contact.id));

  const effectCtx: EffectContext = {
    organizationId,
    at: new Date(assessedAt),
    outbox: deps.outbox,
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads: {
      "m16.bereavement.risk_score_computed": {
        planId: plan.id,
        contactId: contact.id,
        scoreKind: row.scoreKind,
        tier: row.ruleTier,
        scoreId: row.id,
        dataCompleteness: row.dataCompleteness,
        confidenceBand: row.confidenceBand,
      },
    },
    // No `alerts` port bound here (matching the composition root's own `buildDrizzleM16WriteService`
    // call, which supplies no `alerts` either) — `risk_tier_escalated` is best-effort per the runner's
    // own rule 3 and is simply not emitted without a bound `AlertPort`, never a hard failure.
  };
  await runEffects(tx, result.effects, effectCtx);
}
