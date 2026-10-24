// M36 ADR-0087 (PROPOSED), slice S2 - the READ side of break-glass: "may this user read this channel under a live grant?" and the trail row
// each such read leaves. Nothing here ever lets anyone WRITE: `canViewChannel` (membership, Part 2, care-team roster) is untouched and still
// decides every send, edit, delete, react, pin, task assignee and alert recipient; only the read routes and read services named in the ADR
// ask `canRead` below, and a grantee reaches those over REST only (realtime rooms, global search and export stay membership-only).
//
// What a grant skips: ONLY the channel-membership and care-team-roster checks. It never skips:
//   - the feature flag (a kill switch ends every grant at once, within the flag cache window),
//   - an active user (a deactivated grantee reads nothing),
//   - the role-category refusal (patient_family, external_auditor, platform_staff never read through a grant),
//   - the Part 2 consent gate on a care_team channel (ADR-0087 D3: a SUD patient's channel stays unreadable to someone M39 does not cover),
//   - expiry and revocation, judged on the DATABASE clock (`expires_at > now()`), so there is no sweeper and no lag window.
// Every failure to decide (a seam outage, a missing subject) reads as a denial.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { BREAK_GLASS_FLAG_KEY, type BreakGlassReadKind } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { excludedMemberUserIds } from "../member-category-gate";
import type { Tx } from "../messaging-write-core";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";

const CH = schema.channels;
const G = schema.messageBreakGlassGrants;

export type Part2Verdict = "not_applicable" | "allowed" | "denied" | "unavailable";

export type BreakGlassDenyReason =
  | "flag_off"
  | "inactive_user"
  | "no_channel"
  | "announcement"
  | "family"
  | "no_live_grant"
  | "excluded_category"
  | "part2_denied"
  | "part2_unavailable";

export type BreakGlassReadDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BreakGlassDenyReason };

/** Everything the decision needs, already read. Pure so the unit matrix can cover every cell without a database. */
export interface BreakGlassReadFacts {
  readonly flagOn: boolean;
  readonly activeUser: boolean;
  /** null when the channel does not exist in this organisation (no existence oracle: a denial like any other). */
  readonly channelKind: string | null;
  readonly liveGrant: boolean;
  readonly excludedCategory: boolean;
  /** Only meaningful for a care_team channel; any other kind passes "not_applicable". */
  readonly part2: Part2Verdict;
}

export function decideBreakGlassRead(f: BreakGlassReadFacts): BreakGlassReadDecision {
  if (!f.flagOn) return { allowed: false, reason: "flag_off" };
  if (!f.activeUser) return { allowed: false, reason: "inactive_user" };
  if (f.channelKind === null) return { allowed: false, reason: "no_channel" };
  // Announcements are org-wide readable already; a grant is meaningless there and must never be recorded as the reason.
  if (f.channelKind === "announcement") return { allowed: false, reason: "announcement" };
  // ADR-0099 D6: a family conversation is readable by the care-team predicate and nothing else. No grant, however fresh, opens it.
  if (f.channelKind === "family") return { allowed: false, reason: "family" };
  if (!f.liveGrant) return { allowed: false, reason: "no_live_grant" };
  if (f.excludedCategory) return { allowed: false, reason: "excluded_category" };
  if (f.part2 === "denied") return { allowed: false, reason: "part2_denied" };
  if (f.part2 === "unavailable") return { allowed: false, reason: "part2_unavailable" };
  return { allowed: true };
}

