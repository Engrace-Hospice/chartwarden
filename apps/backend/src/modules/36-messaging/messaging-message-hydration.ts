// apps/backend/src/modules/36-messaging/messaging-message-hydration.ts - turn stored `message` rows into the
// `ResolvedMessage` shape every read returns (channel history, WP 2.2 thread). One implementation, so a thread
// reply and a channel row can never disagree about body decoding, references, attachment visibility or reply counts.
//
// The caller has already authorised the read (the `channel_visibility` ABAC predicate at the route); this module
// decrypts bodies under the tenant DEK, so it must only ever be given rows of a channel the viewer may read.
import { schema } from "@chartwarden/db";
import type { MessageBodyKind, ResolvedMessage } from "@chartwarden/messaging";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { loadAttachmentViews } from "./attachments/attachment-service-db";
import { loadClinicalLinkViews } from "./clinical-link/clinical-link-store-db";
import { loadMessageAnnotations } from "./message-annotations";
import type { MessageBodyCipher, Tx } from "./messaging-write-core";
import { loadPollViews } from "./polls/poll-views";
import { decodeStoredBody } from "./rich-body-codec";

const MSG = schema.messages;
const MER = schema.messageEntityReferences;
const MATT = schema.messageAttachments;
const USER = schema.users;

/** The columns a page query must select, in this shape, to be hydrated. */
export const MESSAGE_ROW_COLUMNS = {
  id: MSG.id,
  channelId: MSG.channelId,
  authorUserId: MSG.authorUserId,
  authorDisplayName: USER.name,
  bodyCipher: MSG.bodyCipher,
  bodyKind: MSG.bodyKind,
  status: MSG.status,
  editedAt: MSG.editedAt,
  createdAt: MSG.createdAt,
  createdAtMicros: sql<string>`${MSG.createdAt}::text`,
  parentMessageId: MSG.parentMessageId,
  urgency: MSG.urgency,
};

export interface MessageRow {
  readonly id: string;
  readonly channelId: string;
  readonly authorUserId: string | null;
  readonly authorDisplayName: string | null;
  readonly bodyCipher: Buffer;
  readonly bodyKind: string;
  readonly status: string;
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  readonly parentMessageId: string | null;
  readonly urgency: string;
}

/**
 * WP 1.3: the "edited" marker time for a read. Only a live edited message carries it: a tombstone shows nothing.
 * Phase 5 (ADR-0055 redaction) MUST also return null here for a redacted message so redaction hides the indicator.
 */
export function visibleEditedAt(row: {
  readonly status: string;
  readonly editedAt: Date | null;
}): string | null {
  return row.status === "edited" && row.editedAt ? row.editedAt.toISOString() : null;
}

