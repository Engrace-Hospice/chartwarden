/**
 * ChartWarden — demo DoseSpot prescriber roster. Enrols Dr. Sam Harris (drharris@) onto the roster with his M40
 * ExternalPhysician id, through the real `POST /api/v1/admin/dosespot-prescribers/:membershipId/enroll` route as
 * orgadmin@ (who holds `prescribing.admin.roster`), then has Dr. Harris confirm that link from his own account
 * (`POST /api/v1/me/dosespot-prescriber-link/confirm`), which a DoseSpot vendor enrolment requires.
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
import { stepUpSession } from "./lib/step-up";

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

  // the roster link is a step-up-gated, idempotent write (and orgadmin@ is recorded as the link's asserter, so Dr. Harris may confirm it)
  await stepUpSession(admin.userId);
  const res = await admin.client.POST("/api/v1/admin/dosespot-prescribers/{membershipId}/enroll", {
    params: { path: { membershipId }, header: { "Idempotency-Key": crypto.randomUUID() } },
    body: { externalPhysicianMdmId: PRESCRIBER_MDM_ID },
  });
  if (!res.error) {
    log.ok(`enrolled ${PRESCRIBER_EMAIL} (ExternalPhysician ${PRESCRIBER_MDM_ID})`);
  } else if (JSON.stringify(res.error).includes("ALREADY_ENROLLED")) {
    log.dup(`${PRESCRIBER_EMAIL} already enrolled`);
  } else {
    log.fail(`enrol failed: ${JSON.stringify(res.error)}`);
  }

  // The roster administrator's link says who Dr. Harris is; the DoseSpot enrolment sends that record's NPI and name to the vendor,
  // so the PRESCRIBER confirms it themself (shown the name and NPI, pinned to them). The demo does it as Dr. Harris, with the seeds'
  // step-up stand-in, so a vendor enrolment in the demo is not refused 409 DOSESPOT_PRACTITIONER_UNCONFIRMED.
  const doctor = await signIn(PRESCRIBER_EMAIL);
  const link = await doctor.client.GET("/api/v1/me/dosespot-prescriber-link");
  if (link.data?.confirmed) {
    log.dup(`${PRESCRIBER_EMAIL} already confirmed their linked record`);
  } else if (link.data?.physician) {
    await stepUpSession(doctor.userId);
    const confirmed = await doctor.client.POST("/api/v1/me/dosespot-prescriber-link/confirm", {
      params: { header: { "Idempotency-Key": crypto.randomUUID() } },
      body: { externalPhysicianMdmId: PRESCRIBER_MDM_ID, npi: link.data.physician.npi },
    });
    if (confirmed.error) log.fail(`link confirmation failed: ${JSON.stringify(confirmed.error)}`);
    else log.ok(`${PRESCRIBER_EMAIL} confirmed their linked record`);
  } else {
    log.fail(
      `nothing to confirm for ${PRESCRIBER_EMAIL}: ${JSON.stringify(link.error ?? link.data)}`,
    );
  }
  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
