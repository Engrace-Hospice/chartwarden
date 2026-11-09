// apps/backend/src/modules/16-bereavement/groups/roster-drizzle.ts — ADR-0109 D10 (PR 3): the support-group roster and a contact's enrollments.
//
// The ROSTER lists live program families only: a contact that left the program (an opt-out, a closed plan) drops off it at once, and the nightly
// sweep withdraws the enrollment too. A VOLUNTEER facilitator gets the reduced projection (D10): display name, enrollment status, attended count;
// relationship and plan are ABSENT, not null.
import { type DbClient, schema } from "@chartwarden/db";
import type {
  BereavedContactRelationship,
  BereavementGroupWithdrawnReason,
} from "@chartwarden/types";
import { desc, eq, sql } from "drizzle-orm";
import type {
  GroupEnrollmentView,
  GroupRosterEntry,
  GroupRosterView,
} from "../routes/group-service";

const MAX_ROSTER = 500;

export async function loadGroupRoster(
  tx: DbClient,
  group: { readonly id: string },
  volunteer: boolean,
): Promise<GroupRosterView> {
  const rows = await tx.execute(sql`
    SELECT e.bereaved_contact_id AS contact_id, c.display_name, c.relationship_code, e.plan_id, e.status,
           (SELECT count(*)::int FROM bereavement_support_group_attendance a
             WHERE a.group_id = e.group_id AND a.bereaved_contact_id = e.bereaved_contact_id) AS attended
      FROM bereavement_support_group_enrollment e
      JOIN bereaved_contact c ON c.id = e.bereaved_contact_id
      JOIN bereavement_plan p ON p.id = c.plan_id
     WHERE e.group_id = ${group.id}::uuid AND e.status = 'enrolled'
       AND c.status = 'active' AND p.status IN ('active', 'paused')
       AND NOT EXISTS (SELECT 1 FROM bereavement_opt_out o
                        WHERE o.bereaved_contact_id = c.id AND o.rescinded_at IS NULL
                          AND o.opt_out_kind IN ('full', 'pause_temporarily'))
     ORDER BY c.display_name, e.bereaved_contact_id
     LIMIT ${MAX_ROSTER}`);
  const entries = (
    rows as unknown as {
      rows: {
        contact_id: string;
        display_name: string;
        relationship_code: string;
        plan_id: string;
        status: "enrolled" | "withdrawn";
        attended: number;
      }[];
    }
  ).rows.map(
    (r): GroupRosterEntry => ({
      contactId: r.contact_id,
      displayName: r.display_name,
      enrollmentStatus: r.status,
      attendedSessions: Number(r.attended),
      ...(volunteer
        ? {}
        : {
            relationshipCode: r.relationship_code as BereavedContactRelationship,
            planId: r.plan_id,
          }),
    }),
  );
  return { groupId: group.id, projection: volunteer ? "volunteer" : "staff", entries };
}

/** One contact's enrollments, newest first; null when the contact is absent (RLS-scoped). */
export async function loadContactEnrollments(
  tx: DbClient,
  contactId: string,
): Promise<GroupEnrollmentView[] | null> {
  const ENROLL = schema.bereavementSupportGroupEnrollment;
  const GROUP = schema.bereavementSupportGroup;
  const CONTACT = schema.bereavedContact;
  const [contact] = await tx
    .select({ id: CONTACT.id })
    .from(CONTACT)
    .where(eq(CONTACT.id, contactId))
    .limit(1);
  if (!contact) return null;
  const rows = await tx
    .select({ e: ENROLL, name: GROUP.name, groupStatus: GROUP.status })
    .from(ENROLL)
    .innerJoin(GROUP, eq(GROUP.id, ENROLL.groupId))
    .where(eq(ENROLL.bereavedContactId, contactId))
    .orderBy(desc(ENROLL.enrolledAt))
    .limit(100);
  return rows.map(
    ({ e, name, groupStatus }): GroupEnrollmentView => ({
      enrollmentId: e.id,
      groupId: e.groupId,
      groupName: name,
      groupStatus,
      contactId: e.bereavedContactId,
      status: e.status,
      withdrawnReason: (e.withdrawnReason ?? null) as BereavementGroupWithdrawnReason | null,
      enrolledAt: e.enrolledAt.toISOString(),
      withdrawnAt: e.withdrawnAt === null ? null : e.withdrawnAt.toISOString(),
    }),
  );
}
