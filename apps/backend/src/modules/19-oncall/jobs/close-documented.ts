// apps/backend/src/modules/19-oncall/jobs/close-documented.ts — the §4.8 `m19.close-documented.cron` (every
// 15 min): close `documented` calls past the 30-minute amendment grace (`TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES`)
// and publish `m19.triage_call.closed`. `closeCall` (`../lifecycle/triage-call.ts`) was written for this and
// had no caller, so a documented call stayed `documented` forever and the M33 closed-call reporting never moved.
//
// THE MACHINE'S OWN GATES, PLUS ONE CONSERVATIVE SKIP. `closeCall` re-checks the grace from `documented_at` and
// refuses a call with an unresolved MANDATORY escalation (§2.2.4: a close may not clear D7's row by lapse). The
// cron additionally leaves a call alone while ANY escalation is unresolved-and-unacknowledged: the system cannot
// fabricate the acknowledgement §3.3's CHECK demands, and closing around the row would orphan an open page that
// `escalation-sla` keeps chasing. Such a call stays `documented` — visible, and the candidate query excludes it
// so a few stuck calls can never fill the per-tick bound and starve the rest. ACKNOWLEDGED, non-mandatory rows
// resolve with the close (`autoResolveOnCallClose`'s verdict, `resolved_by` NULL — no actor to invent).
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES } from "@chartwarden/types";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { stateHistoryPort } from "../consumers/bindings";
import { autoResolveOnCallClose } from "../lifecycle/escalation";
import type { TriageEscalationFacts } from "../lifecycle/escalation";
import { closeCall } from "../lifecycle/triage-call";
import { runEffects } from "../routes/effects-runner";
import {
  type M19TriageCronDeps,
  MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK,
  type TriageCronItemOutcome,
  type TriageCronOrgResult,
  callEventBase,
  callFactsOf,
  iso,
  processOrgItems,
  runForEachActiveOrg,
  triageCronContext,
} from "./triage-cron-common";

const CALL = schema.triageCall;
const ESCALATION = schema.triageEscalation;

const MS_PER_MINUTE = 60_000;

/** SQL: no escalation of this call is still unresolved-and-(mandatory-or-unacknowledged). */
const NO_BLOCKING_ESCALATION = sql`NOT EXISTS (
  SELECT 1 FROM triage_escalation e
   WHERE e.triage_call_id = ${CALL.id}
     AND e.resolved_at IS NULL
     AND (e.trigger_kind = 'mandatory_protocol' OR e.acknowledged_at IS NULL))`;

async function loadEscalationFacts(
  tx: DbClient,
  organizationId: string,
  callId: string,
): Promise<readonly TriageEscalationFacts[]> {
  const rows = await tx
    .select()
    .from(ESCALATION)
    .where(and(eq(ESCALATION.organizationId, organizationId), eq(ESCALATION.triageCallId, callId)))
    .orderBy(asc(ESCALATION.escalatedAt));
  return rows.map((r) => ({
    escalationId: r.id,
    tier: r.tier,
    triggerKind: r.triggerKind,
    escalatedAt: iso(r.escalatedAt),
    acknowledgedAt: r.acknowledgedAt === null ? null : iso(r.acknowledgedAt),
    resolvedAt: r.resolvedAt === null ? null : iso(r.resolvedAt),
    escalatedToMembershipId: r.escalatedToMembershipId,
    escalatedToExternalActorId: r.escalatedToExternalActorId,
  }));
}

async function closeOne(
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
  if (!call || call.state !== "documented") return "skipped";

  const escalations = await loadEscalationFacts(tx, organizationId, callId);
  const verdict = autoResolveOnCallClose(escalations, iso(at));
  if (verdict.blocking.length > 0) return "skipped";

  const transition = closeCall({ call: callFactsOf(call), escalations, at: iso(at) });
  const patch = await runEffects(tx, transition.effects, {
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
    payloads: {
      "m19.triage_call.closed": { ...callEventBase(call, at), finalDisposition: call.disposition },
    },
  });
  // The acknowledged, non-mandatory rows resolve with the call (the verdict's own effects, applied here).
  if (verdict.effects.length > 0) {
    await tx
      .update(ESCALATION)
      .set({ resolvedAt: at, updatedAt: at })
      .where(
        and(
          eq(ESCALATION.organizationId, organizationId),
          eq(ESCALATION.triageCallId, callId),
          isNull(ESCALATION.resolvedAt),
          isNotNull(ESCALATION.acknowledgedAt),
        ),
      );
  }
  const updated = await tx
    .update(CALL)
    .set({
      state: transition.to,
      closedAt: patch.closedAt ?? at,
      version: call.version + 1,
      updatedAt: at,
    })
    .where(and(eq(CALL.id, call.id), eq(CALL.version, call.version)))
    .returning({ id: CALL.id });
  if (updated.length !== 1) throw new Error(`M19_CLOSE_DOCUMENTED: triage_call ${call.id} changed`);
  return "acted";
}

async function processOrg(
  deps: M19TriageCronDeps,
  organizationId: string,
  at: Date,
): Promise<TriageCronOrgResult> {
  const graceStart = new Date(at.getTime() - TRIAGE_DOCUMENTED_CLOSE_GRACE_MINUTES * MS_PER_MINUTE);
  const ids = await withOrgContext(deps.db, triageCronContext(organizationId), async (handle) => {
    const rows = await (handle as DbClient)
      .select({ id: CALL.id })
      .from(CALL)
      .where(
        and(
          eq(CALL.organizationId, organizationId),
          eq(CALL.state, "documented"),
          lte(CALL.documentedAt, graceStart),
          NO_BLOCKING_ESCALATION,
        ),
      )
      .orderBy(asc(CALL.documentedAt), asc(CALL.id))
      .limit(MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK);
    return rows.map((r) => r.id);
  });
  return processOrgItems(deps, {
    label: "M19_CLOSE_DOCUMENTED",
    organizationId,
    ids,
    one: (tx, id) => closeOne(deps, tx, organizationId, id, at),
  });
}

/** §4.8 `m19.close-documented.cron` — every active org; returns calls closed (`acted`) per org. */
export function runCloseDocumentedTick(
  deps: M19TriageCronDeps,
): Promise<ReadonlyMap<string, TriageCronOrgResult>> {
  return runForEachActiveOrg(deps, "M19_CLOSE_DOCUMENTED", (orgId, at) =>
    processOrg(deps, orgId, at),
  );
}
