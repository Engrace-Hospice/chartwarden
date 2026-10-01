// apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-plan-opened.ts — the §4.10
// `m16.bereavement.plan_opened` binding (#248 continuation of F-160/F-164's M31 build).
//
// F-164 reported this pair BLOCKED: the INSERT half of the D6 lateral flip (`planBereavedFlip`,
// `../lifecycle/bereaved-flip.ts`) needs `portal_access_grant.granted_by_membership_id` — NOT NULL, and
// unlike `revoked_by_membership_id` on the same table, no nullable escape — plus (compounding,
// independently) the real M39 consent this insert's `sourceConsentRecordId` should resolve from is
// `draft` immediately after death and only becomes `active` once separately signed, so even with the
// actor problem solved the overwhelming majority of real `plan_opened` deliveries were expected to find
// no active consent to insert against yet.
//
// RE-CHECKED, NOT RE-ASSERTED, THIS PASS — both halves resolved:
//
//   1. ACTOR: migration 0257 widens `granted_by_membership_id` to nullable, the
//      `order_discontinuation.actor_membership_id` precedent ("NULL for system-actor cascades") — a
//      consumer-driven INSERT names no acting membership, the `CONSUMER_USER_ID` convention this file's
//      sibling consumers already use for the identical reason.
//
//   2. CONSENT: the "no active consent yet" framing was right about WHEN `plan_opened` fires
//      (`seedRosterAndSchedule`, before any contact is confirmed) but wrong that there is no way to
//      resolve the fact SAFELY. `bereaved_contact.consent_record_id` is set per-contact at roster-seed
//      time (D6), and M16's own `m39-consent-signed.ts` consumer flips a contact's `status`
//      `proposed → active` ONLY once THAT EXACT consent record signs — so `bereaved_contact.status =
//      'active'` is already the per-contact fact "this contact's bereavement_outreach_consent is
//      signed", no second M39 read needed to know THAT it's active. What it does not carry is the
//      consent's VERSION (`portal_access_grant.source_consent_version`, text, NOT NULL) — resolved via
//      M39's real `ConsentEvaluator.evaluate({consentType: 'bereavement_outreach_consent', ...})`
//      (the `22-documents/outbox-consumers/consent-gate.ts` opaque-seam precedent, `sessionClass:
//      'staff'`, `callerModule: 'm31'`), cross-checked that the GOVERNING record it returns is the SAME
//      one (`consentRecordId === contact.consentRecordId`) — `evaluate()`'s `pickGoverning` resolves one
//      record per (patient, type), which is not guaranteed to be THIS contact's record if the plan has
//      more than one bereaved contact each with their own active `bereavement_outreach_consent`. A
//      mismatch is a REFUSAL to flip that contact this delivery (never a guessed/fabricated version),
//      not an error — a future `m16.bereavement.contact_active` binding (still unbuilt, same deferred
//      group) is the per-contact-exact mechanism this arc's own F-164 note already names as the real
//      primary trigger; this consumer only ever catches the narrower "already confirmed by the time
//      plan_opened is (re)delivered" case.
//
// WHAT THIS MEANS IN PRODUCTION, STATED HONESTLY: at the instant `seedRosterAndSchedule` actually fires,
// every fresh bereaved_contact row is `proposed` (roster-seed and confirm are different transitions), so
// a first delivery of `plan_opened` will almost always find zero qualifying contacts and no-op — matching
// F-164's own prediction. This consumer is still correct and worth building: it operates on whatever
// contact/grant rows exist however they got there (the `plan-closed`/`consent-revoked` siblings' own
// stated methodology), it is idempotent under redelivery (a later redelivery, after a contact confirms,
// WILL find and flip it), and it never throws on the common "nothing to do yet" case.
//
// GRANT PRE-CONDITION: `planBereavedFlip` throws `BEREAVED_FLIP_GRANT_NOT_ACTIVE` when the account holds
// no active (non-bereaved) grant for the decedent to flip — per F-164's own standing finding, no
// production path anywhere inserts a `portal_access_grant` row today, so this candidate set is ALSO
// commonly empty. Pre-checked here (never calling the planner without a candidate in hand) so the
// legitimate absence is a skip, never a thrown/DLQ'd delivery.
//
// IDEMPOTENT BY CONSTRUCTION: the candidate query excludes any account whose live grant for the decedent
// is ALREADY `bereaved_family` (the flip already ran), and the revoke/insert executes inside one
// transaction per contact — a redelivery after a successful flip finds no non-bereaved live grant left to
// flip and no-ops, never a duplicate insert or a second revoke.
import { type DbClient, schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import {
  type FlipCandidateGrant,
  planBereavedFlip,
  resolveBereavedInWindow,
} from "../lifecycle/bereaved-flip";

const PAG = schema.portalAccessGrants;

/** M16's org-explicit "bereaved contact flip candidates for plan" seam, injected as a port —
 *  `arch:tables`/`arch:boundaries` (F-165, #248): M31's `dependsOn` carries no edge to 16, so this file
 *  must not import M16's contact table off the shared `schema` namespace, and must not even import a
 *  TYPE from M16's `seams/` directory directly — the port shape is declared structurally here, the
 *  `m16-plan-closed.ts`/M30 precedent one module over (that file's own siting-port type is likewise
 *  locally declared, never imported from M16). */
export interface BereavedContactFlipCandidate {
  readonly portalAccountId: string;
  readonly consentRecordId: string;
}

export type BereavedContactFlipCandidatesReader = (
  db: DbClient,
  organizationId: string,
  planId: string,
) => Promise<readonly BereavedContactFlipCandidate[]>;

/** Not a real membership row — mirrors the sibling telehealth/plan-closed consumers' system-actor
 *  sentinel; `granted_by_membership_id` is nullable as of mig 0257 for exactly this cascade. */
const CONSUMER_USER_ID = "";

/** §7.5/D6 — the platform's first (and, to date, only) floor-schema version. No production route has
 *  ever created a `portal_access_grant` row (F-164), so no earlier version has ever been persisted to
 *  disagree with; mirrors `platformFloorScopeSet`'s own `floorVersion` contract, an opaque caller-chosen
 *  string, not a value `scope-set.ts` itself defines. */
const PORTAL_SCOPE_FLOOR_VERSION = "1";

const BEREAVEMENT_OUTREACH_CONSENT_TYPE_KEY = "bereavement_outreach_consent";

export const M31_BEREAVEMENT_PLAN_OPENED_CONSUMER = {
  eventName: "m16.bereavement.plan_opened",
  consumerName: "m31.m16-bereavement-plan-opened",
} as const;

export interface BereavementPlanOpenedConsumerDeps {
  readonly db: DbClient;
  readonly bereavedContactFlipCandidatesForPlan: BereavedContactFlipCandidatesReader;
}

interface PlanOpenedFacts {
  readonly planId: string;
  readonly patientId: string;
}

function factsOf(payload: unknown): PlanOpenedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const planId = p.planId;
  const patientId = p.patientId;
  if (typeof planId !== "string" || planId.length === 0) {
    throw new Error(`${M31_BEREAVEMENT_PLAN_OPENED_CONSUMER.consumerName}: payload has no planId`);
  }
  if (typeof patientId !== "string" || patientId.length === 0) {
    throw new Error(
      `${M31_BEREAVEMENT_PLAN_OPENED_CONSUMER.consumerName}: payload has no patientId`,
    );
  }
  return { planId, patientId };
}

