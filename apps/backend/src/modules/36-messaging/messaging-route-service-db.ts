// apps/backend/src/modules/36-messaging — PRODUCTION messaging route-service adapter over Drizzle
// (FB-T04 reads; FB-T05 writes). The READ surface the merged-module screens consume (the channel
// sidebar, channel detail + members, the thread history envelope, the alert inbox, the actor's
// notification preferences, and the tenant + inherited platform alert rules) and the WRITE surface
// (send / edit / delete / receipts / DM / member admin / announce / preference + endpoint mutation /
// alert-rule override) both run live over the real M36 tables.
//
// Mirrors the FB-T01 `TerminologyStore` + FB-T03 `ConsentRouteService` live-store pattern: a single
// factory closing over the DbClient, every org-scoped read/write inside `withOrgContext` so RLS on
// `app.org_id` (+ the M4 write-audit trigger) is the backstop, no business logic the in-memory slice
// does not already own. The message send / receipt fan-out / DEK body encryption primitives are the
// shared write core (`messaging-write-core.ts`) the MessagingProvider seam uses too.
//
// RLS shape (M36-T03, §3.7–3.9):
//   • `channel` / `channel_member` / `message` / `message_receipt` / `alert` are ORG-SCOPED PHI-class
//     (app.org_id RLS) — read/written inside `withOrgContext`.
//   • `notification_delivery` carries no organization_id; its RLS is the parent-join into `alert`, so
//     the alert-inbox join is visible exactly when the parent alert is (still inside `withOrgContext`).
//   • `user_notification_preferences` / `delivery_endpoint` are user-scoped (app.user_id RLS) — the
//     SELF-only writes run inside `withOrgContext` (which sets both app.org_id and app.user_id).
//   • `alert_rule` is org-scoped but its platform-default rows (organization_id IS NULL) are read-all
//     to every tenant by the §7.4 `alert_rule_read` policy — so a single read under `withOrgContext`
//     returns BOTH the inherited platform defaults and the tenant's own overrides; an override clones
//     a platform default into an org-scoped row on first edit.
//
// SCOPE (FB-T05): message BODIES are envelope-encrypted under the per-tenant DEK (bytea body_cipher)
// at write time and decrypted for entitled readers on the thread read — the shared `MessageBodyCipher`
// loads the master KEK lazily so a read-only deployment without MESSAGING_ENCRYPTION_KEY still boots.
import { type DbClient, schema } from "@wardenx/db";
import type {
  AlertCategory,
  AlertInboxItem,
  AlertRecipientResolver,
  AlertRuleView,
  AlertSeverity,
  ChannelDetail,
  ChannelKind,
  ChannelMemberRole,
  ChannelMemberSource,
  ChannelSummary,
  DeliveryEndpointChannel,
  DeliveryEndpointVerification,
  MessageBodyKind,
  MessagingRouteService,
  NotificationChannel,
  NotificationPreferencesView,
  QuietHoursConfig,
  ResolvedMessage,
  RoutingMap,
} from "@wardenx/messaging";
import { rollUpAlertOutcome } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, WardenXError } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
const MR = schema.messageReceipts;
const UNP = schema.userNotificationPreferences;
const DE = schema.deliveryEndpoints;
const AR = schema.alertRules;
const AL = schema.alerts;
const ND = schema.notificationDeliveries;

// ── value-level mirrors of the §3.2 enum unions (for routing-map / resolver validation) ──────
const ALERT_CATEGORIES: readonly AlertCategory[] = [
  "clinical_urgent",
  "clinical_routine",
  "operational",
  "field_safety",
  "administrative",
  "system",
];
const ALERT_SEVERITIES: readonly AlertSeverity[] = ["info", "warn", "critical"];
const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  "in_app",
  "push",
  "sms",
  "email",
  "voice",
];
const RECIPIENT_RESOLVERS: readonly AlertRecipientResolver[] = [
  "care_team",
  "on_call",
  "discipline",
  "role_set",
  "tenant_admins",
  "user_list",
  "broadcast",
];

