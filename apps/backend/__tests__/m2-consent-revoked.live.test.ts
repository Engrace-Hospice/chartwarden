/**
 * F-142 (#248) — LIVE Postgres proof that M2's §2.6/D7 M39 consent-revocation cascade
 * (`buildM2ConsentRevokedConsumer`) actually deletes the right `session` rows.
 *
 * `m39.consent.revoked` → M2's "portal-session terminate" is the first outbox consumer M2 has ever
 * had. This proves: a `patient_portal` session scoped to the revoked patient is deleted on a
 * `portal_access` revocation; a `caregiver_portal` session for the SAME patient is left untouched
 * (different session class — the file's own deliberate scope); a `patient_portal` session for a
 * DIFFERENT patient in the same org is left untouched; a same-org session is untouched by any OTHER
 * consent type (`family_caregiver_access` — the deliberately-unhandled type, see the consumer's own
 * header); redelivery after termination is a safe no-op; and cross-tenant isolation holds (org B's
 * session, same patient id, is untouched by org A's delivery).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:consent-revoked:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM2ConsentRevokedConsumer } from "../src/modules/02-identity/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const PATIENT_X = "aaaaaaaa-0000-4000-8000-0000000000a1";
const PATIENT_Y = "aaaaaaaa-0000-4000-8000-0000000000a2";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

describe.skipIf(!DB_URL)(
  "F-142 — M2's M39 consent-revocation session-termination cascade — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM2ConsentRevokedConsumer>;

    async function resetSchema() {
      // DROP OWNED BY is DATABASE-scoped (safe against a shared cluster); DROP ROLE is CLUSTER-global
      // and is deliberately NOT run here — this suite may share a Postgres instance with other
      // concurrently-running live suites against sibling databases, and dropping a role those suites'
      // connections depend on would break them. Migration 0001's `CREATE ROLE` is already idempotent
      // (`IF NOT EXISTS`-guarded), so leaving an existing role in place and re-applying migrations is
      // equivalent to a fresh cluster for this database's purposes.
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; END IF; END $$;`,
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

    async function seedUser(): Promise<string> {
      const row = await admin.query(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${nextId("user")}@example.test`],
      );
      return row.rows[0].id as string;
    }

    async function seedSession(opts: {
      organizationId: string;
      sessionClass: "patient_portal" | "caregiver_portal" | "staff";
      scope: Record<string, unknown> | null;
    }): Promise<string> {
      const userId = await seedUser();
      const id = nextId("sess");
      await admin.query(
        `INSERT INTO session
           (id, user_id, active_organization_id, token, expires_at, session_class, scope)
         VALUES ($1, $2, $3, $4, now() + interval '1 day', $5, $6)`,
        [
          id,
          userId,
          opts.organizationId,
          nextId("token"),
          opts.sessionClass,
          opts.scope ? JSON.stringify(opts.scope) : null,
        ],
      );
      return id;
    }

    async function sessionExists(id: string): Promise<boolean> {
      const { rows } = await admin.query(`SELECT 1 FROM session WHERE id = $1`, [id]);
      return rows.length > 0;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m2-consent-revoked-a','M2 Consent Revoked A','M2 Consent Revoked A'),
                ($2,'m2-consent-revoked-b','M2 Consent Revoked B','M2 Consent Revoked B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      consumer = buildM2ConsentRevokedConsumer({ db: handle.db });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("deletes a patient_portal session scoped to the revoked patient on a portal_access revocation", async () => {
      const portalAccountId = nextId("acct");
      const sessionId = await seedSession({
        organizationId: ORG_A,
        sessionClass: "patient_portal",
        scope: { portalAccountId, patientId: PATIENT_X },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "portal_access" },
      });

      expect(await sessionExists(sessionId)).toBe(false);
    });

    it("does not touch a caregiver_portal session for the same patient (deliberately unhandled type)", async () => {
      const portalAccountId = nextId("acct");
      const sessionId = await seedSession({
        organizationId: ORG_A,
        sessionClass: "caregiver_portal",
        scope: { portalAccountId, patientId: PATIENT_X },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "portal_access" },
      });

      expect(await sessionExists(sessionId)).toBe(true);
    });

    it("does not touch a patient_portal session for a different patient in the same org", async () => {
      const portalAccountId = nextId("acct");
      const sessionId = await seedSession({
        organizationId: ORG_A,
        sessionClass: "patient_portal",
        scope: { portalAccountId, patientId: PATIENT_Y },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "portal_access" },
      });

      expect(await sessionExists(sessionId)).toBe(true);
    });

    it("no-ops entirely for a non-portal_access typeKey (e.g. family_caregiver_access)", async () => {
      const portalAccountId = nextId("acct");
      const sessionId = await seedSession({
        organizationId: ORG_A,
        sessionClass: "patient_portal",
        scope: { portalAccountId, patientId: PATIENT_X },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "family_caregiver_access" },
      });

      expect(await sessionExists(sessionId)).toBe(true);
    });

    it("is a safe no-op redelivery once the session is already gone", async () => {
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: { patientId: PATIENT_X, typeKey: "portal_access" },
        }),
      ).resolves.toBeUndefined();
    });

    it("does not cross tenants — org B's session for the same patient id is untouched by org A's delivery", async () => {
      const portalAccountId = nextId("acct");
      const sessionIdB = await seedSession({
        organizationId: ORG_B,
        sessionClass: "patient_portal",
        scope: { portalAccountId, patientId: PATIENT_X },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "portal_access" },
      });

      expect(await sessionExists(sessionIdB)).toBe(true);
    });

    it("does not touch a staff session even if it somehow carried a matching patientId in scope", async () => {
      // Defense-in-depth: a staff session's scope is never written with a patientId in production
      // (nothing but a portal/collaborator/funeral bind ever sets one), but the consumer filters by
      // sessionClass explicitly rather than relying on that invariant alone.
      const sessionId = await seedSession({
        organizationId: ORG_A,
        sessionClass: "staff",
        scope: { patientId: PATIENT_X },
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: PATIENT_X, typeKey: "portal_access" },
      });

      expect(await sessionExists(sessionId)).toBe(true);
    });
  },
);
