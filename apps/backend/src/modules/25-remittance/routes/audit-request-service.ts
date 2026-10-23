// apps/backend/src/modules/25-remittance/routes/audit-request-service.ts - M25 milestone 7a-1: audit request intake. A
// RAC / UPIC / SMRC (or other) request for records is logged for one or many claims, assembled and moved through its
// states by a person. NO CLOCK IS COMPUTED: the due date is a recorded deadline typed from the request letter
// (later-tier-service.ts), so a request with none reads `no_deadline_recorded`, never a default. Nothing is sent from
// here (the response packet and its filing proof are milestone 7a-2). Every command runs under `withOrgContext` (RLS)
// inside the actor's provider-entity scope; every request-level change is If-Match so two people cannot overwrite each
// other. A linked ADR / denial / claim must be visible to THIS org (a foreign key alone ignores RLS) and inside the
// actor's scope, else it is a 404. The audit_request write-audit trigger and audit_request_event are the trail.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AuditCreateRefusal,
  type AuditDueState,
  type AuditState,
  auditDueState,
  canTransitionAudit,
  checkAuditCreate,
  isAuditTerminal,
  noticeDayOf,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import type { AppealSourcePorts } from "./appeal-packet-sources";
import { patientOfClaim } from "./claim-patient";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import {
  type RecordedDeadlineView,
  earliestOpenDueAt,
  viewRecordedDeadline,
} from "./recorded-deadline-view";
import { type ClaimFactsPort, m23ClaimFactsPort } from "./remittance-ports";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface AuditCreateInput {
  readonly authorityKind: string;
  readonly authorityName?: string | null;
  readonly requestReference?: string | null;
  readonly requestDatedOn?: string | null;
  readonly receivedOn: string;
  readonly scopeNote?: string | null;
  /** Required only when no claim is given (otherwise taken from the claims). */
  readonly providerEntityId?: string;
  readonly claimIds?: readonly string[];
  readonly adrCaseId?: string | null;
  readonly denialCaseId?: string | null;
}

export interface AuditPatchInput {
  readonly authorityName?: string | null;
  readonly requestReference?: string | null;
  readonly requestDatedOn?: string | null;
  readonly scopeNote?: string | null;
  readonly adrCaseId?: string | null;
  readonly denialCaseId?: string | null;
}

export type AuditMoveTarget = "in_assembly" | "in_review" | "responded" | "closed" | "withdrawn";

