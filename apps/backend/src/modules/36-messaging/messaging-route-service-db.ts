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
  MessageReferenceInput,
  MessagingProvider,
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
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  WardenXError,
} from "@wardenx/types";
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { projectAlertInboxPresentation } from "./alert-inbox-presentation";
import { attachmentPreviewLabel } from "./attachment-preview-label";
import { bindAttachmentsInTx, loadAttachmentViews } from "./attachments/attachment-service-db";
import {
  MAX_VERIFICATION_ATTEMPTS,
  VERIFICATION_CODE_TTL_MS,
  type VerificationOutcome,
  checkVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
} from "./endpoint-verification";
import { publishMessageHint } from "./message-hint-events";
import { MESSAGE_ROW_COLUMNS, hydrateMessages } from "./messaging-message-hydration";
import {
  type MessageBodyCipher,
  blankMessageError,
  channelOr404,
  createMessageBodyCipher,
  insertEncryptedMessage,
  markMessagesRead,
  withValidMessageContent,
} from "./messaging-write-core";
import { type Part2ChannelGate, createSeamPart2ChannelGate } from "./part2-channel-gate";
import { createDbReactionPinService } from "./reaction-pin-service-db";
import { decodeStoredBody, sameMentionToken, storedBodyFor } from "./rich-body-codec";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;
const MER = schema.messageEntityReferences;
const MREV = schema.messageRevisions;
const MATT = schema.messageAttachments;

// ADR-0055 item 3: the author may edit for this long after the message was created (server clock). Tenant shortening
// arrives with per-tenant messaging settings; the platform maximum is this value.
const EDIT_WINDOW_MS = 5 * 60 * 1000;
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

export interface MessagingOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

function validateReferenceRanges(body: string, references: readonly MessageReferenceInput[]): void {
  if (references.length > 25) {
    throw new WardenXError("INVALID_MESSAGE_REFERENCES", "too many message references", 422);
  }
  const ordered = [...references].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = -1;
  for (const reference of ordered) {
    if (
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < 0 ||
      reference.end <= reference.start ||
      reference.end > body.length ||
      reference.start < previousEnd
    ) {
      throw new WardenXError(
        "INVALID_MESSAGE_REFERENCES",
        "message reference ranges are invalid or overlap",
        422,
      );
    }
    previousEnd = reference.end;
  }
}

interface EffectiveChannelAccessCandidate {
  readonly kind: ChannelKind;
  readonly subjectId: string | null;
  readonly memberSource: ChannelMemberSource | null;
}

/**
 * Evaluate the part of channel visibility that cannot safely be inferred from persisted M36
 * membership alone. Automatic care-team membership mirrors M5 and can lag its source of truth, so
 * it is revalidated through the opaque CareTeamProvider seam on every effective-access decision.
 * Manual membership is an explicit audited override and remains authoritative by domain rule.
 */
