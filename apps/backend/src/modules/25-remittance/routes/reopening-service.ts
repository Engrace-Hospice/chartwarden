// apps/backend/src/modules/25-remittance/routes/reopening-service.ts — M25 milestone 3: the MAC reopening of a
// denial the routing rules send to a reopening (a 56900 ADR non-response). Open one from a denial, record the
// MAC's deadline if it gave one, record the filing (a request made outside WardenX; electronic submission is
// milestone 6), record the decision, withdraw or close. Every command runs under `withOrgContext` (RLS) inside the
// actor's provider-entity scope; every change is If-Match so two people cannot overwrite each other. Opening a
// reopening against an ADR in assembly or review moves that ADR to `denied_no_response` in the SAME transaction,
// so the two records never disagree. There are no outbox events yet (nothing consumes them); the reopening_case
// write-audit trigger and the reopening_case_event history are the trail. A filed reopening is frozen by trigger.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  type AdrState,
  type ReopeningFilingRefusal,
  type ReopeningOutcome,
  type ReopeningState,
  canTransitionAdr,
  canTransitionReopening,
  checkReopeningFiling,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation, resolveDenialRoute } from "./denial-route-service";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface ReopeningCreateInput {
  readonly denialCaseId: string;
  /** The ADR the MAC never got an answer to; supplies the MAC name and is moved to `denied_no_response`. */
  readonly adrCaseId?: string;
  /** Required when no ADR is given. */
  readonly macName?: string;
}

export interface ReopeningFilingInput {
  readonly formName: string;
  readonly channel: string;
  readonly confirmationRef: string;
  readonly filedAt: string;
}

export interface ReopeningSummary {
  readonly id: string;
  readonly claimId: string;
  readonly denialCaseId: string;
  readonly adrCaseId: string | null;
  readonly macName: string;
  readonly state: string;
  readonly formName: string | null;
  readonly filingChannel: string | null;
  readonly filedAt: string | null;
  /** null = the MAC stated no deadline and none was recorded: the screen says so instead of computing one. */
  readonly dueAt: string | null;
  readonly outcome: string | null;
  readonly decidedAt: string | null;
  readonly version: number;
}

export interface ReopeningDetail extends ReopeningSummary {
  readonly filingConfirmationRef: string | null;
  readonly events: { id: string; eventKind: string; occurredAt: string }[];
}

