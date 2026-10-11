// @wardenx/messaging — the in-memory MessagingRouteService slice (M36-T07, spec §4.1–4.2).
//
// The DB-free implementation of the §4.1 route inventory's application service, so the backend
// route module is integration-testable with no live Postgres/Valkey (mirrors M38's
// `createInMemoryTerminologyStore`). Production swaps a Drizzle/Valkey impl that runs each
// mutation inside `withOrgContext` (RLS on `app.org_id`) and encrypts message bodies under the
// tenant DEK; this slice keeps everything in memory and treats bodies as plaintext (the seam
// boundary is plaintext by contract — §3.4). State is per-instance, so a fresh service per test
// gives isolation. The clock is injectable (`now`) and ids are a deterministic counter so route
// tests are reproducible.

import { ConflictError, ForbiddenError, NotFoundError, WardenXError } from "@wardenx/types";
import type {
  AlertCategory,
  AlertRecipientResolver,
  AlertSeverity,
  ChannelKind,
  ChannelMemberRole,
  ChannelMemberSource,
  DeliveryEndpointChannel,
  MessageBodyKind,
  NotificationChannel,
} from "../interfaces/kinds";
import type {
  AttachmentInput,
  MessageReferenceInput,
  ResolvedMessage,
} from "../interfaces/provider";
import type {
  AlertInboxItem,
  AlertRulePatch,
  AlertRuleView,
  ChannelDetail,
  ChannelSummary,
  DeliveryEndpointInput,
  DeliveryEndpointView,
  DmEligibleStaffMember,
  MessagingRouteService,
  NotificationPreferencesInput,
  NotificationPreferencesView,
} from "../interfaces/route-service";
import {
  type MemberAdminActor,
  type PatientLocationResolver,
  mayManageChannelMembersResolved,
} from "../member-admin";
import type { QuietHoursConfig, RoutingMap } from "../resolution";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  SYSTEM_LOCKED_EVENT_TYPES,
  assertLockedRulePatchAllowed,
  isSystemLockedEventType,
} from "../seed";

// ── value-level mirrors of the §3.2 enum unions (for routing-map validation) ────────────────
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
const SYSTEM_LOCKED_EVENTS = new Set<string>(SYSTEM_LOCKED_EVENT_TYPES);

interface ChannelRow {
  channelId: string;
  orgId: string;
  kind: ChannelKind;
  title: string | null;
  subjectId: string | null;
  archivedAt: string | null;
  members: Map<string, { role: ChannelMemberRole; source: ChannelMemberSource }>;
}

interface MessageRow {
  messageId: string;
  channelId: string;
  orgId: string;
  authorUserId: string | null;
  body: string;
  bodyKind: MessageBodyKind;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  parentMessageId: string | null;
  references: readonly MessageReferenceInput[];
}

function validateReferences(
  body: string,
  references: readonly MessageReferenceInput[],
  channel: ChannelRow,
  eligibleStaff: ReadonlyMap<string, { readonly displayName: string }>,
): void {
  if (references.length > 25) {
    throw new WardenXError("INVALID_MESSAGE_REFERENCES", "too many message references", 422);
  }
  let previousEnd = -1;
  for (const reference of [...references].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const label =
      reference.kind === "staff"
        ? eligibleStaff.get(`${channel.orgId}:${reference.entityId}`)?.displayName
        : channel.kind === "care_team" && channel.subjectId === reference.entityId
          ? "Patient"
          : undefined;
    if (
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < 0 ||
      reference.end <= reference.start ||
      reference.end > body.length ||
      reference.start < previousEnd ||
      !label ||
      (reference.kind === "staff" && !channel.members.has(reference.entityId)) ||
      body.slice(reference.start, reference.end) !== `@${label}`
    ) {
      throw new WardenXError(
        "INVALID_MESSAGE_REFERENCES",
        "a message reference is invalid for this conversation",
        422,
      );
    }
    previousEnd = reference.end;
  }
}

interface EndpointRow {
  endpointId: string;
  orgId: string;
  userId: string;
  channel: DeliveryEndpointChannel;
  target: string;
  verificationStatus: "verified" | "pending" | "expired";
  token: string | null;
}

