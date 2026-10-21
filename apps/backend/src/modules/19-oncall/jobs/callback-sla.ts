// apps/backend/src/modules/19-oncall/jobs/callback-sla.ts — the §4.8 `m19.callback-sla.cron` (every minute):
// find `awaiting_callback` calls whose callback target has lapsed and publish
// `m19.triage_call.callback_sla_breached`, which M36 turns into the `m19.triage.callback_sla_breached` warn
// page to the on-call roster (`36-messaging/outbox-consumers/oncall-alerts.ts`). Until now `markAwaitingCallback`
// declared an alert effect whose payload no code ever built, so a caller left on hold was never chased.
//
// THE TARGET. `tenant_oncall_policy.callback_sla_per_severity` for the call's ProviderEntity, read as the
// TIGHTEST target (the call carries no severity) — see `triage-sla-policy.ts`. No policy row = the platform
// floor (30 min): a call can only reach `awaiting_callback` under an on-call shift, which needs the policy, so
// a missing row is a data hole the page should survive rather than hide behind.
//
// ONE PAGE PER WAIT. A one-minute tick would otherwise re-publish every minute; `triage_call
// .callback_sla_breached_at` marks the breach and is compared with the call's latest `awaiting_callback` entry
// (`awaiting-callback-queries.ts`), so a wait is paged once and a later wait of the same call is judged afresh.
// The marker UPDATE does NOT bump `version`: it is cron bookkeeping, and bumping it would 412 a clinician who
// is resuming the call at that instant (§2.5).
//
// NO AUTO-ESCALATE. The spec's "alert / auto-escalate" is read as the alert: an escalation row needs a named
// recipient (§3.3 CHECK) and a system actor has no caller to fall back on, so inventing one would page the
// wrong person. The `sla_breach` escalation trigger stays reserved for a human or a future ladder resolver.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import {
  NOT_YET_PAGED_THIS_WAIT,
  awaitingCallbackCallIds,
  enteredAwaitingCallbackAt,
} from "./awaiting-callback-queries";
import {
  type M19TriageCronDeps,
  type TriageCronItemOutcome,
  type TriageCronOrgResult,
  callEventBase,
  minutesBetween,
  processOrgItems,
  runForEachActiveOrg,
  triageCronContext,
} from "./triage-cron-common";
import { resolveCallbackSlaMinutes } from "./triage-sla-policy";

const CALL = schema.triageCall;
const POLICY = schema.tenantOncallPolicy;

async function breachOne(
  deps: M19TriageCronDeps,
  tx: DbClient,
  organizationId: string,
  callId: string,
  at: Date,
): Promise<TriageCronItemOutcome> {
  const [call] = await tx
    .select()
    .from(CALL)
    .where(and(eq(CALL.organizationId, organizationId), eq(CALL.id, callId)))
    .for("update")
    .limit(1);
  // Resumed / abandoned / timed out by someone else between the candidate read and the lock.
  if (!call || call.state !== "awaiting_callback") return "skipped";

  const entered = (await enteredAwaitingCallbackAt(tx, organizationId, callId)) ?? call.openedAt;
  if (call.callbackSlaBreachedAt !== null && call.callbackSlaBreachedAt >= entered) {
    return "skipped";
  }
  const [policy] = await tx
    .select({ sla: POLICY.callbackSlaPerSeverity })
    .from(POLICY)
    .where(
      and(
        eq(POLICY.organizationId, organizationId),
        eq(POLICY.providerEntityId, call.providerEntityId),
      ),
    )
    .limit(1);
  const slaTargetMinutes = resolveCallbackSlaMinutes(policy?.sla);
  const minutesElapsed = minutesBetween(entered, at);
  if (minutesElapsed < slaTargetMinutes) return "skipped";

  await deps.outbox.publish(tx, {
    eventName: "m19.triage_call.callback_sla_breached",
    organizationId,
    aggregateKind: "triage_call",
    aggregateId: call.id,
    payload: { ...callEventBase(call, at), slaTargetMinutes, minutesElapsed },
  });
  await tx
    .update(CALL)
    .set({ callbackSlaBreachedAt: at })
    .where(and(eq(CALL.organizationId, organizationId), eq(CALL.id, call.id)));
  return "acted";
}

async function processOrg(
  deps: M19TriageCronDeps,
  organizationId: string,
  at: Date,
): Promise<TriageCronOrgResult> {
  const ids = await withOrgContext(deps.db, triageCronContext(organizationId), (handle) =>
    awaitingCallbackCallIds(handle as DbClient, organizationId, NOT_YET_PAGED_THIS_WAIT),
  );
  return processOrgItems(deps, {
    label: "M19_CALLBACK_SLA",
    organizationId,
    ids,
    one: (tx, id) => breachOne(deps, tx, organizationId, id, at),
  });
}

/** §4.8 `m19.callback-sla.cron` — every active org; returns pages published (`acted`) per org. */
export function runCallbackSlaTick(
  deps: M19TriageCronDeps,
): Promise<ReadonlyMap<string, TriageCronOrgResult>> {
  return runForEachActiveOrg(deps, "M19_CALLBACK_SLA", (orgId, at) => processOrg(deps, orgId, at));
}