export interface ReopeningService {
  createReopening(
    actor: M25WriteActor,
    input: ReopeningCreateInput,
  ): Promise<{ id: string; version: number }>;
  listReopenings(
    actor: M25ReadActor,
    filter: { state?: string; denialCaseId?: string },
    limit: number,
  ): Promise<{ items: ReopeningSummary[] }>;
  getReopening(actor: M25ReadActor, id: string): Promise<ReopeningDetail | null>;
  setDue(
    actor: M25WriteActor,
    id: string,
    dueAt: string | null,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  submitReopening(
    actor: M25WriteActor,
    id: string,
    input: ReopeningFilingInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  decideReopening(
    actor: M25WriteActor,
    id: string,
    outcome: ReopeningOutcome,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  withdrawReopening(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  closeReopening(
    actor: M25WriteActor,
    id: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : String(d);

const LIVE_STATES: readonly string[] = ["draft", "submitted", "decided"];

const FILING_MESSAGES: Readonly<Record<ReopeningFilingRefusal, string>> = {
  FORM_REQUIRED: "name the form or request you filed with the MAC",
  CHANNEL_INVALID: "the filing channel must be mac_portal, fax, mail or other",
  PROOF_REQUIRED: "the confirmation or tracking reference the MAC gave is required",
  FILED_IN_FUTURE: "the filing time cannot be in the future",
};

export function buildDrizzleReopeningService(db: DbClient): ReopeningService {
  const RC = schema.reopeningCase;
  const EV = schema.reopeningCaseEvent;
  const ADR = schema.adrCase;
  const ADR_EV = schema.adrCaseEvent;

  const summary = (r: typeof RC.$inferSelect): ReopeningSummary => ({
    id: r.id,
    claimId: r.claimId,
    denialCaseId: r.denialCaseId,
    adrCaseId: r.adrCaseId,
    macName: r.macName,
    state: r.state,
    formName: r.formName,
    filingChannel: r.filingChannel,
    filedAt: iso(r.filedAt),
    dueAt: iso(r.dueAt),
    outcome: r.outcome,
    decidedAt: iso(r.decidedAt),
    version: r.version,
  });

  async function load(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(RC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(RC)
      .where(scope ? and(eq(RC.id, id), scope) : eq(RC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("reopening case");
    return rows[0];
  }

  /** One guarded progress update: legal edge, If-Match version, an event row, all in the caller's transaction. */
  async function advance(
    tx: Tx,
    actor: M25WriteActor,
    cur: typeof RC.$inferSelect,
    to: ReopeningState,
    ifMatch: number,
    fields: Partial<typeof RC.$inferInsert>,
    eventPayload?: Record<string, unknown>,
  ) {
    if (!canTransitionReopening(cur.state as ReopeningState, to)) {
      throw new WardenXError(
        "INVALID_TRANSITION",
        `cannot transition from '${cur.state}' to '${to}'`,
        409,
      );
    }
    // The legal edge was checked against the row read above, so the update also pins that state and the caller's
    // version: a concurrent writer makes it match nothing (a 409), never apply to a state it was not checked for.
    const updated = await tx
      .update(RC)
      .set({ state: to, version: sql`${RC.version} + 1`, ...fields })
      .where(and(eq(RC.id, cur.id), eq(RC.version, ifMatch), eq(RC.state, cur.state)))
      .returning({ id: RC.id, version: RC.version });
    if (!updated[0]) throw new VersionConflictError(cur.version);
    await tx.insert(EV).values({
      organizationId: actor.organizationId,
      reopeningCaseId: cur.id,
      eventKind: to,
      eventPayload: eventPayload ?? null,
      actorMembershipId: actor.membershipId,
    });
    return updated[0];
  }

  return {
    async createReopening(actor, input) {
      return withOrgContext(db, actor, async (tx) => {
        const DC = schema.denialCase;
        const scope = providerEntityScopeCondition(DC.providerEntityId, actor.providerEntityScope);
        const denialRows = await tx
          .select({ claimId: DC.claimId, providerEntityId: DC.providerEntityId })
          .from(DC)
          .where(scope ? and(eq(DC.id, input.denialCaseId), scope) : eq(DC.id, input.denialCaseId))
          .limit(1);
        const denial = denialRows[0];
        if (!denial) throw new NotFoundError("denial case");
        if (!denial.claimId) {
          throw new WardenXError("INVALID_STATE", "the denial has no claim to reopen", 409);
        }
        // An ADR must be visible to THIS org under RLS, inside the actor's scope, and on the same claim.
        let adr: typeof ADR.$inferSelect | undefined;
        if (input.adrCaseId) {
          const adrScope = providerEntityScopeCondition(
            ADR.providerEntityId,
            actor.providerEntityScope,
          );
          const rows = await tx
            .select()
            .from(ADR)
            .where(
              adrScope ? and(eq(ADR.id, input.adrCaseId), adrScope) : eq(ADR.id, input.adrCaseId),
            )
            .limit(1);
          adr = rows[0];
          // The ADR must be on this claim and not tied to another denial: an ADR answering a sibling denial must
          // not be consumed (and closed as a non-response) by this one.
          if (
            !adr ||
            adr.claimId !== denial.claimId ||
            (adr.denialCaseId !== null && adr.denialCaseId !== input.denialCaseId)
          ) {
            throw new NotFoundError("ADR case");
          }
        }
        const macName = (adr?.macName ?? input.macName ?? "").trim();
        if (!macName) throw new WardenXError("INVALID_MAC", "the MAC name is required", 422);
        // Only a denial the routing rules send to a reopening may open one: an appealable denial belongs in the
        // appeal chain, and a second path for it would let the wrong clock run.
        // The MAC that picks a MAC-specific rule comes only from an ADR (the chosen one, else the denial's own
        // lookup), never from the typed name: a typed name could select the rule the opener prefers.
        const route = await resolveDenialRoute(
          tx,
          input.denialCaseId,
          actor.providerEntityScope,
          adr?.macName ?? null,
        );
        if (route.route !== "reopening") {
          throw new WardenXError(
            "ROUTE_NOT_REOPENING",
            "the routing rules do not send this denial to a reopening; record the MAC reason code (for example 56900) or add a routing rule first",
            409,
          );
        }
        const existing = await tx
          .select({ state: RC.state })
          .from(RC)
          .where(eq(RC.denialCaseId, input.denialCaseId));
        if (existing.some((r) => LIVE_STATES.includes(r.state))) {
          throw new WardenXError(
            "REOPENING_EXISTS",
            "this denial already has a reopening in progress",
            409,
          );
        }
        // One path at a time: an appeal still being worked on this denial would run a second clock beside it.
        const AP = schema.appealCase;
        const appeals = await tx
          .select({ state: AP.state })
          .from(AP)
          .where(eq(AP.denialCaseId, input.denialCaseId));
        if (appeals.some((a) => ["draft", "submitted", "under_review"].includes(a.state))) {
          throw new WardenXError(
            "APPEAL_IN_PROGRESS",
            "this denial already has an appeal in progress; withdraw or finish it before opening a reopening",
            409,
          );
        }
        let inserted: { id: string; version: number }[];
        try {
          inserted = await tx
            .insert(RC)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: denial.providerEntityId,
              claimId: denial.claimId,
              denialCaseId: input.denialCaseId,
              adrCaseId: adr?.id ?? null,
              macName,
            })
            .returning({ id: RC.id, version: RC.version });
        } catch (e) {
          // Two creates raced past the check above; the live-per-denial index is the backstop.
          if (isUniqueViolation(e)) {
            throw new WardenXError(
              "REOPENING_EXISTS",
              "this denial already has a reopening in progress",
              409,
            );
          }
          throw e;
        }
        await tx.insert(EV).values({
          organizationId: actor.organizationId,
          reopeningCaseId: inserted[0]!.id,
          eventKind: "created",
          actorMembershipId: actor.membershipId,
        });
        // The MAC never got a response, so an ADR still being worked is over: record it as the non-response it
        // became, in this transaction. A submitted or closed ADR is only linked (nothing to move).
        if (adr && canTransitionAdr(adr.state as AdrState, "denied_no_response")) {
          const moved = await tx
            .update(ADR)
            .set({
              state: "denied_no_response",
              version: sql`${ADR.version} + 1`,
              reviewedByMembershipId: null,
              reviewedAt: null,
            })
            .where(and(eq(ADR.id, adr.id), eq(ADR.version, adr.version)))
            .returning({ id: ADR.id });
          // Someone changed the ADR after it was read (for example filed it): nothing is half-recorded.
          if (!moved[0]) throw new VersionConflictError(adr.version);
          await tx.insert(ADR_EV).values({
            organizationId: actor.organizationId,
            adrCaseId: adr.id,
            eventKind: "denied_no_response",
            actorMembershipId: actor.membershipId,
          });
        }
        return inserted[0]!;
      });
    },

    async listReopenings(actor, filter, limit) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          providerEntityScopeCondition(RC.providerEntityId, actor.providerEntityScope),
          filter.state ? eq(RC.state, filter.state) : undefined,
          filter.denialCaseId ? eq(RC.denialCaseId, filter.denialCaseId) : undefined,
        ].filter((c) => c !== undefined);
        const rows = await tx
          .select()
          .from(RC)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(RC.createdAt), asc(RC.id))
          .limit(limit);
        return { items: rows.map(summary) };
      });
    },

    async getReopening(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(RC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(RC)
          .where(scope ? and(eq(RC.id, id), scope) : eq(RC.id, id))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const events = await tx
          .select({ id: EV.id, eventKind: EV.eventKind, occurredAt: EV.occurredAt })
          .from(EV)
          .where(eq(EV.reopeningCaseId, id))
          .orderBy(asc(EV.occurredAt));
        return {
          ...summary(row),
          filingConfirmationRef: row.filingConfirmationRef,
          events: events.map((e) => ({ ...e, occurredAt: iso(e.occurredAt) ?? "" })),
        };
      });
    },

    async setDue(actor, id, dueAt, ifMatch) {
      const due = dueAt === null ? null : new Date(dueAt);
      if (due !== null && Number.isNaN(due.getTime())) {
        throw new WardenXError("INVALID_DUE_DATE", "the deadline is not a real date and time", 422);
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        if (cur.state !== "draft" && cur.state !== "submitted") {
          throw new WardenXError(
            "INVALID_STATE",
            `a deadline cannot be changed on a ${cur.state} reopening`,
            409,
          );
        }
        const updated = await tx
          .update(RC)
          .set({ dueAt: due, version: sql`${RC.version} + 1` })
          .where(and(eq(RC.id, id), eq(RC.version, ifMatch), eq(RC.state, cur.state)))
          .returning({ id: RC.id, version: RC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(EV).values({
          organizationId: actor.organizationId,
          reopeningCaseId: id,
          eventKind: "due_set",
          actorMembershipId: actor.membershipId,
        });
        return updated[0];
      });
    },

    async submitReopening(actor, id, input, ifMatch) {
      const filedAt = new Date(input.filedAt);
      if (Number.isNaN(filedAt.getTime())) {
        throw new WardenXError(
          "INVALID_FILED_AT",
          "the filing time is not a real date and time",
          422,
        );
      }
      const refusal = checkReopeningFiling({
        formName: input.formName,
        channel: input.channel,
        confirmationRef: input.confirmationRef,
        filedAt,
        now: new Date(),
      });
      if (refusal) throw new WardenXError(refusal, FILING_MESSAGES[refusal], 422);
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        return advance(tx, actor, cur, "submitted", ifMatch, {
          formName: input.formName.trim(),
          filingChannel: input.channel,
          filingConfirmationRef: input.confirmationRef.trim(),
          filedAt,
        });
      });
    },

    async decideReopening(actor, id, outcome, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        return advance(
          tx,
          actor,
          cur,
          "decided",
          ifMatch,
          { outcome, decidedAt: new Date() },
          { outcome },
        );
      });
    },

    async withdrawReopening(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        return advance(tx, actor, cur, "withdrawn", ifMatch, {});
      });
    },

    async closeReopening(actor, id, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        return advance(tx, actor, cur, "closed", ifMatch, { closedAt: new Date() });
      });
    },
  };
}
