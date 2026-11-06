// apps/backend/src/modules/16-bereavement/routes/group-service-drizzle.ts — the Drizzle-backed support-group service (ADR-0109 D10, PR 3).
//
// Every method runs inside one `withOrgContext` transaction (RLS on `app.org_id`). Group and session state changes are compare-and-set UPDATEs on
// `version` + status; `If-Match` (never a body field) names the version read.
//
//   open        draft -> open. A recurring group's sessions are materialized from its recurrence (group-local wall time, DST-safe). A VOLUNTEER
//               facilitator must pass the 418.78 gates at this moment (M15's `VolunteerComplianceProvider`, fail closed).
//   close       draft | open -> completed | cancelled. Live enrollments are withdrawn (`group_ended`) and future scheduled sessions cancelled.
//   enroll      program families only (`program/program-contacts.ts`), into an OPEN group, under capacity (counted under a row lock on the group).
//   attendance  a session that has started and is not cancelled. Each NEW attendee gets an attendance row AND a contact-log ACTIVITY row
//               (`support_group_session`, outcome `attended`, contact_at = the session start, id = the attendance id) on the same transaction: no
//               outreach row, no cadence item, never counted in M30. A retry is a no-op per contact (both unique indexes). The session becomes `held`.
//
// The facilitator columns hold membership ids. A staff facilitator must resolve to a bereavement-capable paid discipline; a volunteer facilitator
// to the volunteer discipline (gates checked at open and, through `bereavement_group_scope`, at every run route).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  BereavedContactRelationship,
  BereavementGroupRecurrence,
  BereavementGroupWithdrawnReason,
} from "@chartwarden/types";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import {
  BEREAVEMENT_CAPABLE_DISCIPLINES,
  BEREAVEMENT_OVERSIGHT_ROLES,
  BEREAVEMENT_VOLUNTEER_DISCIPLINE,
  disciplineForRoleKeys,
} from "../abac-predicates";
import type { BereavementCipher } from "../bereavement-crypto";
import { recordSessionAttendance } from "../groups/attendance-drizzle";
import { materializeSessions, recurrenceProblem } from "../groups/recurrence";
import { loadContactEnrollments, loadGroupRoster } from "../groups/roster-drizzle";
import { BereavementStateError, checkVersion } from "../lifecycle/index";
import { loadProgramContacts } from "../program/program-contacts";
import type { M16ReadActor, M16WriteActor } from "./actor";
import { type Cursor, clampLimit, decodeCheckedCursor, toCursorPage } from "./concurrency";
import type {
  GroupDetailView,
  GroupEnrollmentView,
  GroupFieldsInput,
  GroupRosterEntry,
  GroupSessionView,
  GroupView,
  M16GroupService,
} from "./group-service";
import type { WriteOutboxPort } from "./write-service";

type GroupRow = typeof schema.bereavementSupportGroup.$inferSelect;
type SessionRow = typeof schema.bereavementSupportGroupSession.$inferSelect;

const GROUP_PAGE = { defaultSize: 25, maxSize: 100 } as const;
/** A group holds at most 52 recurring meetings plus drop-ins; the session list is bounded. */
const MAX_SESSIONS = 200;
const MAX_ATTENDEES_PER_CALL = 200;

