// apps/backend/src/bootstrap/routes/ops-outbox.ts — M1 operator outbox visibility (WX-PR-020,
// OPS-004). `outbox_event` is HELPER_ONLY (architecture/module-manifest.ts) — only the dispatcher's
// own home (this codePath, apps/backend/src/bootstrap) may query it directly, so this route lives
// beside outbox-dispatcher.ts rather than in a feature module.
//
// Read-only: the dispatcher already retries `pending`/`failed` rows on its own backoff clock
// (outbox-dispatcher.ts's documented retry semantics) — an operator does not need a manual "retry
// now" button for correctness, only visibility into what's stuck and why, which is what "the DLQ
// terminal ... a dead letter is evidence" (the dispatcher's own doc comment) is for.
//
// Org-scoped like every other authenticated read (withOrgContextFromRequest, RLS-enforced) — this is
// NOT a cross-tenant platform view. Gated on `member.manage` (the same admin-only bar Staff
// Management uses) as a pragmatic reuse rather than minting a new `ops.*` permission category for a
// first, single-screen ops surface; revisit if/when more ops screens land (WX-PR-020's remaining
// scope — job/queue visibility, tracing — noted as deferred in the backlog).
import { requirePermission } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContextFromRequest } from "@chartwarden/tenancy";
import { NotFoundError, ValidationError } from "@chartwarden/types";
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const OUTBOX = schema.outboxEvents;
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const READ = requirePermission("member.manage") as PreHandler;

const OUTBOX_STATUSES = ["pending", "dispatching", "dispatched", "failed"] as const;
type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

function isOutboxStatus(v: unknown): v is OutboxStatus {
  return typeof v === "string" && (OUTBOX_STATUSES as readonly string[]).includes(v);
}

interface OutboxRowSummary {
  id: string;
  eventType: string;
  aggregateKind: string;
  aggregateId: string;
  status: OutboxStatus;
  attemptCount: number;
  createdAt: string;
  dispatchedAt: string | null;
  nextAttemptAt: string | null;
}

/** What an operator reads in place of a decision's free text and codes. */
const PART2_WITHHELD = "[withheld: 42 CFR Part 2]";

/** The structural keys of a care-plan or discipline-plan decision mutation an operator may still read. */
const MUTATION_KEEP_KEYS: ReadonlySet<string> = new Set([
  "op",
  "kind",
  "problemId",
  "goalId",
  "interventionId",
  "parentProblemId",
  "parentGoalId",
  "goalRefs",
  "problemKind",
  "source",
  "status",
  "sudRelated",
  "discipline",
  "event",
]);

const withheldMutation = (mutation: unknown): unknown => {
  if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation)) return mutation;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mutation as Record<string, unknown>)) {
    if (MUTATION_KEEP_KEYS.has(key)) out[key] = value;
    else if (key === "updates" && value !== null && typeof value === "object") {
      // A problem/goal update keeps its status change; every other field is the decision's own text.
      const status = (value as Record<string, unknown>).status;
      out[key] = status === undefined ? PART2_WITHHELD : { status, other: PART2_WITHHELD };
    } else out[key] = PART2_WITHHELD;
  }
  return out;
};

/**
 * The stored payload as an operator may read it. An `idg.decision_recorded` plan decision carries the decision's
 * own clinical text (a problem's description and codes, a goal's wording, an intervention's scope, a resolution
 * note) so M7 and M15 can apply it, and the ops detail read has no disclosure verdict for the patient. The row
 * stays whole (the consumers need it); this read keeps the structure (operation, ids, enums, the Part 2 flag)
 * and withholds every other field of every mutation, so an operator can see which decision is stuck and where
 * but never what it says (audit D-11). Every other event type is returned as stored
 * (`m15.plan.version_signed` is already redacted at emit, audit D-13).
 */
export function payloadForOps(eventType: string, payload: unknown): unknown {
  if (eventType !== "idg.decision_recorded") return payload;
  const decision = (
    payload as { payload?: Record<string, unknown> & { mutations?: unknown } } | null
  )?.payload;
  if (!decision || typeof decision !== "object") return payload;
  if (!Array.isArray(decision.mutations)) {
    return { ...(payload as object), payload: withheldDecisionFields(decision) };
  }
  return {
    ...(payload as object),
    payload: {
      ...withheldDecisionFields(decision),
      mutations: decision.mutations.map(withheldMutation),
    },
  };
}

