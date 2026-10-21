/**
 * GAP-009 / GAP-010 — admit against REAL Postgres as the NOBYPASSRLS `wardenx_app` role.
 *   010: the matcher is fed each candidate's primary address / phone / email, so a same name+DOB+address
 *        admit hard-blocks (no second patient), a name+DOB+phone+email near-match opens a soft review row
 *        (`matchReviewIds` non-empty), the admitted contact details are persisted, and an SSN is refused
 *        before anything is written when no tenant key is bound (GAP-010: the bound path is m5-ssn-identifier).
 *   009: a bypassed admit writes a CRITICAL `patient.create_bypass_match` audit_event (justification
 *        recorded) on the same transaction as the patient row.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-admit-matching.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { IdentifierCipherUnboundError } from "../src/modules/05-patient/identifiers/identifier-cipher";
import { type AdmitResult, M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const STAFF = "d0000000-0000-4000-8000-000000000001";

const ADDRESS = { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" };
const JANE = {
  lastName: "Doe",
  firstName: "Jane",
  dob: "1950-01-01",
  administrativeSex: "female",
};

describe.skipIf(!DB_URL)("GAP-009/010 M5 admit matching + bypass audit — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap910','x','x')",
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [STAFF, "s@gap910.test"]);
    await admin.query(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [STAFF, ORG_A],
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: Parameters<typeof txPublisher.publish>[0], input: never) =>
        txPublisher.publish(tx, { ...(input as object), callerModule: "m5" } as never),
    };
    service = createDbPatientRouteService(handle.db, outbox as never);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const patientCount = async (): Promise<number> =>
    Number((await admin.query("SELECT count(*)::int AS n FROM patient")).rows[0].n);

  it("persists the admitted address / phone / email as primary rows", async () => {
    const out = await service.admit(
      ORG_A,
      { ...JANE, primaryAddress: ADDRESS, phone: "(512) 555-1234", email: "Jane@Example.com" },
      STAFF,
    );
    expect(out.outcome).toBe("created");
    const pid = (out as { patientId: string }).patientId;
    const addr = await admin.query(
      "SELECT line1, state, is_primary FROM patient_address WHERE patient_id=$1",
      [pid],
    );
    expect(addr.rows).toEqual([{ line1: "1 Main St", state: "TX", is_primary: true }]);
    const phone = await admin.query("SELECT e164 FROM patient_phone WHERE patient_id=$1", [pid]);
    expect(phone.rows[0].e164).toBe("+15125551234");
    const email = await admin.query("SELECT email FROM patient_email WHERE patient_id=$1", [pid]);
    expect(email.rows[0].email).toBe("jane@example.com");
  });

  it("a second admit of the same name + DOB + address is a hard block and creates no patient", async () => {
    const before = await patientCount();
    const out = await service.admit(ORG_A, { ...JANE, primaryAddress: ADDRESS }, STAFF);
    expect(out).toMatchObject({ outcome: "hard_block", matchedOn: "dob_name_address" });
    expect(await patientCount()).toBe(before);
  });

  it("same name + DOB + phone + email at a new address opens a soft match review", async () => {
    const before = await patientCount();
    const out = await service.admit(
      ORG_A,
      {
        ...JANE,
        primaryAddress: { ...ADDRESS, line1: "999 Elsewhere Blvd", postalCode: "78799" },
        phone: "512-555-1234",
        email: "jane@example.com",
      },
      STAFF,
    );
    expect(out.outcome).toBe("soft_review");
    expect((out as Extract<AdmitResult, { outcome: "soft_review" }>).matchReviewIds.length).toBe(1);
    expect(await patientCount()).toBe(before + 1);
    const reviews = await admin.query(
      "SELECT status FROM patient_match_review WHERE new_patient_id=$1",
      [(out as { patientId: string }).patientId],
    );
    expect(reviews.rows).toEqual([{ status: "open" }]);
  });

  // GAP-010: this service is built WITHOUT an identifier cipher (the unbound default), so an SSN is refused
  // before anything is written - never stored in the clear. The bound path is m5-ssn-identifier.live.test.ts.
  it("refuses an SSN when no tenant key is bound, before writing anything", async () => {
    const before = await patientCount();
    await expect(
      service.admit(ORG_A, { ...JANE, lastName: "Ssn", ssn: "123-45-6789" }, STAFF),
    ).rejects.toBeInstanceOf(IdentifierCipherUnboundError);
    await expect(
      service.admit(ORG_A, { ...JANE, lastName: "Ssn", ssn: "000-12-3456" }, STAFF),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await patientCount()).toBe(before);
  });

  it("a bypassed admit writes a CRITICAL patient.create_bypass_match audit_event with the justification", async () => {
    const out = await service.admit(
      ORG_A,
      {
        ...JANE,
        primaryAddress: ADDRESS,
        bypassMatchReview: true,
        bypassJustification: "Confirmed distinct twin with the registrar",
      },
      STAFF,
    );
    expect(out.outcome).toBe("created");
    const pid = (out as { patientId: string }).patientId;
    const rows = (
      await admin.query(
        "SELECT severity, actor_user_id, context FROM audit_event WHERE event_type='patient.create_bypass_match' AND resource_id=$1",
        [pid],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("critical");
    expect(rows[0].actor_user_id).toBe(STAFF);
    expect(rows[0].context).toMatchObject({
      justification: "Confirmed distinct twin with the registrar",
    });
  });
});