export interface M16GroupDeps {
  /** The catalog-validating tx publisher (callerModule `m16`). */
  readonly outbox: WriteOutboxPort;
  /** Seals / opens the meeting link. Unbound => a link cannot be stored (422) and reads show none. */
  readonly cipher?: BereavementCipher;
  /** The bereavement discipline a MEMBERSHIP evidences (the ABAC resolver's `disciplineOf`); null = unknown (refused). */
  readonly disciplineOf: (organizationId: string, membershipId: string) => Promise<string | null>;
  /** M15's 418.78 verdict for a volunteer membership. Throws / false => refused. */
  readonly volunteerGatesSatisfied: (input: {
    readonly organizationId: string;
    readonly volunteerMembershipId: string;
  }) => Promise<boolean>;
  readonly now?: () => Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const stale = (what: string): BereavementStateError =>
  new BereavementStateError("STALE_VERSION", `the ${what} has moved on; re-read it and retry`);

export { withdrawLapsedGroupEnrollments } from "../groups/enrollment-sweep";

export function buildDrizzleM16GroupService(db: DbClient, deps: M16GroupDeps): M16GroupService {
  const GROUP = schema.bereavementSupportGroup;
  const SESSION = schema.bereavementSupportGroupSession;
  const ENROLL = schema.bereavementSupportGroupEnrollment;
  const ATTEND = schema.bereavementSupportGroupAttendance;
  const LOG = schema.bereavementContactLog;
  const CONTACT = schema.bereavedContact;
  const now = deps.now ?? (() => new Date());
  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });
  const asTx = (scoped: unknown): DbClient => scoped as DbClient;

  async function groupOr404(
    tx: DbClient,
    groupId: string,
    opts: { readonly lock?: boolean } = {},
  ): Promise<GroupRow> {
    const q = tx.select().from(GROUP).where(eq(GROUP.id, groupId)).limit(1);
    const [row] = await (opts.lock === true ? q.for("update") : q);
    if (!row) throw new BereavementStateError("GROUP_NOT_FOUND", "support group not found");
    return row;
  }

  async function sessionOr404(
    tx: DbClient,
    groupId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const [row] = await tx
      .select()
      .from(SESSION)
      .where(and(eq(SESSION.id, sessionId), eq(SESSION.groupId, groupId)))
      .limit(1);
    if (!row) throw new BereavementStateError("SESSION_NOT_FOUND", "session not found");
    return row;
  }

  /** Enrolled counts and next-session starts for a set of groups (two grouped queries). */
  async function statsFor(
    tx: DbClient,
    groupIds: readonly string[],
  ): Promise<Map<string, { enrolled: number; next: Date | null }>> {
    const out = new Map<string, { enrolled: number; next: Date | null }>();
    if (groupIds.length === 0) return out;
    for (const id of groupIds) out.set(id, { enrolled: 0, next: null });
    const counts = await tx
      .select({ groupId: ENROLL.groupId, n: sql<number>`count(*)::int` })
      .from(ENROLL)
      .where(and(inArray(ENROLL.groupId, [...groupIds]), eq(ENROLL.status, "enrolled")))
      .groupBy(ENROLL.groupId);
    for (const c of counts) out.set(c.groupId, { enrolled: c.n, next: null });
    const nexts = await tx
      .select({ groupId: SESSION.groupId, next: sql<Date>`min(${SESSION.startsAt})` })
      .from(SESSION)
      .where(
        and(
          inArray(SESSION.groupId, [...groupIds]),
          eq(SESSION.status, "scheduled"),
          gt(SESSION.startsAt, now()),
        ),
      )
      .groupBy(SESSION.groupId);
    for (const n of nexts) {
      const cur = out.get(n.groupId) ?? { enrolled: 0, next: null };
      out.set(n.groupId, { ...cur, next: n.next === null ? null : new Date(n.next) });
    }
    return out;
  }

  function view(row: GroupRow, stats: { enrolled: number; next: Date | null }): GroupView {
    return {
      groupId: row.id,
      name: row.name,
      description: row.description ?? null,
      format: row.format,
      modality: row.modality,
      enrollmentRequired: row.enrollmentRequired,
      facilitatorKind: row.facilitatorKind,
      facilitatorUserId: row.facilitatorUserId,
      coFacilitatorUserId: row.coFacilitatorUserId ?? null,
      capacity: row.capacity ?? null,
      status: row.status,
      recurrence: (row.recurrenceJsonb ?? null) as BereavementGroupRecurrence | null,
      timezone: row.timezone,
      venueText: row.venueText ?? null,
      hasJoinUrl: row.joinUrlCipher !== null,
      enrolledCount: stats.enrolled,
      nextSessionAt: iso(stats.next),
      openedAt: iso(row.openedAt),
      closedAt: iso(row.closedAt),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function detail(tx: DbClient, row: GroupRow): Promise<GroupDetailView> {
    const stats = (await statsFor(tx, [row.id])).get(row.id) ?? { enrolled: 0, next: null };
    let joinUrl: string | null = null;
    if (row.joinUrlCipher !== null && deps.cipher !== undefined) {
      joinUrl = await deps.cipher.decrypt(
        row.organizationId,
        "bereavement_support_group.join_url",
        row.joinUrlCipher,
      );
    }
    return { ...view(row, stats), joinUrl };
  }

  function sessionView(row: SessionRow, attendeeCount: number): GroupSessionView {
    return {
      sessionId: row.id,
      groupId: row.groupId,
      sessionNo: row.sessionNo,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      status: row.status,
      attendeeCount,
      version: row.version,
    };
  }

  async function attendeeCounts(tx: DbClient, sessionIds: readonly string[]) {
    const out = new Map<string, number>();
    if (sessionIds.length === 0) return out;
    const rows = await tx
      .select({ sessionId: ATTEND.sessionId, n: sql<number>`count(*)::int` })
      .from(ATTEND)
      .where(inArray(ATTEND.sessionId, [...sessionIds]))
      .groupBy(ATTEND.sessionId);
    for (const r of rows) out.set(r.sessionId, r.n);
    return out;
  }

  /** A staff facilitator is a paid bereavement-capable discipline; a volunteer facilitator the volunteer discipline. */
  async function assertFacilitators(
    organizationId: string,
    input: GroupFieldsInput,
  ): Promise<void> {
    const ineligible = (msg: string) =>
      new BereavementStateError("GROUP_FACILITATOR_INELIGIBLE", msg);
    const primary = await deps.disciplineOf(organizationId, input.facilitatorUserId);
    const isCapable = (d: string | null) =>
      d !== null && (BEREAVEMENT_CAPABLE_DISCIPLINES as readonly string[]).includes(d);
    if (input.facilitatorKind === "volunteer") {
      if (primary !== BEREAVEMENT_VOLUNTEER_DISCIPLINE) {
        throw ineligible("the volunteer facilitator is not a bereavement volunteer");
      }
    } else if (!isCapable(primary) || primary === BEREAVEMENT_VOLUNTEER_DISCIPLINE) {
      throw ineligible("the staff facilitator is not bereavement-capable staff");
    }
    if (input.coFacilitatorUserId !== null) {
      const co = await deps.disciplineOf(organizationId, input.coFacilitatorUserId);
      if (!isCapable(co) || co === BEREAVEMENT_VOLUNTEER_DISCIPLINE) {
        throw ineligible("the co-facilitator must be bereavement-capable staff");
      }
    }
  }

  async function sealJoinUrl(
    organizationId: string,
    joinUrl: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (joinUrl === undefined || joinUrl === null) return joinUrl;
    if (deps.cipher === undefined) {
      throw new BereavementStateError(
        "GROUP_NOT_EDITABLE",
        "a meeting link cannot be stored: no tenant key is bound",
      );
    }
    return deps.cipher.encrypt(organizationId, "bereavement_support_group.join_url", joinUrl);
  }

  function assertRecurrence(rec: BereavementGroupRecurrence, timezone: string): void {
    const problem = recurrenceProblem(rec, timezone);
    if (problem !== null) throw new BereavementStateError("GROUP_RECURRENCE_INVALID", problem);
  }

  /** Is the actor acting as a volunteer on this group (the reduced roster)? Oversight never is. */
  function actsAsVolunteer(actor: M16ReadActor, group: GroupRow): boolean {
    if (BEREAVEMENT_OVERSIGHT_ROLES.some((r) => actor.roles.includes(r))) return false;
    return (
      disciplineForRoleKeys(actor.roles) === BEREAVEMENT_VOLUNTEER_DISCIPLINE ||
      (group.facilitatorKind === "volunteer" && group.facilitatorUserId === actor.membershipId)
    );
  }

  async function enrollmentView(
    tx: DbClient,
    row: typeof schema.bereavementSupportGroupEnrollment.$inferSelect,
  ): Promise<GroupEnrollmentView> {
    const [g] = await tx
      .select({ name: GROUP.name, status: GROUP.status })
      .from(GROUP)
      .where(eq(GROUP.id, row.groupId))
      .limit(1);
    return {
      enrollmentId: row.id,
      groupId: row.groupId,
      groupName: g?.name ?? "",
      groupStatus: g?.status ?? "cancelled",
      contactId: row.bereavedContactId,
      status: row.status,
      withdrawnReason: (row.withdrawnReason ?? null) as BereavementGroupWithdrawnReason | null,
      enrolledAt: row.enrolledAt.toISOString(),
      withdrawnAt: iso(row.withdrawnAt),
    };
  }

  return {
    async listGroups(actor, input) {
      const limit = clampLimit(input.limit, GROUP_PAGE);
      const after: Cursor | null = decodeCheckedCursor(input.cursor, "instant");
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const rows = await tx
          .select()
          .from(GROUP)
          .where(
            and(
              input.status === undefined ? undefined : eq(GROUP.status, input.status),
              after === null
                ? undefined
                : or(
                    lt(GROUP.createdAt, new Date(after.a)),
                    and(eq(GROUP.createdAt, new Date(after.a)), lt(GROUP.id, after.id)),
                  ),
            ),
          )
          .orderBy(desc(GROUP.createdAt), desc(GROUP.id))
          .limit(limit + 1);
        const stats = await statsFor(
          tx,
          rows.slice(0, limit).map((r) => r.id),
        );
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: r.createdAt.toISOString(), id: r.id }),
          (r) => view(r, stats.get(r.id) ?? { enrolled: 0, next: null }),
        );
      });
    },

    async getGroup(actor, groupId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [row] = await tx.select().from(GROUP).where(eq(GROUP.id, groupId)).limit(1);
        return row ? detail(tx, row) : null;
      });
    },

    async createGroup(actor, input) {
      if (input.format === "recurring") {
        if (input.recurrence === null) {
          throw new BereavementStateError(
            "GROUP_RECURRENCE_INVALID",
            "a recurring group needs its schedule",
          );
        }
        assertRecurrence(input.recurrence, input.timezone);
      } else if (input.recurrence !== null) {
        throw new BereavementStateError(
          "GROUP_RECURRENCE_INVALID",
          "a drop-in group has no recurrence (add its sessions one at a time)",
        );
      }
      await assertFacilitators(actor.organizationId, input);
      const joinUrlCipher = await sealJoinUrl(actor.organizationId, input.joinUrl);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [row] = await tx
          .insert(GROUP)
          .values({
            organizationId: actor.organizationId,
            name: input.name,
            description: input.description,
            format: input.format,
            modality: input.modality,
            enrollmentRequired: input.enrollmentRequired,
            facilitatorKind: input.facilitatorKind,
            facilitatorUserId: input.facilitatorUserId,
            coFacilitatorUserId: input.coFacilitatorUserId,
            capacity: input.capacity,
            recurrenceJsonb: input.recurrence,
            timezone: input.timezone,
            venueText: input.venueText,
            joinUrlCipher: joinUrlCipher ?? null,
            createdByMembershipId: actor.membershipId,
            version: 1,
          })
          .returning();
        if (!row) throw new Error("support group insert returned no row");
        return detail(tx, row);
      });
    },

    async updateGroup(actor, groupId, input) {
      await assertFacilitators(actor.organizationId, input);
      const joinUrlCipher = await sealJoinUrl(actor.organizationId, input.joinUrl);
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const group = await groupOr404(tx, groupId);
        checkVersion(input.expectedVersion, group.version);
        if (group.status !== "draft" && group.status !== "open") {
          throw new BereavementStateError(
            "GROUP_NOT_EDITABLE",
            `a ${group.status} group can no longer be changed`,
          );
        }
        let recurrence = group.recurrenceJsonb as BereavementGroupRecurrence | null;
        if (input.recurrence !== undefined) {
          if (group.format !== "recurring" || group.status !== "draft") {
            throw new BereavementStateError(
              "GROUP_NOT_EDITABLE",
              "only a draft recurring group's schedule can change (its sessions exist once it opens)",
            );
          }
          recurrence = input.recurrence;
        }
        if (recurrence !== null) assertRecurrence(recurrence, input.timezone);
        const [row] = await tx
          .update(GROUP)
          .set({
            name: input.name,
            description: input.description,
            modality: input.modality,
            enrollmentRequired: input.enrollmentRequired,
            facilitatorKind: input.facilitatorKind,
            facilitatorUserId: input.facilitatorUserId,
            coFacilitatorUserId: input.coFacilitatorUserId,
            capacity: input.capacity,
            timezone: input.timezone,
            venueText: input.venueText,
            recurrenceJsonb: recurrence,
            ...(joinUrlCipher === undefined ? {} : { joinUrlCipher }),
            version: group.version + 1,
            updatedAt: now(),
          })
          .where(and(eq(GROUP.id, group.id), eq(GROUP.version, group.version)))
          .returning();
        if (!row) throw stale("support group");
        return detail(tx, row);
      });
    },

    async openGroup(actor, groupId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const group = await groupOr404(tx, groupId);
        checkVersion(input.expectedVersion, group.version);
        if (group.status !== "draft") {
          throw new BereavementStateError(
            "GROUP_NOT_EDITABLE",
            `a ${group.status} group cannot be opened`,
          );
        }
        if (group.facilitatorKind === "volunteer") {
          let ok = false;
          try {
            ok = await deps.volunteerGatesSatisfied({
              organizationId: actor.organizationId,
              volunteerMembershipId: group.facilitatorUserId,
            });
          } catch {
            ok = false; // §8.7 — an M15 outage never reads as "the gates are clear"
          }
          if (!ok) {
            throw new BereavementStateError(
              "GROUP_FACILITATOR_INELIGIBLE",
              "the volunteer facilitator does not currently meet the volunteer requirements (418.78)",
            );
          }
        }
        const at = now();
        const [row] = await tx
          .update(GROUP)
          .set({ status: "open", openedAt: at, version: group.version + 1, updatedAt: at })
          .where(
            and(
              eq(GROUP.id, group.id),
              eq(GROUP.version, group.version),
              eq(GROUP.status, "draft"),
            ),
          )
          .returning();
        if (!row) throw stale("support group");
        const recurrence = row.recurrenceJsonb as BereavementGroupRecurrence | null;
        if (recurrence !== null) {
          assertRecurrence(recurrence, row.timezone);
          const sessions = materializeSessions(recurrence, row.timezone);
          // Sessions numbered after any drop-in meeting added while the group was a draft.
          const [{ maxNo } = { maxNo: 0 }] = await tx
            .select({ maxNo: sql<number>`coalesce(max(${SESSION.sessionNo}), 0)::int` })
            .from(SESSION)
            .where(eq(SESSION.groupId, row.id));
          if (sessions.length > 0) {
            await tx.insert(SESSION).values(
              sessions.map((s) => ({
                organizationId: row.organizationId,
                groupId: row.id,
                sessionNo: maxNo + s.sessionNo,
                startsAt: s.startsAt,
                endsAt: s.endsAt,
                version: 1,
              })),
            );
          }
        }
        return detail(tx, row);
      });
    },

    async closeGroup(actor, groupId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const group = await groupOr404(tx, groupId, { lock: true });
        checkVersion(input.expectedVersion, group.version);
        if (group.status !== "draft" && group.status !== "open") {
          throw new BereavementStateError(
            "GROUP_NOT_EDITABLE",
            `a ${group.status} group is already closed`,
          );
        }
        if (input.status === "completed" && group.status !== "open") {
          throw new BereavementStateError("GROUP_NOT_OPEN", "only an open group can be completed");
        }
        const at = now();
        const [row] = await tx
          .update(GROUP)
          .set({ status: input.status, closedAt: at, version: group.version + 1, updatedAt: at })
          .where(and(eq(GROUP.id, group.id), eq(GROUP.version, group.version)))
          .returning();
        if (!row) throw stale("support group");
        await tx
          .update(ENROLL)
          .set({
            status: "withdrawn",
            withdrawnReason: "group_ended",
            withdrawnAt: at,
            withdrawnByMembershipId: actor.membershipId,
            version: sql`${ENROLL.version} + 1`,
            updatedAt: at,
          })
          .where(and(eq(ENROLL.groupId, row.id), eq(ENROLL.status, "enrolled")));
        await tx
          .update(SESSION)
          .set({ status: "cancelled", version: sql`${SESSION.version} + 1`, updatedAt: at })
          .where(
            and(
              eq(SESSION.groupId, row.id),
              eq(SESSION.status, "scheduled"),
              gt(SESSION.startsAt, at),
            ),
          );
        return detail(tx, row);
      });
    },

    async listSessions(actor, groupId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [group] = await tx
          .select({ id: GROUP.id })
          .from(GROUP)
          .where(eq(GROUP.id, groupId))
          .limit(1);
        if (!group) return null;
        const rows = await tx
          .select()
          .from(SESSION)
          .where(eq(SESSION.groupId, groupId))
          .orderBy(asc(SESSION.startsAt), asc(SESSION.sessionNo))
          .limit(MAX_SESSIONS);
        const counts = await attendeeCounts(
          tx,
          rows.map((r) => r.id),
        );
        return rows.map((r) => sessionView(r, counts.get(r.id) ?? 0));
      });
    },

    async addSession(actor, groupId, input) {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (!(endsAt.getTime() > startsAt.getTime())) {
        throw new BereavementStateError(
          "GROUP_RECURRENCE_INVALID",
          "a session must end after it starts",
        );
      }
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        // The group row lock serializes session numbering.
        const group = await groupOr404(tx, groupId, { lock: true });
        if (group.status !== "draft" && group.status !== "open") {
          throw new BereavementStateError(
            "GROUP_NOT_EDITABLE",
            `a ${group.status} group takes no new sessions`,
          );
        }
        const [{ maxNo, n } = { maxNo: 0, n: 0 }] = await tx
          .select({
            maxNo: sql<number>`coalesce(max(${SESSION.sessionNo}), 0)::int`,
            n: sql<number>`count(*)::int`,
          })
          .from(SESSION)
          .where(eq(SESSION.groupId, group.id));
        if (n >= MAX_SESSIONS) {
          throw new BereavementStateError(
            "GROUP_NOT_EDITABLE",
            "this group already has the maximum number of sessions",
          );
        }
        const [row] = await tx
          .insert(SESSION)
          .values({
            organizationId: group.organizationId,
            groupId: group.id,
            sessionNo: maxNo + 1,
            startsAt,
            endsAt,
            version: 1,
          })
          .returning();
        if (!row) throw new Error("session insert returned no row");
        return sessionView(row, 0);
      });
    },

    async cancelSession(actor, groupId, sessionId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const session = await sessionOr404(tx, groupId, sessionId);
        checkVersion(input.expectedVersion, session.version);
        if (session.status !== "scheduled") {
          throw new BereavementStateError(
            "SESSION_NOT_RECORDABLE",
            `a ${session.status} session cannot be cancelled`,
          );
        }
        const [row] = await tx
          .update(SESSION)
          .set({ status: "cancelled", version: session.version + 1, updatedAt: now() })
          .where(
            and(
              eq(SESSION.id, session.id),
              eq(SESSION.version, session.version),
              eq(SESSION.status, "scheduled"),
            ),
          )
          .returning();
        if (!row) throw stale("session");
        return sessionView(row, 0);
      });
    },

    async roster(actor, groupId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const [group] = await tx.select().from(GROUP).where(eq(GROUP.id, groupId)).limit(1);
        return group ? loadGroupRoster(tx, group, actsAsVolunteer(actor, group)) : null;
      });
    },

    async enroll(actor, groupId, contactId) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        // Locking the group serializes the capacity count with every other enrollment into it.
        const group = await groupOr404(tx, groupId, { lock: true });
        if (group.status !== "open") {
          throw new BereavementStateError(
            "GROUP_NOT_OPEN",
            `a ${group.status} group takes no enrollments`,
          );
        }
        const facts = (await loadProgramContacts(tx, [contactId])).get(contactId);
        if (facts === undefined || !facts.inProgram) {
          throw new BereavementStateError(
            "CONTACT_NOT_ENROLLABLE",
            "support groups are for active program families only",
          );
        }
        const [existing] = await tx
          .select()
          .from(ENROLL)
          .where(
            and(
              eq(ENROLL.groupId, group.id),
              eq(ENROLL.bereavedContactId, contactId),
              eq(ENROLL.status, "enrolled"),
            ),
          )
          .limit(1);
        if (existing) return enrollmentView(tx, existing); // idempotent: already enrolled
        if (group.capacity !== null) {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(ENROLL)
            .where(and(eq(ENROLL.groupId, group.id), eq(ENROLL.status, "enrolled")));
          if (n >= group.capacity) {
            throw new BereavementStateError("GROUP_FULL", "this group is full");
          }
        }
        const [row] = await tx
          .insert(ENROLL)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: facts.providerEntityId,
            locationId: facts.locationId,
            groupId: group.id,
            planId: facts.planId,
            bereavedContactId: contactId,
            enrolledByMembershipId: actor.membershipId,
            version: 1,
          })
          .returning();
        if (!row) throw new Error("enrollment insert returned no row");
        return enrollmentView(tx, row);
      });
    },

    async withdraw(actor, groupId, contactId, input) {
      return withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        await groupOr404(tx, groupId);
        const at = now();
        const [row] = await tx
          .update(ENROLL)
          .set({
            status: "withdrawn",
            withdrawnReason: input.reason,
            withdrawnAt: at,
            withdrawnByMembershipId: actor.membershipId,
            version: sql`${ENROLL.version} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(ENROLL.groupId, groupId),
              eq(ENROLL.bereavedContactId, contactId),
              eq(ENROLL.status, "enrolled"),
            ),
          )
          .returning();
        if (!row) {
          throw new BereavementStateError(
            "CONTACT_NOT_ENROLLED",
            "this contact has no live enrollment in the group",
          );
        }
        return enrollmentView(tx, row);
      });
    },

    async recordAttendance(actor, groupId, sessionId, contactIds) {
      const unique = [...new Set(contactIds)];
      if (unique.length === 0 || unique.length > MAX_ATTENDEES_PER_CALL) {
        throw new BereavementStateError(
          "SESSION_NOT_RECORDABLE",
          `name between 1 and ${MAX_ATTENDEES_PER_CALL} attendees`,
        );
      }
      const result = await withOrgContext(db, scope(actor), async (scoped) => {
        const tx = asTx(scoped);
        const group = await groupOr404(tx, groupId);
        if (group.status !== "open") {
          throw new BereavementStateError(
            "GROUP_NOT_OPEN",
            `a ${group.status} group's sessions are closed`,
          );
        }
        const session = await sessionOr404(tx, groupId, sessionId);
        const at = now();
        if (session.status === "cancelled" || session.startsAt.getTime() > at.getTime()) {
          throw new BereavementStateError(
            "SESSION_NOT_RECORDABLE",
            "attendance is recorded once a session has started, and never for a cancelled one",
          );
        }
        return recordSessionAttendance(tx, {
          actor,
          group,
          session,
          contactIds: unique,
          at,
          outbox: deps.outbox,
        });
      });
      return result;
    },

    async contactEnrollments(actor, contactId) {
      return withOrgContext(db, scope(actor), async (scoped) =>
        loadContactEnrollments(asTx(scoped), contactId),
      );
    },
  };
}
