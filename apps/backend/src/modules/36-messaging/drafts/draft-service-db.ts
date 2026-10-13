// apps/backend/src/modules/36-messaging/drafts/draft-service-db.ts — WP 2.5 server-side drafts (Drizzle impl of
// MessageDraftService). The body and its mention references are ONE JSON document sealed under the tenant DEK, the same
// envelope as message.body_cipher; only revision/device/timestamps are plaintext. Every statement runs under
// withOrgContext with the CALLER as the context user: RLS (migration 1085) pins rows to org AND owner, and the queries
// below also name the owner, so a forgotten filter cannot surface a colleague's draft. Org and user come from the
// server-side request context, never the body. The caller has already authorised the channel (channel_visibility).
import { type DbClient, schema } from "@wardenx/db";
import {
  type DraftKey,
  type DraftView,
  type MessageDraftService,
  type MessageReferenceInput,
  type SaveDraftInput,
  assertDraftWithinLimits,
  decideDraftSave,
  draftConflictError,
  isEmptyDraft,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { type SQL, and, eq, isNull, sql } from "drizzle-orm";
import { type MessageBodyCipher, createMessageBodyCipher } from "../messaging-write-core";

const DRAFT = schema.messageDrafts;
const MSG = schema.messages;
const UNIQUE_VIOLATION = "23505";

interface SealedDraft {
  readonly body: string;
  readonly references: readonly MessageReferenceInput[];
}

export interface DraftServiceDeps {
  readonly db: DbClient;
  /** Injectable for tests; defaults to the process-wide lazy KEK loader (fails closed without MESSAGING_ENCRYPTION_KEY). */
  readonly cipher?: MessageBodyCipher;
  /** Drafts one user may hold across all channels and thread roots (default 200). */
  readonly maxPerUser?: number;
}

/** A draft is scratch space, not storage: bound how many one user can accumulate. */
export const DEFAULT_MAX_DRAFTS_PER_USER = 200;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null) ?? null;
  return code?.code === UNIQUE_VIOLATION || code?.cause?.code === UNIQUE_VIOLATION;
}

export function createDbDraftService(deps: DraftServiceDeps): MessageDraftService {
  const { db } = deps;
  const cipher = deps.cipher ?? createMessageBodyCipher();
  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_DRAFTS_PER_USER;

  const slot = (orgId: string, key: DraftKey): SQL | undefined =>
    and(
      eq(DRAFT.organizationId, orgId),
      eq(DRAFT.userId, key.userId),
      eq(DRAFT.channelId, key.channelId),
      key.parentMessageId
        ? eq(DRAFT.parentMessageId, key.parentMessageId)
        : isNull(DRAFT.parentMessageId),
    );

  const view = (orgId: string, row: typeof DRAFT.$inferSelect): DraftView => {
    const sealed = JSON.parse(cipher.open(orgId, row.bodyCipher)) as SealedDraft;
    return {
      channelId: row.channelId,
      parentMessageId: row.parentMessageId,
      body: sealed.body,
      references: sealed.references,
      revision: row.revision,
      deviceId: row.deviceId,
      updatedAt: row.updatedAt.toISOString(),
    };
  };

  const deleteDraft: MessageDraftService["deleteDraft"] = async (orgId, key) => {
    await withOrgContext(db, { organizationId: orgId, userId: key.userId }, async (tx) => {
      await tx.delete(DRAFT).where(slot(orgId, key));
    });
  };

  return {
    deleteDraft,

    async getDraft(orgId, key) {
      return withOrgContext(db, { organizationId: orgId, userId: key.userId }, async (tx) => {
        const [row] = await tx.select().from(DRAFT).where(slot(orgId, key)).limit(1);
        return row ? view(orgId, row) : null;
      });
    },

    async saveDraft(orgId, input: SaveDraftInput) {
      assertDraftWithinLimits(input);
      if (isEmptyDraft(input)) {
        // A blank save is a discard, but it still answers to the conflict rule: a stale device's blank autosave must
        // not silently erase a newer draft from another device. The explicit DELETE route is the unconditional discard.
        return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
          const [held] = await tx
            .select()
            .from(DRAFT)
            .where(slot(orgId, input))
            .limit(1)
            .for("update");
          if (!held) return null;
          if (decideDraftSave(held, input) === "conflict") throw draftConflictError();
          await tx.delete(DRAFT).where(slot(orgId, input));
          return null;
        });
      }
      const sealed = cipher.seal(
        orgId,
        JSON.stringify({
          body: input.body,
          references: input.references ?? [],
        } satisfies SealedDraft),
      ).cipher;
      try {
        return await withOrgContext(
          db,
          { organizationId: orgId, userId: input.userId },
          async (tx) => {
            if (input.parentMessageId) {
              // A thread draft needs a live root in THIS channel (the composite FK is the backstop, this is the 404).
              const [root] = await tx
                .select({ id: MSG.id, status: MSG.status, parentMessageId: MSG.parentMessageId })
                .from(MSG)
                .where(
                  and(
                    eq(MSG.organizationId, orgId),
                    eq(MSG.channelId, input.channelId),
                    eq(MSG.id, input.parentMessageId),
                  ),
                )
                .limit(1);
              // The root must be live and itself a root (replies of replies are not a thing, WP 2.2).
              if (!root || root.status === "deleted" || root.parentMessageId !== null) {
                throw new NotFoundError("message", input.parentMessageId);
              }
            }
            const [current] = await tx
              .select()
              .from(DRAFT)
              .where(slot(orgId, input))
              .limit(1)
              .for("update");
            if (decideDraftSave(current ?? null, input) === "conflict") throw draftConflictError();
            if (!current) {
              // Serialise a user's first-saves so the cap cannot be raced past, then count (this user only: RLS).
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${orgId}:${input.userId}`}, 36))`,
              );
              const [{ n }] = (await tx
                .select({ n: sql<number>`count(*)::int` })
                .from(DRAFT)
                .where(and(eq(DRAFT.organizationId, orgId), eq(DRAFT.userId, input.userId)))) as [
                { n: number },
              ];
              if (Number(n) >= maxPerUser) {
                throw new WardenXError(
                  "DRAFT_LIMIT_REACHED",
                  `at most ${maxPerUser} drafts can be kept; send or discard one first`,
                  409,
                );
              }
              const [created] = await tx
                .insert(DRAFT)
                .values({
                  organizationId: orgId,
                  channelId: input.channelId,
                  userId: input.userId,
                  parentMessageId: input.parentMessageId ?? null,
                  bodyCipher: sealed,
                  deviceId: input.deviceId,
                })
                .returning();
              return view(orgId, created as typeof DRAFT.$inferSelect);
            }
            const [updated] = await tx
              .update(DRAFT)
              .set({
                bodyCipher: sealed,
                revision: current.revision + 1,
                deviceId: input.deviceId,
                updatedAt: new Date(),
              })
              .where(and(eq(DRAFT.organizationId, orgId), eq(DRAFT.id, current.id)))
              .returning();
            return view(orgId, updated as typeof DRAFT.$inferSelect);
          },
        );
      } catch (error) {
        // Two first saves raced (e.g. two devices on a brand-new draft): the loser sees the winner's row next read.
        if (isUniqueViolation(error)) throw draftConflictError();
        throw error;
      }
    },
  };
}
