// apps/backend/src/modules/36-messaging/group-tags/group-tags.ts - ADR-0107 (PROPOSED): resolve `@role`, `@care-team` and `@on-call` to people at send.
// Called from the send transaction in messaging-route-service-db.ts (the only importer). Reads: role, membership_role, membership, channel_member
// (active members) and, for on_call, the guarded EscalationRouter seam. Writes nothing itself: it returns who each tag meant, and the caller freezes
// that in message_group_tag_recipient in the same transaction.
//
// Rules (each has a test): the flag off refuses the kinds; every person is an active channel member (nobody is added or leaked to); `@on-call` is the
// router's tier 1 NOW for the care-team patient and a gap / unavailable roster REFUSES the send (never a fall-back); a tag that reaches nobody, or
// more than GROUP_TAG_MAX_RECIPIENTS people, is refused rather than silently shortened; the author is never a recipient.
import { schema } from "@chartwarden/db";
import {
  ChartWardenError,
  type EscalationRouter,
  GROUP_TAG_ERROR_CODES,
  GROUP_TAG_MAX_PER_MESSAGE,
  GROUP_TAG_MAX_RECIPIENTS,
  GROUP_TAG_TEAM_LABEL,
  type GroupTagKind,
  ON_CALL_TAG_ENTITY_IDS,
  ON_CALL_TAG_LABELS,
  isGroupTagKind,
  onCallRoleForEntityId,
} from "@chartwarden/types";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { type Tx, activeMemberIds } from "../messaging-write-core";
import { sameMentionToken } from "../rich-body-codec";

const ROLE = schema.roles;
const MROLE = schema.membershipRoles;
const MEMBERSHIP = schema.memberships;

export interface GroupTagPorts {
  /** Tenant flag `messaging.group_tags` (absent = off). */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The guarded EscalationRouter (ADR-0081): only M19 answers who is on call. */
  readonly router: EscalationRouter;
  readonly now?: () => Date;
}

export interface GroupTagReference {
  readonly kind: string;
  readonly entityId: string;
  readonly start: number;
  readonly end: number;
}

export interface ResolvedGroupTag {
  readonly reference: GroupTagReference;
  readonly kind: GroupTagKind;
  readonly userIds: readonly string[];
}

const refuse = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422);

/** Resolves every group-tag reference of one message. Pure input, no writes. */
export async function resolveGroupTags(
  tx: Tx,
  ports: GroupTagPorts | undefined,
  ctx: {
    readonly orgId: string;
    readonly authorUserId: string;
    readonly channel: { id: string; kind: string; subjectId: string | null };
    /** The message's plain text, to check each tag's `@label` token. */
    readonly body: string;
    readonly references: readonly GroupTagReference[];
  },
): Promise<ResolvedGroupTag[]> {
  const tags = ctx.references.filter((r) => isGroupTagKind(r.kind));
  if (tags.length === 0) return [];
  if (!ports || !(await ports.isEnabled(ctx.orgId))) {
    throw refuse(GROUP_TAG_ERROR_CODES.disabled, "group tags are not enabled");
  }
  if (tags.length > GROUP_TAG_MAX_PER_MESSAGE) {
    throw refuse(
      GROUP_TAG_ERROR_CODES.tooMany,
      `a message may carry at most ${GROUP_TAG_MAX_PER_MESSAGE} group tags`,
    );
  }
  const members = new Set(await activeMemberIds(tx, ctx.orgId, ctx.channel.id));
  const out: ResolvedGroupTag[] = [];
  for (const reference of tags) {
    const kind = reference.kind as GroupTagKind;
    const label = await canonicalLabel(tx, ports, ctx, kind, reference.entityId);
    if (
      label === null ||
      !sameMentionToken(ctx.body.slice(reference.start, reference.end), label)
    ) {
      throw refuse(GROUP_TAG_ERROR_CODES.invalid, "a group tag is not valid for this conversation");
    }
    const candidates = await peopleFor(tx, ports, ctx, kind, reference.entityId, members);
    const userIds = [...new Set(candidates)].filter(
      (id) => members.has(id) && id !== ctx.authorUserId,
    );
    if (userIds.length === 0) {
      throw refuse(GROUP_TAG_ERROR_CODES.empty, "a group tag reaches nobody in this conversation");
    }
    if (userIds.length > GROUP_TAG_MAX_RECIPIENTS) {
      throw refuse(
        GROUP_TAG_ERROR_CODES.tooMany,
        `a group tag may reach at most ${GROUP_TAG_MAX_RECIPIENTS} people`,
      );
    }
    out.push({ reference, kind, userIds });
  }
  return out;
}

const isCareTeam = (channel: { kind: string; subjectId: string | null }): boolean =>
  channel.kind === "care_team" && channel.subjectId !== null;

