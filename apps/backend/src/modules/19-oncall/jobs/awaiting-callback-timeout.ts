// apps/backend/src/modules/19-oncall/jobs/awaiting-callback-timeout.ts — the §4.8
// `m19.awaiting-callback-timeout.cron` (every 10 min): a call that has sat in `awaiting_callback` past the
// grace window (default 60 min; a tenant may only tighten it via `state_overrides`, see `triage-sla-policy.ts`)
// advances to `disposition_pending` so a clinician dispositions it on what was recorded, instead of the call
// hanging open forever. The transition is the call machine's own (`autoTimeoutCallback`): audit + a
// `triage_call_state_history` row with `system_actor = true` and `auto_timeout = true` ("record in state
// history"). Migration 0362 adds that edge to the DB forward-transition whitelist and the history column.
//
// SAME OPTIMISTIC-CONCURRENCY RULE AS EVERY WRITER (§2.5): the call is locked `FOR UPDATE`, re-checked, and the
// UPDATE is guarded on `(id, version)` and bumps it, so a clinician who resumed the call first makes the
// cron's item a skip.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import { stateHistoryPort } from "../consumers/bindings";
import { autoTimeoutCallback } from "../lifecycle/triage-call";
import { runEffects } from "../routes/effects-runner";
import { awaitingCallbackCallIds, enteredAwaitingCallbackAt } from "./awaiting-callback-queries";
import {
  type M19TriageCronDeps,
  type TriageCronItemOutcome,
  type TriageCronOrgResult,
  callFactsOf,
  minutesBetween,
  processOrgItems,
  runForEachActiveOrg,
  triageCronContext,
} from "./triage-cron-common";
import { resolveAwaitingCallbackGraceMinutes } from "./triage-sla-policy";

const CALL = schema.triageCall;
const POLICY = schema.tenantOncallPolicy;

async function timeoutOne(
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
  if (!call || call.state !== "awaiting_callback") return "skipped";

  const entered = (await enteredAwaitingCallbackAt(tx, organizationId, callId)) ?? call.openedAt;
  const [policy] = await tx
    .select({ overrides: POLICY.stateOverrides })
    .from(POLICY)
    .where(
      and(
        eq(POLICY.organizationId, organizationId),
        eq(POLICY.providerEntityId, call.providerEntityId),
      ),
    )
    .limit(1);
  if (minutesBetween(entered, at) < resolveAwaitingCallbackGraceMinutes(policy?.overrides)) {
    return "skipped";
  }

  const transition = autoTimeoutCallback(callFactsOf(call));
  await runEffects(tx, transition.effects, {
    organizationId,
    providerEntityId: call.providerEntityId,
    locationId: call.locationId,
    triageCallId: call.id,
    at,
    actorMembershipId: null,
    commandPayloadDigest: null,
    outbox: deps.outbox,
    stateHistory: stateHistoryPort(),
    aggregateKind: "triage_call",
    aggregateId: call.id,
    payloads: {},
  });
  const updated = await tx
    .update(CALL)
    .set({ state: transition.to, version: call.version + 1, updatedAt: at })
    .where(and(eq(CALL.id, call.id), eq(CALL.version, call.version)))
    .returning({ id: CALL.id });
  // Unreachable under the row lock; if it ever fires the item (not the tick) rolls back and is reported.
  if (updated.length !== 1) throw new Error(`M19_CALLBACK_TIMEOUT: triage_call ${call.id} changed`);
  return "acted";
}

async function processOrg(
  deps: M19TriageCronDeps,
  organizationId: string,
  at: Date,
): Promise<TriageCronOrgResult> {
  const ids = await withOrgContext(deps.db, triageCronContext(organizationId), (handle) =>
    awaitingCallbackCallIds(handle as DbClient, organizationId),
  );
  return processOrgItems(deps, {
    label: "M19_AWAITING_CALLBACK_TIMEOUT",
    organizationId,
    ids,
    one: (tx, id) => timeoutOne(deps, tx, organizationId, id, at),
  });
}

/** §4.8 `m19.awaiting-callback-timeout.cron` — every active org; returns calls advanced (`acted`) per org. */
export function runAwaitingCallbackTimeoutTick(
  deps: M19TriageCronDeps,
): Promise<ReadonlyMap<string, TriageCronOrgResult>> {
  return runForEachActiveOrg(deps, "M19_AWAITING_CALLBACK_TIMEOUT", (orgId, at) =>
    processOrg(deps, orgId, at),
  );
}
