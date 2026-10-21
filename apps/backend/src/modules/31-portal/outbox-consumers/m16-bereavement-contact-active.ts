// apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-contact-active.ts — the §4.10
// `m16.bereavement.contact_active` binding (F-167, #248, continuation of F-160/F-164/F-165's M31 build).
//
// F-139 named this pair genuine ("M16's OWN outbox table names M31 explicitly among its consumers").
// F-160/F-162/F-164 built M31's other five confirmed-genuine pairs but left this one unbuilt, and
// `m16-bereavement-plan-opened.ts` (F-165) names it explicitly as "the per-contact-exact mechanism this
// arc's own F-164 note already names as the real primary trigger" for the D6 lateral flip — `plan_opened`
// fires once per PLAN, before any contact has confirmed, so its own per-contact loop almost always finds
// zero candidates; `contact_active` fires exactly once per CONTACT, at the moment that contact's own
// bereavement_outreach_consent is verified (`confirmContact`, §2.6/D6) — the precise trigger the flip is
// actually waiting for.
//
// RE-VERIFIED, NOT RE-ASSERTED, THIS PASS: `M16ContactActivePayload` (`packages/types/src/bereavement.ts`)
// carries `{planId, contactId, portalAccountId}` — `portalAccountId` directly, no plan-wide scan needed —
// but no `patientId` and no `consentRecordId`/version, so this consumer still needs the same two supporting
// reads `plan_opened`'s per-contact branch uses: M16's `BereavementPlanProvider.planById` for the decedent
// patient (the `plan-closed`/`plan-opened` precedent) and M39's `ConsentEvaluator.evaluate` for the
// governing consent's VERSION (`portal_access_grant.source_consent_version`, NOT NULL, not carried by
// `bereaved_contact` at all). The candidate READ itself goes through a NEW, narrower M16 org-explicit seam
// (`bereavedContactFlipCandidateForOrg`, keyed by contactId rather than by plan) rather than
// `bereavedContactFlipCandidatesForPlanForOrg` filtered client-side — re-reading fresh by id is what makes
// a redelivery after the contact has since left `active` (opted out, deceased) an honest no-op rather than
// acting on the payload's stale snapshot.
//
// ACTOR / CONSENT-VERSION RESOLUTION: identical to `plan_opened`'s per-contact branch (F-165) — migration
// 0257's nullable `granted_by_membership_id` (the `order_discontinuation.actor_membership_id`
// system-actor-cascade precedent) plus M39's `ConsentEvaluator.evaluate`, cross-checked that the GOVERNING
// record it returns for the plan's patient is the SAME record this contact's `consent_record_id` names
// (`evaluate()`'s `pickGoverning` resolves one record per (patient, type), which need not be THIS contact's
// record on a plan with more than one bereaved contact each holding their own active consent) — a mismatch
// is a refusal to flip THIS delivery, never a fabricated attribution.
//
// GRANT PRE-CONDITION: `planBereavedFlip` throws `BEREAVED_FLIP_GRANT_NOT_ACTIVE` when the account holds no
// active (non-bereaved) grant for the decedent to flip — per F-164's standing finding, no production route
// anywhere inserts a `portal_access_grant` row today, so this is commonly the real-world case. Pre-checked
// here (never calling the planner without a live grant in hand) so the legitimate absence is a skip, never
// a thrown/DLQ'd delivery.
//
// IDEMPOTENT BY CONSTRUCTION: the seam read excludes any contact no longer `active` or missing its portal
// link, the live-grant pre-check excludes an account whose grant is already `bereaved_family` (flip already
// ran), and revoke/insert execute inside one transaction — a redelivery after a successful flip finds no
// non-bereaved live grant left to flip and no-ops, never a duplicate insert or a second revoke.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { type M31EventEmitter, emitGrantGranted, emitGrantsRevoked } from "../events";
import {
  type FlipCandidateGrant,
  planBereavedFlip,
  resolveBereavedInWindow,
} from "../lifecycle/bereaved-flip";

const PAG = schema.portalAccessGrants;