export interface AuditSummary {
  readonly id: string;
  readonly authorityKind: string;
  readonly authorityName: string | null;
  readonly requestReference: string | null;
  readonly receivedOn: string;
  readonly state: string;
  readonly claimCount: number;
  readonly dueState: AuditDueState;
  /** The earliest open recorded deadline (ISO instant), or null. */
  readonly nextDueAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface AuditClaimView {
  readonly id: string;
  readonly claimId: string;
  readonly dateOfServiceNote: string | null;
  /** For display; null when the claim cannot be read or beyond the first AUDIT_CLAIM_LABEL_CAP claims. */
  readonly claimControlNumber: string | null;
}

export interface AuditDetail extends AuditSummary {
  /** The patient when the request covers exactly one claim; null for none or many (no single patient). */
  readonly patientId: string | null;
  readonly requestDatedOn: string | null;
  readonly scopeNote: string | null;
  readonly providerEntityId: string;
  readonly adrCaseId: string | null;
  readonly denialCaseId: string | null;
  readonly respondedAt: string | null;
  readonly closedAt: string | null;
  readonly claims: AuditClaimView[];
  readonly deadlines: RecordedDeadlineView[];
  readonly events: { id: string; eventKind: string; occurredAt: string }[];
}

export interface AuditRequestService {
  createAuditRequest(
    actor: M25WriteActor,
    input: AuditCreateInput,
  ): Promise<{ id: string; version: number }>;
  listAuditRequests(
    actor: M25ReadActor,
    filter: { state?: string },
    limit: number,
  ): Promise<{ items: AuditSummary[] }>;
  getAuditRequest(actor: M25ReadActor, id: string): Promise<AuditDetail | null>;
  updateAuditRequest(
    actor: M25WriteActor,
    id: string,
    patch: AuditPatchInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  /** Both claim edits are If-Match on the request and bump its version, so concurrent claim-set edits are detected. */
  addClaim(
    actor: M25WriteActor,
    id: string,
    input: { claimId: string; dateOfServiceNote?: string | null },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  removeClaim(
    actor: M25WriteActor,
    id: string,
    claimId: string,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  moveAuditRequest(
    actor: M25WriteActor,
    id: string,
    to: AuditMoveTarget,
    input: { respondedAt?: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface AuditRequestPorts {
  readonly claims?: ClaimFactsPort;
  /** M23 claim copy seam: names the single patient of a one-claim request for the read audit. */
  readonly sources?: AppealSourcePorts;
  /** True when the provider entity exists for the org (used only when a request names no claim). */
  readonly providerEntityExists?: (
    tx: DbClient,
    organizationId: string,
    providerEntityId: string,
  ) => Promise<boolean>;
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : String(d);

/** Claims whose control number a detail read resolves (one in-transaction lookup each). */
const AUDIT_CLAIM_LABEL_CAP = 50;

const MAX_LIST = 100;

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);

const CREATE_MESSAGES: Readonly<Record<AuditCreateRefusal, string>> = {
  AUTHORITY_KIND_INVALID: "the authority must be rac, upic, smrc or other",
  AUTHORITY_NAME_REQUIRED: "name the authority when it is 'other'",
  DATE_INVALID: "a date is not a real calendar date",
  RECEIVED_IN_FUTURE: "the received date cannot be in the future",
  DATED_AFTER_RECEIVED: "the request letter cannot be dated after it was received",
};

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function buildDrizzleAuditRequestService(
  db: DbClient,
  ports: AuditRequestPorts = {},
): AuditRequestService {
  const claims = ports.claims ?? m23ClaimFactsPort;
  const AR = schema.auditRequest;
  const ARC = schema.auditRequestClaim;
  const EV = schema.auditRequestEvent;
  const RD = schema.recordedDeadline;

  async function load(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(AR.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(AR)
      .where(scope ? and(eq(AR.id, id), scope) : eq(AR.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("audit request");
    return rows[0];
  }

  /** A withdrawn or closed request takes no change: a typed 409, not the trigger's raw error. */
  function assertOpen(cur: typeof AR.$inferSelect): void {
    if (isAuditTerminal(cur.state as AuditState)) {
      throw new ChartWardenError("AUDIT_FROZEN", `the audit request is ${cur.state}`, 409);
    }
  }

  /** Bump the request's version under If-Match; a stale caller loses with a 409 and the whole edit rolls back. */
  async function bumpVersion(
    tx: Tx,
    cur: typeof AR.$inferSelect,
    ifMatch: number,
  ): Promise<{ id: string; version: number }> {
    const bumped = await tx
      .update(AR)
      .set({ version: sql`${AR.version} + 1`, updatedAt: new Date() })
      .where(and(eq(AR.id, cur.id), eq(AR.version, ifMatch)))
      .returning({ id: AR.id, version: AR.version });
    if (!bumped[0]) throw new VersionConflictError(cur.version);
    return bumped[0];
  }

  const inScope = (actor: M25ReadActor, providerEntityId: string): boolean =>
    actor.providerEntityScope === undefined || actor.providerEntityScope.includes(providerEntityId);

  /** An ADR / denial link must be visible to this org, inside the actor's scope (else 404). */
  async function checkLinks(
    tx: Tx,
    actor: M25ReadActor,
    links: { adrCaseId?: string | null; denialCaseId?: string | null },
  ): Promise<void> {
    if (links.adrCaseId) {
      const A = schema.adrCase;
      const r = await tx
        .select({ pe: A.providerEntityId })
        .from(A)
        .where(eq(A.id, links.adrCaseId))
        .limit(1);
      if (!r[0] || !inScope(actor, r[0].pe)) throw new NotFoundError("ADR case");
    }
    if (links.denialCaseId) {
      const D = schema.denialCase;
      const r = await tx
        .select({ pe: D.providerEntityId })
        .from(D)
        .where(eq(D.id, links.denialCaseId))
        .limit(1);
      if (!r[0] || !inScope(actor, r[0].pe)) throw new NotFoundError("denial case");
    }
  }

  async function visibleClaim(tx: Tx, actor: M25ReadActor, claimId: string) {
    const claim = await claims.byId(tx, claimId);
    if (!claim || !inScope(actor, claim.providerEntityId)) throw new NotFoundError("claim");
    return claim;
  }

  async function event(
    tx: Tx,
    actor: M25WriteActor,
    auditRequestId: string,
    eventKind: string,
    eventPayload?: Record<string, unknown>,
  ) {
    await tx.insert(EV).values({
      organizationId: actor.organizationId,
      auditRequestId,
      eventKind,
      eventPayload: eventPayload ?? null,
      actorMembershipId: actor.membershipId,
    });
  }

  async function summaries(
    tx: Tx,
    rows: readonly (typeof AR.$inferSelect)[],
    now: Date,
  ): Promise<AuditSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const counts = await tx
      .select({ id: ARC.auditRequestId, n: sql<number>`count(*)::int` })
      .from(ARC)
      .where(and(inArray(ARC.auditRequestId, ids), isNull(ARC.removedAt)))
      .groupBy(ARC.auditRequestId);
    const deadlines = await tx.select().from(RD).where(inArray(RD.auditRequestId, ids));
    return rows.map((r) => {
      const nextDue = earliestOpenDueAt(deadlines.filter((d) => d.auditRequestId === r.id));
      return {
        id: r.id,
        authorityKind: r.authorityKind,
        authorityName: r.authorityName,
        requestReference: r.requestReference,
        receivedOn: r.receivedOn,
        state: r.state,
        claimCount: counts.find((c) => c.id === r.id)?.n ?? 0,
        dueState: auditDueState({ state: r.state as AuditState, nextDueAt: nextDue, now }),
        nextDueAt: nextDue ? nextDue.toISOString() : null,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  return {
    async createAuditRequest(actor, input) {
      const today = noticeDayOf(new Date());
      const refusal = checkAuditCreate({
        authorityKind: input.authorityKind,
        authorityName: input.authorityName ?? "",
        requestDatedOn: input.requestDatedOn ?? null,
        receivedOn: input.receivedOn,
        today,
      });
      if (refusal) throw unprocessable(`AUDIT_${refusal}`, CREATE_MESSAGES[refusal]);
      const claimIds = [...new Set(input.claimIds ?? [])];
      return withOrgContext(db, actor, async (tx) => {
        await checkLinks(tx, actor, input);
        const visible = [];
        for (const claimId of claimIds) visible.push(await visibleClaim(tx, actor, claimId));
        const entities = new Set(visible.map((c) => c.providerEntityId));
        if (entities.size > 1) {
          throw unprocessable(
            "AUDIT_MIXED_PROVIDER_ENTITY",
            "an audit request covers the claims of one provider entity; log one request per entity",
          );
        }
        const providerEntityId = visible[0]?.providerEntityId ?? input.providerEntityId;
        if (!providerEntityId) {
          throw unprocessable(
            "AUDIT_PROVIDER_ENTITY_REQUIRED",
            "name the provider entity, or add a claim to take it from",
          );
        }
        if (input.providerEntityId && input.providerEntityId !== providerEntityId) {
          throw unprocessable(
            "AUDIT_MIXED_PROVIDER_ENTITY",
            "the provider entity does not match the claims",
          );
        }
        if (!inScope(actor, providerEntityId)) throw new NotFoundError("provider entity");
        if (
          visible.length === 0 &&
          ports.providerEntityExists &&
          !(await ports.providerEntityExists(
            tx as unknown as DbClient,
            actor.organizationId,
            providerEntityId,
          ))
        ) {
          throw new NotFoundError("provider entity");
        }
        const inserted = await tx
          .insert(AR)
          .values({
            organizationId: actor.organizationId,
            providerEntityId,
            authorityKind: input.authorityKind,
            authorityName: clean(input.authorityName),
            requestReference: clean(input.requestReference),
            requestDatedOn: input.requestDatedOn ?? null,
            receivedOn: input.receivedOn,
            scopeNote: clean(input.scopeNote),
            adrCaseId: input.adrCaseId ?? null,
            denialCaseId: input.denialCaseId ?? null,
            createdByMembershipId: actor.membershipId,
          })
          .returning({ id: AR.id, version: AR.version });
        const created = inserted[0]!;
        for (const c of visible) {
          await tx.insert(ARC).values({
            organizationId: actor.organizationId,
            auditRequestId: created.id,
            claimId: c.id,
            addedByMembershipId: actor.membershipId,
          });
        }
        await event(tx, actor, created.id, "received", { claimCount: visible.length });
        return created;
      });
    },

    async listAuditRequests(actor, filter, limit) {
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          providerEntityScopeCondition(AR.providerEntityId, actor.providerEntityScope),
          filter.state ? eq(AR.state, filter.state) : undefined,
        ].filter((c) => c !== undefined);
        const rows = await tx
          .select()
          .from(AR)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(AR.createdAt), asc(AR.id))
          .limit(Math.min(limit, MAX_LIST));
        return { items: await summaries(tx, rows, new Date()) };
      });
    },

    async getAuditRequest(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(AR.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(AR)
          .where(scope ? and(eq(AR.id, id), scope) : eq(AR.id, id))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        const now = new Date();
        const [base] = await summaries(tx, [row], now);
        const claimRows = await tx
          .select()
          .from(ARC)
          .where(and(eq(ARC.auditRequestId, id), isNull(ARC.removedAt)))
          .orderBy(asc(ARC.createdAt));
        const deadlineRows = await tx
          .select()
          .from(RD)
          .where(eq(RD.auditRequestId, id))
          .orderBy(asc(RD.dueOn), asc(RD.createdAt));
        const events = await tx
          .select({ id: EV.id, eventKind: EV.eventKind, occurredAt: EV.occurredAt })
          .from(EV)
          .where(eq(EV.auditRequestId, id))
          .orderBy(asc(EV.occurredAt))
          .limit(200);
        const controlNumbers = new Map<string, string>();
        for (const c of claimRows.slice(0, AUDIT_CLAIM_LABEL_CAP)) {
          const facts = await claims.byId(tx, c.claimId);
          if (facts?.claimControlNumber) controlNumbers.set(c.claimId, facts.claimControlNumber);
        }
        return {
          ...base!,
          patientId: await patientOfClaim(
            ports.sources,
            actor.organizationId,
            claimRows.length === 1 ? (claimRows[0]?.claimId ?? null) : null,
          ),
          requestDatedOn: row.requestDatedOn,
          scopeNote: row.scopeNote,
          providerEntityId: row.providerEntityId,
          adrCaseId: row.adrCaseId,
          denialCaseId: row.denialCaseId,
          respondedAt: iso(row.respondedAt),
          closedAt: iso(row.closedAt),
          claims: claimRows.map((c) => ({
            id: c.id,
            claimId: c.claimId,
            dateOfServiceNote: c.dateOfServiceNote,
            claimControlNumber: controlNumbers.get(c.claimId) ?? null,
          })),
          deadlines: deadlineRows.map((d) => viewRecordedDeadline(d, now)),
          events: events.map((e) => ({
            id: e.id,
            eventKind: e.eventKind,
            occurredAt: e.occurredAt.toISOString(),
          })),
        };
      });
    },

    async updateAuditRequest(actor, id, patch, ifMatch) {
      if (patch.requestDatedOn && !/^\d{4}-\d{2}-\d{2}$/.test(patch.requestDatedOn)) {
        throw unprocessable("AUDIT_DATE_INVALID", CREATE_MESSAGES.DATE_INVALID);
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        assertOpen(cur);
        await checkLinks(tx, actor, patch);
        const next = {
          authorityName:
            patch.authorityName === undefined ? cur.authorityName : clean(patch.authorityName),
          requestReference:
            patch.requestReference === undefined
              ? cur.requestReference
              : clean(patch.requestReference),
          requestDatedOn:
            patch.requestDatedOn === undefined ? cur.requestDatedOn : patch.requestDatedOn,
          scopeNote: patch.scopeNote === undefined ? cur.scopeNote : clean(patch.scopeNote),
          adrCaseId: patch.adrCaseId === undefined ? cur.adrCaseId : patch.adrCaseId,
          denialCaseId: patch.denialCaseId === undefined ? cur.denialCaseId : patch.denialCaseId,
        };
        if (cur.authorityKind === "other" && !next.authorityName) {
          throw unprocessable(
            "AUDIT_AUTHORITY_NAME_REQUIRED",
            CREATE_MESSAGES.AUTHORITY_NAME_REQUIRED,
          );
        }
        if (next.requestDatedOn && next.requestDatedOn > cur.receivedOn) {
          throw unprocessable("AUDIT_DATED_AFTER_RECEIVED", CREATE_MESSAGES.DATED_AFTER_RECEIVED);
        }
        const updated = await tx
          .update(AR)
          .set({ ...next, version: sql`${AR.version} + 1`, updatedAt: new Date() })
          .where(and(eq(AR.id, id), eq(AR.version, ifMatch)))
          .returning({ id: AR.id, version: AR.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await event(tx, actor, id, "updated", { fields: Object.keys(patch) });
        return updated[0];
      });
    },

    async addClaim(actor, id, input, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        assertOpen(cur);
        const claim = await visibleClaim(tx, actor, input.claimId);
        if (claim.providerEntityId !== cur.providerEntityId) {
          throw unprocessable(
            "AUDIT_MIXED_PROVIDER_ENTITY",
            "the claim belongs to another provider entity than this request",
          );
        }
        try {
          await tx.insert(ARC).values({
            organizationId: actor.organizationId,
            auditRequestId: id,
            claimId: claim.id,
            dateOfServiceNote: clean(input.dateOfServiceNote),
            addedByMembershipId: actor.membershipId,
          });
          await event(tx, actor, id, "claim_added");
          return await bumpVersion(tx, cur, ifMatch);
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new ChartWardenError(
              "AUDIT_CLAIM_EXISTS",
              "the claim is already on this request",
              409,
            );
          }
          throw e;
        }
      });
    },

    async removeClaim(actor, id, claimId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        assertOpen(cur);
        const removed = await tx
          .update(ARC)
          .set({ removedAt: new Date(), removedByMembershipId: actor.membershipId })
          .where(and(eq(ARC.auditRequestId, id), eq(ARC.claimId, claimId), isNull(ARC.removedAt)))
          .returning({ id: ARC.id });
        if (!removed[0]) throw new NotFoundError("audit request claim");
        await event(tx, actor, id, "claim_removed");
        return await bumpVersion(tx, cur, ifMatch);
      });
    },

    async moveAuditRequest(actor, id, to, input, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        if (!canTransitionAudit(cur.state as AuditState, to)) {
          throw new ChartWardenError(
            "INVALID_TRANSITION",
            `cannot transition from '${cur.state}' to '${to}'`,
            409,
          );
        }
        const now = new Date();
        let respondedAt: Date | undefined;
        if (to === "responded") {
          respondedAt = input.respondedAt ? new Date(input.respondedAt) : now;
          if (Number.isNaN(respondedAt.getTime()) || respondedAt.getTime() > now.getTime()) {
            throw unprocessable(
              "AUDIT_RESPONDED_IN_FUTURE",
              "the response time cannot be in the future",
            );
          }
        }
        const updated = await tx
          .update(AR)
          .set({
            state: to,
            version: sql`${AR.version} + 1`,
            updatedAt: now,
            ...(respondedAt ? { respondedAt } : {}),
            ...(to === "closed" || to === "withdrawn" ? { closedAt: now } : {}),
          })
          .where(and(eq(AR.id, id), eq(AR.version, ifMatch), eq(AR.state, cur.state)))
          .returning({ id: AR.id, version: AR.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await event(tx, actor, id, to);
        return updated[0];
      });
    },
  };
}
