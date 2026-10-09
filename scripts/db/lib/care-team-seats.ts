// scripts/db/lib/care-team-seats.ts — the extra care-team seats the demo personas need.
//
// Every patient-scoped write re-checks the caseload (M11 GAP-030, M15 `planCaseloadScope`, …) and answers an
// out-of-scope patient with a 404, so a persona on nobody's care team cannot do what its scenario seed has it
// do. `patient_assignment_role` has no `lpn` or volunteer-coordinator value: `rn` is the nursing-team seat (the
// LPN who drafts orders for the RN case manager) and `volunteer` the volunteer-programme seat (the coordinator
// who assigns the volunteer).
//
// Written by BOTH `seed-staff-personas.ts` (which re-creates the users, so seats pointing at a previous run's
// ids go stale) and `seed-clinical.ts` (which wipes every `patient_assignment` row for the demo patients), so
// the seats survive whichever of the two runs last.
import type { Client } from "pg";

export const CARE_TEAM_SEATS: ReadonlyArray<{ email: string; role: "rn" | "volunteer" }> = [
  { email: "dana@wardenx.local", role: "rn" },
  { email: "vera@wardenx.local", role: "volunteer" },
];

/** Replaces the persona seats on `patientIds`; a persona that does not exist yet is skipped. Returns the seats written. */
export async function anchorCareTeamSeats(
  db: Client,
  orgId: string,
  patientIds: readonly string[],
): Promise<readonly string[]> {
  const written: string[] = [];
  for (const { email, role } of CARE_TEAM_SEATS) {
    const user = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
    const userId = user.rows[0]?.id;
    if (!userId) continue;
    await db.query(
      `DELETE FROM patient_assignment
        WHERE organization_id = $1 AND role = $2 AND patient_id = ANY($3)`,
      [orgId, role, patientIds],
    );
    for (const patientId of patientIds) {
      await db.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,$4, CURRENT_DATE)`,
        [patientId, orgId, userId, role],
      );
    }
    written.push(`${email} (${role})`);
  }
  return written;
}
