// apps/backend/src/modules/31-portal/outbox-consumers/m16-bereavement-plan-closed.ts — the §4.10
// `m16.bereavement.plan_closed_completed` binding (#248 continuation of F-160's M31 build).
//
// M31's own §4.10 "M31 consumes" table names this pair with a real consumer file
// (`m16-bereavement-plan-closed.ts`), effect: "Revoke bereaved grants." §7.5 step 4 in the spec's prose
// names the mechanism exactly: "Every non-revoked `bereaved_family` grant for the decedent patient on the
// account is revoked with `bereavement_window_expired`" — the T03 pure planner `planBereavedWindowClose`
// (`../lifecycle/bereaved-flip.ts`) has shipped this decision since M31-T03, unit-untested and uncalled by
// anything until this file.
//
// UNLIKE `plan_opened`'s flip (reported BLOCKED this same pass — see that consumer's own sibling file, not
// built here), THIS half needs no actor and no fresh M39 consent resolution: it is a pure REVOKE. Every
// column a revoke touches is either nullable (`revoked_by_membership_id`, `revoke_reason_cipher`) or
// computable from the event alone (`revoked_at`, `revoke_cascade_source`) — no NOT NULL column here has the
// F-150 "no system-actor-membership convention" problem `plan_opened`'s INSERT half hits.
//
// PATIENT ID RESOLUTION: the catalogued payload (`events-by-m16.ts`) carries only `{planId, closedAt,
// outreachStats}` — no `patientId`. Resolved via M16's own registered `BereavementPlanProvider.planById`
// seam (the SAME `getSeam("...")` opaque-pull idiom `resolveBereavedInWindow` in this file's sibling
// already uses for `BereavedPortalScopeProvider` — M31 `dependsOn` includes 16, so this stays off a
// `@chartwarden/bereavement` import edge per that file's own header note). A plan the seam cannot resolve (a
// bad id, or a genuine seam outage) is a REFUSAL to act, never a guess at which patient to touch.
//
// SCOPE: this revokes every active `bereaved_family` grant for the decedent patient ACROSS EVERY bereaved
// contact's portal account, not one account at a time — `planBereavedWindowClose`'s own signature takes one
// account's `accountGrants`, but the WHERE-clause candidate set (`organization_id`, `patient_id`,
// `grant_kind='bereaved_family'`, `revoked_at IS NULL`) is identical for every account that could hold one,
// so a single query yields the exact same candidate rows the pure planner would be handed per-account, one
// account at a time, with an identical `bereavement_window_expired` cascade source for every row —
// verified by feeding the whole candidate set through the pure function once rather than re-deciding the
// same fixed mapping in SQL.
//
// IDEMPOTENT BY CONSTRUCTION: each UPDATE is guarded by `revoked_at IS NULL` in its own WHERE clause (the
// telehealth consumers' precedent), so a redelivery after the first successful run matches zero rows.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { type M31EventEmitter, emitGrantsRevoked } from "../events";
import { type FlipCandidateGrant, planBereavedWindowClose } from "../lifecycle/bereaved-flip";

const PAG = schema.portalAccessGrants;

/** Not a real membership row — mirrors the sibling telehealth consumers' system-actor sentinel; nothing
 *  this table writes on a revoke needs an acting membership (`revoked_by_membership_id` is nullable). */
const CONSUMER_USER_ID = "";

export const M31_BEREAVEMENT_PLAN_CLOSED_CONSUMER = {
  eventName: "m16.bereavement.plan_closed_completed",
  consumerName: "m31.m16-bereavement-plan-closed",
} as const;

export interface BereavementPlanClosedConsumerDeps {
  readonly db: DbClient;
  /** GAP-159 - same-tx grant-revoked + bereaved-window-closed emits (absent in slice/tests). */
  readonly events?: M31EventEmitter;
}

interface PlanClosedFacts {
  readonly planId: string;
}

function factsOf(payload: unknown): PlanClosedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const planId = p.planId;
  if (typeof planId !== "string" || planId.length === 0) {
    throw new Error(`${M31_BEREAVEMENT_PLAN_CLOSED_CONSUMER.consumerName}: payload has no planId`);
  }
  return { planId };
}

/** The M31-side structural projection of M16's `BereavementPlanProvider.planById` (the one arm this
 *  consumer calls) — mirrors `BereavedPortalScopePort` in the sibling `bereaved-flip.ts` file. */
interface BereavementPlanLookupPort {
  planById(orgId: string, planId: string): Promise<{ readonly patientId: string } | null>;
}

/**
 * M31's live `m16.bereavement.plan_closed_completed` binding — revokes every active `bereaved_family`
 * grant for the plan's decedent patient, via the T03 `planBereavedWindowClose` pure core.
 */
export function buildM31BereavementPlanClosedConsumer(deps: BereavementPlanClosedConsumerDeps) {
  return {
    consumerName: M31_BEREAVEMENT_PLAN_CLOSED_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_BEREAVEMENT_PLAN_CLOSED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // `BereavementPlanProvider`'s Drizzle backing opens `withOrgContextFromRequest`, which throws
      // outside an active `runWithRequestContext` scope — a dispatcher tick is not a request, the
      // `19-oncall`/`20-field-safety`/M16's own `m39-consent-signed.ts` precedent for this exact shape.
      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        let patientId: string | null = null;
        try {
          const planProvider = getSeam("BereavementPlanProvider") as BereavementPlanLookupPort;
          const plan = await planProvider.planById(organizationId, facts.planId);
          patientId = plan?.patientId ?? null;
        } catch {
          patientId = null; // seam outage / unregistered — refuse rather than guess which patient to touch.
        }
        if (!patientId) return;
        const resolvedPatientId = patientId;

        await withOrgContext(
          deps.db,
          { organizationId, userId: CONSUMER_USER_ID },
          async (scoped) => {
            const tx = scoped as unknown as DbClient;

            const candidates = await tx
              .select({ id: PAG.id })
              .from(PAG)
              .where(
                and(
                  eq(PAG.organizationId, organizationId),
                  eq(PAG.patientId, resolvedPatientId),
                  eq(PAG.grantKind, "bereaved_family"),
                  isNull(PAG.revokedAt),
                ),
              );
            if (candidates.length === 0) return;

            const accountGrants: FlipCandidateGrant[] = candidates.map((r) => ({
              grantId: r.id,
              patientId: resolvedPatientId,
              grantKind: "bereaved_family",
              revoked: false,
            }));
            const plan = planBereavedWindowClose({
              decedentPatientId: resolvedPatientId,
              accountGrants,
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
              for (const r of revokedRows) {
                await deps.events?.emitInTx(
                  tx,
                  organizationId,
                  "m31.portal_account.bereaved_window_closed",
                  { kind: "portal_account", id: r.portalAccountId },
                  { portalAccountId: r.portalAccountId, patientId: r.patientId },
                );
              }
            }
          },
        );
      });
    },
  };
}