/** The label the server expects after `@`, or null when the tag cannot exist in this conversation. */
async function canonicalLabel(
  tx: Tx,
  _ports: GroupTagPorts,
  ctx: { orgId: string; channel: { id: string; kind: string; subjectId: string | null } },
  kind: GroupTagKind,
  entityId: string,
): Promise<string | null> {
  const id = entityId.toLowerCase();
  if (kind === "team") {
    return isCareTeam(ctx.channel) && id === ctx.channel.id.toLowerCase()
      ? GROUP_TAG_TEAM_LABEL
      : null;
  }
  if (kind === "on_call") {
    const role = onCallRoleForEntityId(id);
    return role && isCareTeam(ctx.channel) ? ON_CALL_TAG_LABELS[role] : null;
  }
  const [row] = await tx
    .select({ name: ROLE.name })
    .from(ROLE)
    .where(
      and(
        eq(ROLE.id, id),
        eq(ROLE.enabled, true),
        or(eq(ROLE.organizationId, ctx.orgId), isNull(ROLE.organizationId)),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

async function peopleFor(
  tx: Tx,
  ports: GroupTagPorts,
  ctx: { orgId: string; channel: { id: string; kind: string; subjectId: string | null } },
  kind: GroupTagKind,
  entityId: string,
  members: ReadonlySet<string>,
): Promise<string[]> {
  const id = entityId.toLowerCase();
  if (kind === "team") return [...members];
  if (kind === "on_call") return onCallNow(ports, ctx, id);
  if (members.size === 0) return [];
  // The role's holders among the channel's members: active membership, grant not expired.
  const rows = await tx
    .select({ userId: MEMBERSHIP.userId })
    .from(MROLE)
    .innerJoin(MEMBERSHIP, eq(MEMBERSHIP.id, MROLE.membershipId))
    .where(
      and(
        eq(MROLE.organizationId, ctx.orgId),
        eq(MROLE.roleId, id),
        eq(MEMBERSHIP.status, "active"),
        inArray(MEMBERSHIP.userId, [...members]),
        or(isNull(MROLE.expiresAt), gt(MROLE.expiresAt, sql`now()`)),
      ),
    );
  return rows.map((r) => r.userId);
}

async function onCallNow(
  ports: GroupTagPorts,
  ctx: { orgId: string; channel: { subjectId: string | null } },
  entityId: string,
): Promise<string[]> {
  const role = onCallRoleForEntityId(entityId);
  if (!role || !ctx.channel.subjectId) return [];
  const asOf = (ports.now?.() ?? new Date()).toISOString();
  // A router failure propagates as a 5xx: it is never turned into a gap or a person (ADR-0081).
  const answer = await ports.router.resolveTier(ctx.orgId, {
    patientId: ctx.channel.subjectId,
    requiredRole: role,
    tier: 1,
    asOf,
  });
  if (answer.kind !== "resolved") {
    throw refuse(
      GROUP_TAG_ERROR_CODES.onCallUnresolved,
      "nobody is confirmed on call for this role right now; use the agency telephone procedure",
    );
  }
  return [...answer.userIds];
}

export interface GroupTagCandidate {
  readonly kind: GroupTagKind;
  readonly entityId: string;
  readonly displayName: string;
  readonly detail: string;
}

/**
 * The picker's group entries for one conversation (flag off => none). Labels only: who is behind a tag is never shown here (ADR-0107 D8). Roles
 * are offered only when an active member of the conversation holds them; team and on-call only in a care-team conversation.
 */
export async function groupTagCandidates(
  tx: Tx,
  ports: GroupTagPorts | undefined,
  ctx: { orgId: string; channel: { id: string; kind: string; subjectId: string | null } },
  needle: string,
): Promise<GroupTagCandidate[]> {
  if (!ports || !(await ports.isEnabled(ctx.orgId))) return [];
  const all: GroupTagCandidate[] = [];
  if (isCareTeam(ctx.channel)) {
    all.push({
      kind: "team",
      entityId: ctx.channel.id,
      displayName: GROUP_TAG_TEAM_LABEL,
      detail: "Everyone in this care team",
    });
    for (const [role, entityId] of Object.entries(ON_CALL_TAG_ENTITY_IDS)) {
      all.push({
        kind: "on_call",
        entityId,
        displayName: ON_CALL_TAG_LABELS[role as keyof typeof ON_CALL_TAG_LABELS],
        detail: "Who is on call now",
      });
    }
  }
  const members = await activeMemberIds(tx, ctx.orgId, ctx.channel.id);
  if (members.length > 0) {
    const roles = await tx
      .selectDistinct({ id: ROLE.id, name: ROLE.name })
      .from(MROLE)
      .innerJoin(MEMBERSHIP, eq(MEMBERSHIP.id, MROLE.membershipId))
      .innerJoin(ROLE, eq(ROLE.id, MROLE.roleId))
      .where(
        and(
          eq(MROLE.organizationId, ctx.orgId),
          eq(MEMBERSHIP.status, "active"),
          eq(ROLE.enabled, true),
          inArray(MEMBERSHIP.userId, members),
          or(isNull(MROLE.expiresAt), gt(MROLE.expiresAt, sql`now()`)),
        ),
      )
      .limit(MAX_ROLE_CANDIDATES);
    for (const role of roles) {
      all.push({ kind: "role", entityId: role.id, displayName: role.name, detail: "Role" });
    }
  }
  return all.filter((c) => !needle || c.displayName.toLowerCase().includes(needle));
}

const MAX_ROLE_CANDIDATES = 50;
