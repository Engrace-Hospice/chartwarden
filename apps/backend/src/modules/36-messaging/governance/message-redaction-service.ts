// apps/backend/src/modules/36-messaging/governance/message-redaction-service.ts - WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED): request and
// approve the REDACTION of a message. Two people (the database refuses the same person twice), audited by the table's trigger and by the
// route's read audit; free text (the reason) is never returned or logged here.
//
// A redaction only MASKS (message-redaction-mask.ts, applied where a body is read): the cipher, the hash and the status are untouched, so
// an active legal hold neither blocks a redaction nor is weakened by it, and the integrity job still verifies the body. A REQUEST already
// takes the message out of search and blocks edits; an APPROVAL masks it for every reader. Approving also deletes the message's blind search
// tokens in the same transaction.
//
// Single-officer fallback (ADR-0055 D9, migration 1165, PROVISIONAL pending compliance sign-off; default OFF per tenant): when the tenant has
// exactly ONE person who can approve, that person may approve their OWN request (`selfApprove`), but it masks nothing until a second role
// countersigns (`countersign`) within 72 hours. Everything that decides WHETHER is checked here (flag, exactly one eligible officer, the
// caller holds the approve permission via the route); everything that decides WHO and WHEN is also enforced by the database guard.
import { type AuditExecutor, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  MESSAGE_REDACTION_REASON_MAX_LENGTH,
  MESSAGE_REDACTION_REASON_MIN_LENGTH,
  MESSAGING_REDACT_APPROVE_PERMISSION,
  type MessageRedactionDto,
  type MessageRedactionListDto,
  NotFoundError,
  type RequestMessageRedactionRequest,
  ValidationError,
} from "@chartwarden/types";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
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
  /**
   * The single-officer fallback's two inputs, bound at the composition root (absent = the fallback does not exist). `enabled` is the tenant flag
   * (absent = off); `eligibleApprovers` is how many active people in the tenant hold `messaging.redact.approve` (M3's reader).
   */
  readonly singleOfficerFallback?: {
    readonly enabled: (organizationId: string) => Promise<boolean>;
    readonly eligibleApprovers: (
      tx: DbClient,
      organizationId: string,
      permissionKey: string,
    ) => Promise<number>;
  };
  readonly now?: () => Date;
  /** M4's active holds (live criteria), used only to say whether a listed message is under a hold. */
  readonly activeHolds: (
    tx: DbClient,
    organizationId: string,
  ) => Promise<readonly ActiveMessageHold[]>;
}

type RedactionRow = typeof RED.$inferSelect;

/** What a row is, from the caller's clock: approved = FINAL (masks); a self-approval is awaiting its countersign until the deadline, then lapsed. */
export function redactionStatus(row: RedactionRow, now: Date): MessageRedactionDto["status"] {
  if (row.approvedAt) return "approved";
  if (!row.selfApprovedAt) return "requested";
  return row.countersignDeadlineAt && row.countersignDeadlineAt.getTime() >= now.getTime()
    ? "awaiting_countersign"
    : "lapsed";
}

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