/** Not a real membership row — mirrors the sibling M16-consumer's system-actor sentinel;
 *  `granted_by_membership_id` is nullable as of mig 0257 for exactly this cascade. */
const CONSUMER_USER_ID = "";

/** §7.5/D6 — the platform's first (and, to date, only) floor-schema version — mirrors
 *  `m16-bereavement-plan-opened.ts`'s own constant exactly; both consumers must agree on it, since a
 *  contact confirmed via THIS event and a plan re-scanned via THAT one must produce the identical scope. */
const PORTAL_SCOPE_FLOOR_VERSION = "1";

const BEREAVEMENT_OUTREACH_CONSENT_TYPE_KEY = "bereavement_outreach_consent";

export const M31_BEREAVEMENT_CONTACT_ACTIVE_CONSUMER = {
  eventName: "m16.bereavement.contact_active",
  consumerName: "m31.m16-bereavement-contact-active",
} as const;

/** M16's org-explicit "one contact's flip candidacy" seam, injected as a port — `arch:tables`/
 *  `arch:boundaries` (the F-165 precedent): M31's `dependsOn` carries no edge to 16, so this file must not
 *  import M16's contact table off the shared `schema` namespace, and must not import a TYPE from M16's
 *  `seams/` directory either — the port shape is declared structurally here. */
export interface ContactFlipCandidate {
  readonly planId: string;
  readonly portalAccountId: string;
  readonly consentRecordId: string;
}

export type ContactFlipCandidateReader = (
  db: DbClient,
  organizationId: string,
  contactId: string,
) => Promise<ContactFlipCandidate | null>;

export interface BereavementContactActiveConsumerDeps {
  readonly db: DbClient;
  /** GAP-159 - same-tx grant + bereaved-mode emits (absent in slice/tests). */
  readonly events?: M31EventEmitter;
  readonly bereavedContactFlipCandidateForContact: ContactFlipCandidateReader;
}

interface ContactActiveFacts {
  readonly contactId: string;
}

function factsOf(payload: unknown): ContactActiveFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const contactId = p.contactId;
  if (typeof contactId !== "string" || contactId.length === 0) {
    throw new Error(
      `${M31_BEREAVEMENT_CONTACT_ACTIVE_CONSUMER.consumerName}: payload has no contactId`,
    );
  }
  return { contactId };
}

/** The M31-side structural projection of M16's `BereavementPlanProvider.planById` (the one arm this
 *  consumer calls) — mirrors the identical port in the sibling `plan-closed`/`plan-opened` consumers. */
interface BereavementPlanLookupPort {
  planById(orgId: string, planId: string): Promise<{ readonly patientId: string } | null>;
}

/** The M31-side structural projection of M39's `ConsentEvaluator.evaluate` — mirrors
 *  `m16-bereavement-plan-opened.ts`'s own `ConsentEvaluatorPort` exactly. */
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
 * M31's live `m16.bereavement.contact_active` binding — flips the confirmed contact's portal account from
 * its live (non-bereaved) grant to the D6 `bereaved_family` scope, via the T03 `planBereavedFlip` pure
 * core. The per-contact-exact sibling of `m16-bereavement-plan-opened.ts`'s own (almost-always-a-no-op)
 * per-contact loop.
 */
