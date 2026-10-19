/**
 * WardenX — additive local-dev seed: M36 care-team channel memberships for the demo personas.
 *
 * The seeds write `patient_assignment` by direct SQL, which emits no `m5.patient.assignment_created`, so M36's
 * channel-membership-sync never runs for them and only the portal-traffic path (which reconciles one patient at a
 * time) ever adds members. This brings every ACTIVE care_team channel to what the sync would have produced.
 *
 * The rule mirrored (source of truth: `syncCareTeamChannel`, apps/backend/src/modules/36-messaging/messaging-provider-db.ts,
 * roster from M5 `createDrizzleCareTeamStore.listMembers`, apps/backend/src/modules/05-patient/seams/drizzle-stores.ts):
 *   roster = DISTINCT clinician_user_id of the patient's OPEN patient_assignment rows (any role);
 *   minus identities holding a patient_family / external_auditor / platform_staff role (member-category-gate.ts F6);
 *   a patient with an active SUD privacy flag is SKIPPED (the real sync defers to M39's Part 2 release per user,
 *   which a SQL seed cannot honestly mirror);
 *   archived channels take no new members; only role 'member', source 'auto' rows are written.
 * Missing channels are opened exactly as the sync does (retention_class care_related, title "Care team") for patients
 * with an open roster; pass --no-create to only add members to channels that already exist.
 *
 * Idempotent: a user with a live membership (removed_at IS NULL) on the channel is left alone. Uses the admin connection.
 * Usage: bun run db:seed:messaging-members [-- --no-create]
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "wardenx-demo";
const CREATE_MISSING = !process.argv.includes("--no-create");
const EXCLUDED_CATEGORIES = ["patient_family", "external_auditor", "platform_staff"];

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    const org = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
      ORG_SLUG,
    ]);
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error(`organization ${ORG_SLUG} not found - run db:seed first`);
    await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    // Patients with an open roster, an active SUD flag excluded.
    const patients = await db.query<{ patient_id: string }>(
      `SELECT DISTINCT pa.patient_id
         FROM patient_assignment pa
        WHERE pa.organization_id = $1 AND pa.unassigned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM patient_privacy_flag_snapshot s
                           WHERE s.patient_id = pa.patient_id AND s.invalidated_at IS NULL AND 'sud' = ANY (s.flags))`,
      [orgId],
    );
    let created = 0;
    if (CREATE_MISSING) {
      const res = await db.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         SELECT $1, 'care_team', p, 'Care team', 'care_related' FROM unnest($2::uuid[]) p
         ON CONFLICT DO NOTHING`,
        [orgId, patients.rows.map((r) => r.patient_id)],
      );
      created = res.rowCount ?? 0;
    }

    const ins = await db.query<{ email: string; mrn: string }>(
      `WITH roster AS (
         SELECT DISTINCT c.id AS channel_id, pa.clinician_user_id AS user_id
           FROM channel c
           JOIN patient_assignment pa ON pa.organization_id = c.organization_id AND pa.patient_id = c.subject_id
                                     AND pa.unassigned_at IS NULL
          WHERE c.organization_id = $1 AND c.channel_kind = 'care_team' AND NOT c.is_archived
            AND c.subject_id = ANY ($2::uuid[])
            AND EXISTS (SELECT 1 FROM membership m WHERE m.organization_id = $1 AND m.user_id = pa.clinician_user_id AND m.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM membership m
                              JOIN membership_role mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
                              JOIN role r ON r.id = mr.role_id
                             WHERE m.organization_id = $1 AND m.user_id = pa.clinician_user_id
                               AND r.category::text = ANY ($3::text[])
                               AND (mr.expires_at IS NULL OR mr.expires_at > now()))
       ), added AS (
         INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         SELECT $1, r.channel_id, r.user_id, 'member', 'auto' FROM roster r
          WHERE NOT EXISTS (SELECT 1 FROM channel_member cm
                             WHERE cm.channel_id = r.channel_id AND cm.user_id = r.user_id AND cm.removed_at IS NULL)
         RETURNING channel_id, user_id
       )
       SELECT u.email, p.mrn FROM added a
         JOIN "user" u ON u.id = a.user_id
         JOIN channel c ON c.id = a.channel_id JOIN patient p ON p.id = c.subject_id
        ORDER BY p.mrn, u.email`,
      [orgId, patients.rows.map((r) => r.patient_id), EXCLUDED_CATEGORIES],
    );
    await db.query("COMMIT");

    for (const r of ins.rows) console.log(`  + ${r.email} -> care_team channel of ${r.mrn}`);
    const noChannel = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM unnest($2::uuid[]) p
        WHERE NOT EXISTS (SELECT 1 FROM channel c WHERE c.organization_id = $1 AND c.channel_kind = 'care_team' AND c.subject_id = p)`,
      [orgId, patients.rows.map((r) => r.patient_id)],
    );
    console.log(
      `✓ messaging channel members: ${ins.rowCount ?? 0} added, ${created} channel(s) created; ${noChannel.rows[0]?.n ?? 0} patient(s) with an open care team have no channel yet${CREATE_MISSING ? "" : " (--no-create)"}.`,
    );
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