interface PreferencesRow {
  id: string;
  orgId: string;
  userId: string;
  routingMap: RoutingMap;
  quietHours: QuietHoursConfig;
  vacationForwardToUserId: string | null;
  vacationUntil: string | null;
  updatedAt: string;
}

interface AlertRuleOverrideRow {
  ruleId: string;
  orgId: string;
  eventType: string;
  category: AlertCategory;
  severityFloor: AlertSeverity;
  recipientResolver: AlertRecipientResolver;
  systemLocked: boolean;
  enabled: boolean;
}

/** Seed shapes — the integration test injects channels/members/messages/alerts up front. */
export interface InMemoryMessagingSeed {
  readonly eligibleStaff?: readonly (DmEligibleStaffMember & {
    orgId: string;
    status?: "active" | "suspended" | "revoked";
  })[];
  /** Patient ids known to the tenant and the current M5-derived clinical roster. */
  readonly careTeamPatients?: readonly {
    orgId: string;
    patientId: string;
    memberUserIds: readonly string[];
  }[];
  readonly channels?: readonly {
    channelId: string;
    orgId: string;
    kind: ChannelKind;
    title?: string | null;
    subjectId?: string | null;
    archivedAt?: string | null;
    members?: readonly { userId: string; role?: ChannelMemberRole; source?: ChannelMemberSource }[];
  }[];
  readonly alerts?: readonly { orgId: string; userId: string; item: AlertInboxItem }[];
}

export interface InMemoryMessagingServiceOptions {
  /** Injectable clock for deterministic timestamps (default: wall clock). */
  readonly now?: () => Date;
  readonly seed?: InMemoryMessagingSeed;
  /** Patient → sited location ids, for care_team member administration (unset ⇒ clinical_lead denied). */
  readonly resolvePatientLocationIds?: PatientLocationResolver;
}

const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  tz: "UTC",
  ranges: [],
  severityOverride: "critical",
};