export function buildM31BereavementContactActiveConsumer(
  deps: BereavementContactActiveConsumerDeps,
) {
  return {
    consumerName: M31_BEREAVEMENT_CONTACT_ACTIVE_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_BEREAVEMENT_CONTACT_ACTIVE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // `BereavementPlanProvider`/`BereavedPortalScopeProvider`'s Drizzle backing opens
      // `withOrgContextFromRequest`, which throws outside an active `runWithRequestContext` scope — a
      // dispatcher tick is not a request, the `plan-closed`/`plan-opened` sibling precedent.
      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        // Re-read fresh by contactId — never trust the payload's snapshot. A contact that has since left
        // `active`, or lost its portal/consent link, is an honest no-op here.
        const candidate = await deps.bereavedContactFlipCandidateForContact(
          deps.db,
          organizationId,
          facts.contactId,
        );
        if (!candidate) return;

        let patientId: string | null = null;
        try {
          const planProvider = getSeam("BereavementPlanProvider") as BereavementPlanLookupPort;
          const plan = await planProvider.planById(organizationId, candidate.planId);
          patientId = plan?.patientId ?? null;
        } catch {
          patientId = null; // seam outage / unregistered — refuse rather than guess which patient to touch.
        }
        if (!patientId) return;
        const resolvedPatientId = patientId;

        // The governing bereavement-outreach consent for the plan's patient, cross-checked against THIS
        // contact's own consent record — `evaluate()`'s `pickGoverning` is per-(patient, type), which is
        // not guaranteed to be this exact contact's record on a plan with several confirmed contacts.
        let governingConsentRecordId: string | null = null;
        let governingConsentVersion: number | null = null;
        try {
          const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorPort;
          const verdict = await evaluator.evaluate({
            organizationId,
            patientId: resolvedPatientId,
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
          // Fail-closed — an unbound/erroring M39 seam resolves no consent; skip rather than guess.
        }
        if (governingConsentRecordId === null || governingConsentVersion === null) return;
        if (candidate.consentRecordId !== governingConsentRecordId) return;
        const resolvedConsentRecordId = governingConsentRecordId;
        const resolvedConsentVersion = String(governingConsentVersion);

        const inWindow = await resolveBereavedInWindow({
          orgId: organizationId,
          portalAccountId: candidate.portalAccountId,
        });
        if (!inWindow) return;

        await withOrgContext(
          deps.db,
          { organizationId, userId: CONSUMER_USER_ID },
          async (scoped) => {
            const tx = scoped as unknown as DbClient;

            // §3.3 partial-unique: at most one live grant per (account, patient). Only a NON-bereaved live
            // grant is a candidate to flip — a live `bereaved_family` grant means the flip already ran
            // (idempotency), and no live grant at all means there is nothing to flip yet (F-164's standing
            // finding: no production path inserts one today).
            const [liveGrant] = await tx
              .select()
              .from(PAG)
              .where(
                and(
                  eq(PAG.organizationId, organizationId),
                  eq(PAG.portalAccountId, candidate.portalAccountId),
                  eq(PAG.patientId, resolvedPatientId),
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
              decedentPatientId: resolvedPatientId,
              accountGrants,
              bereavedInWindow: true,
              floorVersion: PORTAL_SCOPE_FLOOR_VERSION,
            });

            const now = new Date();
            for (const rev of plan.revoke) {
              const revokedRows = await tx
                .update(PAG)
                .set({
                  revokedAt: now,
                  revokeCascadeSource: rev.revokeCascadeSource,
                  version: sql`${PAG.version} + 1`,
                  updatedAt: now,
                })
                .where(and(eq(PAG.id, rev.grantId), isNull(PAG.revokedAt)))
                .returning({
                  id: PAG.id,
                  portalAccountId: PAG.portalAccountId,
                  patientId: PAG.patientId,
                });
              await emitGrantsRevoked(
                deps.events,
                tx,
                organizationId,
                revokedRows,
                rev.revokeCascadeSource,
              );
            }
            for (const ins of plan.insert) {
              const [granted] = await tx
                .insert(PAG)
                .values({
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
                })
                .returning({
                  id: PAG.id,
                  portalAccountId: PAG.portalAccountId,
                  patientId: PAG.patientId,
                  grantKind: PAG.grantKind,
                });
              if (granted) {
                await emitGrantGranted(deps.events, tx, organizationId, granted);
                await deps.events?.emitInTx(
                  tx,
                  organizationId,
                  "m31.portal_account.bereaved_mode_entered",
                  { kind: "portal_account", id: granted.portalAccountId },
                  {
                    portalAccountId: granted.portalAccountId,
                    patientId: granted.patientId,
                    bereavementPlanId: candidate.planId,
                  },
                );
              }
            }
          },
        );
      });
    },
  };
}