async function effectivelyVisibleChannels<T extends EffectiveChannelAccessCandidate>(
  orgId: string,
  userId: string,
  candidates: readonly T[],
  part2Gate: Part2ChannelGate,
  warn?: (message: string, context: Record<string, string>) => void,
): Promise<T[]> {
  const careTeamPatientIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.kind === "care_team" && candidate.subjectId ? [candidate.subjectId] : [],
      ),
    ),
  ];
  const automaticPatientIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.kind === "care_team" && candidate.memberSource === "auto" && candidate.subjectId
        ? [candidate.subjectId]
        : [],
    ),
  );
  const currentCareTeamPatients = new Set<string>();
  const part2AllowedPatients = new Set<string>();

  // A sidebar is bounded by the user's memberships, but do not turn a large caseload into an
  // unbounded burst of seam/database reads. The seam deliberately runs outside M36 transactions.
  let nextPatient = 0;
  const workers = Array.from({ length: Math.min(8, careTeamPatientIds.length) }, async () => {
    while (nextPatient < careTeamPatientIds.length) {
      const patientId = careTeamPatientIds[nextPatient++];
      if (!patientId) continue;
      try {
        const allowed = await part2Gate.allowedUserIds({
          organizationId: orgId,
          patientId,
          userIds: [userId],
        });
        if (allowed.has(userId)) part2AllowedPatients.add(patientId);
        if (automaticPatientIds.has(patientId)) {
          const roster = await getSeam("CareTeamProvider").careTeamMembers({
            organizationId: orgId,
            patientId,
          });
          if (roster.includes(userId)) currentCareTeamPatients.add(patientId);
        }
      } catch (error) {
        // An unavailable clinical/consent seam is an authorization denial, never a stale grant.
        // Logged (ids only) so an outage is distinguishable from a genuine "not a member" 404.
        warn?.("messaging visibility seam failed; denying access", {
          organizationId: orgId,
          patientId,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  });
  await Promise.all(workers);

  return candidates.filter((candidate) => {
    if (candidate.kind === "announcement") return true;
    if (!candidate.memberSource) return false;
    if (candidate.kind !== "care_team") return true;
    if (!candidate.subjectId || !part2AllowedPatients.has(candidate.subjectId)) return false;
    if (candidate.memberSource !== "auto") return true;
    return currentCareTeamPatients.has(candidate.subjectId);
  });
}

async function careTeamTitlesForAuthorizedChannels(
  orgId: string,
  channels: readonly EffectiveChannelAccessCandidate[],
): Promise<ReadonlyMap<string, string>> {
  const patientIds = [
    ...new Set(
      channels.flatMap((channel) =>
        channel.kind === "care_team" && channel.subjectId ? [channel.subjectId] : [],
      ),
    ),
  ];
  const titles = new Map<string, string>();
  let nextPatient = 0;
  const workers = Array.from({ length: Math.min(8, patientIds.length) }, async () => {
    while (nextPatient < patientIds.length) {
      const patientId = patientIds[nextPatient++];
      if (!patientId) continue;
      try {
        const patient = await getSeam("PatientReader").findById({
          organizationId: orgId,
          id: patientId,
        });
        if (!patient || patient.organizationId !== orgId) continue;
        const displayName = `${patient.firstName} ${patient.lastName}`.trim();
        if (displayName) titles.set(patientId, `${displayName} · Care Team`);
      } catch {
        // Patient identity is PHI: an unavailable ownership seam degrades to the generic,
        // already-authorized title instead of exposing stale or guessed metadata.
      }
    }
  });
  await Promise.all(workers);
  return titles;
}

function dmParticipantKey(userId: string, peerUserId: string): string {
  return [userId, peerUserId].sort().join(":");
}

/**
 * Re-check, inside the write transaction, that the actor is still an active user with a live
 * membership (announcement channels are org-wide). `assertMessageChannelAccess` runs before the
 * transaction opens, so this narrows the window for a removal landing in between to the gap between
 * this read and the write (plain READ COMMITTED reads, no row lock), rather than closing it.
 * The Part 2 consent seam cannot run inside a transaction and is only checked up front.
 */
async function assertLiveMembershipInTx(
  tx: Parameters<typeof channelOr404>[0],
  orgId: string,
  userId: string,
  messageId: string,
): Promise<void> {
  const [row] = await tx
    .select({ channelId: MSG.channelId, kind: CH.channelKind })
    .from(MSG)
    .innerJoin(CH, eq(CH.id, MSG.channelId))
    .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, messageId)))
    .limit(1);
  let live = !!row && (await isActiveMessagingUser(tx, orgId, userId));
  if (live && row!.kind !== "announcement") {
    const [member] = await tx
      .select({ userId: CM.userId })
      .from(CM)
      .where(
        and(
          eq(CM.organizationId, orgId),
          eq(CM.channelId, row!.channelId),
          eq(CM.userId, userId),
          isNull(CM.removedAt),
        ),
      )
      .limit(1);
    live = !!member;
  }
  if (!live) throw new NotFoundError("message", messageId);
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

function iso(d: Date | null | undefined): string | null {
  return d == null ? null : d.toISOString();
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

/** Keyset cursor over (created_at, id) — opaque, never an offset (§4.12). `createdAtMicros` is the column read as
 * text (`created_at::text`): a JS Date keeps milliseconds only, and a cursor rounded down to the millisecond re-serves
 * the row it points at (duplicate on every page boundary) and can skip a neighbour. */
function encodeCursor(createdAtMicros: string, id: string): string {
  return Buffer.from(`${createdAtMicros}|${id}`, "utf8").toString("base64url");
}
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A cursor is `created_at::text|uuid` as this service issued it. Anything else is the caller's mistake: a 400, never
 * a database cast error (500) and never a silent first page.
 */
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const [createdAt, id] = parts;
  if (
    parts.length !== 2 ||
    !createdAt ||
    !id ||
    !CURSOR_TIME.test(createdAt) ||
    !CURSOR_ID.test(id)
  ) {
    throw new WardenXError("INVALID_CURSOR", "the cursor is not valid", 400);
  }
  return { createdAt, id };
}

/** Keep inbox previews compact and text-only. The plaintext exists only in the authorized response
 * path and is never written to logs, caches, or denormalized storage. */
function messagePreview(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
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
    /** Injectable seam adapters keep the authorization path deterministic in slice tests. */
    resolvePatientId?: (organizationId: string, patientId: string) => Promise<string | null>;
    careTeamMembers?: (organizationId: string, patientId: string) => Promise<readonly string[]>;
    syncCareTeamChannel?: (
      organizationId: string,
      patientId: string,
    ) => Promise<{ channelId: string; membershipChanged: boolean }>;
    /**
     * GAP-166 — delivers the freshly issued sms/email verification code to the endpoint itself. There is no
     * out-of-band dispatcher yet, so by default NOTHING is sent and the endpoint simply stays `pending`
     * (fail closed: an unverified endpoint is never a delivery target). A throw rolls the registration back.
     */
    /** GAP-065 — the M39 Part 2 consent gate on care_team visibility (default: seam-backed, fail-closed). */
    part2Gate?: Part2ChannelGate;
    /** Operational warning sink (ids only); default: silent. */
    warn?: (message: string, context: Record<string, string>) => void;
    outbox?: MessagingOutboxPort;
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
  const hydrationContext = (orgId: string, viewerUserId: string, channelKind: string) => ({
    orgId,
    viewerUserId,
    channelKind,
    cipher,
    warn: opts.warn,
  });
  const resolvePatientId =
    opts.resolvePatientId ??
    (async (organizationId: string, patientId: string) =>
      (await getSeam("PatientReader").findById({ organizationId, id: patientId }))?.id ?? null);
  const careTeamMembers =
    opts.careTeamMembers ??
    ((organizationId: string, patientId: string) =>
      getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId }));
  const syncCareTeamChannel =
    opts.syncCareTeamChannel ??
    ((organizationId: string, patientId: string) =>
      (getSeam("MessagingProvider") as MessagingProvider).syncCareTeamChannel(
        organizationId,
        patientId,
      ));

  async function mentionCandidates(
    orgId: string,
    userId: string,
    channelId: string,
    query: string,
  ) {
    const channel = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
      await assertActiveMessagingUser(tx, orgId, userId);
      const [row] = await tx
        .select({ kind: CH.channelKind, subjectId: CH.subjectId })
        .from(CH)
        .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
        .limit(1);
      return row ?? null;
    });
    if (
      !channel ||
      !(await (async () => {
        const candidate = await withOrgContext(
          db,
          { organizationId: orgId, userId },
          async (tx) => {
            const [member] = await tx
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
            return {
              kind: channel.kind as ChannelKind,
              subjectId: channel.subjectId,
              memberSource: (member?.source as ChannelMemberSource | undefined) ?? null,
            };
          },
        );
        return (
          (await effectivelyVisibleChannels(orgId, userId, [candidate], part2Gate, opts.warn))
            .length === 1
        );
      })())
    ) {
      throw new NotFoundError("channel", channelId);
    }

    const needle = query.trim().toLowerCase().slice(0, 100);
    const staffRows = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) =>
      tx
        .select({
          entityId: CM.userId,
          displayName: USER.name,
          source: CM.source,
        })
        .from(CM)
        .innerJoin(USER, and(eq(USER.id, CM.userId), eq(USER.status, "active")))
        .innerJoin(
          MEMBERSHIP,
          and(
            eq(MEMBERSHIP.organizationId, CM.organizationId),
            eq(MEMBERSHIP.userId, CM.userId),
            eq(MEMBERSHIP.status, "active"),
          ),
        )
        .where(and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), isNull(CM.removedAt)))
        .limit(50),
    );
    const staff = [];
    for (const row of staffRows) {
      const visible = await effectivelyVisibleChannels(
        orgId,
        row.entityId,
        [
          {
            kind: channel.kind as ChannelKind,
            subjectId: channel.subjectId,
            memberSource: row.source as ChannelMemberSource,
          },
        ],
        part2Gate,
        opts.warn,
      );
      const displayName = row.displayName?.trim() ?? "";
      if (
        visible.length === 1 &&
        displayName &&
        (!needle || displayName.toLowerCase().includes(needle))
      ) {
        staff.push({
          kind: "staff" as const,
          entityId: row.entityId,
          displayName,
          detail: "Staff member",
        });
      }
      if (staff.length >= 20) break;
    }

    const patients = [];
    if (channel.kind === "care_team" && channel.subjectId) {
      try {
        const patient = await getSeam("PatientReader").findById({
          organizationId: orgId,
          id: channel.subjectId,
        });
        if (patient) {
          const displayName = `${patient.firstName} ${patient.lastName}`.trim();
          if (
            !needle ||
            displayName.toLowerCase().includes(needle) ||
            patient.mrn.toLowerCase().includes(needle)
          ) {
            patients.push({
              kind: "patient" as const,
              entityId: patient.id,
              displayName,
              detail: `MRN ${patient.mrn}`,
            });
          }
        }
      } catch {
        // M5 identity is an authorization dependency: fail closed for patient candidates.
      }
    }
    return [...staff, ...patients];
  }
  async function canViewChannelFor(
    orgId: string,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const candidate = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
      if (!(await isActiveMessagingUser(tx, orgId, userId))) return null;
      const c = await tx
        .select({ kind: CH.channelKind, subjectId: CH.subjectId })
        .from(CH)
        .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
        .limit(1);
      if (!c[0]) return null; // unknown / cross-org → no existence oracle
      // §4.5: announcement is org-wide; the bereavement provider-seam refinement (M16) is a later
      // cross-module integration — until then the channel-member check is the visibility rule.
      if (c[0].kind === "announcement") {
        return {
          kind: c[0].kind as ChannelKind,
          subjectId: c[0].subjectId,
          memberSource: null,
        };
      }
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
      return {
        kind: c[0].kind as ChannelKind,
        subjectId: c[0].subjectId,
        memberSource: (m[0]?.source as ChannelMemberSource | undefined) ?? null,
      };
    });
    if (!candidate) return false;
    return (
      (await effectivelyVisibleChannels(orgId, userId, [candidate], part2Gate, opts.warn))
        .length === 1
    );
  }

  /**
   * Edit/delete/mark-read act on an existing message, so the actor must still be allowed into its
   * channel (active user, live membership, Part 2 gate). A miss is a 404, matching canViewChannel's
   * no-existence-oracle rule; `writable` additionally refuses archived channels with 410. Delete is not
   * `writable`: a tombstone is the only way an author can retract a mistaken PHI message after discharge.
   */
  async function assertMessageChannelAccess(
    orgId: string,
    userId: string,
    messageId: string,
    writable: boolean,
  ): Promise<void> {
    const row = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
      const rows = await tx
        .select({ channelId: MSG.channelId, isArchived: CH.isArchived })
        .from(MSG)
        .innerJoin(CH, eq(CH.id, MSG.channelId))
        .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, messageId)))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!row || !(await canViewChannelFor(orgId, userId, row.channelId))) {
      throw new NotFoundError("message", messageId);
    }
    if (writable && row.isArchived) {
      throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
    }
  }
  return {
    // WP 2.4: reactions + pins live in their own module (reaction-pin-service-db.ts).
    ...createDbReactionPinService({
      db,
      canViewChannel: canViewChannelFor,
      outbox: opts.outbox,
      hydrationContext,
    }),
    // ── channels & messages (§4.2; reads) ─────────────────────────────────────────────────────
    async listChannels(orgId, userId): Promise<ChannelSummary[]> {
      const candidates = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        if (!(await isActiveMessagingUser(tx, orgId, userId))) return [];
        const rows = await tx
          .select({
            channelId: CH.id,
            kind: CH.channelKind,
            title: CH.title,
            subjectId: CH.subjectId,
            memberSource: CM.source,
            isArchived: CH.isArchived,
            archivesAt: CH.archivesAt,
            updatedAt: CH.updatedAt,
          })
          .from(CM)
          .innerJoin(CH, eq(CH.id, CM.channelId))
          .where(and(eq(CM.organizationId, orgId), eq(CM.userId, userId), isNull(CM.removedAt)));
        return rows.map((row) => ({
          ...row,
          kind: row.kind as ChannelKind,
          memberSource: row.memberSource as ChannelMemberSource,
        }));
      });
      const rows = await effectivelyVisibleChannels(
        orgId,
        userId,
        candidates,
        part2Gate,
        opts.warn,
      );
      if (rows.length === 0) return [];
      // Resolve minimum-necessary patient identity only after stale memberships and clinical access
      // have been rejected. Calls stay outside the M36 transaction because M5 owns this data and its
      // seam may use the same connection pool.
      const careTeamTitles = await careTeamTitlesForAuthorizedChannels(orgId, rows);

      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const channelIds = rows.map((row) => row.channelId);
        // Unread = delivered-but-unread receipts for this user, grouped by channel (the SD-028
        // partial index `(user_id, status) WHERE status='delivered'` is exactly this path). Scope the
        // aggregation to the already-authorized set so stale channels contribute no metadata at all.
        const unreadRows = await tx
          .select({
            channelId: MSG.channelId,
            count: sql<number>`count(*)::int`,
          })
          .from(MR)
          .innerJoin(MSG, eq(MSG.id, MR.messageId))
          .where(
            and(
              eq(MR.organizationId, orgId),
              eq(MR.userId, userId),
              eq(MR.status, "delivered"),
              inArray(MSG.channelId, channelIds),
            ),
          )
          .groupBy(MSG.channelId);
        const unread = new Map(unreadRows.map((r) => [r.channelId, Number(r.count)]));
        const mentionRows = await tx
          .select({ channelId: MSG.channelId, count: sql<number>`count(DISTINCT ${MSG.id})::int` })
          .from(MER)
          .innerJoin(
            MSG,
            and(eq(MSG.id, MER.messageId), eq(MSG.organizationId, MER.organizationId)),
          )
          .innerJoin(
            MR,
            and(
              eq(MR.messageId, MER.messageId),
              eq(MR.organizationId, MER.organizationId),
              eq(MR.userId, userId),
              eq(MR.status, "delivered"),
            ),
          )
          .where(
            and(
              eq(MER.organizationId, orgId),
              eq(MER.referenceKind, "staff"),
              eq(MER.entityId, userId),
              inArray(MSG.channelId, channelIds),
            ),
          )
          .groupBy(MSG.channelId);
        const mentions = new Map(mentionRows.map((row) => [row.channelId, Number(row.count)]));

        // One bounded query yields the latest row for every already-authorized channel. Decryption
        // happens only after effective visibility has removed stale clinical memberships.
        const latestRows = await tx
          .selectDistinctOn([MSG.channelId], {
            channelId: MSG.channelId,
            messageId: MSG.id,
            bodyCipher: MSG.bodyCipher,
            bodyKind: MSG.bodyKind,
            status: MSG.status,
            createdAt: MSG.createdAt,
            authorDisplayName: USER.name,
          })
          .from(MSG)
          .leftJoin(USER, eq(USER.id, MSG.authorUserId))
          .where(and(eq(MSG.organizationId, orgId), inArray(MSG.channelId, channelIds)))
          .orderBy(MSG.channelId, desc(MSG.createdAt), desc(MSG.id));
        const latest = new Map(latestRows.map((row) => [row.channelId, row]));
        // A text-less latest message (attachment-only) previews as its attachments, viewer-scoped.
        const previewTextByMessage = new Map<string, string>();
        for (const row of latestRows) {
          if (row.status !== "deleted") {
            previewTextByMessage.set(
              row.messageId,
              // WP 2.1: a rich body previews as its plain-text projection, never as JSON or a link target.
              messagePreview(
                decodeStoredBody(
                  row.bodyKind as MessageBodyKind,
                  cipher.open(orgId, row.bodyCipher),
                ).body,
              ),
            );
          }
        }
        const previewAttachments = await loadAttachmentViews(tx, {
          orgId,
          viewerUserId: userId,
          messageIds: [...previewTextByMessage].filter(([, text]) => !text).map(([id]) => id),
        });

        // DM labels are server-derived from the other active channel member. This is a single
        // tenant-scoped join for the entire inbox, never a client-supplied title or per-row query.
        const dmChannelIds = rows.filter((row) => row.kind === "dm").map((row) => row.channelId);
        const peerRows =
          dmChannelIds.length === 0
            ? []
            : await tx
                .select({ channelId: CM.channelId, userId: CM.userId, displayName: USER.name })
                .from(CM)
                .innerJoin(USER, eq(USER.id, CM.userId))
                .where(
                  and(
                    eq(CM.organizationId, orgId),
                    inArray(CM.channelId, dmChannelIds),
                    isNull(CM.removedAt),
                    sql`${CM.userId} <> ${userId}::uuid`,
                  ),
                );
        const peerByChannel = new Map(peerRows.map((peer) => [peer.channelId, peer]));
        const peerUserIds = [...new Set(peerRows.map((peer) => peer.userId))];
        const peerMemberships =
          peerUserIds.length === 0
            ? []
            : await tx
                .select({ membershipId: MEMBERSHIP.id, userId: MEMBERSHIP.userId })
                .from(MEMBERSHIP)
                .where(
                  and(
                    eq(MEMBERSHIP.organizationId, orgId),
                    eq(MEMBERSHIP.status, "active"),
                    inArray(MEMBERSHIP.userId, peerUserIds),
                  ),
                );
        const peerRoleRows =
          peerMemberships.length === 0
            ? []
            : await tx
                .select({ membershipId: MEMBERSHIP_ROLE.membershipId, roleName: ROLE.name })
                .from(MEMBERSHIP_ROLE)
                .innerJoin(ROLE, eq(ROLE.id, MEMBERSHIP_ROLE.roleId))
                .where(
                  and(
                    eq(MEMBERSHIP_ROLE.organizationId, orgId),
                    inArray(
                      MEMBERSHIP_ROLE.membershipId,
                      peerMemberships.map((membership) => membership.membershipId),
                    ),
                    eq(ROLE.enabled, true),
                    or(
                      isNull(MEMBERSHIP_ROLE.expiresAt),
                      sql`${MEMBERSHIP_ROLE.expiresAt} > now()`,
                    ),
                  ),
                );
        const peerUserByMembership = new Map(
          peerMemberships.map((membership) => [membership.membershipId, membership.userId]),
        );
        const rolesByUser = new Map<string, string[]>();
        for (const role of peerRoleRows) {
          const peerUserId = peerUserByMembership.get(role.membershipId);
          if (!peerUserId) continue;
          const roles = rolesByUser.get(peerUserId) ?? [];
          roles.push(role.roleName);
          rolesByUser.set(peerUserId, roles);
        }

        return rows
          .map(
            (r): ChannelSummary => ({
              channelId: r.channelId,
              kind: r.kind,
              title:
                r.kind === "dm"
                  ? peerByChannel.get(r.channelId)?.displayName?.trim() || "Direct message"
                  : r.kind === "care_team" && r.subjectId
                    ? (careTeamTitles.get(r.subjectId) ?? r.title ?? "Care Team")
                    : r.title,
              subjectId: r.subjectId,
              archivedAt: r.isArchived ? (iso(r.archivesAt) ?? iso(r.updatedAt)) : null,
              unreadCount: unread.get(r.channelId) ?? 0,
              mentionCount: mentions.get(r.channelId) ?? 0,
              participantRoles:
                r.kind === "dm"
                  ? [
                      ...(rolesByUser.get(peerByChannel.get(r.channelId)?.userId ?? "") ?? []),
                    ].sort()
                  : [],
              lastActivityAt: iso(latest.get(r.channelId)?.createdAt) ?? iso(r.updatedAt)!,
              lastMessage: (() => {
                const message = latest.get(r.channelId);
                if (!message) return null;
                return {
                  messageId: message.messageId,
                  preview:
                    message.status === "deleted"
                      ? "Message deleted"
                      : previewTextByMessage.get(message.messageId) ||
                        attachmentPreviewLabel(previewAttachments.get(message.messageId) ?? []),
                  createdAt: message.createdAt.toISOString(),
                  authorDisplayName: message.authorDisplayName?.trim() || null,
                };
              })(),
            }),
          )
          .sort(
            (a, b) =>
              b.lastActivityAt.localeCompare(a.lastActivityAt) ||
              a.channelId.localeCompare(b.channelId),
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
        // WP 2.9: names for the member list.
        const memberNames = new Map(
          members.length === 0
            ? []
            : (
                await tx
                  .select({ id: USER.id, name: USER.name })
                  .from(USER)
                  .where(
                    inArray(
                      USER.id,
                      members.map((m) => m.userId),
                    ),
                  )
              ).map((u) => [u.id, u.name?.trim() || null] as const),
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
        const mention = await tx
          .select({ count: sql<number>`count(DISTINCT ${MER.messageId})::int` })
          .from(MER)
          .innerJoin(
            MR,
            and(
              eq(MR.messageId, MER.messageId),
              eq(MR.organizationId, MER.organizationId),
              eq(MR.userId, userId),
              eq(MR.status, "delivered"),
            ),
          )
          .innerJoin(
            MSG,
            and(eq(MSG.id, MER.messageId), eq(MSG.organizationId, MER.organizationId)),
          )
          .where(
            and(
              eq(MER.organizationId, orgId),
              eq(MER.referenceKind, "staff"),
              eq(MER.entityId, userId),
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
          mentionCount: Number(mention[0]?.count ?? 0),
          participantRoles: [],
          lastActivityAt: iso(ch.updatedAt)!,
          lastMessage: null,
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role as ChannelMemberRole,
            source: m.source as ChannelMemberSource,
            displayName: memberNames.get(m.userId) ?? null,
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
        let cur = input.cursor ? decodeCursor(input.cursor) : null;
        const backward = input.anchorMessageId ? true : input.direction === "backward";
        let includeCursor = false;
        if (input.anchorMessageId) {
          const [anchor] = await tx
            .select({ id: MSG.id, createdAtMicros: sql<string>`${MSG.createdAt}::text` })
            .from(MSG)
            .where(
              and(
                eq(MSG.organizationId, orgId),
                eq(MSG.channelId, input.channelId),
                eq(MSG.id, input.anchorMessageId),
              ),
            )
            .limit(1);
          if (!anchor) throw new NotFoundError("message", input.anchorMessageId);
          cur = { id: anchor.id, createdAt: anchor.createdAtMicros };
          includeCursor = true;
        }
        // Stable keyset over (created_at, id). Forward preserves the original contract; backward
        // starts at the newest rows and walks toward older history.
        if (cur) {
          where.push(
            backward
              ? includeCursor
                ? sql`(${MSG.createdAt}, ${MSG.id}) <= (${cur.createdAt}, ${cur.id})`
                : sql`(${MSG.createdAt}, ${MSG.id}) < (${cur.createdAt}, ${cur.id})`
              : sql`(${MSG.createdAt}, ${MSG.id}) > (${cur.createdAt}, ${cur.id})`,
          );
        }
        const rows = await tx
          .select(MESSAGE_ROW_COLUMNS)
          .from(MSG)
          .leftJoin(USER, eq(USER.id, MSG.authorUserId))
          .where(and(...where))
          .orderBy(
            backward ? desc(MSG.createdAt) : asc(MSG.createdAt),
            backward ? desc(MSG.id) : asc(MSG.id),
          )
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const chronologicalRows = backward ? [...pageRows].reverse() : pageRows;
        // Entitled-reader gate: the channel_visibility ABAC predicate already authorized this read
        // at the route, so decrypt each body under the tenant DEK; a 'deleted' tombstone is empty.
        const page = await hydrateMessages(
          tx,
          hydrationContext(orgId, input.userId, ch[0].kind),
          chronologicalRows,
          input.channelId,
        );
        const cursorRow = backward ? chronologicalRows[0] : chronologicalRows.at(-1);
        const nextCursor =
          hasMore && cursorRow ? encodeCursor(cursorRow.createdAtMicros, cursorRow.id) : undefined;
        return {
          messages: page,
          nextCursor,
          patientId: ch[0].kind === "care_team" ? ch[0].subjectId : null,
        };
      });
    },

    // WP 2.2: a message and its direct replies. Thread permissions ARE the channel's: the route has already run
    // `channel_visibility` on the channel id, and every query here is scoped to that channel, so a root that is
    // absent, in another channel or in another org is the one NOT_FOUND a random id gets.
    async listThread(orgId, input) {
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const ch = await tx
          .select({ id: CH.id, kind: CH.channelKind, subjectId: CH.subjectId })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!ch[0]) throw new NotFoundError("channel", input.channelId);
        const [rootRow] = await tx
          .select(MESSAGE_ROW_COLUMNS)
          .from(MSG)
          .leftJoin(USER, eq(USER.id, MSG.authorUserId))
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.channelId, input.channelId),
              eq(MSG.id, input.messageId),
            ),
          )
          .limit(1);
        if (!rootRow) throw new NotFoundError("message", input.messageId);
        const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
        const where: SQL[] = [
          eq(MSG.organizationId, orgId),
          eq(MSG.channelId, input.channelId),
          eq(MSG.parentMessageId, input.messageId),
        ];
        const cur = input.cursor ? decodeCursor(input.cursor) : null;
        if (cur) where.push(sql`(${MSG.createdAt}, ${MSG.id}) > (${cur.createdAt}, ${cur.id})`);
        // Oldest first: a thread reads top to bottom. Same (created_at, id) keyset as the channel list, with the
        // cursor carrying the microsecond text of created_at so rows sharing a millisecond neither repeat nor vanish.
        const replyRows = await tx
          .select(MESSAGE_ROW_COLUMNS)
          .from(MSG)
          .leftJoin(USER, eq(USER.id, MSG.authorUserId))
          .where(and(...where))
          .orderBy(asc(MSG.createdAt), asc(MSG.id))
          .limit(limit + 1);
        const hasMore = replyRows.length > limit;
        const pageRows = replyRows.slice(0, limit);
        const [root, ...replies] = await hydrateMessages(
          tx,
          hydrationContext(orgId, input.userId, ch[0].kind),
          [rootRow, ...pageRows],
          input.channelId,
        );
        const last = pageRows.at(-1);
        return {
          root: root!,
          replies,
          nextCursor: hasMore && last ? encodeCursor(last.createdAtMicros, last.id) : undefined,
          patientId: ch[0].kind === "care_team" ? ch[0].subjectId : null,
        };
      });
    },

    canViewChannel: canViewChannelFor,

    // --- post a message: archive gate (410) → DEK-encrypt + insert + receipt fan-out (§3.4) -----
    async sendMessage(orgId, rawInput) {
      // WP 1.5: a message is valid with text OR an attachment. A blank body is stored as the empty string, sealed
      // like any other body, so edit/revision/idempotency/integrity treat it uniformly.
      const input = withValidMessageContent(rawInput);
      const references = input.references ?? [];
      validateReferenceRanges(input.body, references);
      const candidates = references.length
        ? await mentionCandidates(orgId, input.authorUserId, input.channelId, "")
        : [];
      const candidateByKey = new Map(
        candidates.map((candidate) => [`${candidate.kind}:${candidate.entityId}`, candidate]),
      );
      for (const reference of references) {
        const candidate = candidateByKey.get(`${reference.kind}:${reference.entityId}`);
        if (
          !candidate ||
          !sameMentionToken(input.body.slice(reference.start, reference.end), candidate.displayName)
        ) {
          throw new WardenXError(
            "INVALID_MESSAGE_REFERENCES",
            "a referenced entity or display label is not valid for this conversation",
            422,
          );
        }
      }
      return withOrgContext(
        db,
        { organizationId: orgId, userId: input.authorUserId },
        async (tx) => {
          const ch = await channelOr404(tx, orgId, input.channelId);
          if (ch.isArchived) throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
          const { messageId, createdAt, replayed } = await insertEncryptedMessage(tx, cipher, {
            orgId,
            channelId: input.channelId,
            authorUserId: input.authorUserId,
            body: input.body,
            bodyKind: input.bodyKind,
            richBody: input.richBody,
            parentMessageId: input.parentMessageId,
            quotedMessageId: input.quotedMessageId,
            clientMessageId: input.clientMessageId,
          });
          // WP 1.2: a retry of an already-committed send returns the original and emits nothing again.
          if (replayed) return { messageId, channelId: input.channelId, createdAt };
          // WP 1.5: bind the caller's own completed uploads inside this transaction; any refusal rolls the
          // message back with it (one uniform 422, so no id-existence oracle).
          if (input.attachments?.length) {
            await bindAttachmentsInTx(tx, {
              orgId,
              channelId: input.channelId,
              authorUserId: input.authorUserId,
              messageId,
              attachmentIds: input.attachments.map((attachment) => attachment.attachmentId),
            });
          }
          if (references.length > 0) {
            await tx.insert(MER).values(
              references.map((reference) => ({
                organizationId: orgId,
                messageId,
                referenceKind: reference.kind,
                entityId: reference.entityId,
                startOffset: reference.start,
                endOffset: reference.end,
              })),
            );
            for (const mentionedUserId of new Set(
              references
                .filter(
                  (reference) =>
                    reference.kind === "staff" && reference.entityId !== input.authorUserId,
                )
                .map((reference) => reference.entityId),
            )) {
              await opts.outbox?.publish(tx, {
                eventName: "m36.message.mentioned",
                organizationId: orgId,
                aggregateKind: "message",
                aggregateId: messageId,
                payload: {
                  organizationId: orgId,
                  channelId: input.channelId,
                  messageId,
                  mentionedUserId,
                  actorUserId: input.authorUserId,
                },
              });
            }
          }
          await publishMessageHint(opts.outbox, tx, "sent", {
            orgId,
            channelId: input.channelId,
            messageId,
            parentMessageId: input.parentMessageId,
            at: createdAt,
          });
          return { messageId, channelId: input.channelId, createdAt };
        },
      );
    },

    // --- edit within the window (author only): re-encrypt + re-hash, status='edited' -----------
    async editMessage(orgId, input) {
      await assertMessageChannelAccess(orgId, input.userId, input.messageId, true);
      const references = input.references ?? [];
      validateReferenceRanges(input.body, references);
      if (references.length > 0) {
        const channelId = await withOrgContext(
          db,
          { organizationId: orgId, userId: input.userId },
          async (tx) => {
            const [message] = await tx
              .select({ channelId: MSG.channelId })
              .from(MSG)
              .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
              .limit(1);
            return message?.channelId ?? null;
          },
        );
        if (!channelId) throw new NotFoundError("message", input.messageId);
        const candidates = await mentionCandidates(orgId, input.userId, channelId, "");
        const candidateByKey = new Map(
          candidates.map((candidate) => [`${candidate.kind}:${candidate.entityId}`, candidate]),
        );
        for (const reference of references) {
          const candidate = candidateByKey.get(`${reference.kind}:${reference.entityId}`);
          if (
            !candidate ||
            !sameMentionToken(
              input.body.slice(reference.start, reference.end),
              candidate.displayName,
            )
          ) {
            throw new WardenXError(
              "INVALID_MESSAGE_REFERENCES",
              "a referenced entity or display label is not valid for this conversation",
              422,
            );
          }
        }
      }
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        await assertLiveMembershipInTx(tx, orgId, input.userId, input.messageId);
        // Lock the row so two concurrent edits cannot claim the same revision number.
        const [m] = await tx
          .select({
            authorUserId: MSG.authorUserId,
            status: MSG.status,
            channelId: MSG.channelId,
            parentMessageId: MSG.parentMessageId,
            bodyCipher: MSG.bodyCipher,
            bodySha256: MSG.bodySha256,
            bodyKind: MSG.bodyKind,
            createdAt: MSG.createdAt,
            editedAt: MSG.editedAt,
            ageMs: sql<number>`extract(epoch from (clock_timestamp() - ${MSG.createdAt})) * 1000`,
          })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1)
          .for("update");
        if (!m || m.status === "deleted") throw new NotFoundError("message", input.messageId);
        if (m.authorUserId !== input.userId) {
          throw new ForbiddenError("only the author may edit a message");
        }
        // WP 1.5: text may be cleared only while the message still shows an attachment.
        if (!input.body.trim()) {
          const kept = await loadAttachmentViews(tx, {
            orgId,
            viewerUserId: input.userId,
            messageIds: [input.messageId],
          });
          if (!kept.get(input.messageId)?.length) throw blankMessageError();
        }
        if (Number(m.ageMs) > EDIT_WINDOW_MS) {
          throw new WardenXError(
            "MESSAGE_EDIT_WINDOW_CLOSED",
            "the edit window has closed; send a new message that quotes this one",
            409,
          );
        }
        // ADR-0055 item 2: keep the body being replaced (and its mention snapshot) before overwriting the head.
        const [{ lastNo }] = (await tx
          .select({ lastNo: sql<number>`coalesce(max(${MREV.revisionNo}), 0)` })
          .from(MREV)
          .where(and(eq(MREV.organizationId, orgId), eq(MREV.messageId, input.messageId)))) as [
          { lastNo: number },
        ];
        const previousReferences = await tx
          .select({
            kind: MER.referenceKind,
            entityId: MER.entityId,
            start: MER.startOffset,
            end: MER.endOffset,
          })
          .from(MER)
          .where(and(eq(MER.organizationId, orgId), eq(MER.messageId, input.messageId)));
        await tx.insert(MREV).values({
          organizationId: orgId,
          messageId: input.messageId,
          revisionNo: Number(lastNo) + 1,
          bodyCipher: m.bodyCipher,
          bodySha256: m.bodySha256,
          bodyKind: m.bodyKind,
          referencesSnapshot: previousReferences,
          bodyWrittenAt: m.editedAt ?? m.createdAt,
          editedBy: input.userId,
        });
        // WP 2.1: the edit carries its own format. A structured edit stores a rich body; a text edit of a rich
        // message makes it plain (its plaintext would otherwise be parsed as a document); a legacy kind is kept.
        const next = storedBodyFor({
          body: input.body.trim() ? input.body : "",
          bodyKind: m.bodyKind === "rich" ? "plain" : (m.bodyKind as MessageBodyKind),
          richBody: input.richBody,
        });
        const { cipher: bodyCipher, sha256 } = cipher.seal(orgId, next.plaintext);
        const editedAt = new Date();
        await tx
          .update(MSG)
          .set({
            bodyCipher,
            bodySha256: sha256,
            bodyKind: next.bodyKind,
            status: "edited",
            editedAt,
          })
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)));
        await tx
          .delete(MER)
          .where(and(eq(MER.organizationId, orgId), eq(MER.messageId, input.messageId)));
        if (references.length > 0) {
          // Edits never emit new mention alerts: this avoids duplicate/ambiguous clinical notices.
          // The same structural range validation still prevents stale tokens.
          await tx.insert(MER).values(
            references.map((reference) => ({
              organizationId: orgId,
              messageId: input.messageId,
              referenceKind: reference.kind,
              entityId: reference.entityId,
              startOffset: reference.start,
              endOffset: reference.end,
            })),
          );
        }
        await publishMessageHint(opts.outbox, tx, "edited", {
          orgId,
          channelId: m.channelId,
          messageId: input.messageId,
          parentMessageId: m.parentMessageId,
          at: editedAt,
        });
        return {
          messageId: input.messageId,
          editedAt: editedAt.toISOString(),
        };
      });
    },

    // --- soft-delete (author only): tombstone — status='deleted', cipher RETAINED (M36-F02) ----
    async deleteMessage(orgId, input) {
      await assertMessageChannelAccess(orgId, input.userId, input.messageId, false);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        await assertLiveMembershipInTx(tx, orgId, input.userId, input.messageId);
        const rows = (await tx
          .select({
            authorUserId: MSG.authorUserId,
            status: MSG.status,
            channelId: MSG.channelId,
            parentMessageId: MSG.parentMessageId,
          })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1)) as Array<{
          authorUserId: string | null;
          status: string;
          channelId: string;
          parentMessageId: string | null;
        }>;
        const m = rows[0];
        if (!m || m.status === "deleted") throw new NotFoundError("message", input.messageId);
        if (m.authorUserId !== input.userId) {
          throw new ForbiddenError("only the author may delete a message");
        }
        // The body_cipher is retained through the retention window; only status/deleted_at change.
        // edited_at is cleared so the mutually-exclusive `message_status_shape` CHECK holds.
        const deletedAt = new Date();
        await tx
          .update(MSG)
          .set({ status: "deleted", deletedAt: deletedAt, editedAt: null })
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)));
        await publishMessageHint(opts.outbox, tx, "deleted", {
          orgId,
          channelId: m.channelId,
          messageId: input.messageId,
          parentMessageId: m.parentMessageId,
          at: deletedAt,
        });
      });
    },

    async markRead(orgId, input) {
      await assertMessageChannelAccess(orgId, input.userId, input.messageId, false);
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

    async searchMentionCandidates(orgId, userId, channelId, query) {
      return mentionCandidates(orgId, userId, channelId, query);
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

    async openCareTeamChannel(orgId, userId, patientId) {
      const conceal = (): NotFoundError => new NotFoundError("care team conversation", patientId);

      const actorActive = await withOrgContext(db, { organizationId: orgId, userId }, (tx) =>
        isActiveMessagingUser(tx, orgId, userId),
      );
      if (!actorActive) throw conceal();

      // PatientReader is M5's opaque tenant-scoped identity seam. Checking it before synchronization
      // prevents an arbitrary/foreign UUID from materializing an empty M36 channel.
      const resolvedPatientId = await resolvePatientId(orgId, patientId);
      if (!resolvedPatientId) throw conceal();
      const roster = new Set(await careTeamMembers(orgId, resolvedPatientId));
      const preflight = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const rows = await tx
          .select({ source: CM.source })
          .from(CH)
          .innerJoin(
            CM,
            and(
              eq(CM.organizationId, CH.organizationId),
              eq(CM.channelId, CH.id),
              eq(CM.userId, userId),
              isNull(CM.removedAt),
            ),
          )
          .where(
            and(
              eq(CH.organizationId, orgId),
              eq(CH.channelKind, "care_team"),
              eq(CH.subjectId, resolvedPatientId),
            ),
          )
          .limit(1);
        return roster.has(userId) || rows[0]?.source === "manual";
      });
      if (!preflight) throw conceal();

      // The provider owns reconciliation and deliberately resolves M5 before its write transaction.
      // Do not wrap this seam call in another pooled transaction.
      const synchronized = await syncCareTeamChannel(orgId, resolvedPatientId);

      // Authorization can change while reconciliation is running. Re-read M5 and the resulting M36
      // membership so a removed clinician cannot use a stale preflight decision to enter the thread.
      const currentRoster = new Set(await careTeamMembers(orgId, resolvedPatientId));
      const result = await withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        if (!(await isActiveMessagingUser(tx, orgId, userId))) return null;
        const rows = await tx
          .select({
            channelId: CH.id,
            isArchived: CH.isArchived,
            source: CM.source,
          })
          .from(CH)
          .innerJoin(
            CM,
            and(
              eq(CM.organizationId, CH.organizationId),
              eq(CM.channelId, CH.id),
              eq(CM.userId, userId),
              isNull(CM.removedAt),
            ),
          )
          .where(
            and(
              eq(CH.organizationId, orgId),
              eq(CH.id, synchronized.channelId),
              eq(CH.channelKind, "care_team"),
              eq(CH.subjectId, resolvedPatientId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        if (row.source === "auto" && !currentRoster.has(userId)) return null;
        return row;
      });
      if (!result) throw conceal();
      return {
        channelId: result.channelId,
        kind: "care_team" as const,
        patientId: resolvedPatientId,
        archived: result.isArchived,
      };
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
          await publishMessageHint(opts.outbox, tx, "sent", {
            orgId,
            channelId,
            messageId,
            at: createdAt,
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
        // §2.4.4 settles an in-app row on a confirmed delivery. Here that is poll time (the ADR-0036 REST
        // refetch/poll model; ADR-0054 realtime is accepted but does not change this).
        // `apps/web/src/modules/36-messaging/notifications-inbox.tsx` is this route's only caller, so the fetch
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