/** A decision's own fields other than its kind (a team note's text, a referral's narrative, ...) are clinical text. */
const DECISION_KEEP_KEYS: ReadonlySet<string> = new Set(["kind", "planKind"]);

function withheldDecisionFields(decision: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decision)) {
    out[key] = DECISION_KEEP_KEYS.has(key) || key === "mutations" ? value : PART2_WITHHELD;
  }
  return out;
}

export function registerOpsOutboxRoutes(app: FastifyInstance, deps: { db?: DbClient }): void {
  app.get(
    "/api/v1/ops/outbox",
    { preHandler: [READ], config: { auditRead: { resourceKind: "outbox_event", list: true } } },
    async (request: FastifyRequest, reply) => {
      const q = request.query as { status?: string; before?: string; limit?: string };
      if (q.status !== undefined && !isOutboxStatus(q.status)) {
        throw new ValidationError("invalid status filter", [
          {
            field: "status",
            code: "INVALID",
            message: `must be one of ${OUTBOX_STATUSES.join(", ")}`,
          },
        ]);
      }
      if (!deps.db) return reply.send({ data: [], nextCursor: null });
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
      const db = deps.db;
      const rows = await withOrgContextFromRequest(db, async (tx) => {
        const conds = [
          q.status ? eq(OUTBOX.status, q.status as OutboxStatus) : undefined,
          q.before ? lt(OUTBOX.createdAt, new Date(q.before)) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        return tx
          .select({
            id: OUTBOX.id,
            eventType: OUTBOX.eventType,
            aggregateKind: OUTBOX.aggregateKind,
            aggregateId: OUTBOX.aggregateId,
            status: OUTBOX.status,
            attemptCount: OUTBOX.attemptCount,
            createdAt: OUTBOX.createdAt,
            dispatchedAt: OUTBOX.dispatchedAt,
            nextAttemptAt: OUTBOX.nextAttemptAt,
          })
          .from(OUTBOX)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(OUTBOX.createdAt))
          .limit(limit);
      });
      const data: OutboxRowSummary[] = rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        aggregateKind: r.aggregateKind,
        aggregateId: r.aggregateId,
        status: r.status as OutboxStatus,
        attemptCount: r.attemptCount,
        createdAt: r.createdAt.toISOString(),
        dispatchedAt: r.dispatchedAt ? r.dispatchedAt.toISOString() : null,
        nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
      }));
      const last = data.at(-1);
      return reply.send({
        data,
        nextCursor: data.length === limit && last ? last.createdAt : null,
      });
    },
  );

  app.get(
    "/api/v1/ops/outbox/:id",
    {
      preHandler: [READ],
      // The detail returns the event's full `payload`, which can carry PHI (e.g. `m15.plan.version_signed` seals the
      // plan's goals). Without a `resourceIdParam` the emitter has nothing to account the read against, returns
      // early, and the disclosure leaves no trail.
      // The event's own `patientId` (most plan, decision and document events carry one) attributes the read to
      // the patient, so a §164.528 accounting by patient shows an operator opening that row.
      config: {
        auditRead: {
          resourceKind: "outbox_event",
          resourceIdParam: "id",
          patientIdPayloadPath: "payload.patientId",
        },
      },
    },
    async (request: FastifyRequest, reply) => {
      if (!deps.db) throw new NotFoundError("outbox event");
      const { id } = request.params as { id: string };
      const db = deps.db;
      const row = await withOrgContextFromRequest(db, async (tx) => {
        const found = await tx.select().from(OUTBOX).where(eq(OUTBOX.id, id)).limit(1);
        return found[0] ?? null;
      });
      if (!row) throw new NotFoundError("outbox event");
      return reply.send({
        id: row.id,
        eventType: row.eventType,
        aggregateKind: row.aggregateKind,
        aggregateId: row.aggregateId,
        status: row.status,
        attemptCount: row.attemptCount,
        lastError: row.lastError,
        payload: payloadForOps(row.eventType, row.payload),
        createdAt: row.createdAt.toISOString(),
        dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null,
        nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
      });
    },
  );
}