/** The M31-side structural projection of M39's `ConsentEvaluator.evaluate` — mirrors
 *  `22-documents/outbox-consumers/consent-gate.ts`'s `ConsentEvaluatorPort`, widened with the two fields
 *  (`consentRecordId`, `consentVersionAtEval`) that method already returns but M22's narrower SUD-only
 *  projection does not declare. */
interface ConsentEvaluatorPort {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number;
  }>;
}

/**
 * M31's live `m16.bereavement.plan_opened` binding — flips each already-confirmed bereaved contact's
 * portal account from its live (non-bereaved) grant to the D6 `bereaved_family` scope, via the T03
 * `planBereavedFlip` pure core.
 */
export function buildM31BereavementPlanOpenedConsumer(deps: BereavementPlanOpenedConsumerDeps) {
  return {
    consumerName: M31_BEREAVEMENT_PLAN_OPENED_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_BEREAVEMENT_PLAN_OPENED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // `BereavedPortalScopeProvider`'s Drizzle backing opens `withOrgContextFromRequest`, which throws
      // outside an active `runWithRequestContext` scope — a dispatcher tick is not a request, the
      // `19-oncall`/`20-field-safety`/M16's own `m39-consent-signed.ts`/this file's own `plan-closed`
      // sibling precedent.
      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        // §2 — only ALREADY-CONFIRMED contacts (their exact bereavement_outreach_consent has signed)
        // with a linked portal account are candidates. A fresh `plan_opened` delivery finds none of
        // these (every contact starts `proposed`); a redelivery after a later confirm does. Resolved via
        // M16's org-explicit `bereavedContactFlipCandidatesForPlanForOrg` seam — `arch:tables` (F-165,
        // #248): M31 must not read `bereaved_contact` off M16's own Drizzle schema directly.
        const candidates = await deps.bereavedContactFlipCandidatesForPlan(
          deps.db,
          organizationId,
          facts.planId,
        );
        if (candidates.length === 0) return;

        // The plan's decedent patient is shared by every contact on it (`facts.patientId`), so the
        // governing bereavement-outreach consent for that patient is resolved ONCE, not once per
        // contact — `evaluate()`'s `pickGoverning` is a per-(patient,type) resolution regardless.
        let governingConsentRecordId: string | null = null;
        let governingConsentVersion: number | null = null;
        try {
          const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorPort;
          const verdict = await evaluator.evaluate({
            organizationId,
            patientId: facts.patientId,
            consentType: BEREAVEMENT_OUTREACH_CONSENT_TYPE_KEY,
            sessionContext: { sessionClass: "staff" },
            callerModule: "m31",
          });
          if (
            verdict.allowed === true &&
            verdict.consentRecordId &&
            verdict.consentVersionAtEval !== undefined
          ) {
            governingConsentRecordId = verdict.consentRecordId;
            governingConsentVersion = verdict.consentVersionAtEval;
          }
        } catch {
          // Fail-closed — an unbound/erroring M39 seam resolves no consent; every candidate is skipped
          // below rather than guessed at.
        }
        if (governingConsentRecordId === null || governingConsentVersion === null) return;
        const resolvedConsentRecordId = governingConsentRecordId;
        const resolvedConsentVersion = String(governingConsentVersion);

        for (const candidate of candidates) {
          // Only THIS contact's exact consent record backs the flip — a governing record for a
          // DIFFERENT contact on the same plan is not this contact's authority (§3.3: "on the
          // authority of THIS M39 consent"), so a mismatch is a skip, not a fabricated attribution.
          if (candidate.consentRecordId !== resolvedConsentRecordId) continue;

          const inWindow = await resolveBereavedInWindow({
            orgId: organizationId,
            portalAccountId: candidate.portalAccountId,
          });
          if (!inWindow) continue;

          await withOrgContext(
            deps.db,
            { organizationId, userId: CONSUMER_USER_ID },
            async (scoped) => {
              const tx = scoped as unknown as DbClient;

              // §3.3 partial-unique: at most one live grant per (account, patient). Only a NON-bereaved
              // live grant is a candidate to flip — a live `bereaved_family` grant means the flip
              // already happened (idempotency), and no live grant at all means there is nothing to
              // flip yet (F-164's standing finding: no production path inserts one today).
              const [liveGrant] = await tx
                .select()
                .from(PAG)
                .where(
                  and(
                    eq(PAG.organizationId, organizationId),
                    eq(PAG.portalAccountId, candidate.portalAccountId),
                    eq(PAG.patientId, facts.patientId),
                    isNull(PAG.revokedAt),
                    ne(PAG.grantKind, "bereaved_family"),
                  ),
                )
                .limit(1);
              if (!liveGrant) return;

              const accountGrants: FlipCandidateGrant[] = [
                {
                  grantId: liveGrant.id,
                  patientId: liveGrant.patientId,
                  grantKind: liveGrant.grantKind,
                  revoked: false,
                },
              ];
              const plan = planBereavedFlip({
                decedentPatientId: facts.patientId,
                accountGrants,
                bereavedInWindow: true,
                floorVersion: PORTAL_SCOPE_FLOOR_VERSION,
              });

              const now = new Date();
              for (const rev of plan.revoke) {
                await tx
                  .update(PAG)
                  .set({
                    revokedAt: now,
                    revokeCascadeSource: rev.revokeCascadeSource,
                    version: sql`${PAG.version} + 1`,
                    updatedAt: now,
                  })
                  .where(and(eq(PAG.id, rev.grantId), isNull(PAG.revokedAt)));
              }
              for (const ins of plan.insert) {
                await tx.insert(PAG).values({
                  organizationId,
                  providerEntityId: liveGrant.providerEntityId,
                  locationId: liveGrant.locationId,
                  portalAccountId: candidate.portalAccountId,
                  patientId: ins.patientId,
                  grantKind: ins.grantKind,
                  scopeSetJsonb: ins.scopeSet,
                  sourceConsentRecordId: resolvedConsentRecordId,
                  sourceConsentVersion: resolvedConsentVersion,
                  grantedAt: now,
                  grantedByMembershipId: null,
                });
              }
            },
          );
        }
      });
    },
  };
}
