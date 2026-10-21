// apps/backend/src/modules/25-remittance/routes/adr-service.ts — the M25 ADR service (hospice ADR/TPE/QIC PRD
// milestone 2a): log an additional documentation request, read the worklist and one case, move it through
// assembly and review, and maintain the organization's MAC response-window rules. Every command runs under
// `withOrgContext` (RLS). The due date is derived by the pure `deriveAdrDeadline` from the MAC rule in force
// (the organization's, else the platform default marked unverified) and the provider's zones, and the case
// RECORDS which window and source it used so a later rule edit never silently moves an existing due date.
// 2a deliberately has no `submitted` transition: filing needs the reviewed packet, sign-off and proof of
// submission that milestone 2b adds. There are no outbox events yet (nothing consumes them); the adr_case
// write-audit trigger and the adr_case_event history are the trail.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  type AdrReviewType,
  type AdrState,
  DEFAULT_DEADLINE_ZONE,
  canTransitionAdr,
  deriveAdrDeadline,
  isKnownZone,
  noticeDayOf,
  resolveAdrWindow,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import {
  type AdrPacketOps,
  type AdrPacketPorts,
  type AdrPacketView,
  buildAdrPacketOps,
  loadAdrPacketView,
} from "./adr-packet-service";
import { VersionConflictError } from "./concurrency";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface AdrCreateInput {
  readonly claimId: string;
  readonly macName: string;
  readonly reviewType: AdrReviewType;
  /** The date the MAC's rule anchors the response window on (YYYY-MM-DD), taken from the ADR letter. */
  readonly requestedOn: string;
  readonly adrReference?: string;
  readonly denialCaseId?: string;
}

export interface MacRuleInput {
  readonly macName: string;
  readonly reviewType: AdrReviewType;
  readonly responseDays: number;
  readonly sourceNote?: string;
  readonly verifiedOn?: string;
  readonly effectiveFrom?: string;
}

/** States a person may move an ADR to in 2a (not `submitted`: see the file header). */
export type AdrManualTarget = Exclude<AdrState, "received" | "submitted" | "closed">;

export interface AdrSummary {
  readonly id: string;
  readonly claimId: string;
  readonly denialCaseId: string | null;
  readonly macName: string;
  readonly reviewType: string;
  readonly state: string;
  readonly adrReference: string | null;
  readonly requestedOn: string;
  readonly windowDays: number;
  readonly windowSource: string;
  readonly windowVerified: boolean;
  readonly responseDueAt: string;
  /** The due day as the provider's calendar prints it (the instant above formats a day early west of UTC). */
  readonly dueDay: string;
  readonly version: number;
}

export interface AdrDetail extends AdrSummary {
  readonly packet: AdrPacketView;
  readonly calendarDueDay: string;
  readonly events: { id: string; eventKind: string; occurredAt: string }[];
}

export interface MacRuleView {
  readonly id: string;
  readonly macName: string;
  readonly reviewType: string;
  readonly responseDays: number;
  readonly sourceNote: string | null;
  readonly verifiedOn: string | null;
  readonly effectiveFrom: string;
  readonly version: number;
}

