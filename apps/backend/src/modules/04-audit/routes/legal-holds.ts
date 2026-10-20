// apps/backend/src/modules/04-audit/routes/legal-holds.ts — GAP-003 the §7 legal-hold surface
// (M4 spec §4.2-4.3, §10.6, M04-F03).
//
// `legal_hold` is M4-OWNED (not HELPER_ONLY, architecture/module-manifest.ts) so this file talks to
// the table directly over Drizzle + `withOrgContext`, unlike `audit_event` itself. What a hold
// PHYSICALLY does: `wardenx_app` holds no UPDATE/DELETE on `audit_event` (migration 0001's
// append-only guarantee) — a hold does not, and cannot, flip a column on every matching row. It
// works the same way the eraser already does (`createDrizzleAuditEraserPorts.legalHoldFor`,
// erasers/audit-eraser.ts): the hold's `criteria` is checked AT THE POINT a destruction/erasure
// would touch a row, not baked into `audit_event` up front. `matchedRecordCount`/`restoredRecordCount`
// below are therefore a REAL, live count of currently-matching `audit_event` rows (via the same
// RLS-scoped `AuditQuery` the read routes use) — bounded (`MATCH_SCAN_CAP`) so a hold with a broad
// criteria can never trigger an unbounded partition scan from a single request.
import {
  type AuditContext,
  type AuditQuery,
  MAX_PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  isMessagingOnlyCriteria,
  resolveLimit,
} from "@wardenx/audit";
import { requirePermission, requireStepUp } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type GovernanceOverlayCounter,
  type M4OutboxPort,
  applyLegalHoldInTx,
  hasSelector,
  releaseLegalHoldInTx,
  restoredCountForM4Route,
} from "../messaging-hold-workflow";
import {
  type CreateLegalHoldBody,
  CreateLegalHoldBodySchema,
  type LegalHoldCriteria,
  LegalHoldIdParamsSchema,
  type LegalHoldListQuery,
  LegalHoldListQuerySchema,
  ReleaseLegalHoldBodySchema,
  parse,
} from "./audit-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type { M4OutboxEmission, M4OutboxPort } from "../messaging-hold-workflow";

/** The injection surface for the legal-holds routes. */
export interface LegalHoldsRouteDeps {
  readonly db: DbClient;
  /** The same RLS-scoped `AuditQuery` `mountAuditRoutes` already builds — reused for match counts. */
  readonly query: AuditQuery;
  readonly outbox?: M4OutboxPort;
  /** M36's overlay counter for a governance-origin hold released through M4's own route (see `restoredCountForM4Route`). */
  readonly countGovernanceOverlay?: GovernanceOverlayCounter;
}

const HOLD = schema.legalHolds;

