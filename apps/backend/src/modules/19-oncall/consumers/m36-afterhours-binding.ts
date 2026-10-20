// apps/backend/src/modules/19-oncall/consumers/m36-afterhours-binding.ts — ADR-0082 decision 4 (slice S2).
//
// The IO half of `./m36-afterhours-requested`: the `m36.afterhours_triage.requested` binding. M36 asks for a
// triage call by id; M19 decides and ALWAYS answers with `m19.afterhours_triage.outcome`, published in the
// same transaction as the decision.
//
// REDELIVERY. The relay's receipt is written AFTER `handle` in a separate transaction (at-least-once), so a
// crash in between redelivers. `opened` is guarded by `triage_call_source_dedupe_uq`; `coalesced` and
// `no_coverage` write no call row, so the guard for them is `triage_afterhours_decision` (migration 1133): one
// row per source event, written in the SAME transaction as the decision and its outcome event (M19 may not
// read `outbox_event`). A replay that finds it does nothing: the original outcome stands, nothing is
// republished and no second `coverage_gap` is emitted, even if the world has since changed. Replays are
// normally serial per event (the relay claims the row); if two deliveries do race, the UNIQUE key makes the
// loser's insert return no row and it THROWS, rolling back its whole transaction (call row, gap, outcome),
// so exactly one outcome is ever published.
import { type DbClient, schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant, OrgId, TriageCallId } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  CONSUMER_USER_ID,
  type OncallTriggerConsumerDeps,
  openMachineCall,
  publishCoverageGap,
} from "./bindings";
import {
  type AfterHoursAction,
  type AfterHoursOutcome,
  type AfterHoursReads,
  M19_AFTERHOURS_OUTCOME_EVENT,
  M36_AFTERHOURS_REQUESTED_EVENT,
  decideAfterHoursRequested,
  parseAfterHoursRequested,
  resolveAfterHoursFacts,
} from "./m36-afterhours-requested";

const DECISION = schema.triageAfterhoursDecisions;

/** Has this source event already been decided? (The replay guard for the arms that write no call row.) */
async function outcomeAlreadyPublished(
  deps: OncallTriggerConsumerDeps,
  organizationId: OrgId,
  sourceOutboxEventId: string,
): Promise<boolean> {
  return withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({ id: DECISION.id })
      .from(DECISION)
      .where(
        and(
          eq(DECISION.organizationId, organizationId),
          eq(DECISION.sourceOutboxEventId, sourceOutboxEventId),
        ),
      )
      .limit(1);
    return row !== undefined;
  });
}

/** Record the decision and publish `m19.afterhours_triage.outcome` on the caller's tx: both commit with it. */
async function publishAfterHoursOutcome(
  deps: OncallTriggerConsumerDeps,
  tx: DbClient,
  input: {
    readonly organizationId: OrgId;
    readonly messageId: string;
    readonly sourceOutboxEventId: string;
    readonly triageCallId: TriageCallId | null;
    readonly outcome: AfterHoursOutcome;
  },
): Promise<void> {
  const inserted = await tx
    .insert(DECISION)
    .values({
      organizationId: input.organizationId,
      sourceOutboxEventId: input.sourceOutboxEventId,
      triageCallId: input.triageCallId,
      outcome: input.outcome,
    })
    .onConflictDoNothing()
    .returning({ id: DECISION.id });
  // A concurrent delivery of the same event inserted first: this transaction decided on a stale read.
  // Throw so everything it did (call row, coverage_gap, outcome) rolls back; the relay's retry then reads
  // the winner's decision row and skips. Publishing here would double the outcome.
  if (inserted.length === 0) {
    throw new Error(
      `after-hours decision for event ${input.sourceOutboxEventId} already recorded by a concurrent delivery`,
    );
  }
  await deps.outbox.publish(tx, {
    eventName: M19_AFTERHOURS_OUTCOME_EVENT,
    organizationId: input.organizationId,
    // The request's own aggregate (the message) - correlation only; M36 matches on `sourceOutboxEventId`.
    aggregateKind: "message",
    aggregateId: input.messageId,
    payload: {
      sourceOutboxEventId: input.sourceOutboxEventId,
      triageCallId: input.triageCallId,
      outcome: input.outcome,
    },
  });
}

/** Execute whichever of the four outcomes the after-hours decider chose; every non-skip answers M36. */
async function applyAfterHoursAction(
  deps: OncallTriggerConsumerDeps,
  action: AfterHoursAction,
  ctx: {
    readonly organizationId: OrgId;
    readonly messageId: string;
    readonly sourceOutboxEventId: string;
    readonly at: Date;
  },
): Promise<void> {
  const answer = (
    tx: DbClient,
    triageCallId: TriageCallId | null,
    outcome: AfterHoursOutcome,
  ): Promise<void> => publishAfterHoursOutcome(deps, tx, { ...ctx, triageCallId, outcome });

  switch (action.kind) {
    case "idempotent_skip":
      // The first delivery published its outcome in the insert's transaction; a second would be noise.
      return;
    case "open_call":
      return openMachineCall(deps, action.draft, ctx.at, (tx, callId) =>
        answer(tx, callId, "opened"),
      );
    case "coalesced":
      return withOrgContext(
        deps.db,
        { organizationId: ctx.organizationId, userId: CONSUMER_USER_ID },
        (tx) => answer(tx as DbClient, action.intoTriageCallId, "coalesced"),
      );
    case "no_coverage":
      if (action.gap === null) {
        return withOrgContext(
          deps.db,
          { organizationId: ctx.organizationId, userId: CONSUMER_USER_ID },
          (tx) => answer(tx as DbClient, null, "no_coverage"),
        );
      }
      return publishCoverageGap(deps, action.gap, (tx) => answer(tx, null, "no_coverage"));
  }
}

/**
 * ADR-0082 decision 4 - the `m36.afterhours_triage.requested` binding. The organization comes from the
 * ENVELOPE (never the payload); the payload is parsed down to three ids; no message text is read.
 */
export function buildAfterHoursRequestedConsumer(
  deps: OncallTriggerConsumerDeps & { readonly afterHoursReads: AfterHoursReads },
): OutboxConsumerBinding {
  const clock = deps.now ?? (() => new Date());
  return {
    consumerName: "m19.m36-afterhours-requested",
    consumerModule: "m19",
    eventTypes: [M36_AFTERHOURS_REQUESTED_EVENT],
    async handle(event) {
      const organizationId = event.organizationId as OrgId;
      const payload = parseAfterHoursRequested(event.payload);
      const at = clock();
      const atIso = at.toISOString() as IsoInstant;

      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        const facts = await resolveAfterHoursFacts({
          organizationId,
          sourceOutboxEventId: event.id,
          payload,
          at: atIso,
          ports: deps.ports,
          reads: deps.afterHoursReads,
          outcomeAlreadyPublished: (org, id) => outcomeAlreadyPublished(deps, org, id),
        });
        const action = decideAfterHoursRequested({
          organizationId,
          sourceOutboxEventId: event.id,
          payload,
          facts,
          at: atIso,
        });
        await applyAfterHoursAction(deps, action, {
          organizationId,
          messageId: payload.messageId,
          sourceOutboxEventId: event.id,
          at,
        });
      });
    },
  };
}