export interface AdrService extends AdrPacketOps {
  createAdr(actor: M25WriteActor, input: AdrCreateInput): Promise<{ id: string; version: number }>;
  listAdrs(
    actor: M25ReadActor,
    filter: { state?: string },
    limit: number,
  ): Promise<{ items: AdrSummary[] }>;
  getAdr(actor: M25ReadActor, id: string): Promise<AdrDetail | null>;
  transitionAdr(
    actor: M25WriteActor,
    id: string,
    to: AdrManualTarget,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  listMacRules(actor: M25ReadActor): Promise<{ items: MacRuleView[] }>;
  upsertMacRule(
    actor: M25WriteActor,
    input: MacRuleInput,
  ): Promise<{ id: string; version: number }>;
}

export interface AdrServicePorts extends AdrPacketPorts {
  readonly claims?: ClaimFactsPort;
  /** The timezones of a provider entity's locations (M1's published reader); absent -> the default zone. */
  readonly providerZones?: (tx: DbClient, providerEntityId: string) => Promise<readonly string[]>;
}

/** True when `day` is a real YYYY-MM-DD calendar date (the schema only checks the shape). */
const isRealDay = (day: string): boolean => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

export function buildDrizzleAdrService(db: DbClient, ports: AdrServicePorts = {}): AdrService {
  const claims = ports.claims ?? m23ClaimFactsPort;
  const ADR = schema.adrCase;
  const EV = schema.adrCaseEvent;
  const MR = schema.macRule;

  const summary = (r: typeof ADR.$inferSelect): AdrSummary => ({
    id: r.id,
    claimId: r.claimId,
    denialCaseId: r.denialCaseId,
    macName: r.macName,
    reviewType: r.reviewType,
    state: r.state,
    adrReference: r.adrReference,
    requestedOn: r.requestedOn,
    windowDays: r.windowDays,
    windowSource: r.windowSource,
    windowVerified: r.windowVerified,
    responseDueAt: iso(r.responseDueAt),
    dueDay: deriveAdrDeadline(r.requestedOn, r.windowDays).dueDay,
    version: r.version,
  });

  async function zonesFor(tx: Tx, providerEntityId: string): Promise<readonly string[]> {
    const zones = (
      ports.providerZones
        ? await ports.providerZones(tx as unknown as DbClient, providerEntityId)
        : []
    ).filter(isKnownZone);
    return zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  }

  /** Rules in force today, newest first per (MAC, review type), so `resolveAdrWindow` finds the current one. */
  async function rulesInForce(tx: Tx) {
    const rows = await tx
      .select()
      .from(MR)
      .where(lte(MR.effectiveFrom, noticeDayOf(new Date())))
      .orderBy(desc(MR.effectiveFrom));
    return rows.map((r) => ({
      macName: r.macName,
      reviewType: r.reviewType,
      responseDays: r.responseDays,
      verifiedOn: r.verifiedOn,
      sourceNote: r.sourceNote,
      effectiveFrom: r.effectiveFrom,
    }));
  }

  return {
    ...buildAdrPacketOps(db, ports),
    async createAdr(actor, input) {
      const macName = input.macName.trim();
      if (!macName) throw new ChartWardenError("INVALID_MAC", "the MAC name is required", 422);
      if (!isRealDay(input.requestedOn)) {
        throw new ChartWardenError(
          "INVALID_REQUEST_DATE",
          "the ADR request date is not a real date",
          422,
        );
      }
      if (input.requestedOn > noticeDayOf(new Date())) {
        throw new ChartWardenError(
          "REQUEST_DATE_IN_FUTURE",
          "the ADR request date cannot be in the future",
          422,
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const claim = await claims.byId(tx, input.claimId);
        const scope = actor.providerEntityScope;
        if (!claim || (scope !== undefined && !scope.includes(claim.providerEntityId))) {
          throw new NotFoundError("claim");
        }
        // A linked denial must be visible to THIS org under RLS (a foreign key alone ignores RLS, so another
        // tenant's id would otherwise be accepted), be on the same claim, and be inside the actor's scope.
        if (input.denialCaseId) {
          const DC = schema.denialCase;
          const denial = await tx
            .select({ claimId: DC.claimId, providerEntityId: DC.providerEntityId })
            .from(DC)
            .where(eq(DC.id, input.denialCaseId))
            .limit(1);
          if (
            !denial[0] ||
            denial[0].claimId !== claim.id ||
            (scope !== undefined && !scope.includes(denial[0].providerEntityId))
          ) {
            throw new NotFoundError("denial case");
          }
        }
        const window = resolveAdrWindow(await rulesInForce(tx), macName, input.reviewType);
        const derived = deriveAdrDeadline(
          input.requestedOn,
          window.days,
          await zonesFor(tx, claim.providerEntityId),
        );
        const inserted = await tx
          .insert(ADR)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: claim.providerEntityId,
            claimId: claim.id,
            denialCaseId: input.denialCaseId ?? null,
            macName,
            reviewType: input.reviewType,
            adrReference: input.adrReference?.trim() || null,
            requestedOn: input.requestedOn,
            windowDays: window.days,
            windowSource: window.source,
            windowVerified: window.verified,
            responseDueAt: derived.dueAt,
          })
          .returning({ id: ADR.id, version: ADR.version });
        await tx.insert(EV).values({
          organizationId: actor.organizationId,
          adrCaseId: inserted[0]!.id,
          eventKind: "received",
          actorMembershipId: actor.membershipId,
        });
        return inserted[0]!;
      });
    },

