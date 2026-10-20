// M36 WP 5.9 (ADR-0084) - the OWNED-WORK steps of an offboarding. Nothing here re-implements a rule: tasks and handoffs call the same sweeps the
// deactivation event already runs (idempotent), and acknowledgment requests move through the ADR-0078 supervisor reassign, so the state machine,
// the eligibility checks (active, can view, Part 2) and the event history stay in one place. A request nobody can take stays where it is, in the
// supervisors' unacknowledged queue, AND raises the shared supervisor attention alert (ADR-0079), once per request and version.
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { AckSupervisorReasonCode } from "@wardenx/types";
import { type SQL, and, count, eq, gte, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import {
  type SupervisorAttentionDeps,
  raiseSupervisorAttention,
} from "../ack-escalation/supervisor-attention";
import type { AckService } from "../ack-requests/ack-service";
import type { OffboardingStep } from "./offboarding-types";

const T = schema.communicationTasks;
const H = schema.clinicalHandoffs;
const R = schema.messageAckRequests;
const M = schema.messages;

/** The closest fixed reason ADR-0078 already allows: the assignee has left and cannot sign in. No new reason code, so no CHECK change. */
export const OFFBOARDING_ACK_REASON: AckSupervisorReasonCode = "assignee_unable_to_sign_in";

/** An urgent message with no tracked request is only "open" for this long (ADR-0084, PROPOSED): older ones are history, not live risk. */
export const UNTRACKED_URGENT_WINDOW_HOURS = 72;

const WAITING = ["pending", "escalated", "failed_unreachable"] as const;
const OPEN = [...WAITING, "acknowledged"] as const;
/** Bound on requests handled per run; the next run finishes the rest (the step reports what is left). */
const ACK_RUN_BATCH = 200;

const countOf = async (query: Promise<ReadonlyArray<{ n: number }>>): Promise<number> =>
  (await query)[0]?.n ?? 0;

export function tasksStep(input: {
  readonly db: DbClient;
  readonly reassignTasks: (
    orgId: string,
    userId: string,
  ) => Promise<{ reassigned: number; flaggedNeedsOwner: number }>;
}): OffboardingStep {
  const active = inArray(T.status, ["open", "accepted"]);
  const counts = (orgId: string, userId: string, needsOwner: boolean) =>
    withOrgContext(input.db, systemOrgContext(orgId), (tx) =>
      countOf(
        tx
          .select({ n: count() })
          .from(T)
          .where(
            and(
              eq(T.organizationId, orgId),
              eq(T.assigneeId, userId),
              active,
              eq(T.needsOwner, needsOwner),
            ),
          ),
      ),
    );
  return {
    key: "tasks",
    kind: "reassign",
    async inspect(ctx) {
      return {
        auto: await counts(ctx.organizationId, ctx.leaverUserId, false),
        human: await counts(ctx.organizationId, ctx.leaverUserId, true),
      };
    },
    async run(ctx) {
      const out = await input.reassignTasks(ctx.organizationId, ctx.leaverUserId);
      return out.reassigned + out.flaggedNeedsOwner;
    },
  };
}

export function handoffsStep(input: {
  readonly db: DbClient;
  readonly resolveHandoffs: (
    orgId: string,
    userId: string,
  ) => Promise<{ recipientClosed: number; senderFlagged: number }>;
}): OffboardingStep {
  const senderFlagged = (userId: string): SQL =>
    sql`(${H.fromUserId} = ${userId} AND EXISTS (
      SELECT 1 FROM clinical_handoff_event e
      WHERE e.organization_id = ${H.organizationId} AND e.handoff_id = ${H.id} AND e.event_type = 'sender_left'))`;
  const read = (orgId: string, userId: string) =>
    withOrgContext(input.db, systemOrgContext(orgId), async (tx) => {
      const offered = and(eq(H.organizationId, orgId), eq(H.state, "offered"));
      const involved = or(eq(H.toUserId, userId), eq(H.fromUserId, userId));
      const all = await countOf(tx.select({ n: count() }).from(H).where(and(offered, involved)));
      const flagged = await countOf(
        tx
          .select({ n: count() })
          .from(H)
          .where(and(offered, senderFlagged(userId))),
      );
      return { auto: all - flagged, human: flagged };
    });
  return {
    key: "handoffs",
    kind: "reassign",
    inspect: (ctx) => read(ctx.organizationId, ctx.leaverUserId),
    async run(ctx) {
      const out = await input.resolveHandoffs(ctx.organizationId, ctx.leaverUserId);
      return out.recipientClosed + out.senderFlagged;
    },
  };
}

interface WaitingRequest {
  readonly id: string;
  readonly ackClass: typeof R.$inferSelect.ackClass;
  readonly version: number;
}

export function ackAssignedStep(input: {
  readonly db: DbClient;
  readonly ack: Pick<AckService, "supervisorReassign" | "supervisorReassignCandidates">;
  readonly attention: SupervisorAttentionDeps;
  readonly warn?: (event: string, context: Record<string, string>) => void;
}): OffboardingStep {
  const waiting = (orgId: string, userId: string, limit: number): Promise<WaitingRequest[]> =>
    withOrgContext(input.db, systemOrgContext(orgId), (tx) =>
      tx
        .select({ id: R.id, ackClass: R.ackClass, version: R.version })
        .from(R)
        .where(
          and(
            eq(R.organizationId, orgId),
            eq(R.assignedUserId, userId),
            inArray(R.status, [...WAITING]),
          ),
        )
        .orderBy(R.deadlineAt, R.id)
        .limit(limit),
    );
  const acknowledged = (orgId: string, userId: string) =>
    withOrgContext(input.db, systemOrgContext(orgId), (tx) =>
      countOf(
        tx
          .select({ n: count() })
          .from(R)
          .where(
            and(
              eq(R.organizationId, orgId),
              eq(R.assignedUserId, userId),
              eq(R.status, "acknowledged"),
            ),
          ),
      ),
    );

  return {
    key: "ack_assigned",
    kind: "reassign",
    async inspect(ctx) {
      const rows = await waiting(ctx.organizationId, ctx.leaverUserId, 10_000);
      return { auto: rows.length, human: await acknowledged(ctx.organizationId, ctx.leaverUserId) };
    },
    async run(ctx) {
      const actor = { orgId: ctx.organizationId, userId: ctx.actorUserId };
      let moved = 0;
      for (const request of await waiting(ctx.organizationId, ctx.leaverUserId, ACK_RUN_BATCH)) {
        try {
          const { candidates } = await input.ack.supervisorReassignCandidates(actor, request.id);
          const next = candidates.find((c) => c.user_id !== ctx.leaverUserId);
          if (next) {
            const out = await input.ack.supervisorReassign(
              actor,
              request.id,
              next.user_id,
              OFFBOARDING_ACK_REASON,
            );
            if (out.changed) {
              moved += 1;
              continue;
            }
          }
        } catch (err) {
          input.warn?.("offboarding ack reassign failed", {
            organization_id: ctx.organizationId,
            request_id: request.id,
            error_name: err instanceof Error ? err.name : "NonError",
          });
        }
        // Nobody could take it: it stays in the supervisors' queue and they are told, once per request and version.
        await raiseSupervisorAttention(
          input.attention,
          ctx.organizationId,
          { id: request.id, ackClass: request.ackClass },
          "assignee_departed",
          `offboard-attn:${request.id}:${request.version}`,
        );
      }
      return moved;
    },
  };
}

export function ackSentStep(input: { readonly db: DbClient }): OffboardingStep {
  return {
    key: "ack_sent",
    kind: "kept",
    async inspect(ctx) {
      const n = await withOrgContext(input.db, systemOrgContext(ctx.organizationId), (tx) =>
        countOf(
          tx
            .select({ n: count() })
            .from(R)
            .where(
              and(
                eq(R.organizationId, ctx.organizationId),
                eq(R.requesterUserId, ctx.leaverUserId),
                inArray(R.status, [...OPEN]),
              ),
            ),
        ),
      );
      return { auto: 0, human: n };
    },
  };
}

export function urgentUntrackedStep(input: {
  readonly db: DbClient;
  readonly now?: () => Date;
}): OffboardingStep {
  const now = input.now ?? (() => new Date());
  return {
    key: "urgent_untracked",
    kind: "reassign",
    async inspect(ctx) {
      const since = new Date(now().getTime() - UNTRACKED_URGENT_WINDOW_HOURS * 3_600_000);
      const n = await withOrgContext(input.db, systemOrgContext(ctx.organizationId), (tx) =>
        countOf(
          tx
            .select({ n: count() })
            .from(M)
            .where(
              and(
                eq(M.organizationId, ctx.organizationId),
                eq(M.urgentRecipientUserId, ctx.leaverUserId),
                eq(M.urgency, "urgent"),
                isNull(M.deletedAt),
                gte(M.createdAt, since),
                notExists(
                  tx
                    .select({ one: sql`1` })
                    .from(R)
                    .where(and(eq(R.organizationId, M.organizationId), eq(R.messageId, M.id))),
                ),
              ),
            ),
        ),
      );
      // The recipient of an urgent message is fixed at birth (a trigger), so M36 cannot move it: it is always a person's.
      return { auto: 0, human: n };
    },
  };
}
