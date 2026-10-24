/**
 * F-159 (#248) — LIVE Postgres proof that M16's §4.5 post-death-grant handler
 * (`buildM16ConsentSignedConsumer`, binding `m39.consent.signed`) actually confirms a proposed bereaved
 * contact and appends its first per-contact risk score under RLS.
 *
 * `m39.consent.signed`'s own catalog entry (events-by-m39.ts) currently declares
 * `declaredConsumers: ["m22", "m5"]` — `"m16"` must be added there before this consumer can be bound live
 * at the composition root; this test drives `consumer.handle(...)` directly (the `m16-consent-revoked`
 * precedent) and needs no catalog change to prove the binding itself works.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:consent-signed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M16_OUTBOX_EVENTS,
  buildM16ConsentSignedConsumer,
} from "../src/modules/16-bereavement/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-159 — M16's m39.consent.signed post-death-grant handler — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let consumer: ReturnType<typeof buildM16ConsentSignedConsumer>;

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

    async function seedContact(opts: {
      organizationId: string;
      providerEntityId: string;
      consentRecordId: string | null;
      status: "active" | "proposed";
      patientId?: string;
      admissionId?: string;
    }): Promise<{ planId: string; contactId: string; patientId: string; admissionId: string }> {
      const patientId = opts.patientId ?? crypto.randomUUID();
      const admissionId = opts.admissionId ?? crypto.randomUUID();
      // migration 0100's CHECK constraints for status IN ('active','paused'): `assigned_counselor_user_id`
      // and `opened_at` both required non-null. `assigned_counselor_user_id` is app-validated, no FK.
      const planRow = await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
            assigned_counselor_user_id, opened_at)
         VALUES ($1, $2, $3, $4, 'active', CURRENT_DATE - INTERVAL '10 days', $5, now())
         RETURNING id`,
        [opts.organizationId, patientId, admissionId, opts.providerEntityId, crypto.randomUUID()],
      );
      const planId = planRow.rows[0].id as string;
      const contactRow = await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code,
            consent_record_id)
         VALUES ($1, $2, $3, $4, 'Test Survivor', 'spouse', $5)
         RETURNING id`,
        [opts.organizationId, opts.providerEntityId, planId, opts.status, opts.consentRecordId],
      );
      return { planId, contactId: contactRow.rows[0].id as string, patientId, admissionId };
    }

    async function contactRow(contactId: string) {
      const { rows } = await admin.query(
        `SELECT status, version, confirmed_at, current_risk_tier, current_risk_score_id
         FROM bereaved_contact WHERE id = $1`,
        [contactId],
      );
      return rows[0];
    }

    async function scoreRows(contactId: string) {
      const { rows } = await admin.query(
        `SELECT score_kind, assessed_by_user_id, rule_tier, bereaved_contact_id
         FROM bereavement_risk_score WHERE bereaved_contact_id = $1`,
        [contactId],
      );
      return rows;
    }

    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2`,
        [organizationId, eventType],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m16-consent-signed-a','M16 Consent Signed A','M16 Consent Signed A'),
                ($2,'m16-consent-signed-b','M16 Consent Signed B','M16 Consent Signed B')`,
        [ORG_A, ORG_B],
      );
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16CS-A','Consent Signed Provider A','1100000011','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16CS-B','Consent Signed Provider B','1100000012','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M16_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      consumer = buildM16ConsentSignedConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            const entry = catalog.get(input.eventName);
            if (!entry) throw new Error(`m16 test publisher: undeclared event ${input.eventName}`);
            await (tx as typeof handle.db).execute(sql`
                INSERT INTO outbox_event
                  (organization_id, event_type, aggregate_kind, aggregate_id, payload)
                VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                        ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
              `);
          },
        },
        // sudDisclosureAllowed left unbound (defaults false) — matching production's own conservative
        // default (write-service-drizzle.ts's `sudAllowed = deps.sudDisclosureAllowed ?? (async () => false)`).
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("confirms a proposed contact, publishes contact_active, and appends a system-scored risk row", async () => {
      const consentId = "bbbbbbbb-0000-4000-8000-000000000001";
      const { planId, contactId } = await seedContact({
        organizationId: ORG_A,
        providerEntityId: providerA,
        consentRecordId: consentId,
        status: "proposed",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          patientId: crypto.randomUUID(),
          organizationId: ORG_A,
          consentRecordId: consentId,
          typeKey: "bereavement_outreach_consent",
          signedAt: new Date().toISOString(),
          signedBy: "test-signer",
          captureMethod: "portal",
        },
      });

      const contact = await contactRow(contactId);
      expect(contact.status).toBe("active");
      expect(contact.confirmed_at).not.toBeNull();
      expect(contact.version).toBe(1);
      expect(contact.current_risk_tier).not.toBeNull();
      expect(contact.current_risk_score_id).not.toBeNull();

      const scores = await scoreRows(contactId);
      expect(scores).toHaveLength(1);
      expect(scores[0].score_kind).toBe("rule_deterministic");
      expect(scores[0].assessed_by_user_id).toBeNull(); // system/cron scorer, per schema's own comment

      const confirmEvents = await outboxRows(ORG_A, "m16.bereavement.contact_active");
      expect(confirmEvents).toHaveLength(1);
      expect(confirmEvents[0].payload).toMatchObject({ planId, contactId });

      const scoreEvents = await outboxRows(ORG_A, "m16.bereavement.risk_score_computed");
      expect(scoreEvents).toHaveLength(1);
      expect(scoreEvents[0].payload).toMatchObject({ planId, contactId });
    });

    it("filters out a non-bereavement-outreach consent type", async () => {
      const consentId = "bbbbbbbb-0000-4000-8000-000000000002";
      const { contactId } = await seedContact({
        organizationId: ORG_A,
        providerEntityId: providerA,
        consentRecordId: consentId,
        status: "proposed",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          patientId: crypto.randomUUID(),
          organizationId: ORG_A,
          consentRecordId: consentId,
          typeKey: "sud_treatment_disclosure",
          signedAt: new Date().toISOString(),
          signedBy: "test-signer",
          captureMethod: "portal",
        },
      });

      const contact = await contactRow(contactId);
      expect(contact.status).toBe("proposed"); // untouched — wrong consent type
      expect(contact.version).toBe(0);
    });

    it("is a no-op for a consent id no contact in this org tracks", async () => {
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: {
            patientId: crypto.randomUUID(),
            organizationId: ORG_A,
            consentRecordId: "bbbbbbbb-0000-4000-8000-0000000000ff",
            typeKey: "bereavement_outreach_consent",
            signedAt: new Date().toISOString(),
            signedBy: "test-signer",
            captureMethod: "portal",
          },
        }),
      ).resolves.toBeUndefined();
    });

    it("is a redelivery no-op once the contact is already active (idempotent)", async () => {
      const consentId = "bbbbbbbb-0000-4000-8000-000000000003";
      const { contactId } = await seedContact({
        organizationId: ORG_A,
        providerEntityId: providerA,
        consentRecordId: consentId,
        status: "active", // already confirmed by some other path
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          patientId: crypto.randomUUID(),
          organizationId: ORG_A,
          consentRecordId: consentId,
          typeKey: "bereavement_outreach_consent",
          signedAt: new Date().toISOString(),
          signedBy: "test-signer",
          captureMethod: "portal",
        },
      });

      const contact = await contactRow(contactId);
      expect(contact.version).toBe(0); // untouched — status filter excludes non-`proposed` rows
      expect(await scoreRows(contactId)).toHaveLength(0);
    });

    it("does not cross tenants — org B's identical consent id is invisible to org A's delivery", async () => {
      const sharedConsentId = "bbbbbbbb-0000-4000-8000-000000000004";
      const { contactId: contactB } = await seedContact({
        organizationId: ORG_B,
        providerEntityId: providerB,
        consentRecordId: sharedConsentId,
        status: "proposed",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          patientId: crypto.randomUUID(),
          organizationId: ORG_A,
          consentRecordId: sharedConsentId,
          typeKey: "bereavement_outreach_consent",
          signedAt: new Date().toISOString(),
          signedBy: "test-signer",
          captureMethod: "portal",
        },
      });

      const contact = await contactRow(contactB);
      expect(contact.status).toBe("proposed"); // org A's delivery never touched org B's contact
    });
  },
);