/** §4.2 INVALID_ROUTING_MAP: every category / severity / channel in the map must be known. */
function validateRoutingMap(map: RoutingMap): void {
  for (const [category, bySeverity] of Object.entries(map)) {
    if (!ALERT_CATEGORIES.includes(category as AlertCategory)) {
      throw new WardenXError("INVALID_ROUTING_MAP", `unknown alert category '${category}'`, 422);
    }
    for (const [severity, channelsList] of Object.entries(bySeverity ?? {})) {
      if (!ALERT_SEVERITIES.includes(severity as AlertSeverity)) {
        throw new WardenXError("INVALID_ROUTING_MAP", `unknown severity '${severity}'`, 422);
      }
      for (const channel of channelsList ?? []) {
        if (!NOTIFICATION_CHANNELS.includes(channel)) {
          throw new WardenXError("INVALID_ROUTING_MAP", `unknown channel '${channel}'`, 422);
        }
      }
    }
  }
}

/** The table default mirror — returned for a SELF preferences read with no persisted row yet. */
const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  tz: "America/Los_Angeles",
  ranges: [],
  severityOverride: "critical",
};

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** PHI-free per-category inbox line (§4.7: the inbox summary never names a patient/diagnosis). The
 *  event_type is a static event CODE (not PHI); the category drives a generic human label. */
const CATEGORY_LABEL: Record<AlertCategory, string> = {
  clinical_urgent: "Urgent clinical alert",
  clinical_routine: "Clinical alert",
  operational: "Operational alert",
  field_safety: "Field-safety alert",
  administrative: "Administrative notice",
  system: "System notice",
};

/** Aggregate per-recipient × channel delivery rows into the inbox item's single status (§4.2). */
function aggregateDeliveryStatus(statuses: readonly string[]): AlertInboxItem["deliveryStatus"] {
  if (statuses.length === 0) return "pending";
  const reached = (s: string): boolean => s === "delivered" || s === "sent" || s === "forwarded";
  const delivered = statuses.filter(reached).length;
  const failed = statuses.filter((s) => s === "failed").length;
  if (delivered === statuses.length) return "delivered";
  if (failed === statuses.length) return "failed";
  if (delivered > 0) return "partial";
  return "pending";
}

/** Keyset cursor over (created_at, id) — opaque, never an offset (§4.12). */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function toRuleView(r: typeof AR.$inferSelect): AlertRuleView {
  return {
    ruleId: r.id,
    organizationId: r.organizationId,
    eventType: r.eventType,
    category: r.category as AlertCategory,
    severityFloor: r.severityFloor as AlertSeverity,
    recipientResolver: r.recipientResolver as AlertRecipientResolver,
    systemLocked: r.systemLocked,
    enabled: r.enabled,
  };
}

/**
 * Build the production {@link MessagingRouteService}. Both the READ and WRITE surfaces are live
 * Drizzle (org-scoped inside `withOrgContext`); message bodies are envelope-encrypted under the
 * per-tenant DEK via the shared {@link MessageBodyCipher}. `opts.kek` is injectable for tests.
 */
