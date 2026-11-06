// apps/backend/src/modules/16-bereavement/groups/attendance-drizzle.ts — ADR-0109 D10 (PR 3): record who attended a support-group session.
//
// Runs inside the route service's transaction, after the group (open) and the session (started, not cancelled) were checked. Every named contact
// must be a program family and, when the group requires it, live-enrolled. Each NEW attendee gets an attendance row AND a contact-log ACTIVITY row
// (`support_group_session`, outcome `attended`, contact_at = the session start, id = the attendance id) on the same transaction: no outreach row,
// no cadence item, never counted in M30. A retry is a no-op per contact (both unique indexes). The session becomes `held`, and
// `support_group_attendance_recorded` (ids and counts only) is published when anyone new was recorded.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { BereavementStateError } from "../lifecycle/index";
import { loadProgramContacts } from "../program/program-contacts";
import type { M16WriteActor } from "../routes/actor";
import type { AttendanceResultView } from "../routes/group-service";
import type { WriteOutboxPort } from "../routes/write-service";

export async function recordSessionAttendance(
  tx: DbClient,
  args: {
    readonly actor: M16WriteActor;
    readonly group: typeof schema.bereavementSupportGroup.$inferSelect;
    readonly session: typeof schema.bereavementSupportGroupSession.$inferSelect;
    readonly contactIds: readonly string[];
    readonly at: Date;
    readonly outbox: WriteOutboxPort;
  },
): Promise<AttendanceResultView> {
  const { actor, group, session, at } = args;
  const unique = args.contactIds;
  const ENROLL = schema.bereavementSupportGroupEnrollment;
  const ATTEND = schema.bereavementSupportGroupAttendance;
  const SESSION = schema.bereavementSupportGroupSession;
  const LOG = schema.bereavementContactLog;
  const facts = await loadProgramContacts(tx, unique);
  const notInProgram = unique.filter((id) => !facts.get(id)?.inProgram);
  if (notInProgram.length > 0) {
    throw new BereavementStateError(
      "CONTACT_NOT_ENROLLABLE",
      `${notInProgram.length} of the named contacts are not active program families`,
    );
  }
  if (group.enrollmentRequired) {
    const enrolled = await tx
      .select({ contactId: ENROLL.bereavedContactId })
      .from(ENROLL)
      .where(
        and(
          eq(ENROLL.groupId, group.id),
          eq(ENROLL.status, "enrolled"),
          inArray(ENROLL.bereavedContactId, unique),
        ),
      );
    const set = new Set(enrolled.map((e) => e.contactId));
    const missing = unique.filter((id) => !set.has(id));
    if (missing.length > 0) {
      throw new BereavementStateError(
        "CONTACT_NOT_ENROLLED",
        `${missing.length} of the named contacts are not enrolled in this group`,
      );
    }
  }
  const inserted = await tx
    .insert(ATTEND)
    .values(
      unique.map((id) => {
        const f = facts.get(id);
        if (f === undefined) throw new Error("unreachable: checked above");
        return {
          organizationId: actor.organizationId,
          providerEntityId: f.providerEntityId,
          locationId: f.locationId,
          sessionId: session.id,
          groupId: group.id,
          planId: f.planId,
          bereavedContactId: id,
          recordedByMembershipId: actor.membershipId,
          recordedAt: at,
        };
      }),
    )
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    // The activity rows: id = the attendance id (the row names its log entry without a lookup), contact_at = the session start.
    await tx
      .insert(LOG)
      .values(
        inserted.map((a) => ({
          id: a.id,
          organizationId: a.organizationId,
          providerEntityId: a.providerEntityId,
          locationId: a.locationId,
          planId: a.planId,
          bereavedContactId: a.bereavedContactId,
          contactAt: session.startsAt,
          outcome: "attended" as const,
          activityKind: "support_group_session",
          activityRefId: session.id,
          loggedByUserId: actor.membershipId,
          contactRespondedDirectly: false,
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(ATTEND)
      .set({ logId: sql`${ATTEND.id}` })
      .where(
        inArray(
          ATTEND.id,
          inserted.map((a) => a.id),
        ),
      );
  }
  if (session.status === "scheduled") {
    await tx
      .update(SESSION)
      .set({ status: "held", heldAt: at, version: sql`${SESSION.version} + 1`, updatedAt: at })
      .where(and(eq(SESSION.id, session.id), eq(SESSION.status, "scheduled")));
  }
  const [{ attendeeCount } = { attendeeCount: 0 }] = await tx
    .select({ attendeeCount: sql<number>`count(*)::int` })
    .from(ATTEND)
    .where(eq(ATTEND.sessionId, session.id));
  if (inserted.length > 0) {
    await args.outbox.publish(tx, {
      organizationId: actor.organizationId,
      eventName: "m16.bereavement.support_group_attendance_recorded",
      aggregateKind: "bereavement_support_group",
      aggregateId: group.id,
      payload: {
        groupId: group.id,
        sessionId: session.id,
        sessionNo: session.sessionNo,
        attendeeCount,
        newlyRecordedCount: inserted.length,
      },
    });
  }
  return {
    sessionId: session.id,
    recordedCount: inserted.length,
    alreadyRecordedCount: unique.length - inserted.length,
    attendeeCount,
  };
}