    async listAdrs(actor, filter, limit) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          providerEntityScopeCondition(ADR.providerEntityId, actor.providerEntityScope),
          filter.state ? eq(ADR.state, filter.state) : undefined,
        ].filter((c) => c !== undefined);
        const rows = await tx
          .select()
          .from(ADR)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(asc(ADR.responseDueAt), asc(ADR.id))
          .limit(limit);
        return { items: rows.map(summary) };
      });
    },

    async getAdr(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(ADR.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(ADR)
          .where(scope ? and(eq(ADR.id, id), scope) : eq(ADR.id, id))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const events = await tx
          .select({ id: EV.id, eventKind: EV.eventKind, occurredAt: EV.occurredAt })
          .from(EV)
          .where(eq(EV.adrCaseId, id))
          .orderBy(asc(EV.occurredAt));
        // The derivation shown to the user is recomputed from the stored anchor and window, never re-resolved.
        const derived = deriveAdrDeadline(row.requestedOn, row.windowDays);
        return {
          ...summary(row),
          packet: await loadAdrPacketView(tx, row),
          calendarDueDay: derived.calendarDueDay,
          events: events.map((e) => ({ ...e, occurredAt: iso(e.occurredAt) })),
        };
      });
    },

    async transitionAdr(actor, id, to, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(ADR.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select({ state: ADR.state, version: ADR.version })
          .from(ADR)
          .where(scope ? and(eq(ADR.id, id), scope) : eq(ADR.id, id))
          .limit(1);
        const cur = rows[0];
        if (!cur) throw new NotFoundError("ADR case");
        if (!canTransitionAdr(cur.state as AdrState, to)) {
          throw new ChartWardenError(
            "INVALID_TRANSITION",
            `cannot transition from '${cur.state}' to '${to}'`,
            409,
          );
        }
        // Who sends a packet to review is the assembler the reviewer must differ from; any move out of review
        // (back to assembly, or away) voids a sign-off, so a returned packet is reviewed afresh.
        const reviewBookkeeping =
          to === "in_review"
            ? {
                sentToReviewByMembershipId: actor.membershipId,
                reviewedByMembershipId: null,
                reviewedAt: null,
              }
            : cur.state === "submitted"
              ? {} // a filed case's review facts are frozen by trigger
              : { reviewedByMembershipId: null, reviewedAt: null };
        const updated = await tx
          .update(ADR)
          .set({ state: to, version: cur.version + 1, ...reviewBookkeeping })
          .where(and(eq(ADR.id, id), eq(ADR.version, ifMatch)))
          .returning({ id: ADR.id, version: ADR.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(EV).values({
          organizationId: actor.organizationId,
          adrCaseId: id,
          eventKind: to,
          actorMembershipId: actor.membershipId,
        });
        return updated[0];
      });
    },

    async listMacRules(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(MR).orderBy(asc(MR.macName), desc(MR.effectiveFrom));
        return {
          items: rows.map((r) => ({
            id: r.id,
            macName: r.macName,
            reviewType: r.reviewType,
            responseDays: r.responseDays,
            sourceNote: r.sourceNote,
            verifiedOn: r.verifiedOn,
            effectiveFrom: r.effectiveFrom,
            version: r.version,
          })),
        };
      });
    },

    async upsertMacRule(actor, input) {
      const macName = input.macName.trim();
      if (!macName) throw new ChartWardenError("INVALID_MAC", "the MAC name is required", 422);
      if (
        !Number.isInteger(input.responseDays) ||
        input.responseDays < 1 ||
        input.responseDays > 365
      ) {
        throw new ChartWardenError(
          "INVALID_WINDOW",
          "the response window must be 1 to 365 whole days",
          422,
        );
      }
      for (const day of [input.verifiedOn, input.effectiveFrom]) {
        if (day !== undefined && !isRealDay(day)) {
          throw new ChartWardenError("INVALID_RULE_DATE", "a rule date is not a real date", 422);
        }
      }
      return withOrgContext(db, actor, async (tx) => {
        const effectiveFrom = input.effectiveFrom ?? noticeDayOf(new Date());
        const fields = {
          responseDays: input.responseDays,
          sourceNote: input.sourceNote?.trim() || null,
          verifiedOn: input.verifiedOn ?? null,
        };
        // MAC names match case-insensitively, so "cgs" edits the "CGS" rule instead of adding a second one.
        const existing = await tx
          .select({ id: MR.id })
          .from(MR)
          .where(
            and(
              sql`lower(btrim(${MR.macName})) = ${macName.toLowerCase()}`,
              eq(MR.reviewType, input.reviewType),
              eq(MR.effectiveFrom, effectiveFrom),
            ),
          )
          .limit(1);
        if (existing[0]) {
          const updated = await tx
            .update(MR)
            .set({ ...fields, version: sql`${MR.version} + 1` })
            .where(eq(MR.id, existing[0].id))
            .returning({ id: MR.id, version: MR.version });
          return updated[0]!;
        }
        const inserted = await tx
          .insert(MR)
          .values({
            organizationId: actor.organizationId,
            macName,
            reviewType: input.reviewType,
            effectiveFrom,
            ...fields,
          })
          .returning({ id: MR.id, version: MR.version });
        return inserted[0]!;
      });
    },
  };
}