/** The org-scoped actor (org binding is server-side: the context, never the query/body). */
function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/** Build the audit context for the compliance-lifecycle event from the request. */
function auditContextFor(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    actorRole: ctx.roles[0],
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

const legalHoldRead = requirePermission("legalhold.read") as PreHandler;
const legalHoldManage = requirePermission("legalhold.manage") as PreHandler;
// A hold freezes retention and its release unfreezes destruction, so both need a fresh step-up (WP 5.6, ADR-0086
// (proposed)): the M36 messaging routes already do, and M4's own create/release must not be the bypass.
const legalHoldStepUp = requireStepUp("legalhold.manage") as PreHandler;

/** Bounded scan cap (§ real-count honesty): a hold's match count is a REAL query result, never an
 *  estimate, but an org-wide criteria with no patient filter must not turn one request into an
 *  unbounded partition scan. 2000 comfortably covers the realistic single-hold case; a hold that
 *  legitimately matches more still returns an accurate count up to the cap (over-reporting "at
 *  least the cap" is never a compliance risk the way under-reporting would be — the caller sees a
 *  real, if capped, number, not a synthetic one). */
const MATCH_SCAN_CAP = 2000;

type EventRow = { resourceKind: string };

function matchesResourceKinds(
  row: EventRow,
  resourceKinds: readonly string[] | undefined,
): boolean {
  return !resourceKinds || resourceKinds.length === 0 || resourceKinds.includes(row.resourceKind);
}

/** Real, RLS-scoped count of `audit_event` rows currently matching `criteria` (bounded, see above). */
async function countMatchingEvents(
  query: AuditQuery,
  orgId: string,
  criteria: LegalHoldCriteria,
): Promise<number> {
  // A messaging-only hold (ADR-0086 (proposed)) names no audit_event row; counting "everything in the date range"
  // would report the whole audit log as held.
  if (isMessagingOnlyCriteria(criteria)) return 0;
  const from = criteria.dateRange?.from;
  const to = criteria.dateRange?.to;

  const scanOne = async (patientId: string | undefined, remaining: number): Promise<number> => {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await query.searchEvents(orgId, {
        ...(patientId !== undefined ? { patientId } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: MAX_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      count += page.items.filter((r) => matchesResourceKinds(r, criteria.resourceKinds)).length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor && count < remaining);
    return count;
  };

  if (criteria.patientIds && criteria.patientIds.length > 0) {
    let total = 0;
    for (const patientId of criteria.patientIds) {
      if (total >= MATCH_SCAN_CAP) break;
      total += await scanOne(patientId, MATCH_SCAN_CAP - total);
    }
    return Math.min(total, MATCH_SCAN_CAP);
  }
  return Math.min(await scanOne(undefined, MATCH_SCAN_CAP), MATCH_SCAN_CAP);
}

function toLegalHoldView(row: typeof HOLD.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    criteria: row.criteria as LegalHoldCriteria,
    status: row.status,
    reason: row.reason,
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt.toISOString(),
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
  };
}

/**
 * Mount the §4.2 legal-hold routes: list, apply, release. Behind `legalhold.read`/`legalhold.manage`
 * (M4 spec §4.5); the compliance-lifecycle event is audited at `compliance` retention (§7) and, when
 * an outbox port is bound, `m4.legal_hold.applied`/`released` notifies the owning-module `HoldApplier`
 * seams (M04-F03) — a follow-up: no module has registered one yet, so today the notification is
 * catalog-validated and persisted but has no subscriber.
 */
export function registerLegalHoldsRoutes(app: FastifyInstance, deps: LegalHoldsRouteDeps): void {
  app.get("/api/v1/legal-holds", { preHandler: [legalHoldRead] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const q = parse(LegalHoldListQuerySchema, request.query) as LegalHoldListQuery;
    return withOrgContext(deps.db, { organizationId, userId }, async (tx) => {
      const limit = resolveLimit(q.limit);
      const where = [eq(HOLD.organizationId, organizationId)];
      if (q.status) where.push(eq(HOLD.status, q.status));
      const cur = q.cursor ? decodeCursor(q.cursor) : null;
      if (cur) {
        where.push(
          sql`(${HOLD.appliedAt}, ${HOLD.id}) < (${cur.createdAt}::timestamptz, ${cur.id})`,
        );
      }
      const rows = await tx
        .select()
        .from(HOLD)
        .where(and(...where))
        .orderBy(desc(HOLD.appliedAt), desc(HOLD.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({ createdAt: last.appliedAt.toISOString(), id: last.id })
          : null;
      return { items: page.map(toLegalHoldView), nextCursor };
    });
  });

  app.post(
    "/api/v1/legal-holds",
    { preHandler: [legalHoldManage, legalHoldStepUp] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const parsed = parse(CreateLegalHoldBodySchema, request.body) as CreateLegalHoldBody;
      // `origin` is the governance provenance marker: only M36's apply route may stamp it, never a request body.
      const { origin: _origin, ...bodyCriteria } = parsed.criteria;
      const body = { ...parsed, criteria: bodyCriteria };
      if (!hasSelector(body.criteria)) {
        throw new WardenXError(
          "EMPTY_CRITERIA",
          "legal hold criteria must specify at least one of patientIds, dateRange, resourceKinds, channelIds, or userIds",
          422,
        );
      }
      const matchedRecordCount = await countMatchingEvents(
        deps.query,
        organizationId,
        body.criteria,
      );
      // Explicit `Tx = DbClient` (the M30/M34 `withOrgContext<DbClient, T>` precedent,
      // apps/backend/src/bootstrap/outbox-persister.ts's `OutboxTx` comment) so `tx` is directly
      // assignable to both `AuditExecutor` and the outbox port's `tx: DbClient` — no cast needed.
      const result = await withOrgContext<DbClient, typeof HOLD.$inferSelect>(
        deps.db,
        { organizationId, userId },
        (tx) =>
          applyLegalHoldInTx(tx, deps, auditContextFor(request), {
            organizationId,
            userId,
            name: body.name,
            criteria: body.criteria,
            reason: body.reason,
            matchedRecordCount,
          }),
      );
      reply.code(201);
      return { legalHoldId: result.id, matchedRecordCount };
    },
  );

  app.post(
    "/api/v1/legal-holds/:id/release",
    { preHandler: [legalHoldManage, legalHoldStepUp] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LegalHoldIdParamsSchema, request.params);
      const body = parse(ReleaseLegalHoldBodySchema, request.body);
      return withOrgContext<DbClient, { released: true; restoredRecordCount: number }>(
        deps.db,
        { organizationId, userId },
        (tx) =>
          releaseLegalHoldInTx(tx, deps, auditContextFor(request), {
            organizationId,
            holdId: id,
            reason: body.reason,
            countRestored: (criteria) =>
              restoredCountForM4Route(
                tx,
                organizationId,
                id,
                criteria,
                (c) => countMatchingEvents(deps.query, organizationId, c),
                deps.countGovernanceOverlay,
              ),
          }),
      );
    },
  );
}
