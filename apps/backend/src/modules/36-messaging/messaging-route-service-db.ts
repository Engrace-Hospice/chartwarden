// apps/backend/src/modules/36-messaging — PRODUCTION messaging route-service adapter over Drizzle
// (FB-T04). The READ surface the merged-module screens consume (the channel sidebar, channel detail
// + members, the thread history envelope, the alert inbox, the actor's notification preferences, and
// the tenant + inherited platform alert rules) runs live over the real M36 tables; the WRITE surface
// (send / edit / delete / receipts / DM / member admin / announce / preference + endpoint mutation /
// alert-rule override) stays fail-clear (501) until the MessagingProvider write path lands in FB-T05.
//
// Mirrors the FB-T01 `TerminologyStore` + FB-T03 `ConsentRouteService` live-store pattern: a single
// factory closing over the DbClient, every org-scoped read inside `withOrgContext` so RLS on
// `app.org_id` is the backstop, no business logic the in-memory slice does not already own.
//
// RLS shape (M36-T03, §3.7–3.9):
//   • `channel` / `channel_member` / `message` / `message_receipt` / `alert` are ORG-SCOPED PHI-class
//     (app.org_id RLS) — read inside `withOrgContext`.
//   • `notification_delivery` carries no organization_id; its RLS is the parent-join into `alert`, so
//     the alert-inbox join is visible exactly when the parent alert is (still inside `withOrgContext`).
//   • `alert_rule` is org-scoped but its platform-default rows (organization_id IS NULL) are read-all
//     to every tenant by the §7.4 `alert_rule_read` policy — so a single read under `withOrgContext`
//     returns BOTH the inherited platform defaults and the tenant's own overrides.
//
// SCOPE (FB-T04): message BODIES are envelope-encrypted under the per-tenant DEK (bytea body_cipher),
// and the M1 KEK/DEK helper that decrypts them is wired in FB-T05 — so the thread read returns the
// real message envelope (author / kind / timestamps / thread structure) with a clear placeholder body
// rather than a half-truth or a hard error. Likewise the SELF preferences read SYNTHESIZES the default
// view when no row exists instead of writing one (row creation is a write, FB-T05).
import { type DbClient, schema } from "@wardenx/db";
import {
  type AlertCategory,
  type AlertInboxItem,
  type AlertRecipientResolver,
  type AlertRuleView,
  type AlertSeverity,
  type ChannelDetail,
  type ChannelKind,
  type ChannelMemberRole,
  type ChannelMemberSource,
  type ChannelSummary,
  type MessageBodyKind,
  type MessagingRouteService,
  type NotificationPreferencesView,
  type QuietHoursConfig,
  type ResolvedMessage,
  type RoutingMap,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;
const UNP = schema.userNotificationPreferences;
const AR = schema.alertRules;
const AL = schema.alerts;
const ND = schema.notificationDeliveries;

/** Shown in place of a message body until the per-tenant DEK decryption path lands (FB-T05). The
 *  thread structure (author/kind/timestamps) is live; only the ciphertext stays sealed. */
const BODY_PENDING_DECRYPTION = "[message body decryption arrives in FB-T05]";

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

/** The message/preference/endpoint/alert-rule WRITES need the MessagingProvider write path —
 *  per-channel DEK body encryption, receipt fan-out, append-only edit/delete tombstones — not wired
 *  on the request handle in FB-T04. Fail clear rather than write a half-formed row (FB-T05). */
function writeNotWired(op: string): never {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    `${op} runs through the M36 MessagingProvider write path (per-channel DEK encryption + receipts), not wired in FB-T04 (lands in FB-T05)`,
    501,
  );
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
 * Build the production {@link MessagingRouteService}. The READ surface is live Drizzle (org-scoped
 * reads inside `withOrgContext`); the WRITE surface defers to the MessagingProvider write path (501).
 */
export function createDbMessagingRouteService(db: DbClient): MessagingRouteService {
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
          .where(and(eq(MR.organizationId, orgId), eq(MR.userId, userId), eq(MR.status, "delivered")))
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
        const page = pageRows.map(
          (m): ResolvedMessage => ({
            messageId: m.id,
            channelId: m.channelId,
            authorUserId: m.authorUserId,
            // Body decryption (per-tenant DEK) lands in FB-T05; deleted is a tombstone (empty body).
            body: m.status === "deleted" ? "" : BODY_PENDING_DECRYPTION,
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
        // §4.5: announcement is org-wide; the caseload/bereavement provider seams are wired with the
        // write path (FB-T05) — until then the channel-member check is the visibility rule (the
        // slice's "otherwise" branch).
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

    async sendMessage() {
      return writeNotWired("posting a message");
    },
    async editMessage() {
      return writeNotWired("editing a message");
    },
    async deleteMessage() {
      return writeNotWired("deleting a message");
    },
    async markRead() {
      return writeNotWired("marking a message read");
    },
    async openDm() {
      return writeNotWired("opening a DM");
    },
    async addMember() {
      return writeNotWired("adding a channel member");
    },
    async removeMember() {
      return writeNotWired("removing a channel member");
    },
    async announce() {
      return writeNotWired("posting an announcement");
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
          // Read-only default — the slice persists on first read; FB-T04 synthesizes it (the row
          // creation is a write that lands with the preferences mutation in FB-T05).
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

    async putPreferences() {
      return writeNotWired("updating notification preferences");
    },
    async registerEndpoint() {
      return writeNotWired("registering a delivery endpoint");
    },
    async verifyEndpoint() {
      return writeNotWired("verifying a delivery endpoint");
    },
    async removeEndpoint() {
      return writeNotWired("removing a delivery endpoint");
    },

    // ── alerts (§4.2) ───────────────────────────────────────────────────────────────────────────
    async alertInbox(orgId, userId): Promise<AlertInboxItem[]> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        // notification_delivery inherits tenancy via its parent alert (RLS parent-join); the join is
        // visible exactly when the parent alert is. category/severity are denormalized on the child.
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
        for (const r of rows) if (r.organizationId === null) byEvent.set(r.eventType, toRuleView(r));
        for (const r of rows) if (r.organizationId !== null) byEvent.set(r.eventType, toRuleView(r));
        return [...byEvent.values()];
      });
    },

    async patchAlertRule() {
      return writeNotWired("overriding an alert rule");
    },
  };
}
