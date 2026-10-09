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
//   • `notification_delivery` / `alert_receipt` carry no organization_id; their RLS is the parent-join
//     into `alert`, so the alert-inbox join/receipt is visible exactly when the parent alert is (still
//     inside `withOrgContext`). `alert_receipt` (migration 0243) shipped without this — see 0247.
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
import {
  type MemberAdminActor,
  PLATFORM_DEFAULT_ALERT_RULES,
  type PatientLocationResolver,
  assertLockedRulePatchAllowed,
  isSystemLockedEventType,
  mayManageChannelMembersResolved,
  rollUpAlertOutcome,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, WardenXError } from "@wardenx/types";
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { projectAlertInboxPresentation } from "./alert-inbox-presentation";
import {
  MAX_VERIFICATION_ATTEMPTS,
  VERIFICATION_CODE_TTL_MS,
  type VerificationOutcome,
  checkVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
} from "./endpoint-verification";
import {
  type MessageBodyCipher,
  channelOr404,
  createMessageBodyCipher,
  insertEncryptedMessage,
  markMessagesRead,
} from "./messaging-write-core";
import { type Part2ChannelGate, createSeamPart2ChannelGate } from "./part2-channel-gate";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;
const UNP = schema.userNotificationPreferences;
const DE = schema.deliveryEndpoints;
const AR = schema.alertRules;
const AL = schema.alerts;
const ND = schema.notificationDeliveries;
const ARCP = schema.alertReceipts;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;
const MEMBERSHIP_ROLE = schema.membershipRoles;
const ROLE = schema.roles;

function dmParticipantKey(userId: string, peerUserId: string): string {
  return [userId, peerUserId].sort().join(":");
}

async function isActiveMessagingUser(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: MEMBERSHIP.id })
    .from(MEMBERSHIP)
    .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
    .where(
      and(
        eq(MEMBERSHIP.organizationId, orgId),
        eq(MEMBERSHIP.userId, userId),
        eq(MEMBERSHIP.status, "active"),
        eq(USER.status, "active"),
      ),
    )
    .limit(1);
  return !!rows[0];
}

async function assertActiveMessagingUser(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  userId: string,
): Promise<void> {
  if (!(await isActiveMessagingUser(tx, orgId, userId))) {
    // One indistinguishable response for absent, suspended, revoked, deactivated, and foreign users.
    throw new NotFoundError("eligible staff member", userId);
  }
}

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
/** The audit context for a member write: the real user, or "" only for the explicit system actor. */
function memberAdminContext(orgId: string, actor: MemberAdminActor) {
  return { organizationId: orgId, userId: actor.kind === "user" ? actor.userId : "" };
}

async function memberAdminChannel(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  channelId: string,
): Promise<{ kind: string; subjectId: string | null } | null> {
  const rows = (await tx
    .select({ kind: CH.channelKind, subjectId: CH.subjectId })
    .from(CH)
    .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
    .limit(1)) as Array<{ kind: string; subjectId: string | null }>;
  return rows[0] ?? null;
}

/** Service-layer enforcement of the §4.5 `location_membership` rule (NOT_FOUND → FORBIDDEN). */
async function assertMayManageMembers(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  channelId: string,
  actor: MemberAdminActor,
  resolveSiting: PatientLocationResolver,
): Promise<void> {
  const ch = await memberAdminChannel(tx, orgId, channelId);
  if (!ch) throw new NotFoundError("channel", channelId);
  if (ch.kind === "dm") {
    throw new ForbiddenError("direct-message membership cannot be changed");
  }
  if (
    !(await mayManageChannelMembersResolved(actor, ch, (patientId) =>
      resolveSiting(orgId, patientId),
    ))
  ) {
    throw new ForbiddenError("not permitted to manage members of this channel");
  }
}

