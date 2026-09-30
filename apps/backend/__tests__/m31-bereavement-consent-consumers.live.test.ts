/**
 * Continuation of the #248 outbox-binding arc (F-139/F-160 pattern) — LIVE Postgres proof that two more of
 * M31's own §4.10 "M31 consumes" table entries write real `portal_access_grant` rows under RLS:
 *   - `buildM31BereavementPlanClosedConsumer` (`m16.bereavement.plan_closed_completed` → revoke every
 *     active `bereaved_family` grant for the plan's decedent patient, via the real M16 `BereavementPlanProvider`
 *     seam and the T03 `planBereavedWindowClose` pure core)
 *   - `buildM31ConsentRevokedGrantCascadeConsumer` (`m39.consent.revoked`, any consent type → revoke every
 *     `portal_access_grant` row whose `source_consent_record_id` matches the revoked consent)
 *
 * Both sat in `scripts/outbox-deferred-consumers.ts`'s m31 group. `m16.bereavement.plan_opened` and
 * `m6.admission.discharged` (the other two pairs investigated in this same pass) are NOT built here — both
 * are reported BLOCKED (see the coordinator's writeup): `plan_opened`'s insert half needs
 * `portal_access_grant.granted_by_membership_id`, NOT NULL with no system-actor convention (the F-150
 * shape); `m6.admission.discharged` has no unique write target on the death branch (redundant with
 * `plan_opened`) and needs unbuilt BullMQ/cron infrastructure on the non-death branch.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m31:bereavement-consent-consumers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBereavementSeams } from "../src/modules/16-bereavement/seams/index";
import { createDrizzleBereavementSeamStore } from "../src/modules/16-bereavement/seams/drizzle-store";
import { buildM31BereavementPlanClosedConsumer } from "../src/modules/31-portal/outbox-consumers/m16-bereavement-plan-closed";
import { buildM31ConsentRevokedGrantCascadeConsumer } from "../src/modules/31-portal/outbox-consumers/m39-consent-revoked";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "#248 continuation — M31's bereavement-plan-closed + consent-revoked outbox consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let planClosedConsumer: ReturnType<typeof buildM31BereavementPlanClosedConsumer>;
    let consentRevokedConsumer: ReturnType<typeof buildM31ConsentRevokedGrantCascadeConsumer>;
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
      sourceConsentRecordId: string;
      revokedAt?: Date | null;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO portal_access_grant
           (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
            source_consent_record_id, source_consent_version, granted_by_membership_id, revoked_at,
            revoke_cascade_source)
         VALUES ($1,$2,$3,$4,$5,'{"categories":{},"floorVersion":"v1"}'::jsonb,$6,'1',$7,$8,$9)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.portalAccountId,
          opts.patientId,
          opts.grantKind,
          opts.sourceConsentRecordId,
          crypto.randomUUID(),
          opts.revokedAt ?? null,
          opts.revokedAt ? "user_action" : null,
        ],
      );
      return row.rows[0].id as string;
    }

    async function grantRow(id: string) {
      const { rows } = await admin.query(
        `SELECT revoked_at, revoke_cascade_source, version FROM portal_access_grant WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    async function seedBereavementPlan(opts: {
      organizationId: string;
      providerEntityId: string;
      patientId: string;
      status: string;
    }): Promise<string> {
      const now = new Date();
      const row = await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date, opened_at,
            closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [
          opts.organizationId,
          opts.patientId,
          crypto.randomUUID(),
          opts.providerEntityId,
          opts.status,
          now.toISOString().slice(0, 10),
          now,
          now,
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
      peA = await seedProviderEntity(ORG_A, "CCN-M31CA");
      peB = await seedProviderEntity(ORG_B, "CCN-M31CB");
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      registerBereavementSeams({ store: createDrizzleBereavementSeamStore(handle.db) });

      planClosedConsumer = buildM31BereavementPlanClosedConsumer({ db: handle.db });
      consentRevokedConsumer = buildM31ConsentRevokedGrantCascadeConsumer({ db: handle.db });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    describe("m16.bereavement.plan_closed_completed", () => {
      it("revokes every active bereaved_family grant for the plan's decedent patient", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u1-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_A, userId);
        const planId = await seedBereavementPlan({
          organizationId: ORG_A,
          providerEntityId: peA,
          patientId,
          status: "closed_completed",
        });
        const grantId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountId,
          patientId,
          grantKind: "bereaved_family",
          sourceConsentRecordId: crypto.randomUUID(),
        });

        await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
          await planClosedConsumer.handle({
            organizationId: ORG_A,
            payload: { planId, closedAt: new Date().toISOString(), outreachStats: {} },
          });
        });

        const row = await grantRow(grantId);
        expect(row.revoked_at).not.toBeNull();
        expect(row.revoke_cascade_source).toBe("bereavement_window_expired");
        expect(row.version).toBe(1);
      });

      it("leaves a non-bereaved_family grant for the same patient untouched", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u2-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_A, userId);
        const planId = await seedBereavementPlan({
          organizationId: ORG_A,
          providerEntityId: peA,
          patientId,
          status: "closed_completed",
        });
        const grantId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountId,
          patientId,
          grantKind: "family_caregiver",
          sourceConsentRecordId: crypto.randomUUID(),
        });

        await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
          await planClosedConsumer.handle({
            organizationId: ORG_A,
            payload: { planId, closedAt: new Date().toISOString(), outreachStats: {} },
          });
        });

        expect((await grantRow(grantId)).revoked_at).toBeNull();
      });

      it("redelivery after the first revoke is a true no-op (version unchanged)", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u3-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_A, userId);
        const planId = await seedBereavementPlan({
          organizationId: ORG_A,
          providerEntityId: peA,
          patientId,
          status: "closed_completed",
        });
        const grantId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountId,
          patientId,
          grantKind: "bereaved_family",
          sourceConsentRecordId: crypto.randomUUID(),
        });

        const payload = { planId, closedAt: new Date().toISOString(), outreachStats: {} };
        await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
          await planClosedConsumer.handle({ organizationId: ORG_A, payload });
          await planClosedConsumer.handle({ organizationId: ORG_A, payload });
        });

        expect((await grantRow(grantId)).version).toBe(1);
      });

      it("an org B plan id is invisible to an org A delivery — no cross-tenant revoke", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u4-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_B, userId);
        const planIdOrgB = await seedBereavementPlan({
          organizationId: ORG_B,
          providerEntityId: peB,
          patientId,
          status: "closed_completed",
        });
        const grantId = await seedGrant({
          organizationId: ORG_B,
          providerEntityId: peB,
          portalAccountId: accountId,
          patientId,
          grantKind: "bereaved_family",
          sourceConsentRecordId: crypto.randomUUID(),
        });

        await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
          await expect(
            planClosedConsumer.handle({
              organizationId: ORG_A,
              payload: { planId: planIdOrgB, closedAt: new Date().toISOString(), outreachStats: {} },
            }),
          ).resolves.not.toThrow();
        });

        expect((await grantRow(grantId)).revoked_at).toBeNull();
      });

      it("an unknown plan id is a no-op, not a throw", async () => {
        await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
          await expect(
            planClosedConsumer.handle({
              organizationId: ORG_A,
              payload: {
                planId: crypto.randomUUID(),
                closedAt: new Date().toISOString(),
                outreachStats: {},
              },
            }),
          ).resolves.not.toThrow();
        });
      });
    });

    describe("m39.consent.revoked", () => {
      it("revokes exactly the grant whose source_consent_record_id matches the revoked consent", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u5-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_A, userId);
        const consentRecordId = crypto.randomUUID();
        const grantId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountId,
          patientId,
          grantKind: "family_caregiver",
          sourceConsentRecordId: consentRecordId,
        });

        await consentRevokedConsumer.handle({
          organizationId: ORG_A,
          payload: {
            patientId,
            consentRecordId,
            revocationId: crypto.randomUUID(),
            typeKey: "family_caregiver_access",
            revokedAt: new Date().toISOString(),
            revokedByKind: "staff",
            cascadeKind: "grant_revocation",
          },
        });

        const row = await grantRow(grantId);
        expect(row.revoked_at).not.toBeNull();
        expect(row.revoke_cascade_source).toBe("consent_revoked");
        expect(row.version).toBe(1);
      });

      it("a sibling grant backed by a DIFFERENT consent record for the SAME patient is untouched — the exact over-termination M2's own consumer refuses to risk", async () => {
        const patientId = crypto.randomUUID();
        const userA = await seedUser(`u6a-${crypto.randomUUID()}@example.test`);
        const userB = await seedUser(`u6b-${crypto.randomUUID()}@example.test`);
        const accountA = await seedPortalAccount(ORG_A, userA);
        const accountB = await seedPortalAccount(ORG_A, userB);
        const consentA = crypto.randomUUID();
        const consentB = crypto.randomUUID();
        const grantAId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountA,
          patientId,
          grantKind: "family_caregiver",
          sourceConsentRecordId: consentA,
        });
        const grantBId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountB,
          patientId,
          grantKind: "family_caregiver",
          sourceConsentRecordId: consentB,
        });

        await consentRevokedConsumer.handle({
          organizationId: ORG_A,
          payload: {
            patientId,
            consentRecordId: consentA,
            revocationId: crypto.randomUUID(),
            typeKey: "family_caregiver_access",
            revokedAt: new Date().toISOString(),
            revokedByKind: "staff",
            cascadeKind: "grant_revocation",
          },
        });

        expect((await grantRow(grantAId)).revoked_at).not.toBeNull();
        expect((await grantRow(grantBId)).revoked_at).toBeNull();
      });

      it("redelivery after the first revoke is a true no-op (version unchanged)", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u7-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_A, userId);
        const consentRecordId = crypto.randomUUID();
        const grantId = await seedGrant({
          organizationId: ORG_A,
          providerEntityId: peA,
          portalAccountId: accountId,
          patientId,
          grantKind: "dpoa_healthcare",
          sourceConsentRecordId: consentRecordId,
        });

        const payload = {
          patientId,
          consentRecordId,
          revocationId: crypto.randomUUID(),
          typeKey: "dpoa_healthcare",
          revokedAt: new Date().toISOString(),
          revokedByKind: "staff",
          cascadeKind: "grant_revocation",
        };
        await consentRevokedConsumer.handle({ organizationId: ORG_A, payload });
        await consentRevokedConsumer.handle({ organizationId: ORG_A, payload });

        expect((await grantRow(grantId)).version).toBe(1);
      });

      it("never touches another org's grant even if it happens to carry the same consent record id", async () => {
        const patientId = crypto.randomUUID();
        const userId = await seedUser(`u8-${crypto.randomUUID()}@example.test`);
        const accountId = await seedPortalAccount(ORG_B, userId);
        const consentRecordId = crypto.randomUUID();
        const grantId = await seedGrant({
          organizationId: ORG_B,
          providerEntityId: peB,
          portalAccountId: accountId,
          patientId,
          grantKind: "family_caregiver",
          sourceConsentRecordId: consentRecordId,
        });

        await consentRevokedConsumer.handle({
          organizationId: ORG_A,
          payload: {
            patientId,
            consentRecordId,
            revocationId: crypto.randomUUID(),
            typeKey: "family_caregiver_access",
            revokedAt: new Date().toISOString(),
            revokedByKind: "staff",
            cascadeKind: "grant_revocation",
          },
        });

        expect((await grantRow(grantId)).revoked_at).toBeNull();
      });
    });
  },
);
