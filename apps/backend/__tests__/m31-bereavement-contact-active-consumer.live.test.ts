/**
 * #248 outbox-binding arc (F-139/F-160/F-164/F-165/F-167 pattern) — LIVE Postgres proof that
 * `buildM31BereavementContactActiveConsumer` (`m16.bereavement.contact_active`) writes a real
 * `portal_access_grant` D6 bereaved-mode lateral flip under RLS.
 *
 * F-139 named this pair genuine but left it unbuilt through F-160/F-162/F-164/F-165. F-165's own
 * `plan_opened` consumer names `contact_active` explicitly as "the per-contact-exact mechanism this arc's
 * own F-164 note already names as the real primary trigger" — `plan_opened` fires once per PLAN, before
 * any contact confirms, so its per-contact loop almost always finds nothing; `contact_active` fires once
 * per CONTACT at the exact moment that contact's own bereavement_outreach_consent is verified.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m31:bereavement-contact-active:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleBereavementSeamStore } from "../src/modules/16-bereavement/seams/drizzle-store";
import { registerBereavementSeams } from "../src/modules/16-bereavement/seams/index";
import { bereavedContactFlipCandidateForOrg } from "../src/modules/16-bereavement/seams/plan-provider-entity-for-org";
import { buildM31BereavementContactActiveConsumer } from "../src/modules/31-portal/outbox-consumers/m16-bereavement-contact-active";
import { createDbConsentStore } from "../src/modules/39-consent/consent-store-db";
import { registerConsentSeams } from "../src/modules/39-consent/seams";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "#248 F-167 — M31's m16.bereavement.contact_active outbox consumer (D6 lateral flip) — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM31BereavementContactActiveConsumer>;
    let peA: string;
    let peB: string;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedOrg(orgId: string, slug: string) {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
        [orgId, slug, slug],
      );
    }

    async function seedProviderEntity(orgId: string, ccn: string): Promise<string> {
      const row = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
        [orgId, ccn, `NPI-${ccn}`],
      );
      return row.rows[0].id as string;
    }

    async function seedUser(email: string): Promise<string> {
      const row = await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email]);
      return row.rows[0].id as string;
    }

    async function seedPortalAccount(orgId: string, userId: string): Promise<string> {
      const row = await admin.query(
        `INSERT INTO portal_account
           (organization_id, user_id, relationship, status, display_name_cipher, email_cipher)
         VALUES ($1,$2,'bereaved_family_member','active','cipher:name','cipher:email')
         RETURNING id`,
        [orgId, userId],
      );
      return row.rows[0].id as string;
    }

    async function seedGrant(opts: {
      organizationId: string;
      providerEntityId: string;
      portalAccountId: string;
      patientId: string;
      grantKind: string;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO portal_access_grant
           (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
            source_consent_record_id, source_consent_version, granted_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'{"categories":{},"floorVersion":"v0"}'::jsonb,$6,'0',$7)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.portalAccountId,
          opts.patientId,
          opts.grantKind,
          crypto.randomUUID(),
          crypto.randomUUID(),
        ],
      );
      return row.rows[0].id as string;
    }

    async function grantRowForPatient(
      organizationId: string,
      portalAccountId: string,
      patientId: string,
    ) {
      const { rows } = await admin.query(
        `SELECT id, grant_kind, revoked_at, revoke_cascade_source, version, source_consent_record_id,
                source_consent_version, granted_by_membership_id, provider_entity_id, location_id,
                scope_set_jsonb
         FROM portal_access_grant
         WHERE organization_id = $1 AND portal_account_id = $2 AND patient_id = $3 AND revoked_at IS NULL`,
        [organizationId, portalAccountId, patientId],
      );
      return rows[0];
    }

    async function seedBereavementPlan(opts: {
      organizationId: string;
      providerEntityId: string;
      patientId: string;
      assignedCounselorUserId: string;
    }): Promise<string> {
      const now = new Date();
      const row = await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date, opened_at,
            assigned_counselor_user_id, assigned_counselor_assigned_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8)
         RETURNING id`,
        [
          opts.organizationId,
          opts.patientId,
          crypto.randomUUID(),
          opts.providerEntityId,
          now.toISOString().slice(0, 10),
          now,
          opts.assignedCounselorUserId,
          now,
        ],
      );
      return row.rows[0].id as string;
    }

    async function seedConsentTypeCatalogOnce() {
      await admin.query(
        `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
           default_expiration_seconds, max_term_seconds, capture_method_floor,
           reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
           is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
           hipaa_164_508_compliant, body_text_template_key, m22_template_version)
         VALUES
           ('bereavement_outreach_consent','Bereavement Outreach','categorical',NULL,NULL,
            ARRAY['witnessed_verbal_documented']::text[],ARRAY['1_day']::text[],'bereavement_outreach',
            false,false,true,false,false,false,'consent_record','v1')
         ON CONFLICT (type_key) DO NOTHING`,
      );
    }

    /** A `bereavement_outreach_consent` record, ACTIVE, for `patientId` — the fact
     *  `ConsentEvaluator.evaluate` resolves and this consumer cross-checks against the contact row. */
    async function seedActiveConsentRecord(opts: {
      organizationId: string;
      providerEntityId: string;
      patientId: string;
      version?: number;
    }): Promise<string> {
      const now = new Date();
      const row = await admin.query(
        `INSERT INTO consent_record
           (organization_id, provider_entity_id, patient_id, type_key, scope_descriptor, grantor_kind,
            effective_at, status, capture_method, capture_evidence_jsonb, created_by_id, signed_at,
            signed_by_id, version)
         VALUES ($1,$2,$3,'bereavement_outreach_consent','{}'::jsonb,'bereaved_person_self',$4,'active',
                 'witnessed_verbal_documented','{}'::jsonb,$5,$4,$5,$6)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.patientId,
          now,
          crypto.randomUUID(),
          opts.version ?? 3,
        ],
      );
      return row.rows[0].id as string;
    }

    async function seedContact(opts: {
      organizationId: string;
      providerEntityId: string;
      planId: string;
      status: "active" | "proposed";
      portalAccountId?: string;
      consentRecordId?: string;
    }): Promise<string> {
      const confirmedAt = opts.status === "active" ? new Date() : null;
      const row = await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code,
            portal_account_id, consent_record_id, confirmed_at)
         VALUES ($1,$2,$3,$4,'Test Contact','spouse',$5,$6,$7)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.planId,
          opts.status,
          opts.portalAccountId ?? null,
          opts.consentRecordId ?? null,
          confirmedAt,
        ],
      );
      return row.rows[0].id as string;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await seedOrg(ORG_A, "a");
      await seedOrg(ORG_B, "b");
      peA = await seedProviderEntity(ORG_A, "CCN-M31CA-A");
      peB = await seedProviderEntity(ORG_B, "CCN-M31CA-B");
      await seedConsentTypeCatalogOnce();
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      registerBereavementSeams({ store: createDrizzleBereavementSeamStore(handle.db) });
      registerConsentSeams({ store: createDbConsentStore(handle.db) });

      consumer = buildM31BereavementContactActiveConsumer({
        db: handle.db,
        bereavedContactFlipCandidateForContact: bereavedContactFlipCandidateForOrg,
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("flips the confirmed contact's live grant to bereaved_family with the real consent record + version", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u1-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      const consentRecordId = await seedActiveConsentRecord({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        version: 4,
      });
      const contactId = await seedContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        status: "active",
        portalAccountId: accountId,
        consentRecordId,
      });
      const liveGrantId = await seedGrant({
        organizationId: ORG_A,
        providerEntityId: peA,
        portalAccountId: accountId,
        patientId,
        grantKind: "family_caregiver",
      });

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await consumer.handle({
          organizationId: ORG_A,
          payload: { planId, contactId, portalAccountId: accountId },
        });
      });

      const { rows: oldRows } = await admin.query(
        `SELECT revoked_at, revoke_cascade_source FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(oldRows[0].revoked_at).not.toBeNull();
      expect(oldRows[0].revoke_cascade_source).toBe("patient_deceased");

      const flipped = await grantRowForPatient(ORG_A, accountId, patientId);
      expect(flipped).toBeDefined();
      expect(flipped.grant_kind).toBe("bereaved_family");
      expect(flipped.source_consent_record_id).toBe(consentRecordId);
      expect(flipped.source_consent_version).toBe("4");
      expect(flipped.granted_by_membership_id).toBeNull();
      expect(flipped.provider_entity_id).toBe(peA);
    });

    it("a contact that has since left active (redelivered against stale payload state) is a true no-op", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u2-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      const contactId = await seedContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        status: "proposed",
        portalAccountId: accountId,
      });
      const liveGrantId = await seedGrant({
        organizationId: ORG_A,
        providerEntityId: peA,
        portalAccountId: accountId,
        patientId,
        grantKind: "family_caregiver",
      });

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: { planId, contactId, portalAccountId: accountId },
          }),
        ).resolves.not.toThrow();
      });

      const { rows } = await admin.query(
        `SELECT revoked_at FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(rows[0].revoked_at).toBeNull();
    });

    it("a consent-record mismatch against the M39 governing record is a skip, not a fabricated flip", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u3-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      // The GOVERNING consent record for this patient (what ConsentEvaluator will return)...
      await seedActiveConsentRecord({ organizationId: ORG_A, providerEntityId: peA, patientId });
      // ...but the contact's own consent_record_id names a DIFFERENT (never-created) record.
      const contactId = await seedContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        status: "active",
        portalAccountId: accountId,
        consentRecordId: crypto.randomUUID(),
      });
      const liveGrantId = await seedGrant({
        organizationId: ORG_A,
        providerEntityId: peA,
        portalAccountId: accountId,
        patientId,
        grantKind: "family_caregiver",
      });

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: { planId, contactId, portalAccountId: accountId },
          }),
        ).resolves.not.toThrow();
      });

      const { rows } = await admin.query(
        `SELECT revoked_at FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(rows[0].revoked_at).toBeNull();
    });

    it("an already-confirmed contact with NO live grant to flip is a no-op, not a throw (F-164's standing 'no producer inserts a grant' case)", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u4-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      const consentRecordId = await seedActiveConsentRecord({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
      });
      const contactId = await seedContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        status: "active",
        portalAccountId: accountId,
        consentRecordId,
      });
      // Deliberately no seedGrant() call.

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: { planId, contactId, portalAccountId: accountId },
          }),
        ).resolves.not.toThrow();
      });

      const flipped = await grantRowForPatient(ORG_A, accountId, patientId);
      expect(flipped).toBeUndefined();
    });

    it("redelivery after a successful flip is a true no-op — no duplicate grant, no re-revoke", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u5-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      const consentRecordId = await seedActiveConsentRecord({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
      });
      const contactId = await seedContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        status: "active",
        portalAccountId: accountId,
        consentRecordId,
      });
      await seedGrant({
        organizationId: ORG_A,
        providerEntityId: peA,
        portalAccountId: accountId,
        patientId,
        grantKind: "family_caregiver",
      });

      const payload = { planId, contactId, portalAccountId: accountId };
      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await consumer.handle({ organizationId: ORG_A, payload });
        await consumer.handle({ organizationId: ORG_A, payload });
      });

      const { rows } = await admin.query(
        `SELECT id FROM portal_access_grant
         WHERE organization_id = $1 AND portal_account_id = $2 AND patient_id = $3
           AND revoked_at IS NULL AND grant_kind = 'bereaved_family'`,
        [ORG_A, accountId, patientId],
      );
      expect(rows).toHaveLength(1);
    });

    it("cross-tenant: org A's delivery never touches org B's contact/grant rows", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u6-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_B, userId);
      const planIdOrgB = await seedBereavementPlan({
        organizationId: ORG_B,
        providerEntityId: peB,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      const consentRecordId = await seedActiveConsentRecord({
        organizationId: ORG_B,
        providerEntityId: peB,
        patientId,
      });
      const contactIdOrgB = await seedContact({
        organizationId: ORG_B,
        providerEntityId: peB,
        planId: planIdOrgB,
        status: "active",
        portalAccountId: accountId,
        consentRecordId,
      });
      const liveGrantId = await seedGrant({
        organizationId: ORG_B,
        providerEntityId: peB,
        portalAccountId: accountId,
        patientId,
        grantKind: "family_caregiver",
      });

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: { planId: planIdOrgB, contactId: contactIdOrgB, portalAccountId: accountId },
          }),
        ).resolves.not.toThrow();
      });

      const { rows } = await admin.query(
        `SELECT revoked_at FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(rows[0].revoked_at).toBeNull();
    });

    it("an unknown contact id is a no-op, not a throw", async () => {
      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: {
              planId: crypto.randomUUID(),
              contactId: crypto.randomUUID(),
              portalAccountId: null,
            },
          }),
        ).resolves.not.toThrow();
      });
    });
  },
);