async function ensureDmMember(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  channelId: string,
  userId: string,
  role: "owner" | "member",
): Promise<void> {
  const rows = await tx
    .select({ id: CM.id, removedAt: CM.removedAt })
    .from(CM)
    .where(and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), eq(CM.userId, userId)))
    .orderBy(desc(CM.joinedAt));
  if (rows.some((row) => row.removedAt === null)) return;
  const reusable = rows[0];
  if (reusable) {
    await tx
      .update(CM)
      .set({ removedAt: null, role, source: "manual", joinedAt: new Date() })
      .where(and(eq(CM.organizationId, orgId), eq(CM.id, reusable.id)));
    return;
  }
  await tx
    .insert(CM)
    .values({ organizationId: orgId, channelId, userId, role, source: "manual" })
    .onConflictDoNothing();
}

/** Default siting resolver: M6's siting seam via `getSeam` (an unbound deny-stub throws ⇒ deny). */
const seamPatientLocationIds: PatientLocationResolver = (organizationId, patientId) =>
  getSeam("PatientSitingReader").getPatientLocationIds({ organizationId, patientId });

/** Map a failed OTP outcome to its HTTP error (the in-memory service uses the same `INVALID_TOKEN`). */
function verificationFailure(outcome: Exclude<VerificationOutcome, "ok">): WardenXError {
  switch (outcome) {
    case "locked":
      return new WardenXError(
        "VERIFICATION_LOCKED",
        `too many wrong codes (max ${MAX_VERIFICATION_ATTEMPTS}); re-register the endpoint for a new code`,
        429,
      );
    case "expired":
      return new WardenXError(
        "VERIFICATION_EXPIRED",
        "verification code expired; re-register the endpoint for a new code",
        422,
      );
    case "not_issued":
      return new WardenXError(
        "VERIFICATION_NOT_ISSUED",
        "no verification code was issued for this endpoint; re-register it",
        422,
      );
    case "mismatch":
      return new WardenXError("INVALID_TOKEN", "verification token does not match", 422);
  }
}

