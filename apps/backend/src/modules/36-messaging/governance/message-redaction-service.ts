// apps/backend/src/modules/36-messaging/governance/message-redaction-service.ts - WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED): request and
// approve the REDACTION of a message. Two people (the database refuses the same person twice), audited by the table's trigger and by the
// route's read audit; free text (the reason) is never returned or logged here.
//
// A redaction only MASKS (message-redaction-mask.ts, applied where a body is read): the cipher, the hash and the status are untouched, so
// an active legal hold neither blocks a redaction nor is weakened by it, and the integrity job still verifies the body. A REQUEST already
// takes the message out of search and blocks edits; an APPROVAL masks it for every reader. Approving also deletes the message's blind search
// tokens in the same transaction.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  MESSAGE_REDACTION_REASON_MAX_LENGTH,
  MESSAGE_REDACTION_REASON_MIN_LENGTH,
  type MessageRedactionDto,
  type MessageRedactionListDto,
  NotFoundError,
  type RequestMessageRedactionRequest,
  ValidationError,
} from "@chartwarden/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type ActiveMessageHold, heldMessageIdsAmong } from "../jobs/retention-hold-sql";
import { deleteSearchTokens } from "../message-search-tokens";
import type { Tx } from "../messaging-write-core";
import type { GovernanceActor } from "./retention-governance-service";
import { type StaffNamePort, nameOrNull, resolveNames } from "./staff-name-port";

const RED = schema.messageRedactions;
const MSG = schema.messages;

/** Redactions listed (newest first). */
export const REDACTION_LIST_LIMIT = 100;

export interface MessageRedactionDeps {
  readonly db: DbClient;
  readonly staffNames?: StaffNamePort;
  /** M4's active holds (live criteria), used only to say whether a listed message is under a hold. */
  readonly activeHolds: (
    tx: DbClient,
    organizationId: string,
  ) => Promise<readonly ActiveMessageHold[]>;
}

type RedactionRow = typeof RED.$inferSelect;

function assertReason(reason: string): void {
  const length = reason.trim().length;
  if (
    length < MESSAGE_REDACTION_REASON_MIN_LENGTH ||
    length > MESSAGE_REDACTION_REASON_MAX_LENGTH
  ) {
    throw new ValidationError("request validation failed", [
      {
        field: "reason",
        code: "INVALID",
        message: `a reason of ${MESSAGE_REDACTION_REASON_MIN_LENGTH} to ${MESSAGE_REDACTION_REASON_MAX_LENGTH} characters is required`,
      },
    ]);
  }
}

export function createMessageRedactionService(deps: MessageRedactionDeps) {
  const inTx = <T>(actor: GovernanceActor, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext<DbClient, T>(
      deps.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  async function toDtos(
    tx: DbClient,
    orgId: string,
    rows: readonly RedactionRow[],
  ): Promise<MessageRedactionDto[]> {
    const names = await resolveNames(
      deps.staffNames,
      tx,
      orgId,
      rows.flatMap((r) => [r.requestedBy, r.approvedBy]),
    );
    const held = await heldMessageIdsAmong(
      tx,
      orgId,
      rows.map((r) => r.messageId),
      await deps.activeHolds(tx, orgId),
    );
    return rows.map((r) => ({
      id: r.id,
      message_id: r.messageId,
      status: r.approvedAt ? ("approved" as const) : ("requested" as const),
      requested_by: r.requestedBy,
      requested_by_name: nameOrNull(names, r.requestedBy),
      requested_at: r.requestedAt.toISOString(),
      approved_by: r.approvedBy,
      approved_by_name: nameOrNull(names, r.approvedBy),
      approved_at: r.approvedAt ? r.approvedAt.toISOString() : null,
      under_legal_hold: held.has(r.messageId),
    }));
  }

  return {
    /** Ask for a message to be redacted. One request per message: a second is 409. The requester needs no channel membership and never sees the body. */
    async request(
      actor: GovernanceActor,
      body: RequestMessageRedactionRequest,
    ): Promise<MessageRedactionDto> {
      assertReason(body.reason);
      return inTx(actor, async (tx) => {
        const [message] = await tx
          .select({ id: MSG.id })
          .from(MSG)
          .where(and(eq(MSG.organizationId, actor.organizationId), eq(MSG.id, body.message_id)))
          .limit(1);
        // Unknown, another tenant's and an already-erased message are the same answer.
        if (!message) throw new NotFoundError("message", body.message_id);
        const [row] = await tx
          .insert(RED)
          .values({
            organizationId: actor.organizationId,
            messageId: body.message_id,
            requestedBy: actor.userId,
            reason: body.reason.trim(),
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new ChartWardenError(
            "REDACTION_EXISTS",
            "this message already has a redaction request",
            409,
          );
        }
        // Out of search from the moment of the request (ADR-0058 d6/7), in the same transaction.
        await deleteSearchTokens(tx as unknown as Tx, actor.organizationId, body.message_id);
        return (await toDtos(tx, actor.organizationId, [row]))[0] as MessageRedactionDto;
      });
    },

    /** Approve a redaction someone ELSE requested. Same person => 403 (and the database refuses it too). Approving twice => 409. */
    async approve(actor: GovernanceActor, id: string): Promise<MessageRedactionDto> {
      return inTx(actor, async (tx) => {
        const [existing] = await tx
          .select()
          .from(RED)
          .where(and(eq(RED.organizationId, actor.organizationId), eq(RED.id, id)))
          .limit(1);
        if (!existing) throw new NotFoundError("message_redaction", id);
        if (existing.approvedAt) {
          throw new ChartWardenError(
            "REDACTION_ALREADY_APPROVED",
            "this redaction is already approved",
            409,
          );
        }
        if (existing.requestedBy === actor.userId) {
          throw new ChartWardenError(
            "REDACTION_SELF_APPROVAL",
            "a redaction is approved by a different person than the one who requested it",
            403,
          );
        }
        const [row] = await tx
          .update(RED)
          .set({ approvedBy: actor.userId, approvedAt: new Date() })
          .where(
            and(
              eq(RED.organizationId, actor.organizationId),
              eq(RED.id, id),
              isNull(RED.approvedAt),
            ),
          )
          .returning();
        if (!row) {
          throw new ChartWardenError(
            "REDACTION_ALREADY_APPROVED",
            "this redaction is already approved",
            409,
          );
        }
        await deleteSearchTokens(tx as unknown as Tx, actor.organizationId, row.messageId);
        return (await toDtos(tx, actor.organizationId, [row]))[0] as MessageRedactionDto;
      });
    },

    async list(actor: GovernanceActor): Promise<MessageRedactionListDto> {
      return inTx(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RED)
          .where(eq(RED.organizationId, actor.organizationId))
          .orderBy(desc(RED.requestedAt), desc(RED.id))
          .limit(REDACTION_LIST_LIMIT);
        return { redactions: await toDtos(tx, actor.organizationId, rows) };
      });
    },
  };
}

export type MessageRedactionService = ReturnType<typeof createMessageRedactionService>;