/** Build the in-memory MessagingRouteService slice that backs the M36 route inventory. */
export function createInMemoryMessagingService(
  options: InMemoryMessagingServiceOptions = {},
): MessagingRouteService {
  const now = options.now ?? (() => new Date());
  let seq = 0;
  const id = (prefix: string): string => `${prefix}_${(++seq).toString(36).padStart(6, "0")}`;
  const iso = (): string => now().toISOString();

  const channels = new Map<string, ChannelRow>();
  const messages = new Map<string, MessageRow>();
  const endpoints = new Map<string, EndpointRow>();
  const preferences = new Map<string, PreferencesRow>(); // key: `${orgId}:${userId}`
  const overrides = new Map<string, AlertRuleOverrideRow>(); // key: `${orgId}:${eventType}`
  const readPointers = new Map<string, string>(); // `${orgId}:${userId}:${channelId}` -> createdAt
  const inbox = new Map<string, AlertInboxItem[]>(); // `${orgId}:${userId}` -> items
  const eligibleStaff = new Map(
    (options.seed?.eligibleStaff ?? []).map((staff) => [`${staff.orgId}:${staff.userId}`, staff]),
  );
  const careTeamPatients = new Map(
    (options.seed?.careTeamPatients ?? []).map((patient) => [
      `${patient.orgId}:${patient.patientId}`,
      new Set(patient.memberUserIds),
    ]),
  );

  const assertEligibleStaff = (orgId: string, userId: string): void => {
    const staff = eligibleStaff.get(`${orgId}:${userId}`);
    if (!staff || (staff.status ?? "active") !== "active") {
      throw new NotFoundError("eligible staff member", userId);
    }
  };

  for (const c of options.seed?.channels ?? []) {
    const members = new Map<string, { role: ChannelMemberRole; source: ChannelMemberSource }>();
    for (const m of c.members ?? []) {
      members.set(m.userId, { role: m.role ?? "member", source: m.source ?? "manual" });
    }
    channels.set(c.channelId, {
      channelId: c.channelId,
      orgId: c.orgId,
      kind: c.kind,
      title: c.title ?? null,
      subjectId: c.subjectId ?? null,
      archivedAt: c.archivedAt ?? null,
      members,
    });
  }
  for (const a of options.seed?.alerts ?? []) {
    const key = `${a.orgId}:${a.userId}`;
    (inbox.get(key) ?? inbox.set(key, []).get(key)!).push(a.item);
  }

  const channelOr404 = (orgId: string, channelId: string): ChannelRow => {
    const ch = channels.get(channelId);
    if (!ch || ch.orgId !== orgId) throw new NotFoundError("channel", channelId);
    return ch;
  };

  const mayManage = (orgId: string, actor: MemberAdminActor, ch: ChannelRow): Promise<boolean> =>
    mayManageChannelMembersResolved(
      actor,
      { kind: ch.kind, subjectId: ch.subjectId },
      options.resolvePatientLocationIds
        ? (patientId) => options.resolvePatientLocationIds!(orgId, patientId)
        : undefined,
    );

  const assertMayManage = async (
    orgId: string,
    actor: MemberAdminActor,
    ch: ChannelRow,
  ): Promise<void> => {
    if (!(await mayManage(orgId, actor, ch))) {
      throw new ForbiddenError("not permitted to manage members of this channel");
    }
  };

  const encodeMessageCursor = (message: MessageRow): string =>
    encodeURIComponent(JSON.stringify([message.createdAt, message.messageId]));
  const decodeMessageCursor = (cursor: string): readonly [string, string] | null => {
    try {
      const value = JSON.parse(decodeURIComponent(cursor)) as unknown;
      return Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => typeof item === "string")
        ? (value as [string, string])
        : null;
    } catch {
      return null;
    }
  };
  const messageOrder = (a: MessageRow, b: MessageRow): number =>
    a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId);

  const toSummary = (orgId: string, userId: string, ch: ChannelRow): ChannelSummary => {
    const pointer = readPointers.get(`${orgId}:${userId}:${ch.channelId}`) ?? "";
    let unread = 0;
    let mentionCount = 0;
    for (const m of messages.values()) {
      if (m.channelId !== ch.channelId || m.deletedAt) continue;
      if (m.authorUserId === userId) continue;
      if (m.createdAt > pointer) unread++;
      if (
        m.createdAt > pointer &&
        m.references.some(
          (reference) => reference.kind === "staff" && reference.entityId === userId,
        )
      ) {
        mentionCount++;
      }
    }
    const latest = [...messages.values()]
      .filter((message) => message.orgId === orgId && message.channelId === ch.channelId)
      .sort(messageOrder)
      .at(-1);
    const peer =
      ch.kind === "dm"
        ? [...ch.members.keys()].find((memberUserId) => memberUserId !== userId)
        : undefined;
    const peerStaff = peer ? eligibleStaff.get(`${orgId}:${peer}`) : undefined;
    return {
      channelId: ch.channelId,
      kind: ch.kind,
      title: ch.kind === "dm" ? (peerStaff?.displayName ?? "Direct message") : ch.title,
      subjectId: ch.subjectId,
      archivedAt: ch.archivedAt,
      unreadCount: unread,
      mentionCount,
      participantRoles: ch.kind === "dm" ? (peerStaff?.roles ?? []) : [],
      lastActivityAt: latest?.createdAt ?? ch.archivedAt ?? "1970-01-01T00:00:00.000Z",
      lastMessage: latest
        ? {
            messageId: latest.messageId,
            preview: latest.deletedAt
              ? "Message deleted"
              : latest.body.replace(/\s+/g, " ").trim().slice(0, 140),
            createdAt: latest.createdAt,
            authorDisplayName: latest.authorUserId
              ? (eligibleStaff.get(`${orgId}:${latest.authorUserId}`)?.displayName ?? null)
              : null,
          }
        : null,
    };
  };

  return {
    async listChannels(orgId, userId) {
      const out: ChannelSummary[] = [];
      for (const ch of channels.values()) {
        const member = ch.members.get(userId);
        if (ch.orgId !== orgId || !member) continue;
        if (
          ch.kind === "care_team" &&
          member.source === "auto" &&
          (!ch.subjectId || !careTeamPatients.get(`${orgId}:${ch.subjectId}`)?.has(userId))
        ) {
          continue;
        }
        out.push(toSummary(orgId, userId, ch));
      }
      return out.sort(
        (a, b) =>
          b.lastActivityAt.localeCompare(a.lastActivityAt) ||
          a.channelId.localeCompare(b.channelId),
      );
    },

    async getChannel(orgId, userId, channelId) {
      const ch = channelOr404(orgId, channelId);
      const detail: ChannelDetail = {
        ...toSummary(orgId, userId, ch),
        patientId: ch.kind === "care_team" ? (ch.subjectId ?? null) : null,
        members: [...ch.members.entries()].map(([uid, m]) => ({
          userId: uid,
          role: m.role,
          source: m.source,
        })),
      };
      return detail;
    },

    async listMessages(orgId, input) {
      const channel = channelOr404(orgId, input.channelId);
      const limit = input.limit ?? 50;
      const backward = input.direction === "backward";
      const cursor = input.cursor ? decodeMessageCursor(input.cursor) : null;
      let rows = [...messages.values()]
        .filter((m) => m.channelId === input.channelId && m.orgId === orgId)
        .sort(messageOrder);
      if (cursor) {
        rows = rows.filter((message) => {
          const comparison =
            message.createdAt.localeCompare(cursor[0]) ||
            message.messageId.localeCompare(cursor[1]);
          return backward ? comparison < 0 : comparison > 0;
        });
      }
      if (backward) rows.reverse();
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      if (backward) pageRows.reverse();
      const page = pageRows.map<ResolvedMessage>((m) => ({
        messageId: m.messageId,
        channelId: m.channelId,
        authorUserId: m.authorUserId,
        authorDisplayName: m.authorUserId
          ? (eligibleStaff.get(`${orgId}:${m.authorUserId}`)?.displayName ?? null)
          : null,
        body: m.deletedAt ? "" : m.body,
        bodyKind: m.bodyKind,
        createdAt: m.createdAt,
        parentMessageId: m.parentMessageId,
        references: m.references.map((reference) => ({
          ...reference,
          displayLabel:
            reference.kind === "staff"
              ? (eligibleStaff.get(`${orgId}:${reference.entityId}`)?.displayName ?? "Staff member")
              : "Patient",
          navigable: reference.kind === "patient" && channel.kind === "care_team",
        })),
      }));
      return {
        messages: page,
        nextCursor:
          hasMore && pageRows.length > 0
            ? encodeMessageCursor(backward ? pageRows[0]! : pageRows.at(-1)!)
            : undefined,
        patientId: channel.kind === "care_team" ? (channel.subjectId ?? null) : null,
      };
    },

    async sendMessage(orgId, input) {
      const ch = channelOr404(orgId, input.channelId);
      if (ch.archivedAt) {
        throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
      }
      validateReferences(input.body, input.references ?? [], ch, eligibleStaff);
      const messageId = id("msg");
      const createdAt = iso();
      messages.set(messageId, {
        messageId,
        channelId: input.channelId,
        orgId,
        authorUserId: input.authorUserId,
        body: input.body,
        bodyKind: input.bodyKind ?? "plain",
        createdAt,
        editedAt: null,
        deletedAt: null,
        parentMessageId: input.parentMessageId ?? null,
        references: input.references ?? [],
      });
      return { messageId, channelId: input.channelId, createdAt };
    },

    async editMessage(orgId, input) {
      const m = messages.get(input.messageId);
      if (!m || m.orgId !== orgId || m.deletedAt)
        throw new NotFoundError("message", input.messageId);
      if (m.authorUserId !== input.userId) {
        throw new ForbiddenError("only the author may edit a message");
      }
      validateReferences(
        input.body,
        input.references ?? [],
        channelOr404(orgId, m.channelId),
        eligibleStaff,
      );
      m.body = input.body;
      m.references = input.references ?? [];
      m.editedAt = iso();
      return { messageId: m.messageId, editedAt: m.editedAt };
    },

    async deleteMessage(orgId, input) {
      const m = messages.get(input.messageId);
      if (!m || m.orgId !== orgId || m.deletedAt)
        throw new NotFoundError("message", input.messageId);
      if (m.authorUserId !== input.userId) {
        throw new ForbiddenError("only the author may delete a message");
      }
      m.deletedAt = iso();
    },

    async markRead(orgId, input) {
      const m = messages.get(input.messageId);
      if (!m || m.orgId !== orgId) throw new NotFoundError("message", input.messageId);
      // Single → pointer to this message; upTo → same (all earlier are already ≤ this createdAt).
      readPointers.set(`${orgId}:${input.userId}:${m.channelId}`, m.createdAt);
    },

    async searchDmEligibleStaff(orgId, userId, query) {
      assertEligibleStaff(orgId, userId);
      const needle = query.trim().toLowerCase();
      return [...eligibleStaff.values()]
        .filter(
          (staff) =>
            staff.orgId === orgId &&
            staff.userId !== userId &&
            (staff.status ?? "active") === "active" &&
            (!needle ||
              staff.displayName.toLowerCase().includes(needle) ||
              staff.roles.some((role) => role.toLowerCase().includes(needle))),
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, 25)
        .map(({ userId: id, displayName, roles }) => ({ userId: id, displayName, roles }));
    },

    async searchMentionCandidates(orgId, userId, channelId, query) {
      const channel = channelOr404(orgId, channelId);
      if (!(await this.canViewChannel(orgId, userId, channelId))) {
        throw new NotFoundError("channel", channelId);
      }
      const needle = query.trim().toLowerCase();
      const staff = [...channel.members.keys()]
        .map((memberUserId) => eligibleStaff.get(`${orgId}:${memberUserId}`))
        .filter((member): member is NonNullable<typeof member> => !!member)
        .filter(
          (member) =>
            (member.status ?? "active") === "active" &&
            (!needle || member.displayName.toLowerCase().includes(needle)),
        )
        .map((member) => ({
          kind: "staff" as const,
          entityId: member.userId,
          displayName: member.displayName,
          detail: member.roles.join(" · ") || null,
        }));
      const patient =
        channel.kind === "care_team" && channel.subjectId && (!needle || "patient".includes(needle))
          ? [
              {
                kind: "patient" as const,
                entityId: channel.subjectId,
                displayName: "Patient",
                detail: "Care team patient",
              },
            ]
          : [];
      return [...staff, ...patient];
    },

    async openDm(orgId, userId, peerUserId) {
      if (peerUserId === userId) {
        throw new ConflictError("cannot open a DM with yourself");
      }
      assertEligibleStaff(orgId, userId);
      assertEligibleStaff(orgId, peerUserId);
      for (const ch of channels.values()) {
        if (
          ch.orgId === orgId &&
          ch.kind === "dm" &&
          ch.members.size === 2 &&
          ch.members.has(userId) &&
          ch.members.has(peerUserId)
        ) {
          return { channelId: ch.channelId, created: false };
        }
      }
      const channelId = id("ch");
      const members = new Map<string, { role: ChannelMemberRole; source: ChannelMemberSource }>();
      members.set(userId, { role: "owner", source: "manual" });
      members.set(peerUserId, { role: "member", source: "manual" });
      channels.set(channelId, {
        channelId,
        orgId,
        kind: "dm",
        title: null,
        subjectId: null,
        archivedAt: null,
        members,
      });
      return { channelId, created: true };
    },

    async openCareTeamChannel(orgId, userId, patientId) {
      assertEligibleStaff(orgId, userId);
      const roster = careTeamPatients.get(`${orgId}:${patientId}`);
      const existing = [...channels.values()].find(
        (channel) =>
          channel.orgId === orgId &&
          channel.kind === "care_team" &&
          channel.subjectId === patientId,
      );
      const hasManualAccess = existing?.members.get(userId)?.source === "manual";
      if (!roster || (!roster.has(userId) && !hasManualAccess)) {
        throw new NotFoundError("care team conversation", patientId);
      }

      let channel = existing;
      if (!channel) {
        const channelId = id("ch");
        channel = {
          channelId,
          orgId,
          kind: "care_team",
          title: "Care team",
          subjectId: patientId,
          archivedAt: null,
          members: new Map(),
        };
        channels.set(channelId, channel);
      }
      if (!channel.archivedAt) {
        for (const memberUserId of roster) {
          if (!channel.members.has(memberUserId)) {
            channel.members.set(memberUserId, { role: "member", source: "auto" });
          }
        }
      }
      for (const [memberUserId, member] of channel.members) {
        if (member.source === "auto" && !roster.has(memberUserId)) {
          channel.members.delete(memberUserId);
        }
      }
      const effectiveMember = channel.members.get(userId);
      if (!effectiveMember || (effectiveMember.source === "auto" && !roster.has(userId))) {
        throw new NotFoundError("care team conversation", patientId);
      }
      return {
        channelId: channel.channelId,
        kind: "care_team" as const,
        patientId,
        archived: channel.archivedAt !== null,
      };
    },

    async canManageMembers(orgId, actor, channelId) {
      const ch = channels.get(channelId);
      if (!ch || ch.orgId !== orgId) return false;
      return mayManage(orgId, actor, ch);
    },

    async addMember(orgId, input) {
      const ch = channelOr404(orgId, input.channelId);
      await assertMayManage(orgId, input.actor, ch);
      if (ch.kind === "dm") throw new ForbiddenError("direct-message membership cannot be changed");
      assertEligibleStaff(orgId, input.userId);
      ch.members.set(input.userId, { role: input.role ?? "member", source: "manual" });
    },

    async removeMember(orgId, input) {
      const ch = channelOr404(orgId, input.channelId);
      await assertMayManage(orgId, input.actor, ch);
      if (!ch.members.delete(input.userId)) {
        throw new NotFoundError("channel member", input.userId);
      }
    },

    async announce(orgId, input) {
      let channel: ChannelRow | undefined;
      for (const ch of channels.values()) {
        if (ch.orgId === orgId && ch.kind === "announcement") {
          channel = ch;
          break;
        }
      }
      if (!channel) {
        const channelId = id("ch");
        channel = {
          channelId,
          orgId,
          kind: "announcement",
          title: "Announcements",
          subjectId: null,
          archivedAt: null,
          members: new Map(),
        };
        channels.set(channelId, channel);
      }
      const messageId = id("msg");
      const createdAt = iso();
      messages.set(messageId, {
        messageId,
        channelId: channel.channelId,
        orgId,
        authorUserId: input.authorUserId,
        body: input.body,
        bodyKind: "plain",
        createdAt,
        editedAt: null,
        deletedAt: null,
        parentMessageId: null,
        references: [],
      });
      return { messageId, channelId: channel.channelId, createdAt };
    },

    async canViewChannel(orgId, userId, channelId) {
      const staff = eligibleStaff.get(`${orgId}:${userId}`);
      if (!staff || (staff.status ?? "active") !== "active") return false;
      const ch = channels.get(channelId);
      if (!ch || ch.orgId !== orgId) return false;
      // announcement is org-wide broadcast — every authenticated org member may read it.
      if (ch.kind === "announcement") return true;
      const member = ch.members.get(userId);
      if (!member) return false;
      if (ch.kind === "care_team" && member.source === "auto") {
        return !!ch.subjectId && !!careTeamPatients.get(`${orgId}:${ch.subjectId}`)?.has(userId);
      }
      return true;
    },

    async getPreferences(orgId, userId) {
      const key = `${orgId}:${userId}`;
      let row = preferences.get(key);
      if (!row) {
        row = {
          id: id("pref"),
          orgId,
          userId,
          routingMap: {},
          quietHours: DEFAULT_QUIET_HOURS,
          vacationForwardToUserId: null,
          vacationUntil: null,
          updatedAt: iso(),
        };
        preferences.set(key, row);
      }
      return toPreferencesView(row);
    },

    async putPreferences(orgId, userId, input) {
      validateRoutingMap(input.routingMap);
      if (input.vacationForwardToUserId && input.vacationForwardToUserId === userId) {
        throw new WardenXError("VACATION_FORWARD_SELF", "cannot forward to yourself", 409);
      }
      if (input.vacationForwardToUserId) {
        assertEligibleStaff(orgId, input.vacationForwardToUserId);
        const target = preferences.get(`${orgId}:${input.vacationForwardToUserId}`);
        if (target?.vacationForwardToUserId === userId) {
          throw new WardenXError(
            "VACATION_FORWARD_CYCLE",
            "the forward target also forwards to you",
            409,
          );
        }
        // A forward target pairs with a future expiry (DB-005 — enforced here at write time, the
        // same invariant the Drizzle-backed store enforces; mirrored so this in-memory reference
        // stays behaviorally accurate, not just structurally similar).
        if (!input.vacationUntil || new Date(input.vacationUntil).getTime() <= Date.now()) {
          throw new WardenXError(
            "VACATION_UNTIL_NOT_FUTURE",
            "vacationUntil must be set and in the future when vacationForwardToUserId is set",
            422,
          );
        }
      }
      const key = `${orgId}:${userId}`;
      const existing = preferences.get(key);
      const row: PreferencesRow = {
        id: existing?.id ?? id("pref"),
        orgId,
        userId,
        routingMap: input.routingMap,
        quietHours: input.quietHours,
        vacationForwardToUserId: input.vacationForwardToUserId ?? null,
        vacationUntil: input.vacationUntil ?? null,
        updatedAt: iso(),
      };
      preferences.set(key, row);
      return { id: row.id, updatedAt: row.updatedAt };
    },

    async registerEndpoint(orgId, userId, input: DeliveryEndpointInput) {
      const endpointId = id("ep");
      // push is browser-issued → immediately verified; sms/email need a verification token.
      const verified = input.channel === "push";
      const row: EndpointRow = {
        endpointId,
        orgId,
        userId,
        channel: input.channel,
        target: input.target,
        verificationStatus: verified ? "verified" : "pending",
        token: verified ? null : "000000", // deterministic slice token; prod sends a real code
      };
      endpoints.set(endpointId, row);
      return { endpointId, channel: row.channel, verificationStatus: row.verificationStatus };
    },

    async verifyEndpoint(orgId, userId, endpointId, token) {
      const row = endpoints.get(endpointId);
      if (!row || row.orgId !== orgId || row.userId !== userId) {
        throw new NotFoundError("delivery endpoint", endpointId);
      }
      if (row.verificationStatus === "verified") {
        return { endpointId, channel: row.channel, verificationStatus: row.verificationStatus };
      }
      if (token !== row.token) {
        throw new WardenXError("INVALID_TOKEN", "verification token does not match", 422);
      }
      row.verificationStatus = "verified";
      row.token = null;
      return { endpointId, channel: row.channel, verificationStatus: row.verificationStatus };
    },

    async removeEndpoint(orgId, userId, endpointId) {
      const row = endpoints.get(endpointId);
      if (!row || row.orgId !== orgId || row.userId !== userId) {
        throw new NotFoundError("delivery endpoint", endpointId);
      }
      endpoints.delete(endpointId);
    },

    async alertInbox(orgId, userId) {
      return [...(inbox.get(`${orgId}:${userId}`) ?? [])];
    },

    async markAlertRead(orgId, userId, alertId) {
      const key = `${orgId}:${userId}`;
      const items = inbox.get(key) ?? [];

      const index = items.findIndex((item) => item.alertId === alertId);

      if (index < 0) {
        throw new NotFoundError("alert", alertId);
      }

      const item = items[index]!;

      items[index] = {
        ...item,
        readAt: new Date().toISOString(),
      };

      inbox.set(key, items);
    },

    async listAlertRules(orgId) {
      return PLATFORM_DEFAULT_ALERT_RULES.map<AlertRuleView>((seed) => {
        const override = overrides.get(`${orgId}:${seed.eventType}`);
        if (override) {
          return {
            ruleId: override.ruleId,
            organizationId: override.orgId,
            eventType: override.eventType,
            category: override.category,
            severityFloor: override.severityFloor,
            recipientResolver: override.recipientResolver,
            systemLocked: override.systemLocked,
            enabled: override.enabled,
          };
        }
        return {
          ruleId: `platform:${seed.eventType}`,
          organizationId: null,
          eventType: seed.eventType,
          category: seed.category,
          severityFloor: seed.severityFloor,
          recipientResolver: seed.recipientResolver,
          systemLocked: seed.systemLocked,
          enabled: seed.enabled,
        };
      });
    },

    async patchAlertRule(orgId, input) {
      const base = resolveRuleBase(orgId, input.ruleId, overrides);
      if (!base) throw new NotFoundError("alert rule", input.ruleId);

      // §7.4 + GAP-102: a system_locked rule can never be disabled, re-resolved or downgraded (even by
      // alert.rules.manage) — judged against the PLATFORM floor, not the (possibly cloned) base row.
      assertLockedRulePatchAllowed(base.eventType, input.patch);
      if (
        input.patch.recipientResolver !== undefined &&
        !RECIPIENT_RESOLVERS.includes(input.patch.recipientResolver)
      ) {
        throw new WardenXError("INVALID_RESOLVER", "unknown recipient resolver", 422);
      }

      const key = `${orgId}:${base.eventType}`;
      const existing = overrides.get(key);
      const row: AlertRuleOverrideRow = {
        ruleId: existing?.ruleId ?? id("rule"), // clone a platform default into an org-scoped row
        orgId,
        eventType: base.eventType,
        category: base.category,
        severityFloor: input.patch.severityFloor ?? base.severityFloor,
        recipientResolver: input.patch.recipientResolver ?? base.recipientResolver,
        systemLocked: base.systemLocked || isSystemLockedEventType(base.eventType),
        enabled: input.patch.enabled ?? base.enabled,
      };
      overrides.set(key, row);
      return {
        ruleId: row.ruleId,
        organizationId: row.orgId,
        eventType: row.eventType,
        category: row.category,
        severityFloor: row.severityFloor,
        recipientResolver: row.recipientResolver,
        systemLocked: row.systemLocked,
        enabled: row.enabled,
      };
    },
  };
}