export function createDbMessagingRouteService(
  db: DbClient,
  opts: {
    kek?: Buffer;
    cipher?: MessageBodyCipher;
    resolvePatientLocationIds?: PatientLocationResolver;
    /**
     * GAP-166 — delivers the freshly issued sms/email verification code to the endpoint itself. There is no
     * out-of-band dispatcher yet, so by default NOTHING is sent and the endpoint simply stays `pending`
     * (fail closed: an unverified endpoint is never a delivery target). A throw rolls the registration back.
     */
    /** GAP-065 — the M39 Part 2 consent gate on care_team visibility (default: seam-backed, fail-closed). */
    part2Gate?: Part2ChannelGate;
    sendEndpointVerificationCode?: (input: {
      channel: DeliveryEndpointChannel;
      target: string;
      code: string;
    }) => Promise<void>;
  } = {},
): MessagingRouteService {
  const resolveSiting = opts.resolvePatientLocationIds ?? seamPatientLocationIds;
  const part2Gate = opts.part2Gate ?? createSeamPart2ChannelGate(db);
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
          .select({
            channelId: MSG.channelId,
            count: sql<number>`count(*)::int`,
          })
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
          patientId: ch.kind === "care_team" ? ch.subjectId : null,
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
          .select({ id: CH.id, kind: CH.channelKind, subjectId: CH.subjectId })
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
        return {
          messages: page,
          nextCursor,
          patientId: ch[0].kind === "care_team" ? ch[0].subjectId : null,
        };
      });
    },

    async canViewChannel(orgId, userId, channelId): Promise<boolean> {
      const access = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        if (!(await isActiveMessagingUser(tx, orgId, userId))) return null;
        const c = await tx
          .select({ kind: CH.channelKind, subjectId: CH.subjectId })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        if (!c[0]) return null; // unknown / cross-org → no existence oracle
        // §4.5: announcement is org-wide; the bereavement provider-seam refinement (M16) is a later
        // cross-module integration — until then the channel-member check is the visibility rule.
        if (c[0].kind === "announcement") return { visible: true as const };
        const m = await tx
          .select({ source: CM.source })
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
        if (!m[0]) return { visible: false as const };
        const patientId = c[0].subjectId;
        if (c[0].kind !== "care_team" || !patientId) return { visible: true as const };
        return m[0].source === "auto"
          ? { visible: true as const, rosterPatientId: patientId, consentPatientId: patientId }
          : { visible: true as const, consentPatientId: patientId };
      });
      if (!access?.visible) return false;
      // GAP-065 / spec §7.13 — the PULL half of the M39 cascade: a care_team channel about a SUD-flagged
      // patient is visible only to members M39's Part 2 release covers, re-asked on every read (so a
      // revocation closes access at once). Manual admin-override members are gated too. Fail-closed: an
      // unreadable flag or an unanswerable evaluator denies.
      if ("consentPatientId" in access && access.consentPatientId) {
        try {
          const permitted = await part2Gate.allowedUserIds({
            organizationId: orgId,
            patientId: access.consentPatientId,
            userIds: [userId],
          });
          if (!permitted.has(userId)) return false;
        } catch {
          return false;
        }
      }
      if (!("rosterPatientId" in access) || !access.rosterPatientId) return true;
      // GAP-104 — caseload_membership (§4.5, care_team): an AUTO member must also be on the patient's
      // CURRENT care team. The roster read stays outside the tx above (the seam opens its own connection),
      // and it revokes access the instant a clinician is unassigned, independent of the sync consumer's lag.
      // A `manual` (admin-override) member is authorized by the override itself.
      const roster = await getSeam("CareTeamProvider").careTeamMembers({
        organizationId: orgId,
        patientId: access.rosterPatientId,
      });
      return roster.includes(userId);
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
          .limit(1)) as Array<{
          authorUserId: string | null;
          status: string;
        }>;
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
        return {
          messageId: input.messageId,
          editedAt: editedAt.toISOString(),
        };
      });
    },

    // --- soft-delete (author only): tombstone — status='deleted', cipher RETAINED (M36-F02) ----
    async deleteMessage(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const rows = (await tx
          .select({ authorUserId: MSG.authorUserId, status: MSG.status })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1)) as Array<{
          authorUserId: string | null;
          status: string;
        }>;
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

    async searchDmEligibleStaff(orgId, userId, query) {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        await assertActiveMessagingUser(tx, orgId, userId);
        const needle = query.trim().slice(0, 100);
        const memberships = await tx
          .select({
            membershipId: MEMBERSHIP.id,
            userId: MEMBERSHIP.userId,
            displayName: USER.name,
          })
          .from(MEMBERSHIP)
          .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
          .where(
            and(
              eq(MEMBERSHIP.organizationId, orgId),
              eq(MEMBERSHIP.status, "active"),
              eq(USER.status, "active"),
              sql`${MEMBERSHIP.userId} <> ${userId}::uuid`,
              needle
                ? sql`(${USER.name} ILIKE ${`%${needle}%`} OR ${USER.email} ILIKE ${`%${needle}%`})`
                : undefined,
            ),
          )
          .orderBy(asc(USER.name), asc(MEMBERSHIP.userId))
          .limit(25);
        if (memberships.length === 0) return [];
        const roleRows = await tx
          .select({ membershipId: MEMBERSHIP_ROLE.membershipId, roleName: ROLE.name })
          .from(MEMBERSHIP_ROLE)
          .innerJoin(ROLE, eq(ROLE.id, MEMBERSHIP_ROLE.roleId))
          .where(
            and(
              eq(MEMBERSHIP_ROLE.organizationId, orgId),
              inArray(
                MEMBERSHIP_ROLE.membershipId,
                memberships.map((membership) => membership.membershipId),
              ),
              eq(ROLE.enabled, true),
              or(isNull(MEMBERSHIP_ROLE.expiresAt), sql`${MEMBERSHIP_ROLE.expiresAt} > now()`),
            ),
          );
        const roles = new Map<string, string[]>();
        for (const row of roleRows) {
          const values = roles.get(row.membershipId) ?? [];
          values.push(row.roleName);
          roles.set(row.membershipId, values);
        }
        return memberships.map((membership) => ({
          userId: membership.userId,
          displayName: membership.displayName?.trim() || "Staff member",
          roles: roles.get(membership.membershipId)?.sort() ?? [],
        }));
      });
    },

    // --- open/find a 1:1 DM channel (membership-validated + concurrency-safe) -------------------
    async openDm(orgId, userId, peerUserId) {
      if (peerUserId === userId) throw new ConflictError("cannot open a DM with yourself");
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        await assertActiveMessagingUser(tx, orgId, userId);
        await assertActiveMessagingUser(tx, orgId, peerUserId);
        const participantKey = dmParticipantKey(userId, peerUserId);
        const inserted = (await tx
          .insert(CH)
          .values({
            organizationId: orgId,
            channelKind: "dm",
            subjectId: null,
            dmParticipantKey: participantKey,
            title: "Direct message",
            retentionClass: "care_related",
          })
          .onConflictDoNothing()
          .returning({ id: CH.id })) as Array<{ id: string }>;
        const created = inserted.length > 0;
        const existing = created
          ? inserted
          : ((await tx
              .select({ id: CH.id })
              .from(CH)
              .where(
                and(
                  eq(CH.organizationId, orgId),
                  eq(CH.channelKind, "dm"),
                  eq(CH.dmParticipantKey, participantKey),
                ),
              )
              .limit(1)) as Array<{ id: string }>);
        const channelId = existing[0]?.id;
        if (!channelId)
          throw new WardenXError("DM_CREATE_FAILED", "could not open conversation", 503);
        await ensureDmMember(tx, orgId, channelId, userId, "owner");
        await ensureDmMember(tx, orgId, channelId, peerUserId, "member");
        return { channelId, created };
      });
    },

    async canManageMembers(orgId, actor, channelId): Promise<boolean> {
      try {
        return await withOrgContext(db, memberAdminContext(orgId, actor), async (tx) => {
          const ch = await memberAdminChannel(tx, orgId, channelId);
          return (
            !!ch &&
            (await mayManageChannelMembersResolved(actor, ch, (patientId) =>
              resolveSiting(orgId, patientId),
            ))
          );
        });
      } catch {
        return false; // fail closed: a lookup failure never grants member administration
      }
    },

    // --- add a manual member (admin override; audited) — re-activates a removed row idempotently -
    // The real actor rides withOrgContext so the write-audit trigger records WHO (GAP-103).
    async addMember(orgId, input) {
      return withOrgContext(db, memberAdminContext(orgId, input.actor), async (tx) => {
        await assertMayManageMembers(tx, orgId, input.channelId, input.actor, resolveSiting);
        await assertActiveMessagingUser(tx, orgId, input.userId);
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
      return withOrgContext(db, memberAdminContext(orgId, input.actor), async (tx) => {
        await assertMayManageMembers(tx, orgId, input.channelId, input.actor, resolveSiting);
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
          await assertActiveMessagingUser(tx, orgId, input.vacationForwardToUserId);
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
        return {
          id: rows[0]!.id,
          updatedAt: rows[0]!.updatedAt.toISOString(),
        };
      });
    },

    // --- register a push / sms / email endpoint (push is browser-verified; sms/email start pending) -
    async registerEndpoint(orgId, userId, input) {
      // GAP-063 — with no verification-code sender bound, an sms/email endpoint could never leave `pending`
      // (only a `verified` endpoint is ever a delivery target). Refuse up front with a clear 503 rather than
      // leave an unverifiable row behind; push is browser-verified and needs no sender.
      if (input.channel !== "push" && !opts.sendEndpointVerificationCode) {
        throw new WardenXError(
          "ENDPOINT_VERIFICATION_UNAVAILABLE",
          `${input.channel} verification is not available: the ${input.channel} delivery provider is not configured`,
          503,
        );
      }
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
        if (!verified) {
          // GAP-166 — issue the §4.2 OTP: store only its salted hash + expiry, hand the code to the sender.
          const code = generateVerificationCode();
          await tx
            .update(DE)
            .set({
              verificationTokenHash: hashVerificationCode(r.id, code),
              verificationTokenExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
              verificationAttempts: 0,
            })
            .where(eq(DE.id, r.id));
          await opts.sendEndpointVerificationCode?.({
            channel: r.channel,
            target: input.target,
            code,
          });
        }
        return {
          endpointId: r.id,
          channel: r.channel,
          verificationStatus: r.verificationStatus,
        };
      });
    },

    // --- confirm a verification (push is already verified) -------------------------------------
    async verifyEndpoint(orgId, userId, endpointId, token) {
      // The outcome is decided inside the tx but the error is thrown AFTER it commits: a wrong guess must
      // persist its attempt increment, and a throw inside `withOrgContext` would roll that back.
      const result = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = (await tx
          .select({
            channel: DE.channel,
            verificationStatus: DE.verificationStatus,
            tokenHash: DE.verificationTokenHash,
            expiresAt: DE.verificationTokenExpiresAt,
            attempts: DE.verificationAttempts,
          })
          .from(DE)
          .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)))
          .limit(1)) as Array<{
          channel: DeliveryEndpointChannel;
          verificationStatus: DeliveryEndpointVerification;
          tokenHash: string | null;
          expiresAt: Date | null;
          attempts: number;
        }>;
        const r = rows[0];
        if (!r) throw new NotFoundError("delivery endpoint", endpointId);
        const ok = {
          endpointId,
          channel: r.channel,
          verificationStatus: r.verificationStatus,
        };
        if (r.verificationStatus === "verified") return { outcome: "ok" as const, body: ok };
        // GAP-166 — the §4.2 OTP: constant-time compare against the stored hash, with TTL + attempt cap.
        const outcome = checkVerificationCode(
          { endpointId, tokenHash: r.tokenHash, expiresAt: r.expiresAt, attempts: r.attempts },
          token,
          new Date(),
        );
        if (outcome === "ok") {
          await tx
            .update(DE)
            .set({
              verificationStatus: "verified",
              verifiedAt: new Date(),
              verificationTokenHash: null,
              verificationTokenExpiresAt: null,
              verificationAttempts: 0,
            })
            .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)));
          return { outcome, body: { ...ok, verificationStatus: "verified" as const } };
        }
        if (outcome === "mismatch") {
          await tx
            .update(DE)
            .set({ verificationAttempts: sql`${DE.verificationAttempts} + 1` })
            .where(and(eq(DE.id, endpointId), eq(DE.userId, userId)));
        }
        return { outcome, body: ok };
      });
      if (result.outcome !== "ok") throw verificationFailure(result.outcome);
      return result.body;
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
            payload: AL.payload,
            createdAt: AL.createdAt,
            category: ND.alertCategory,
            deliveryStatus: ND.status,
            readAt: ARCP.readAt,
          })
          .from(ND)
          .innerJoin(AL, eq(AL.id, ND.alertId))
          .leftJoin(ARCP, and(eq(ARCP.alertId, AL.id), eq(ARCP.recipientUserId, userId)))
          .where(and(eq(AL.organizationId, orgId), eq(ND.recipientUserId, userId)))
          .orderBy(desc(AL.createdAt));
        const byAlert = new Map<
          string,
          {
            alertId: string;
            eventType: string;
            category: AlertCategory;
            severity: AlertSeverity;
            payload: unknown;
            createdAt: Date;
            statuses: string[];
            readAt: Date | null;
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
              payload: r.payload,
              createdAt: r.createdAt,
              statuses: [],
              readAt: r.readAt,
            };
            byAlert.set(r.alertId, e);
          }
          e.statuses.push(r.deliveryStatus);
        }
        return [...byAlert.values()].map((e): AlertInboxItem => {
          const presentation = projectAlertInboxPresentation(e.payload, e.category);
          return {
            alertId: e.alertId,
            eventType: e.eventType,
            category: e.category,
            severity: e.severity,
            summary: presentation.summary,
            deepLink: presentation.deepLink,
            createdAt: e.createdAt.toISOString(),
            deliveryStatus: aggregateDeliveryStatus(e.statuses),
            readAt: iso(e.readAt),
          };
        });
      });
    },

    async markAlertRead(orgId, userId, alertId): Promise<void> {
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        // The alert must belong to this organization and must actually have
        // been delivered/routed to this actor. This avoids allowing an actor
        // to create receipts for arbitrary alert ids.
        const eligible = await tx
          .select({ alertId: AL.id })
          .from(ND)
          .innerJoin(AL, eq(AL.id, ND.alertId))
          .where(
            and(eq(AL.id, alertId), eq(AL.organizationId, orgId), eq(ND.recipientUserId, userId)),
          )
          .limit(1);

        if (!eligible[0]) {
          throw new NotFoundError("alert", alertId);
        }

        const now = new Date();

        await tx
          .insert(ARCP)
          .values({
            alertId,
            recipientUserId: userId,
            readAt: new Date(),
          })
          .onConflictDoNothing({
            target: [ARCP.alertId, ARCP.recipientUserId],
          });
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
        // GAP-102: a system_locked rule may only be tightened (spec §7.4 / D11) — refused here with a
        // named 4xx before any row is written; migration 0334's trigger is the DB backstop.
        assertLockedRulePatchAllowed(base.eventType, input.patch);

        const severityFloor = input.patch.severityFloor ?? (base.severityFloor as AlertSeverity);
        const recipientResolver =
          input.patch.recipientResolver ?? (base.recipientResolver as AlertRecipientResolver);
        const enabled = input.patch.enabled ?? base.enabled;
        // Migration 0334's trigger rejects an UNLOCKED tenant row for an event whose platform rule is
        // locked, so a legacy clone (written before the event was locked, e.g. m3.breakglass.invoked) is
        // promoted on edit — judged against the platform seed, never the clone's own flag.
        const systemLocked = base.systemLocked || isSystemLockedEventType(base.eventType);

        // One override per (org, event_type): update the existing org row if present, else clone the
        // base into a new org-scoped row. (When `base` is already the org row, this updates it.)
        const ownRows = (await tx
          .select({ id: AR.id, channelsOverride: AR.channelsOverride })
          .from(AR)
          .where(and(eq(AR.organizationId, orgId), eq(AR.eventType, base.eventType)))
          .limit(1)) as Array<{ id: string; channelsOverride: string[] | null }>;
        let row: typeof AR.$inferSelect;
        if (ownRows[0]) {
          // A weak legacy clone (reduced/NULL channels, different resolver_args) is not touched by the
          // patch fields yet still trips migration 0334's trigger on any UPDATE — so a locked event's
          // update also restores resolver_args and a channels superset of the platform floor.
          const lockedFloor = systemLocked
            ? await loadLockedFloor(tx, base.eventType, ownRows[0].channelsOverride)
            : {};
          const updated = (await tx
            .update(AR)
            .set({
              severityFloor,
              recipientResolver,
              enabled,
              systemLocked,
              ...lockedFloor,
              updatedAt: new Date(),
            })
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
              systemLocked,
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

/**
 * For a system_locked event type: the `resolverArgs` + `channelsOverride` an org row must carry to satisfy
 * migration 0334 — the platform row's resolver_args and a SUPERSET of its channels (the clone's extra
 * channels are kept; a NULL clone takes the platform list). Reads the platform floor row the way the
 * emitter does, falling back to the seed if the row is absent. Empty object when there is no floor.
 */
async function loadLockedFloor(
  tx: Pick<DbClient, "select">,
  eventType: string,
  cloneChannels: readonly string[] | null,
): Promise<{ resolverArgs?: unknown; channelsOverride?: string[] | null }> {
  const rows = (await tx
    .select()
    .from(AR)
    .where(and(isNull(AR.organizationId), eq(AR.eventType, eventType), eq(AR.systemLocked, true)))
    .limit(1)) as Array<typeof AR.$inferSelect>;
  const seed = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
  const floor = rows[0] ?? seed;
  if (!floor) return {};
  const platformChannels = (floor.channelsOverride ?? null) as readonly string[] | null;
  if (platformChannels === null) return { resolverArgs: floor.resolverArgs };
  const merged = [...new Set([...(cloneChannels ?? []), ...platformChannels])];
  return { resolverArgs: floor.resolverArgs, channelsOverride: merged };
}
