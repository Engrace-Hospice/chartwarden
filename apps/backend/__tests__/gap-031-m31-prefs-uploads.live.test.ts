/**
 * M31 provisioning Drizzle paths - `portal_notification_preference` and `portal_document_upload` - LIVE Postgres, as
 * the RLS-enforced `wardenx_app` role. The account + grant are created by the REAL invitation issue/accept flow so
 * the rows carry real tenancy columns. Proves preference upsert (insert then in-place update with a version bump),
 * the upload begin -> stage -> complete lifecycle against real columns (encrypted staging, ciphertext cleared on
 * submit, idempotent complete) and that a rejected / expired stage is DURABLY recorded (not rolled back with the
 * thrown error). Gated on a live DB:
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:gap-031:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortalPhiCipher } from "../src/modules/31-portal/portal-crypto";
import { createPortalInvitations } from "../src/modules/31-portal/provisioning/invitations";
import { createPortalPreferences } from "../src/modules/31-portal/provisioning/preferences";
import { createPortalUploads } from "../src/modules/31-portal/provisioning/uploads";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG = "11111111-1111-4111-8111-111111113101";
const PDF = Buffer.from("%PDF-1.7 a small portal upload");

describe.skipIf(!DB_URL)("M31 preferences + uploads, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let patientId = "";
  let accountId = "";
  let userId = "";
  const key = randomBytes(32);
  const cipher = createPortalPhiCipher({
    dekForOrg: async () => ({ version: "v1", key }),
    dekForOrgVersion: async (_org: string, version: string) => ({ version, key }),
  });
  let clock = new Date();

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'g031','g031','g031')",
      [ORG],
    );
    const providerEntityId = (
      await admin.query(
        "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE','123456','1234567893','x','1231','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id as string;
    patientId = (
      await admin.query(
        "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'G031','A','B','1990-01-01','M','active') RETURNING id",
        [ORG],
      )
    ).rows[0].id as string;
    userId = (await admin.query(`INSERT INTO "user" (email) VALUES ('p@g031.test') RETURNING id`))
      .rows[0].id as string;
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const tokens: string[] = [];
    const invitations = createPortalInvitations({
      db: app.db,
      cipher,
      users: {
        ensureUser: async () => ({ userId }),
        markEmailVerified: async () => undefined,
      },
      consent: {
        governingConsent: async () => ({
          consentRecordId: (await admin.query("SELECT gen_random_uuid() AS id")).rows[0].id,
          consentVersion: "1",
        }),
      },
      site: { siteForPatient: async () => ({ providerEntityId, locationId: null }) },
      delivery: {
        deliver: async (input) => {
          tokens.push(input.token);
          return { inviteUrl: "https://portal.test/accept" };
        },
      },
    });
    const issued = await invitations.issue({
      organizationId: ORG,
      actingUserId: "",
      patientId,
      relationship: "family_caregiver",
      inviteeDisplayName: "Pat Ient",
      inviteeEmail: "p@g031.test",
      proposedScopeSet: [],
    });
    accountId = issued.portalAccountId;
    await invitations.accept(tokens[0] as string);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  it("preferences: first toggle inserts, the second updates the SAME row with a version bump", async () => {
    const prefs = createPortalPreferences(app.db);
    await prefs.update({
      organizationId: ORG,
      actingUserId: userId,
      portalAccountId: accountId,
      idOrChannel: "sms",
      update: { enabled: true, quietHoursStartHour: 22, quietHoursEndHour: 7 },
    });
    const view = await prefs.update({
      organizationId: ORG,
      actingUserId: userId,
      portalAccountId: accountId,
      idOrChannel: "sms",
      update: { enabled: false },
    });
    expect(view.channels.find((c) => c.channel === "sms")?.enabled).toBe(false);
    const { rows } = await admin.query(
      "SELECT enabled, version FROM portal_notification_preference WHERE portal_account_id = $1 AND channel = 'sms'",
      [accountId],
    );
    expect(rows).toEqual([{ enabled: false, version: 1 }]);
    expect((await prefs.list(ORG, accountId)).quietHours).toEqual({ startHour: 22, endHour: 7 });
  });

  const uploads = () =>
    createPortalUploads({
      db: app.db,
      cipher,
      now: () => clock,
      intake: {
        accept: async () => ({
          documentId: "d0000000-0000-4000-8000-000000003101",
          intakeBatchId: "e0000000-0000-4000-8000-000000003101",
        }),
      },
    });
  const ids = () => ({
    organizationId: ORG,
    actingUserId: userId,
    portalAccountId: accountId,
    patientId,
  });
  const begin = (size = PDF.byteLength) =>
    uploads().begin({
      ...ids(),
      purpose: "prior_records",
      mimeType: "application/pdf",
      expectedByteSize: size,
      patientDischargedReadOnly: false,
    });
  const row = async (uploadId: string) =>
    (
      await admin.query(
        "SELECT status, content_cipher IS NOT NULL AS has_cipher, document_id, rejection_code FROM portal_document_upload WHERE id = $1",
        [uploadId],
      )
    ).rows[0];

  it("uploads: begin -> stage (ciphertext only) -> complete clears the ciphertext, and complete is idempotent", async () => {
    const { uploadId } = await begin();
    expect(await row(uploadId)).toMatchObject({ status: "initiated", has_cipher: false });
    await uploads().stage({ ...ids(), uploadId, bytes: PDF });
    expect(await row(uploadId)).toMatchObject({ status: "staged", has_cipher: true });
    const done = await uploads().complete({ ...ids(), uploadId });
    expect(done).toMatchObject({
      status: "received",
      documentId: "d0000000-0000-4000-8000-000000003101",
    });
    expect(await row(uploadId)).toMatchObject({ status: "submitted", has_cipher: false });
    expect(await uploads().complete({ ...ids(), uploadId })).toMatchObject({ status: "received" });
  });

  it("a stage with the wrong magic bytes is durably recorded as rejected, not rolled back", async () => {
    const { uploadId } = await begin(16);
    await expect(
      uploads().stage({ ...ids(), uploadId, bytes: Buffer.from("NOT-A-PDF-AT-ALL") }),
    ).rejects.toBeDefined();
    const after = await row(uploadId);
    expect(after.status).toBe("rejected");
    expect(after.rejection_code).toBeTruthy();
  });

  it("a stage after the window closes is durably recorded as expired", async () => {
    const { uploadId } = await begin();
    clock = new Date(Date.now() + 60 * 60_000);
    await expect(uploads().stage({ ...ids(), uploadId, bytes: PDF })).rejects.toMatchObject({
      statusCode: 410,
    });
    expect((await row(uploadId)).status).toBe("expired");
  });
});