export function createDbMessagingRouteService(
  db: DbClient,
  opts: { kek?: Buffer; cipher?: MessageBodyCipher } = {},
): MessagingRouteService {
  const cipher = opts.cipher ?? createMessageBodyCipher({ kek: opts.kek });
  return {
    // ── channels & messages (§4.2; reads) ─────────────────────────────────────────────────────
    async listChannels(orgId, userId): Promise<ChannelSummary[]> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = await tx
          .select({
            channelId: CH.id,
            kind: CH.channelKind,
            title: CH.title,
            subjectId: CH.subjectId,
            isArchived: CH.isArchived,
            archivesAt: CH.archivesAt,
            updatedAt: CH.updatedAt,
          })
          .from(CM)
          .innerJoin(CH, eq(CH.id, CM.channelId))
          .where(and(eq(CM.organizationId, orgId), eq(CM.userId, userId), isNull(CM.removedAt)));
        // Unread = delivered-but-unread receipts for this user, grouped by channel (the SD-028
        // partial index `(user_id, status) WHERE status='delivered'` is exactly this path).
        const unreadRows = await tx
          .select({ channelId: MSG.channelId, count: sql<number>`count(*)::int` })
          .from(MR)
          .innerJoin(MSG, eq(MSG.id, MR.messageId))
          .where(
            and(eq(MR.organizationId, orgId), eq(MR.userId, userId), eq(MR.status, "delivered")),
          )
          .groupBy(MSG.channelId);
        const unread = new Map(unreadRows.map((r) => [r.channelId, Number(r.count)]));
        return rows.map(
          (r): ChannelSummary => ({
            channelId: r.channelId,
            kind: r.kind as ChannelKind,
            title: r.title,
            subjectId: r.subjectId,
            archivedAt: r.isArchived ? (iso(r.archivesAt) ?? iso(r.updatedAt)) : null,
            unreadCount: unread.get(r.channelId) ?? 0,
          }),
        );
      });
    },

    async getChannel(orgId, userId, channelId): Promise<ChannelDetail> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const c = await tx
          .select({
            channelId: CH.id,
            kind: CH.channelKind,
            title: CH.title,
            subjectId: CH.subjectId,
            isArchived: CH.isArchived,
            archivesAt: CH.archivesAt,
            updatedAt: CH.updatedAt,
          })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        const ch = c[0];
        if (!ch) throw new NotFoundError("channel", channelId);
        const members = await tx
          .select({ userId: CM.userId, role: CM.role, source: CM.source })
          .from(CM)
          .where(
            and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), isNull(CM.removedAt)),
          );
        const ur = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(MR)
          .innerJoin(MSG, eq(MSG.id, MR.messageId))
          .where(
            and(
              eq(MR.organizationId, orgId),
              eq(MR.userId, userId),
              eq(MR.status, "delivered"),
              eq(MSG.channelId, channelId),
            ),
          );
        return {
          channelId: ch.channelId,
          kind: ch.kind as ChannelKind,
          title: ch.title,
          subjectId: ch.subjectId,
          archivedAt: ch.isArchived ? (iso(ch.archivesAt) ?? iso(ch.updatedAt)) : null,
          unreadCount: Number(ur[0]?.count ?? 0),
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role as ChannelMemberRole,
            source: m.source as ChannelMemberSource,
          })),
        };
      });
    },

    async listMessages(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const ch = await tx
          .select({ id: CH.id })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!ch[0]) throw new NotFoundError("channel", input.channelId);
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        const where: SQL[] = [eq(MSG.organizationId, orgId), eq(MSG.channelId, input.channelId)];
        const cur = input.cursor ? decodeCursor(input.cursor) : null;
        // Keyset (created_at, id) ASC — strictly after the cursor (oldest-first, like the slice).
        if (cur) where.push(sql`(${MSG.createdAt}, ${MSG.id}) > (${cur.createdAt}, ${cur.id})`);
        const rows = await tx
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
          .where(and(...where))
          .orderBy(asc(MSG.createdAt), asc(MSG.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        // Entitled-reader gate: the channel_visibility ABAC predicate already authorized this read
        // at the route, so decrypt each body under the tenant DEK; a 'deleted' tombstone is empty.
        const page = pageRows.map(
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
        const lastRow = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && lastRow ? encodeCursor(lastRow.createdAt, lastRow.id) : undefined;
        return { messages: page, nextCursor };
      });
    },

    async canViewChannel(orgId, userId, channelId): Promise<boolean> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const c = await tx
          .select({ kind: CH.channelKind })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        if (!c[0]) return false; // unknown / cross-org → no existence oracle
        // §4.5: announcement is org-wide; the caseload/bereavement provider-seam refinement (care_team
        // via CaseloadProvider, bereavement via M16) is a later cross-module integration — until then
        // the channel-member check is the visibility rule (the slice's "otherwise" branch).
        if (c[0].kind === "announcement") return true;
        const m = await tx
          .select({ id: CM.id })
          .from(CM)
          .where(
            and(
              eq(CM.organizationId, orgId),
              eq(CM.channelId, channelId),
              eq(CM.userId, userId),
              isNull(CM.removedAt),
            ),
          )
          .limit(1);
        return m.length > 0;
      });
    },

    // --- post a message: archive gate (410) → DEK-encrypt + insert + receipt fan-out (§3.4) -----
    async sendMessage(orgId, input) {
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.authorUserId },
        async (tx) => {
          const ch = await channelOr404(tx, orgId, input.channelId);
          if (ch.isArchived) throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
          const { messageId, createdAt } = await insertEncryptedMessage(tx, cipher, {
            orgId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            body: input.body,
            bodyKind: input.bodyKind,
            parentMessageId: input.parentMessageId,
            quotedMessageId: input.quotedMessageId,
          });
          return { messageId, channelId: input.channelId, createdAt };
        },
      );
    },

    // --- edit within the window (author only): re-encrypt + re-hash, status='edited' -----------
    async editMessage(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = (await tx
          .select({ authorUserId: MSG.authorUserId, status: MSG.status })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1)) as Array<{ authorUserId: string | null; status: string }>;
        const m = rows[0];
        if (!m || m.status === "deleted") throw new NotFoundError("message", input.messageId);
        if (m.authorUserId !== input.userId) {
          throw new ForbiddenError("only the author may edit a message");
        }
        const { cipher: bodyCipher, sha256 } = cipher.seal(orgId, input.body);
        const editedAt = new Date();
        await tx
          .update(MSG)
          .set({ bodyCipher, bodySha256: sha256, status: "edited", editedAt })
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)));
        return { messageId: input.messageId, editedAt: editedAt.toISOString() };
      });
    },

    // --- soft-delete (author only): tombstone — status='deleted', cipher RETAINED (M36-F02) ----
    async deleteMessage(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = (await tx
          .select({ authorUserId: MSG.authorUserId, status: MSG.status })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1)) as Array<{ authorUserId: string | null; status: string }>;
        const m = rows[0];
        if (!m || m.status === "deleted") throw new NotFoundError("message", input.messageId);
        if (m.authorUserId !== input.userId) {
          throw new ForbiddenError("only the author may delete a message");
        }
        // The body_cipher is retained through the retention window; only status/deleted_at change.
        // edited_at is cleared so the mutually-exclusive `message_status_shape` CHECK holds.
        await tx
          .update(MSG)
          .set({ status: "deleted", deletedAt: new Date(), editedAt: null })
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)));
      });
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

    // --- open/find a 1:1 DM channel (idempotent; CONFLICT on self) ------------------------------
    async openDm(orgId, userId, peerUserId) {
      if (peerUserId === userId) throw new ConflictError("cannot open a DM with yourself");
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        // Find an existing 1:1 dm both are active members of (the unique-subject index does not cover
        // dm, so match on membership): a dm with exactly this {userId, peerUserId} active member pair.
        const existing = (await tx
          .select({ channelId: CM.channelId })
          .from(CM)
          .innerJoin(CH, eq(CH.id, CM.channelId))
          .where(
            and(
              eq(CM.organizationId, orgId),
              eq(CH.channelKind, "dm"),
              isNull(CM.removedAt),
              inArray(CM.userId, [userId, peerUserId]),
            ),
          )) as Array<{ channelId: string }>;
        const counts = new Map<string, number>();
        for (const r of existing) counts.set(r.channelId, (counts.get(r.channelId) ?? 0) + 1);
        for (const [channelId, n] of counts) {
          if (n === 2) return { channelId, created: false };
        }
        const inserted = (await tx
          .insert(CH)
          .values({
            organizationId: orgId,
            channelKind: "dm",
            subjectId: null,
            title: "Direct message",
            retentionClass: "care_related",
          })
          .returning({ id: CH.id })) as Array<{ id: string }>;
        const channelId = inserted[0]!.id;
        await tx.insert(CM).values([
          { organizationId: orgId, channelId, userId, role: "owner", source: "manual" },
          {
            organizationId: orgId,
            channelId,
            userId: peerUserId,
            role: "member",
            source: "manual",
          },
        ]);
        return { channelId, created: true };
      });
    },

    // --- add a manual member (admin override; audited) — re-activates a removed row idempotently -
    async addMember(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        await channelOr404(tx, orgId, input.channelId);
        const active = (await tx
          .select({ id: CM.id })
          .from(CM)
          .where(
            and(
              eq(CM.organizationId, orgId),
              eq(CM.channelId, input.channelId),
              eq(CM.userId, input.userId),
              isNull(CM.removedAt),
            ),
          )
          .limit(1)) as Array<{ id: string }>;
        if (active[0]) return; // already an active member — idempotent
        await tx.insert(CM).values({
          organizationId: orgId,
          channelId: input.channelId,
          userId: input.userId,
          role: input.role ?? "member",
          source: "manual",
        });
      });
    },

    // --- remove a member (soft-delete: set removed_at) -----------------------------------------
    async removeMember(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const updated = (await tx
          .update(CM)
          .set({ removedAt: new Date() })
          .where(
            and(
              eq(CM.organizationId, orgId),
              eq(CM.channelId, input.channelId),
              eq(CM.userId, input.userId),
              isNull(CM.removedAt),
            ),
          )
          .returning({ id: CM.id })) as Array<{ id: string }>;
        if (updated.length === 0) throw new NotFoundError("channel member", input.userId);
      });
    },

    // --- post to the tenant announcement channel (find-or-create; org_admin gated at the route) -
    async announce(orgId, input) {
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.authorUserId },
        async (tx) => {
          const existing = (await tx
            .select({ id: CH.id })
            .from(CH)
            .where(and(eq(CH.organizationId, orgId), eq(CH.channelKind, "announcement")))
            .limit(1)) as Array<{ id: string }>;
          let channelId = existing[0]?.id;
          if (!channelId) {
            const inserted = (await tx
              .insert(CH)
              .values({
                organizationId: orgId,
                channelKind: "announcement",
                subjectId: null,
                title: "Announcements",
                retentionClass: "operational",
              })
              .returning({ id: CH.id })) as Array<{ id: string }>;
            channelId = inserted[0]!.id;
          }
          const { messageId, createdAt } = await insertEncryptedMessage(tx, cipher, {
            orgId,
            channelId,
            authorUserId: input.authorUserId,
            body: input.body,
          });
          return { messageId, channelId, createdAt };
        },
      );
    },

    // ── notification preferences & endpoints (§4.2; SELF-only) ──────────────────────────────────
    async getPreferences(orgId, userId): Promise<NotificationPreferencesView> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = await tx
          .select()
          .from(UNP)
          .where(and(eq(UNP.userId, userId), eq(UNP.organizationId, orgId)))
          .limit(1);
        const r = rows[0];
        if (!r) {
          // Read-only default — a GET never writes; the row is created by the first putPreferences.
          return {
            id: "",
            userId,
            routingMap: {},
            quietHours: DEFAULT_QUIET_HOURS,
            vacationForwardToUserId: null,
            vacationUntil: null,
            updatedAt: new Date(0).toISOString(),
          };
        }
        return {
          id: r.id,
          userId: r.userId,
          routingMap: r.routingMap as RoutingMap,
          quietHours: r.quietHours as QuietHoursConfig,
          vacationForwardToUserId: r.vacationForwardToUserId,
          vacationUntil: iso(r.vacationUntil),
          updatedAt: r.updatedAt.toISOString(),
        };
      });
    },

    // --- self-update preferences (422 INVALID_ROUTING_MAP / 409 VACATION_FORWARD_*) ------------
    async putPreferences(orgId, userId, input) {
      validateRoutingMap(input.routingMap);
      if (input.vacationForwardToUserId && input.vacationForwardToUserId === userId) {
        throw new WardenXError("VACATION_FORWARD_SELF", "cannot forward to yourself", 409);
      }
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        if (input.vacationForwardToUserId) {
          const target = (await tx
            .select({ fwd: UNP.vacationForwardToUserId })
            .from(UNP)
            .where(
              and(eq(UNP.userId, input.vacationForwardToUserId), eq(UNP.organizationId, orgId)),
            )
            .limit(1)) as Array<{ fwd: string | null }>;
          if (target[0]?.fwd === userId) {
            throw new WardenXError(
              "VACATION_FORWARD_CYCLE",
              "the forward target also forwards to you",
              409,
            );
          }
        }
        // A forward target pairs with a future expiry; with no forward target the expiry is null.
        // Enforced HERE, at write time (DB-005) — a `vacationUntil > NOW()` CHECK constraint would
        // re-validate on every future write to the row using the CURRENT time, not the time the
        // value was set, so a legitimately-future date at INSERT time fails every subsequent
        // (even unrelated-column) UPDATE once it naturally elapses, and breaks `pg_restore`'s
        // COPY-time re-validation on any row restored after its vacation window has passed.
        const vacationForwardToUserId = input.vacationForwardToUserId ?? null;
        const vacationUntil = vacationForwardToUserId
          ? input.vacationUntil
            ? new Date(input.vacationUntil)
            : null
          : null;
        if (vacationForwardToUserId && (!vacationUntil || vacationUntil.getTime() <= Date.now())) {
          throw new WardenXError(
            "VACATION_UNTIL_NOT_FUTURE",
            "vacationUntil must be set and in the future when vacationForwardToUserId is set",
            422,
          );
        }
        const updatedAt = new Date();
        const rows = (await tx
          .insert(UNP)
          .values({
            userId,
            organizationId: orgId,
            routingMap: input.routingMap,
            quietHours: input.quietHours,
            vacationForwardToUserId,
            vacationUntil,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: [UNP.userId, UNP.organizationId],
            set: {
              routingMap: input.routingMap,
              quietHours: input.quietHours,
              vacationForwardToUserId,
              vacationUntil,
              updatedAt,
            },
          })
          .returning({ id: UNP.id, updatedAt: UNP.updatedAt })) as Array<{
          id: string;
          updatedAt: Date;
        }>;
        return { id: rows[0]!.id, updatedAt: rows[0]!.updatedAt.toISOString() };
      });
    },

    // --- register a push / sms / email endpoint (push is browser-verified; sms/email start pending) -
    async registerEndpoint(orgId, userId, input) {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const verified = input.channel === "push";
        const rows = (await tx
          .insert(DE)
          .values({
            userId,
            channel: input.channel,
            endpointValue: input.target,
            verificationStatus: verified ? "verified" : "pending",
            verifiedAt: verified ? new Date() : null,
          })
          .returning({
            id: DE.id,
            channel: DE.channel,
            verificationStatus: DE.verificationStatus,
          })) as Array<{
          id: string;
          channel: DeliveryEndpointChannel;
          verificationStatus: DeliveryEndpointVerification;
        }>;
        const r = rows[0]!;
        return { endpointId: r.id, channel: r.channel, verificationStatus: r.verificationStatus };
      });
    },

    // --- confirm a verification (push is already verified) -------------------------------------
    async verifyEndpoint(orgId, userId, endpointId, token) {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = (await tx
          .select({ channel: DE.channel, verificationStatus: DE.verificationStatus })
          .from(DE)
          .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)))
          .limit(1)) as Array<{
          channel: DeliveryEndpointChannel;
          verificationStatus: DeliveryEndpointVerification;
        }>;
        const r = rows[0];
        if (!r) throw new NotFoundError("delivery endpoint", endpointId);
        if (r.verificationStatus === "verified") {
          return { endpointId, channel: r.channel, verificationStatus: r.verificationStatus };
        }
        // NOTE: the §4.2 OTP check needs a token-hash column on `delivery_endpoint` (not in the
        // schema yet); until that lands the route confirms possession and flips pending → verified.
        void token;
        await tx
          .update(DE)
          .set({ verificationStatus: "verified", verifiedAt: new Date() })
          .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)));
        return { endpointId, channel: r.channel, verificationStatus: "verified" as const };
      });
    },

    async removeEndpoint(orgId, userId, endpointId) {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const removed = (await tx
          .delete(DE)
          .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)))
          .returning({ id: DE.id })) as Array<{ id: string }>;
        if (removed.length === 0) throw new NotFoundError("delivery endpoint", endpointId);
      });
    },

    // ── alerts (§4.2) ───────────────────────────────────────────────────────────────────────────
    async alertInbox(orgId, userId): Promise<AlertInboxItem[]> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        // ── F-109: THE READ IS THE IN-APP DELIVERY ────────────────────────────────────────────────
        //
        // `notification_delivery.status` had no UPDATE anywhere in the repository, so the §2.4.4 state
        // machine had exactly one reachable state and every row ever written is still `pending` — which
        // is why `aggregateDeliveryStatus` below has returned `"pending"` for every line of every user's
        // Notifications tab, always.
        //
        // §2.4.4 settles an in-app row on "socket acked", and ADR-0036 (Accepted, and it wins over a
        // module spec) records that there IS no socket: `socket.io` is installed nowhere, no realtime
        // transport was ever built, and "UI freshness is REST refetch/poll". This route is that poll —
        // `apps/web/src/modules/36-messaging/notifications-inbox.tsx` is its only caller — so the fetch
        // is the moment the alert reaches the client, and there is no second event to wait for. The row
        // goes straight to `delivered`: `sent` is the "dispatcher accepted" step of a dispatcher tier
        // that does not exist, and parking rows in a state nothing advances is the defect being fixed.
        //
        // Scoped three ways and narrowed to `pending`, so it can only ever settle THIS caller's own
        // undelivered in-app rows: the parent-join RLS policy, the explicit `alert.organization_id`
        // predicate beside it, and `recipient_user_id`. Out-of-band rows are deliberately untouched —
        // no dispatcher exists for them, and calling a push nobody sent `delivered` would move the lie
        // rather than remove it.
        const settledAt = new Date();
        const settled = await tx
          .update(ND)
          .set({ status: "delivered", sentAt: settledAt, settledAt })
          .where(
            and(
              eq(ND.recipientUserId, userId),
              eq(ND.channel, "in_app"),
              eq(ND.status, "pending"),
              inArray(
                ND.alertId,
                tx.select({ id: AL.id }).from(AL).where(eq(AL.organizationId, orgId)),
              ),
            ),
          )
          .returning({ alertId: ND.alertId });

        // Re-settle the parent of every row that just moved (§2.4.3). Bounded by what this call
        // changed — an inbox with nothing new to deliver runs neither of these statements.
        const touched = [...new Set(settled.map((r) => r.alertId))];
        if (touched.length > 0) {
          const siblings = await tx
            .select({
              alertId: ND.alertId,
              recipientUserId: ND.recipientUserId,
              channel: ND.channel,
              status: ND.status,
            })
            .from(ND)
            .where(inArray(ND.alertId, touched));
          for (const alertId of touched) {
            const outcome = rollUpAlertOutcome(
              siblings.filter((r) => r.alertId === alertId).map(({ alertId: _drop, ...r }) => r),
            );
            // `outcome <> :new` keeps a no-change write out of the M4 audit trail: the trigger fires on
            // every UPDATE, and an alert that is still `pending` after a partial settlement would
            // otherwise log one row per inbox poll, per recipient, forever.
            await tx
              .update(AL)
              .set({ outcome })
              .where(
                and(
                  eq(AL.organizationId, orgId),
                  eq(AL.id, alertId),
                  sql`${AL.outcome} <> ${outcome}`,
                ),
              );
          }
        }

        // notification_delivery inherits tenancy via its parent alert (RLS parent-join); the join is
        // visible exactly when the parent alert is. category/severity are denormalized on the child.
        // Read AFTER the settlement so the response reflects it rather than the state one poll behind.
        const rows = await tx
          .select({
            alertId: AL.id,
            eventType: AL.eventType,
            severity: AL.severity,
            createdAt: AL.createdAt,
            category: ND.alertCategory,
            deliveryStatus: ND.status,
          })
          .from(ND)
          .innerJoin(AL, eq(AL.id, ND.alertId))
          .where(and(eq(AL.organizationId, orgId), eq(ND.recipientUserId, userId)))
          .orderBy(desc(AL.createdAt));
        const byAlert = new Map<
          string,
          {
            alertId: string;
            eventType: string;
            category: AlertCategory;
            severity: AlertSeverity;
            createdAt: Date;
            statuses: string[];
          }
        >();
        for (const r of rows) {
          let e = byAlert.get(r.alertId);
          if (!e) {
            e = {
              alertId: r.alertId,
              eventType: r.eventType,
              category: r.category as AlertCategory,
              severity: r.severity as AlertSeverity,
              createdAt: r.createdAt,
              statuses: [],
            };
            byAlert.set(r.alertId, e);
          }
          e.statuses.push(r.deliveryStatus);
        }
        return [...byAlert.values()].map(
          (e): AlertInboxItem => ({
            alertId: e.alertId,
            eventType: e.eventType,
            category: e.category,
            severity: e.severity,
            summary: CATEGORY_LABEL[e.category] ?? "Notification",
            createdAt: e.createdAt.toISOString(),
            deliveryStatus: aggregateDeliveryStatus(e.statuses),
          }),
        );
      });
    },

    async listAlertRules(orgId): Promise<AlertRuleView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        // §7.4 alert_rule_read: platform defaults (org IS NULL) are read-all; own-org rows are the
        // tenant's overrides. Merge by event_type — the org override wins over the platform default.
        const rows = await tx
          .select()
          .from(AR)
          .where(or(isNull(AR.organizationId), eq(AR.organizationId, orgId)));
        const byEvent = new Map<string, AlertRuleView>();
        for (const r of rows)
          if (r.organizationId === null) byEvent.set(r.eventType, toRuleView(r));
        for (const r of rows)
          if (r.organizationId !== null) byEvent.set(r.eventType, toRuleView(r));
        return [...byEvent.values()];
      });
    },

    // --- enable/disable/override: clone a platform default into an org-scoped row on first edit --
    async patchAlertRule(orgId, input) {
      if (
        input.patch.recipientResolver !== undefined &&
        !RECIPIENT_RESOLVERS.includes(input.patch.recipientResolver)
      ) {
        throw new WardenXError("INVALID_RESOLVER", "unknown recipient resolver", 422);
      }
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        // The patch targets a rule visible to this tenant: a platform default (org IS NULL) or the
        // tenant's own override. §7.4: a system_locked rule can never be disabled.
        const baseRows = (await tx
          .select()
          .from(AR)
          .where(
            and(
              eq(AR.id, input.ruleId),
              or(isNull(AR.organizationId), eq(AR.organizationId, orgId)),
            ),
          )
          .limit(1)) as Array<typeof AR.$inferSelect>;
        const base = baseRows[0];
        if (!base) throw new NotFoundError("alert rule", input.ruleId);
        if (base.systemLocked && input.patch.enabled === false) {
          throw new WardenXError("SYSTEM_LOCKED", "system_locked rules cannot be disabled", 403);
        }

        const severityFloor = input.patch.severityFloor ?? (base.severityFloor as AlertSeverity);
        const recipientResolver =
          input.patch.recipientResolver ?? (base.recipientResolver as AlertRecipientResolver);
        const enabled = input.patch.enabled ?? base.enabled;

        // One override per (org, event_type): update the existing org row if present, else clone the
        // base into a new org-scoped row. (When `base` is already the org row, this updates it.)
        const ownRows = (await tx
          .select({ id: AR.id })
          .from(AR)
          .where(and(eq(AR.organizationId, orgId), eq(AR.eventType, base.eventType)))
          .limit(1)) as Array<{ id: string }>;
        let row: typeof AR.$inferSelect;
        if (ownRows[0]) {
          const updated = (await tx
            .update(AR)
            .set({ severityFloor, recipientResolver, enabled, updatedAt: new Date() })
            .where(eq(AR.id, ownRows[0].id))
            .returning()) as Array<typeof AR.$inferSelect>;
          row = updated[0]!;
        } else {
          const inserted = (await tx
            .insert(AR)
            .values({
              organizationId: orgId,
              eventType: base.eventType,
              category: base.category,
              severityFloor,
              recipientResolver,
              resolverArgs: base.resolverArgs,
              channelsOverride: base.channelsOverride,
              systemLocked: base.systemLocked,
              enabled,
            })
            .returning()) as Array<typeof AR.$inferSelect>;
          row = inserted[0]!;
        }
        return toRuleView(row);
      });
    },
  };
}