function toPreferencesView(row: PreferencesRow): NotificationPreferencesView {
  return {
    id: row.id,
    userId: row.userId,
    routingMap: row.routingMap,
    quietHours: row.quietHours,
    vacationForwardToUserId: row.vacationForwardToUserId,
    vacationUntil: row.vacationUntil,
    updatedAt: row.updatedAt,
  };
}

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

/** Resolve the rule a patch targets — a platform default (`platform:<event>`) or an org override
 *  (by its stored id) — into the base fields the patch is applied over. */
function resolveRuleBase(
  orgId: string,
  ruleId: string,
  overrides: Map<string, AlertRuleOverrideRow>,
): {
  eventType: string;
  category: AlertCategory;
  severityFloor: AlertSeverity;
  recipientResolver: AlertRecipientResolver;
  systemLocked: boolean;
  enabled: boolean;
} | null {
  if (ruleId.startsWith("platform:")) {
    const eventType = ruleId.slice("platform:".length);
    const seed = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
    return seed
      ? {
          eventType: seed.eventType,
          category: seed.category,
          severityFloor: seed.severityFloor,
          recipientResolver: seed.recipientResolver,
          systemLocked: seed.systemLocked || SYSTEM_LOCKED_EVENTS.has(seed.eventType),
          enabled: seed.enabled,
        }
      : null;
  }
  for (const row of overrides.values()) {
    if (row.orgId === orgId && row.ruleId === ruleId) {
      return {
        eventType: row.eventType,
        category: row.category,
        severityFloor: row.severityFloor,
        recipientResolver: row.recipientResolver,
        systemLocked: row.systemLocked,
        enabled: row.enabled,
      };
    }
  }
  return null;
}