/** The live (un-revoked, unexpired on the database clock) grant of this user on this channel, if any. Run inside an org context. */
export async function findLiveBreakGlassGrant(
  tx: Pick<Tx, "select">,
  q: { readonly orgId: string; readonly userId: string; readonly channelId: string },
): Promise<{ readonly id: string } | null> {
  const [row] = await tx
    .select({ id: G.id })
    .from(G)
    .where(
      and(
        eq(G.organizationId, q.orgId),
        eq(G.channelId, q.channelId),
        eq(G.granteeUserId, q.userId),
        isNull(G.revokedAt),
        sql`${G.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface BreakGlassFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export interface BreakGlassReadAccessDeps {
  readonly db: DbClient;
  readonly part2Gate: Part2ChannelGate;
  /** The M1 feature-flag reader. Absent => the feature is off everywhere. */
  readonly flags?: BreakGlassFlagReader | undefined;
  /** The route service's own active-user rule (a membership and a user both active). Injected to avoid an import cycle. */
  readonly isActiveUser: (tx: Tx, orgId: string, userId: string) => Promise<boolean>;
  /**
   * Whether the user STILL holds messaging.break_glass.invoke. A grant is not a standing right: removing the permission (or demoting the
   * person) ends the access at the next read, not at the grant's expiry. Absent => nobody holds it (fail closed).
   */
  readonly holdsInvoke?: ((orgId: string, userId: string) => Promise<boolean>) | undefined;
  readonly warn?: ((message: string, context: Record<string, string>) => void) | undefined;
}

export interface BreakGlassReadAccess {
  /** Whether a live grant lets `userId` READ `channelId`. Fail closed: any error is a denial. */
  canRead(orgId: string, userId: string, channelId: string): Promise<boolean>;
  /**
   * Whether `userId` could HOLD a grant on `channelId` (every rule of `canRead` except that a grant already exists): flag on, active user,
   * not an excluded role category, not an announcement, and the Part 2 gate satisfied. Used to refuse a request, with the same answer for
   * every reason, so a refusal never says why (it would disclose a patient's Part 2 status).
   */
  canHold(orgId: string, userId: string, channelId: string): Promise<boolean>;
}

export function createBreakGlassReadAccess(deps: BreakGlassReadAccessDeps): BreakGlassReadAccess {
  // Cached a few seconds per org like every messaging flag: a kill switch lands within that window.
  const flagOn = cacheFlagRead(async (organizationId) =>
    deps.flags ? (await deps.flags.forOrg(organizationId))[BREAK_GLASS_FLAG_KEY] === true : false,
  );

  async function part2Of(orgId: string, userId: string, patientId: string): Promise<Part2Verdict> {
    let unavailable = false;
    try {
      const allowed = await deps.part2Gate.allowedUserIds({
        organizationId: orgId,
        patientId,
        userIds: [userId],
        onUnavailable: () => {
          unavailable = true;
        },
      });
      if (allowed.has(userId)) return "allowed";
      return unavailable ? "unavailable" : "denied";
    } catch (error) {
      deps.warn?.("break-glass part 2 gate failed; denying access", {
        organizationId: orgId,
        error: error instanceof Error ? error.name : "unknown",
      });
      return "unavailable";
    }
  }

  /** `requireLiveGrant` false asks "could this user hold a grant here?" (the request path); true asks "does a live grant let them read?". */
  async function evaluate(
    orgId: string,
    userId: string,
    channelId: string,
    requireLiveGrant: boolean,
  ): Promise<boolean> {
    try {
      if (!(await flagOn(orgId))) return false;
      // A grant is not a standing right: the holder must STILL hold the invoke permission (absent resolver => nobody does).
      if (!deps.holdsInvoke || !(await deps.holdsInvoke(orgId, userId))) return false;
      const base = await withOrgContext(deps.db, { organizationId: orgId, userId }, async (tx) => {
        // Cheapest first: almost every denied read has no grant at all.
        const grant = requireLiveGrant
          ? await findLiveBreakGlassGrant(tx, { orgId, userId, channelId })
          : true;
        if (!grant) return null;
        const activeUser = await deps.isActiveUser(tx, orgId, userId);
        const [channel] = await tx
          .select({ kind: CH.channelKind, subjectId: CH.subjectId })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        const excludedCategory = activeUser
          ? (await excludedMemberUserIds(tx, orgId, [userId])).size > 0
          : false;
        return { activeUser, channel: channel ?? null, excludedCategory };
      });
      if (!base) return false;
      const facts = {
        flagOn: true,
        activeUser: base.activeUser,
        channelKind: base.channel ? String(base.channel.kind) : null,
        liveGrant: true,
        excludedCategory: base.excludedCategory,
      } as const;
      const isCareTeam = base.channel?.kind === "care_team";
      const pre = decideBreakGlassRead({
        ...facts,
        part2: isCareTeam ? "allowed" : "not_applicable",
      });
      if (!pre.allowed || !isCareTeam) return pre.allowed;
      // The consent seam runs outside the transaction (like every M36 visibility decision) and only for a grantee who already qualifies.
      const subject = base.channel?.subjectId ?? null;
      const part2 = subject ? await part2Of(orgId, userId, subject) : "denied";
      return decideBreakGlassRead({ ...facts, part2 }).allowed;
    } catch (error) {
      deps.warn?.("break-glass read check failed; denying access", {
        organizationId: orgId,
        error: error instanceof Error ? error.name : "unknown",
      });
      return false;
    }
  }

  return {
    canRead: (orgId, userId, channelId) => evaluate(orgId, userId, channelId, true),
    canHold: (orgId, userId, channelId) => evaluate(orgId, userId, channelId, false),
  };
}

export interface BreakGlassReadRecord {
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly kind: BreakGlassReadKind;
  /** The thread root, attachment or other single resource read; omit for a whole-channel or list read. */
  readonly resourceId?: string | null;
  /** How many items a list read returned (a count, never ids of bodies). */
  readonly itemCount?: number | null;
}

/**
 * Record, in the SAME transaction as the read, that `userId` read `channelId` under a live grant (ids, kind, count, database-clock instant;
 * never a body). One statement: it inserts a trail row against the user's live grant when there is one and reports whether the user is still
 * a live channel member. The table's own guard refuses a row for a grant that is not live now or not the reader's, so a read that cannot be
 * recorded cannot happen.
 *
 * Returns whether a row was written. A reader with NO live grant who is not a live member is a read the route should never have allowed
 * (the grant ended between the route check and now): the caller fails closed on `recorded === false && liveMember === false`.
 */
export async function recordBreakGlassRead(
  tx: Pick<Tx, "execute">,
  r: BreakGlassReadRecord,
): Promise<{ readonly recorded: boolean; readonly liveMember: boolean }> {
  const res = await tx.execute<{ recorded: number; live_member: boolean }>(sql`
    WITH ins AS (
      INSERT INTO message_break_glass_read (organization_id, grant_id, read_kind, resource_id, item_count)
      SELECT g.organization_id, g.id, ${r.kind}, ${r.resourceId ?? null}::uuid, ${r.itemCount ?? null}::integer
        FROM message_break_glass_grant g
       WHERE g.organization_id = ${r.orgId}::uuid AND g.channel_id = ${r.channelId}::uuid AND g.grantee_user_id = ${r.userId}::uuid
         AND g.revoked_at IS NULL AND g.expires_at > now()
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins)::int AS recorded,
           EXISTS (
             SELECT 1 FROM channel_member m
              WHERE m.organization_id = ${r.orgId}::uuid AND m.channel_id = ${r.channelId}::uuid
                AND m.user_id = ${r.userId}::uuid AND m.removed_at IS NULL
           ) AS live_member`);
  const row = res.rows[0];
  return { recorded: (row?.recorded ?? 0) > 0, liveMember: row?.live_member === true };
}