/** The migration 1165 trigger raises `message_redaction_lapsed` (check_violation 23514); drizzle may wrap it, so look through `cause`. */
function isRedactionLapsedViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    const { message, code, cause } = e as { message?: unknown; code?: unknown; cause?: unknown };
    if (
      code === "23514" &&
      typeof message === "string" &&
      message.includes("message_redaction_lapsed")
    ) {
      return true;
    }
    e = cause;
  }
  return false;
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
      rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.countersignedBy]),
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
      status: redactionStatus(r, (deps.now ?? (() => new Date()))()),
      requested_by: r.requestedBy,
      requested_by_name: nameOrNull(names, r.requestedBy),
      requested_at: r.requestedAt.toISOString(),
      approved_by: r.approvedBy,
      approved_by_name: nameOrNull(names, r.approvedBy),
      approved_at: r.approvedAt ? r.approvedAt.toISOString() : null,
      self_approved: r.selfApprovedAt !== null,
      countersign_deadline_at: r.countersignDeadlineAt
        ? r.countersignDeadlineAt.toISOString()
        : null,
      countersigned_by: r.countersignedBy,
      countersigned_by_name: nameOrNull(names, r.countersignedBy),
      under_legal_hold: held.has(r.messageId),
    }));
  }

  /** The fallback is usable now: the tenant flag is on and exactly one active person holds the approve permission. */
  async function fallbackOpen(tx: DbClient, organizationId: string): Promise<boolean> {
    const fallback = deps.singleOfficerFallback;
    if (!fallback || !(await fallback.enabled(organizationId))) return false;
    return (
      (await fallback.eligibleApprovers(
        tx,
        organizationId,
        MESSAGING_REDACT_APPROVE_PERMISSION,
      )) === 1
    );
  }

  async function assertFallbackOpen(tx: DbClient, actor: GovernanceActor): Promise<void> {
    if (!(await fallbackOpen(tx, actor.organizationId))) {
      throw new ChartWardenError(
        "REDACTION_FALLBACK_UNAVAILABLE",
        "the single-officer fallback is not available: it needs the tenant setting on and exactly one eligible officer",
        403,
      );
    }
  }

  /** The row, locked for the rest of the transaction (two concurrent decisions queue, the second sees the first). */
  async function lockRow(tx: DbClient, actor: GovernanceActor, id: string): Promise<RedactionRow> {
    const [existing] = await tx
      .select()
      .from(RED)
      .where(and(eq(RED.organizationId, actor.organizationId), eq(RED.id, id)))
      .for("update")
      .limit(1);
    if (!existing) throw new NotFoundError("message_redaction", id);
    return existing;
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

    /**
     * Approve your OWN request: the single-officer fallback. Refused unless the tenant flag is on AND exactly one person can approve (and that is
     * the caller). Not final: it masks nothing and starts the 72 h countersign period. Audited loudly in addition to the row's own audit trigger.
     */
    async selfApprove(actor: GovernanceActor, id: string): Promise<MessageRedactionDto> {
      return inTx(actor, async (tx) => {
        const existing = await lockRow(tx, actor, id);
        if (existing.requestedBy !== actor.userId) {
          throw new ChartWardenError(
            "REDACTION_SELF_APPROVAL_NOT_REQUESTER",
            "only the person who requested a redaction can approve it as the sole officer",
            403,
          );
        }
        if (existing.approvedAt || existing.selfApprovedAt) {
          throw new ChartWardenError(
            "REDACTION_ALREADY_APPROVED",
            "this redaction is already approved or awaiting its countersign",
            409,
          );
        }
        await assertFallbackOpen(tx, actor);
        const [row] = await tx
          .update(RED)
          .set({ selfApprovedAt: new Date() })
          .where(
            and(
              eq(RED.organizationId, actor.organizationId),
              eq(RED.id, id),
              isNull(RED.approvedAt),
              isNull(RED.selfApprovedAt),
            ),
          )
          .returning();
        if (!row) {
          throw new ChartWardenError(
            "REDACTION_ALREADY_APPROVED",
            "this redaction is already approved or awaiting its countersign",
            409,
          );
        }
        await audit(tx as unknown as AuditExecutor, actor.auditContext, {
          eventType: "m36.redaction.self_approved",
          resourceKind: "message_redaction",
          resourceId: row.id,
          outcome: "success",
          context: {
            redactionId: row.id,
            messageId: row.messageId,
            countersignDeadlineAt: row.countersignDeadlineAt?.toISOString() ?? null,
            provisional: true,
          },
        });
        return (await toDtos(tx, actor.organizationId, [row]))[0] as MessageRedactionDto;
      });
    },

    /**
     * The second role countersigns a self-approved redaction within its 72 h period: the redaction becomes final (masks). Never the requester
     * (403, and the database refuses it too); after the deadline it is 409 REDACTION_COUNTERSIGN_LAPSED and nothing changes.
     */
    async countersign(actor: GovernanceActor, id: string): Promise<MessageRedactionDto> {
      return inTx(actor, async (tx) => {
        const existing = await lockRow(tx, actor, id);
        if (existing.requestedBy === actor.userId) {
          throw new ChartWardenError(
            "REDACTION_COUNTERSIGN_SELF",
            "a redaction is countersigned by a different person than the one who requested it",
            403,
          );
        }
        const status = redactionStatus(existing, (deps.now ?? (() => new Date()))());
        if (status === "lapsed") {
          throw new ChartWardenError(
            "REDACTION_COUNTERSIGN_LAPSED",
            "the countersign period has passed; this redaction is not final",
            409,
          );
        }
        if (status !== "awaiting_countersign") {
          throw new ChartWardenError(
            "REDACTION_NOT_AWAITING_COUNTERSIGN",
            "this redaction is not awaiting a countersign",
            409,
          );
        }
        // Same gate as the self-approval: a fallback row is completed only while the fallback is still open (flag on, exactly one eligible
        // approver). Turn the setting off, or add a second officer, and the row must go through the ordinary two-person approval instead.
        await assertFallbackOpen(tx, actor);
        // The app clock and the database clock can disagree at the 72 h deadline: the trigger is the authority, so its refusal is the same 409.
        const [row] = await tx
          .update(RED)
          .set({ countersignedBy: actor.userId, approvedBy: existing.requestedBy })
          .where(
            and(
              eq(RED.organizationId, actor.organizationId),
              eq(RED.id, id),
              isNull(RED.approvedAt),
              isNotNull(RED.selfApprovedAt),
            ),
          )
          .returning()
          .catch((error: unknown) => {
            if (isRedactionLapsedViolation(error)) {
              throw new ChartWardenError(
                "REDACTION_COUNTERSIGN_LAPSED",
                "the countersign period has passed; this redaction is not final",
                409,
              );
            }
            throw error;
          });
        if (!row) {
          throw new ChartWardenError(
            "REDACTION_NOT_AWAITING_COUNTERSIGN",
            "this redaction is not awaiting a countersign",
            409,
          );
        }
        await deleteSearchTokens(tx as unknown as Tx, actor.organizationId, row.messageId);
        await audit(tx as unknown as AuditExecutor, actor.auditContext, {
          eventType: "m36.redaction.countersigned",
          resourceKind: "message_redaction",
          resourceId: row.id,
          outcome: "success",
          context: { redactionId: row.id, messageId: row.messageId, provisional: true },
        });
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
        return {
          redactions: await toDtos(tx, actor.organizationId, rows),
          single_officer_fallback_available: await fallbackOpen(tx, actor.organizationId),
        };
      });
    },
  };
}

export type MessageRedactionService = ReturnType<typeof createMessageRedactionService>;
