/**
 * ChartWarden — demo DoseSpot prescriber roster. Enrols Dr. Sam Harris (drharris@) onto the roster with his M40
 * ExternalPhysician id, through the real `POST /api/v1/admin/dosespot-prescribers/:membershipId/enroll` route as
 * orgadmin@ (who holds `prescribing.admin.roster`).
 *
 * Why it matters: a standard medication order is signed by its authoring prescriber OR by the physician it names
 * (roster MDM id match; spec §2.2/§2.3, no on-behalf signing). Orders drafted by an RN name Dr. Harris but are
 * authored by the RN, who may not sign — without this roster row nobody can, and the sign refuses with
 * SIGNER_NOT_ORDERING_PHYSICIAN. No EPCS enablement and no DEA schedules: this only links the membership to the
 * ExternalPhysician the order names.
 * Prereqs: db:seed:staff, db:seed:mdm (the ExternalPhysician row), the API running.
 * Idempotent: an existing active enrolment for the same membership is reported, not an error.
 * Run: bun run db:seed:prescriber-roster
 */
import { Client } from "pg";
import { ORG_SLUG, ScenarioLog, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const PRESCRIBER_EMAIL = "drharris@chartwarden.local";
const PRESCRIBER_MDM_ID = "11111111-0000-4000-8000-000000000001"; // Samuel Harris MD, db:seed:mdm

async function prescriberMembershipId(): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    const res = await db.query<{ id: string }>(
      `SELECT m.id FROM membership m
         JOIN "user" u ON u.id = m.user_id
         JOIN organization o ON o.id = m.organization_id
        WHERE o.slug = $1 AND u.email = $2`,
      [ORG_SLUG, PRESCRIBER_EMAIL],
    );
    const id = res.rows[0]?.id;
    if (!id)
      throw new Error(
        `${PRESCRIBER_EMAIL} has no membership in ${ORG_SLUG} — run db:seed:staff first`,
      );
    return id;
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const log = new ScenarioLog("prescriber roster");
  const admin = await signIn("orgadmin@chartwarden.local");
  const membershipId = await prescriberMembershipId();

  const res = await admin.client.POST("/api/v1/admin/dosespot-prescribers/{membershipId}/enroll", {
    params: { path: { membershipId } },
    body: { externalPhysicianMdmId: PRESCRIBER_MDM_ID },
  });
  if (!res.error) {
    log.ok(`enrolled ${PRESCRIBER_EMAIL} (ExternalPhysician ${PRESCRIBER_MDM_ID})`);
  } else if (JSON.stringify(res.error).includes("ALREADY_ENROLLED")) {
    log.dup(`${PRESCRIBER_EMAIL} already enrolled`);
  } else {
    log.fail(`enrol failed: ${JSON.stringify(res.error)}`);
  }
  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
