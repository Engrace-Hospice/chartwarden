// apps/backend/src/modules/36-messaging — PRODUCTION `MessagingProvider` seam (§4.6) over Drizzle
// (FB-T05). The cross-module channel/message surface other modules consume without a direct schema
// edge: the implementation is injected into the M1 seam registry and validated by validateSeams(),
// replacing the Phase-0 deny-stub so the seam is REAL (not failing-closed) when a DB is present.
//
// Shares the FB-T05 write core with the route-service adapter: bodies are envelope-encrypted under the
// per-tenant DEK at write time (§3.4) and decrypted for entitled readers; sends fan out `delivered`
// receipts. Every op runs inside `withOrgContext` so RLS on `app.org_id` (+ the M4 write-audit trigger)
// is the backstop.
//
// SCOPE (FB-T05): the channel/message CRUD (`openChannel`/`sendMessage`/`markRead`/`listMessages`) is
// live. The auto-sync hooks (`sync*`/`archiveCareTeamChannel`, §2.3) are driven by M5/M16/M17/M19
// outbox events that are not wired in Phase 1 — they stay forward-seam deferrals (a clear NOT_IMPLEMENTED
// throw) rather than reconcile membership against source data that has no live producer yet.
import { type DbClient, schema } from "@wardenx/db";
import type {
  ChannelKind,
  MessageBodyKind,
  MessagingProvider,
  ResolvedMessage,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { and, asc, eq } from "drizzle-orm";
import {
  type MessageBodyCipher,
  channelOr404,
  createMessageBodyCipher,
  insertEncryptedMessage,
  markMessagesRead,
} from "./messaging-write-core";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;

/** The channel-kind shape the §3.3 `channel_kind_subject_shape` CHECK enforces (subject + retention). */
function channelShape(kind: ChannelKind): {
  retentionClass: "operational" | "care_related" | "bereavement";
  subjectRequired: boolean;
} {
  switch (kind) {
    case "dm":
      return { retentionClass: "care_related", subjectRequired: false };
    case "announcement":
      return { retentionClass: "operational", subjectRequired: false };
    case "bereavement":
      return { retentionClass: "bereavement", subjectRequired: true };
    default: // care_team / discipline / location / on_call
      return { retentionClass: "care_related", subjectRequired: true };
  }
}

/** Build the production {@link MessagingProvider}. `opts.kek`/`opts.cipher` are injectable for tests. */
export function createDbMessagingProvider(
  db: DbClient,
  opts: { kek?: Buffer; cipher?: MessageBodyCipher } = {},
): MessagingProvider {
  const cipher = opts.cipher ?? createMessageBodyCipher({ kek: opts.kek });

  function notWired(hook: string): never {
    throw new WardenXError(
      "NOT_IMPLEMENTED",
      `${hook} is driven by a source-module outbox event (M5/M16/M17/M19) not wired in Phase 1`,
      501,
    );
  }

  return {
    async openChannel(orgId, spec) {
      const shape = channelShape(spec.kind);
      if (spec.kind === "bereavement") {
        // bereavement needs a pre-computed archives_at (M16 plan), so it is opened via the M16 sync hook.
        notWired("opening a bereavement channel");
      }
      return withOrgContext(
        db,
        { organizationId: orgId, userId: spec.creatorUserId },
        async (tx) => {
          if (shape.subjectRequired && spec.subjectId) {
            const existing = (await tx
              .select({ id: CH.id })
              .from(CH)
              .where(
                and(
                  eq(CH.organizationId, orgId),
                  eq(CH.channelKind, spec.kind),
                  eq(CH.subjectId, spec.subjectId),
                ),
              )
              .limit(1)) as Array<{ id: string }>;
            if (existing[0]) return { channelId: existing[0].id, created: false };
          }
          if (spec.kind === "announcement") {
            const existing = (await tx
              .select({ id: CH.id })
              .from(CH)
              .where(and(eq(CH.organizationId, orgId), eq(CH.channelKind, "announcement")))
              .limit(1)) as Array<{ id: string }>;
            if (existing[0]) return { channelId: existing[0].id, created: false };
          }
          const inserted = (await tx
            .insert(CH)
            .values({
              organizationId: orgId,
              channelKind: spec.kind,
              subjectId: shape.subjectRequired ? (spec.subjectId ?? null) : null,
              title: spec.title ?? defaultTitle(spec.kind),
              retentionClass: shape.retentionClass,
            })
            .returning({ id: CH.id })) as Array<{ id: string }>;
          const channelId = inserted[0]!.id;
          await tx.insert(CM).values({
            organizationId: orgId,
            channelId,
            userId: spec.creatorUserId,
            role: "owner",
            source: "manual",
          });
          return { channelId, created: true };
        },
      );
    },

    async sendMessage(orgId, input) {
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.authorUserId },
        async (tx) => {
          const ch = await channelOr404(tx, orgId, input.channelId);
          if (ch.isArchived) throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
          return insertEncryptedMessage(tx, cipher, {
            orgId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            body: input.body,
            bodyKind: input.bodyKind,
            parentMessageId: input.parentMessageId,
            quotedMessageId: input.quotedMessageId,
          });
        },
      );
    },

    async markRead(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, (tx) =>
        markMessagesRead(tx, {
          orgId,
          userId: input.userId,
          messageId: input.messageId,
          upTo: input.upTo,
        }),
      );
    },

    async listMessages(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        await channelOr404(tx, orgId, input.channelId);
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        const rows = (await tx
          .select({
            id: MSG.id,
            channelId: MSG.channelId,
            authorUserId: MSG.authorUserId,
            bodyCipher: MSG.bodyCipher,
            bodyKind: MSG.bodyKind,
            status: MSG.status,
            createdAt: MSG.createdAt,
            parentMessageId: MSG.parentMessageId,
          })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.channelId, input.channelId)))
          .orderBy(asc(MSG.createdAt), asc(MSG.id))
          .limit(limit)) as Array<{
          id: string;
          channelId: string;
          authorUserId: string | null;
          bodyCipher: Buffer;
          bodyKind: string;
          status: string;
          createdAt: Date;
          parentMessageId: string | null;
        }>;
        const messages = rows.map(
          (m): ResolvedMessage => ({
            messageId: m.id,
            channelId: m.channelId,
            authorUserId: m.authorUserId,
            body: m.status === "deleted" ? "" : cipher.open(orgId, m.bodyCipher),
            bodyKind: m.bodyKind as MessageBodyKind,
            createdAt: m.createdAt.toISOString(),
            parentMessageId: m.parentMessageId,
          }),
        );
        return { messages };
      });
    },

    // Auto-sync hooks (§2.3) — driven by source-module outbox events not wired in Phase 1.
    async syncCareTeamChannel() {
      notWired("syncCareTeamChannel");
    },
    async syncOnCallChannel() {
      notWired("syncOnCallChannel");
    },
    async syncBereavementChannel() {
      notWired("syncBereavementChannel");
    },
    async archiveCareTeamChannel() {
      notWired("archiveCareTeamChannel");
    },
  };
}

/** A human title for a freshly opened channel when the caller supplied none (title is NOT NULL). */
function defaultTitle(kind: ChannelKind): string {
  switch (kind) {
    case "announcement":
      return "Announcements";
    case "dm":
      return "Direct message";
    case "care_team":
      return "Care team";
    default:
      return kind.replace(/_/g, " ");
  }
}
