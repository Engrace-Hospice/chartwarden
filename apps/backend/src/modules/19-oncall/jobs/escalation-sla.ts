// apps/backend/src/modules/19-oncall/jobs/escalation-sla.ts — the §4.8 `m19.escalation-sla` cron (every
// 5 min): "alert on escalation rows open > tier-specific SLA from `tenant_oncall_policy.escalation_tiers`".
// "Open" is the §2.2.4 state of that name — NOT yet acknowledged (`acknowledged_at IS NULL`, `resolved_at IS
// NULL`); an acknowledged row has been picked up by a named human and is that human's to resolve. Published as
// `m19.triage_call.escalation_sla_breached`; M36 turns it into the `m19.triage.escalation_sla_breached` page
// to the clinical-supervisor / DON / org-admin role set (`36-messaging/outbox-consumers/oncall-alerts.ts`).
//
// THE SLA. `escalation_tiers[tier].slaMinutes` when the tenant set one, else the platform default per tier
// (`TRIAGE_ESCALATION_SLA_DEFAULT_MINUTES`); a mandatory (D7) row is capped at the tightest default — see
// `triage-sla-policy.ts`. The spec names no number, so every default is the conservative (short) side.
//
// A STANDING BREACH RE-PAGES, PACED. An unacknowledged escalation is the one finding where a single page that
// nobody saw is the failure, so `triage_escalation.sla_breached_at` records the last page and the row is
// re-published at most every `TRIAGE_ESCALATION_SLA_REPAGE_MINUTES` until someone acknowledges it. The marker
// UPDATE does not bump `version` (cron bookkeeping must not 412 the human acknowledging at that instant).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { TRIAGE_ESCALATION_SLA_REPAGE_MINUTES } from "@wardenx/types";
import { and, asc, eq, isNull, lte, notInArray, or } from "drizzle-orm";
import {
  type M19TriageCronDeps,
  MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK,
  type TriageCronItemOutcome,
  type TriageCronOrgResult,
  callEventBase,
  minutesBetween,
  processOrgItems,
  runForEachActiveOrg,
  triageCronContext,
} from "./triage-cron-common";
import { resolveEscalationSlaMinutes } from "./triage-sla-policy";

const CALL = schema.triageCall;
const ESCALATION = schema.triageEscalation;
const POLICY = schema.tenantOncallPolicy;

const MS_PER_MINUTE = 60_000;

async function breachOne(
  deps: M19TriageCronDeps,
  tx: DbClient,
  organizationId: string,
  escalationId: string,
  at: Date,
): Promise<TriageCronItemOutcome> {
  const [esc] = await tx
    .select()
    .from(ESCALATION)
    .where(and(eq(ESCALATION.organizationId, organizationId), eq(ESCALATION.id, escalationId)))
    .for("update")
    .limit(1);
  // Acknowledged / resolved by a human between the candidate read and the lock.
  if (!esc || esc.acknowledgedAt !== null || esc.resolvedAt !== null) return "skipped";
  const repageAfter = new Date(at.getTime() - TRIAGE_ESCALATION_SLA_REPAGE_MINUTES * MS_PER_MINUTE);
  if (esc.slaBreachedAt !== null && esc.slaBreachedAt > repageAfter) return "skipped";

  const [policy] = await tx
    .select({ tiers: POLICY.escalationTiers })
    .from(POLICY)
    .where(
      and(
        eq(POLICY.organizationId, organizationId),
        eq(POLICY.providerEntityId, esc.providerEntityId),
      ),
    )
    .limit(1);
  const mandatory = esc.triggerKind === "mandatory_protocol";
  const slaTargetMinutes = resolveEscalationSlaMinutes(policy?.tiers, esc.tier, mandatory);
  const minutesOpen = minutesBetween(esc.escalatedAt, at);
  if (minutesOpen < slaTargetMinutes) return "skipped";

  await deps.outbox.publish(tx, {
    eventName: "m19.triage_call.escalation_sla_breached",
    organizationId,
    aggregateKind: "triage_escalation",
    aggregateId: esc.id,
    payload: {
      ...callEventBase(
        { organizationId, providerEntityId: esc.providerEntityId, id: esc.triageCallId },
        at,
      ),
      escalationId: esc.id,
      tier: esc.tier,
      mandatory,
      slaTargetMinutes,
      minutesOpen,
    },
  });
  await tx
    .update(ESCALATION)
    .set({ slaBreachedAt: at })
    .where(and(eq(ESCALATION.organizationId, organizationId), eq(ESCALATION.id, esc.id)));
  return "acted";
}

async function processOrg(
  deps: M19TriageCronDeps,
  organizationId: string,
  at: Date,
): Promise<TriageCronOrgResult> {
  const repageAfter = new Date(at.getTime() - TRIAGE_ESCALATION_SLA_REPAGE_MINUTES * MS_PER_MINUTE);
  const ids = await withOrgContext(deps.db, triageCronContext(organizationId), async (handle) => {
    const rows = await (handle as DbClient)
      .select({ id: ESCALATION.id })
      .from(ESCALATION)
      .innerJoin(CALL, eq(CALL.id, ESCALATION.triageCallId))
      .where(
        and(
          eq(ESCALATION.organizationId, organizationId),
          isNull(ESCALATION.acknowledgedAt),
          isNull(ESCALATION.resolvedAt),
          notInArray(CALL.state, ["closed", "abandoned"]),
          or(isNull(ESCALATION.slaBreachedAt), lte(ESCALATION.slaBreachedAt, repageAfter)),
        ),
      )
      .orderBy(asc(ESCALATION.escalatedAt), asc(ESCALATION.id))
      .limit(MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK);
    return rows.map((r) => r.id);
  });
  return processOrgItems(deps, {
    label: "M19_ESCALATION_SLA",
    organizationId,
    ids,
    one: (tx, id) => breachOne(deps, tx, organizationId, id, at),
  });
}

/** §4.8 `m19.escalation-sla` — every active org; returns pages published (`acted`) per org. */
export function runEscalationSlaTick(
  deps: M19TriageCronDeps,
): Promise<ReadonlyMap<string, TriageCronOrgResult>> {
  return runForEachActiveOrg(deps, "M19_ESCALATION_SLA", (orgId, at) =>
    processOrg(deps, orgId, at),
  );
}
