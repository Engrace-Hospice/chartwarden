/**
 * Continuation of the #248 outbox-binding arc (F-139/F-160/F-164 pattern) — LIVE Postgres proof that
 * `buildM31BereavementPlanOpenedConsumer` (`m16.bereavement.plan_opened`) writes a real `portal_access_grant`
 * D6 bereaved-mode lateral flip under RLS.
 *
 * F-164 reported this pair BLOCKED on two grounds: `portal_access_grant.granted_by_membership_id` is NOT
 * NULL with no system-actor escape, and the bereavement_outreach_consent the insert's
 * `source_consent_record_id` should resolve from is `draft` immediately after death, so most real
 * `plan_opened` deliveries would find no active consent to insert against. F-165 (this pass) re-checked
 * both: migration 0257 nullable-widens the actor column (the `order_discontinuation.actor_membership_id`
 * precedent), and the consent fact resolves via `bereaved_contact.status = 'active'` (M16's own
 * `m39-consent-signed.ts` consumer only flips a contact to `active` once its EXACT consent record signs)
 * plus M39's real `ConsentEvaluator.evaluate` for the consent's version, cross-checked against the
 * contact's own `consent_record_id`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m31:bereavement-plan-opened:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleBereavementSeamStore } from "../src/modules/16-bereavement/seams/drizzle-store";
import { registerBereavementSeams } from "../src/modules/16-bereavement/seams/index";
import { bereavedContactFlipCandidatesForPlanForOrg } from "../src/modules/16-bereavement/seams/plan-provider-entity-for-org";
import { buildM31BereavementPlanOpenedConsumer } from "../src/modules/31-portal/outbox-consumers/m16-bereavement-plan-opened";
import { createDbConsentStore } from "../src/modules/39-consent/consent-store-db";
import { registerConsentSeams } from "../src/modules/39-consent/seams";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "#248 F-165 — M31's m16.bereavement.plan_opened outbox consumer (D6 lateral flip) — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM31BereavementPlanOpenedConsumer>;
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
      /** `berv_plan_active_requires_counselor` — an `active` plan needs one; no real FK on this
       *  logical M2-membership column, so any uuid satisfies the CHECK. */
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

    async function seedActiveContact(opts: {
      organizationId: string;
      providerEntityId: string;
      planId: string;
      portalAccountId: string;
      consentRecordId: string;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code,
            portal_account_id, consent_record_id, confirmed_at)
         VALUES ($1,$2,$3,'active','Test Contact','spouse',$4,$5,now())
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.planId,
          opts.portalAccountId,
          opts.consentRecordId,
        ],
      );
      return row.rows[0].id as string;
    }

    async function seedProposedContact(opts: {
      organizationId: string;
      providerEntityId: string;
      planId: string;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code)
         VALUES ($1,$2,$3,'proposed','Proposed Contact','child')
         RETURNING id`,
        [opts.organizationId, opts.providerEntityId, opts.planId],
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
      peA = await seedProviderEntity(ORG_A, "CCN-M31PO-A");
      peB = await seedProviderEntity(ORG_B, "CCN-M31PO-B");
      await seedConsentTypeCatalogOnce();
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      registerBereavementSeams({ store: createDrizzleBereavementSeamStore(handle.db) });
      registerConsentSeams({ store: createDbConsentStore(handle.db) });

      consumer = buildM31BereavementPlanOpenedConsumer({
        db: handle.db,
        bereavedContactFlipCandidatesForPlan: bereavedContactFlipCandidatesForPlanForOrg,
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("flips an already-confirmed contact's live grant to bereaved_family with the real consent record + version", async () => {
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
      await seedActiveContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
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
          payload: {
            planId,
            patientId,
            admissionId: crypto.randomUUID(),
            deathDate: new Date().toISOString().slice(0, 10),
            assignedCounselorUserId: crypto.randomUUID(),
            archivesAt: new Date().toISOString(),
          },
        });
      });

      // The old grant is revoked...
      const { rows: oldRows } = await admin.query(
        `SELECT revoked_at, revoke_cascade_source FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(oldRows[0].revoked_at).not.toBeNull();
      expect(oldRows[0].revoke_cascade_source).toBe("patient_deceased");

      // ...and a new bereaved_family grant exists, carrying the REAL consent record + version, no actor.
      const flipped = await grantRowForPatient(ORG_A, accountId, patientId);
      expect(flipped).toBeDefined();
      expect(flipped.grant_kind).toBe("bereaved_family");
      expect(flipped.source_consent_record_id).toBe(consentRecordId);
      expect(flipped.source_consent_version).toBe("4");
      expect(flipped.granted_by_membership_id).toBeNull();
      expect(flipped.provider_entity_id).toBe(peA);
    });

    it("a still-proposed contact (consent not yet signed) is a true no-op — no grant flip, no throw", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u2-${crypto.randomUUID()}@example.test`);
      const accountId = await seedPortalAccount(ORG_A, userId);
      const planId = await seedBereavementPlan({
        organizationId: ORG_A,
        providerEntityId: peA,
        patientId,
        assignedCounselorUserId: crypto.randomUUID(),
      });
      await seedProposedContact({ organizationId: ORG_A, providerEntityId: peA, planId });
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
            payload: {
              planId,
              patientId,
              admissionId: crypto.randomUUID(),
              deathDate: new Date().toISOString().slice(0, 10),
              assignedCounselorUserId: crypto.randomUUID(),
              archivesAt: new Date().toISOString(),
            },
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
      const userId = await seedUser(`u3-${crypto.randomUUID()}@example.test`);
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
      await seedActiveContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
        portalAccountId: accountId,
        consentRecordId,
      });
      // Deliberately no seedGrant() call — mirrors F-164's standing finding that no production path
      // inserts a portal_access_grant row today.

      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: {
              planId,
              patientId,
              admissionId: crypto.randomUUID(),
              deathDate: new Date().toISOString().slice(0, 10),
              assignedCounselorUserId: crypto.randomUUID(),
              archivesAt: new Date().toISOString(),
            },
          }),
        ).resolves.not.toThrow();
      });

      const flipped = await grantRowForPatient(ORG_A, accountId, patientId);
      expect(flipped).toBeUndefined();
    });

    it("redelivery after a successful flip is a true no-op — no duplicate grant, no re-revoke", async () => {
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
      await seedActiveContact({
        organizationId: ORG_A,
        providerEntityId: peA,
        planId,
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

      const payload = {
        planId,
        patientId,
        admissionId: crypto.randomUUID(),
        deathDate: new Date().toISOString().slice(0, 10),
        assignedCounselorUserId: crypto.randomUUID(),
        archivesAt: new Date().toISOString(),
      };
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

    it("cross-tenant: org A's payload never touches org B's contact/grant rows", async () => {
      const patientId = crypto.randomUUID();
      const userId = await seedUser(`u5-${crypto.randomUUID()}@example.test`);
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
      await seedActiveContact({
        organizationId: ORG_B,
        providerEntityId: peB,
        planId: planIdOrgB,
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
            payload: {
              planId: planIdOrgB,
              patientId,
              admissionId: crypto.randomUUID(),
              deathDate: new Date().toISOString().slice(0, 10),
              assignedCounselorUserId: crypto.randomUUID(),
              archivesAt: new Date().toISOString(),
            },
          }),
        ).resolves.not.toThrow();
      });

      const { rows } = await admin.query(
        `SELECT revoked_at FROM portal_access_grant WHERE id = $1`,
        [liveGrantId],
      );
      expect(rows[0].revoked_at).toBeNull();
    });

    it("an unknown plan id is a no-op, not a throw", async () => {
      await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: {
              planId: crypto.randomUUID(),
              patientId: crypto.randomUUID(),
              admissionId: crypto.randomUUID(),
              deathDate: new Date().toISOString().slice(0, 10),
              assignedCounselorUserId: crypto.randomUUID(),
              archivesAt: new Date().toISOString(),
            },
          }),
        ).resolves.not.toThrow();
      });
    });
  },
);