export interface HydrationContext {
  readonly orgId: string;
  readonly viewerUserId: string;
  readonly channelKind: string;
  readonly cipher: MessageBodyCipher;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface ReplyStats {
  readonly replyCount: number;
  readonly lastReplyAt: string | null;
}

/**
 * Direct replies per parent, in one grouped query for the whole page (no N+1; served by
 * `message_org_channel_parent_idx`). Counts LIVE replies only: a deleted reply is a tombstone, and a tombstone is not
 * "a reply" a reader can open. Replies are channel-scoped (migration 1083), so a channel member's count is exactly the
 * set of rows that member can read: nothing here depends on the viewer, and nothing about another channel leaks.
 */
export async function loadReplyStats(
  tx: Tx,
  orgId: string,
  channelId: string,
  parentIds: readonly string[],
): Promise<Map<string, ReplyStats>> {
  if (parentIds.length === 0) return new Map();
  const rows = (await tx
    .select({
      parentId: MSG.parentMessageId,
      replyCount: sql<number>`count(*)::int`,
      lastReplyAt: sql<Date>`max(${MSG.createdAt})`,
    })
    .from(MSG)
    .where(
      and(
        eq(MSG.organizationId, orgId),
        eq(MSG.channelId, channelId),
        inArray(MSG.parentMessageId, [...parentIds]),
        sql`${MSG.status} <> 'deleted'`,
      ),
    )
    .groupBy(MSG.parentMessageId)) as Array<{
    parentId: string;
    replyCount: number;
    lastReplyAt: Date | string;
  }>;
  return new Map(
    rows.map((r) => [
      r.parentId,
      { replyCount: Number(r.replyCount), lastReplyAt: new Date(r.lastReplyAt).toISOString() },
    ]),
  );
}

export async function hydrateMessages(
  tx: Tx,
  ctx: HydrationContext,
  rows: readonly MessageRow[],
  channelId: string,
): Promise<ResolvedMessage[]> {
  const { orgId } = ctx;
  const messageIds = rows.map((row) => row.id);
  const referenceRows =
    messageIds.length === 0
      ? []
      : await tx
          .select({
            messageId: MER.messageId,
            kind: MER.referenceKind,
            entityId: MER.entityId,
            start: MER.startOffset,
            end: MER.endOffset,
            staffName: USER.name,
          })
          .from(MER)
          .leftJoin(USER, and(eq(USER.id, MER.entityId), eq(MER.referenceKind, "staff")))
          .where(and(eq(MER.organizationId, orgId), inArray(MER.messageId, messageIds)))
          .orderBy(asc(MER.startOffset));
  const referencesByMessage = new Map<string, typeof referenceRows>();
  for (const reference of referenceRows) {
    const values = referencesByMessage.get(reference.messageId) ?? [];
    values.push(reference);
    referencesByMessage.set(reference.messageId, values);
  }
  // WP 1.5: scan-gated attachment metadata. A tombstoned message shows none; the loader hides quarantined
  // files from everyone and pending ones from everyone but their uploader.
  // WP 3.2: clinical links as ids and kind only; the viewer's access is decided per chip by `resolve`.
  const clinicalLinks = await loadClinicalLinkViews(
    tx,
    orgId,
    rows.filter((row) => row.status !== "deleted").map((row) => row.id),
  );
  const liveIds = rows.filter((row) => row.status !== "deleted").map((row) => row.id);
  const attachmentsByMessage = await loadAttachmentViews(tx, {
    orgId,
    viewerUserId: ctx.viewerUserId,
    messageIds: liveIds,
  });
  // How many bound files this viewer cannot see (still scanning for someone else, or quarantined): a bare count,
  // so an attachment-only message is not mistaken for a tombstone and nothing about the files leaks.
  const boundRows =
    liveIds.length === 0
      ? []
      : await tx
          .select({ messageId: MATT.messageId, n: sql<number>`count(*)::int` })
          .from(MATT)
          .where(and(eq(MATT.organizationId, orgId), inArray(MATT.messageId, liveIds)))
          .groupBy(MATT.messageId);
  const boundByMessage = new Map(boundRows.map((row) => [row.messageId, Number(row.n)]));
  // WP 2.2: reply count + last reply time, one grouped query for the page.
  const replyStats = await loadReplyStats(tx, orgId, channelId, messageIds);
  // WP 2.4: reaction counts + pin flag, one grouped read each for the page.
  const annotations = await loadMessageAnnotations(tx, {
    orgId,
    channelId,
    viewerUserId: ctx.viewerUserId,
    messageIds: liveIds,
  });
  // WP 2.10: the poll riding on a message (counts + the viewer's own vote), one grouped read for the page.
  const polls = await loadPollViews(tx, {
    orgId,
    channelId,
    viewerUserId: ctx.viewerUserId,
    messageIds: liveIds,
    cipher: ctx.cipher,
    ...(ctx.warn ? { warn: ctx.warn } : {}),
  });
  return Promise.all(
    rows.map(async (m): Promise<ResolvedMessage> => {
      const decoded: ReturnType<typeof decodeStoredBody> =
        m.status === "deleted"
          ? { body: "" }
          : decodeStoredBody(
              m.bodyKind as MessageBodyKind,
              await ctx.cipher.open(orgId, m.bodyCipher),
            );
      // A rich body that no longer parses is not a deleted message: say so, and leave ids (never content).
      if (decoded.unreadable) {
        ctx.warn?.("rich message body could not be read; showing a placeholder", {
          organizationId: orgId,
          messageId: m.id,
          channelId: m.channelId,
        });
      }
      const stats = replyStats.get(m.id);
      return {
        messageId: m.id,
        channelId: m.channelId,
        authorUserId: m.authorUserId,
        authorDisplayName: m.authorDisplayName?.trim() || null,
        body: decoded.body,
        bodyKind: m.bodyKind as MessageBodyKind,
        ...(decoded.bodyDoc ? { bodyDoc: decoded.bodyDoc } : {}),
        ...(decoded.unreadable ? { bodyUnreadable: true as const } : {}),
        createdAt: m.createdAt.toISOString(),
        editedAt: visibleEditedAt(m),
        parentMessageId: m.parentMessageId,
        // WP 4.1: display only; a tombstone shows nothing, and routine is simply absent.
        ...(m.urgency === "urgent" && m.status !== "deleted" ? { urgency: "urgent" as const } : {}),
        reactions: annotations.reactions.get(m.id) ?? [],
        pinned: annotations.pinned.has(m.id),
        ...(polls.has(m.id) ? { poll: polls.get(m.id) } : {}),
        replyCount: stats?.replyCount ?? 0,
        lastReplyAt: stats?.lastReplyAt ?? null,
        attachments: attachmentsByMessage.get(m.id) ?? [],
        hiddenAttachmentCount: Math.max(
          0,
          (boundByMessage.get(m.id) ?? 0) - (attachmentsByMessage.get(m.id)?.length ?? 0),
        ),
        ...(clinicalLinks.has(m.id) ? { clinicalLinks: clinicalLinks.get(m.id) } : {}),
        references: (referencesByMessage.get(m.id) ?? []).map((reference) => ({
          kind: reference.kind as "staff" | "patient",
          entityId: reference.entityId,
          start: reference.start,
          end: reference.end,
          displayLabel:
            reference.kind === "staff" ? reference.staffName?.trim() || "Staff member" : "Patient",
          navigable: reference.kind === "patient" && ctx.channelKind === "care_team",
        })),
      };
    }),
  );
}
