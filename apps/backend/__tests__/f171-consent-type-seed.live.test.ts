/**
 * F-171 (#248) — LIVE Postgres proof that `scripts/db/seed-consent-types.ts`'s two new
 * `consent_type_catalog` rows (`portal_access`, `bereavement_outreach_consent`) are what was standing
 * between the real M39 consent lifecycle and their already-built, already-bound §2.4/D7 revocation
 * cascades (M2 `buildM2ConsentRevokedConsumer` F-142, M16 `buildM16ConsentRevokedConsumer` F-151, M31
 * `buildM31ConsentRevokedGrantCascadeConsumer`).
 *
 * `consent_record.type_key` carries a real FK to `consent_type_catalog.type_key` — before this seed
 * change, drafting a `portal_access` or `bereavement_outreach_consent` consent record through the real
 * M39 write service (`createDbConsentRouteService`) failed the FK, not a validation error, so the D14
 * post-mortem bereavement-consent flow and every portal_access consent draft were unreachable in every
 * deployment. This drives the REAL production chain end to end: seed catalog (the exact `TYPES` array
 * this pass shipped) → `createDraft`/`createBereavementOutreachDraft` → `signConsent` → `revokeConsent`
 * (real catalog-validating outbox publish, `cascadeKind` resolved from the catalog row at revoke time,
 * per `consent-store-db.ts`'s `revokeConsent`) → the real M2/M16/M31 consumers invoked with the ACTUAL
 * delivered payload (read back from `outbox_event`, not a hand-rolled fixture) → real downstream writes
 * under RLS.
 *
 * Deliberately does NOT attempt `media_release` — this pass found (and left BLOCKED, reported in
 * `scripts/outbox-deferred-consumers.ts`'s m22 group) that M22's own cascade consumer does not exist and
 * cannot be built without guessing which `document` rows are "media" (no schema concept distinguishes a
 * media-release photo from a wound-care photo). Seeding a type whose cascade doesn't exist would be the
 * "looks fixed, isn't" mistake this pass was told to avoid.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f171:consent-type-seed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TYPES as SEEDED_CONSENT_TYPES } from "../../../scripts/db/seed-consent-types";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM2ConsentRevokedConsumer } from "../src/modules/02-identity/index";
import { buildM16ConsentRevokedConsumer } from "../src/modules/16-bereavement/index";
import { buildM31ConsentRevokedGrantCascadeConsumer } from "../src/modules/31-portal/outbox-consumers/m39-consent-revoked";
import { M39_OUTBOX_EVENTS, createDbConsentRouteService } from "../src/modules/39-consent";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT_LIVING = "44444444-4444-4444-4444-444444444401";
const PATIENT_DECEASED = "44444444-4444-4444-4444-444444444402";

describe.skipIf(!DB_URL)(
  "F-171 — consent-type seed unblocks portal_access/bereavement_outreach_consent — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let service: ReturnType<typeof createDbConsentRouteService>;
    let providerEntityId: string;

    async function resetSchema(): Promise<void> {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; END IF; END $$;`,
        );
      }
    }

    async function applyMigrations(): Promise<void> {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    /** Inserts the EXACT shipped `TYPES` array — proves the file this pass edited, not a copy of it. */
    async function seedConsentTypesFromShippedFile(): Promise<void> {
      for (const c of SEEDED_CONSENT_TYPES) {
        await admin.query(
          `INSERT INTO consent_type_catalog (
           type_key, display_name_en, scope_discriminator, default_expiration_seconds,
           max_term_seconds, capture_method_floor, reminder_cadence_floor, revocation_cascade_kind,
           is_per_recipient, is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code,
           cfr_42_part_2_compliant, hipaa_164_508_compliant, body_text_template_key, m22_template_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (type_key) DO NOTHING`,
          [
            c.typeKey,
            c.displayNameEn,
            c.scopeDiscriminator,
            c.defaultExpirationSeconds,
            c.maxTermSeconds,
            c.captureMethodFloor,
            c.reminderCadenceFloor,
            c.revocationCascadeKind,
            c.isPerRecipient,
            c.isPerNamedAgent,
            c.isPostMortemEligible,
            c.requiresJurisdictionCode,
            c.cfr42Part2Compliant,
            c.hipaa164508Compliant,
            c.bodyTextTemplateKey,
            c.m22TemplateVersion,
          ],
        );
      }
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'f173-org','F173 Org','F173 Org')",
        [ORG],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f173-live@x.test')`, [USER]);
      providerEntityId = (
        await admin.query(
          `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'F173PE','F173 Provider','1100009901','enc','12-31') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO patient
         (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth,
          status, deceased_date)
       VALUES
         ($1, $2, 'F173-MRN-1', 'Living', 'Patient', '1950-01-01', 'female', 'active', NULL),
         ($3, $2, 'F173-MRN-2', 'Deceased', 'Patient', '1940-01-01', 'male', 'deceased', CURRENT_DATE)`,
        [PATIENT_LIVING, ORG, PATIENT_DECEASED],
      );
      await seedConsentTypesFromShippedFile();

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M39_OUTBOX_EVENTS]));
      service = createDbConsentRouteService(handle.db, {
        outbox: {
          publish: (tx, input) =>
            publisher.publish(tx as DbClient, { ...input, callerModule: "m39" }),
        },
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("seeds all 5 canonical types shipped in scripts/db/seed-consent-types.ts", async () => {
      const rows = await admin.query("SELECT type_key FROM consent_type_catalog ORDER BY type_key");
      const keys = rows.rows.map((r) => r.type_key as string);
      expect(keys).toEqual(
        expect.arrayContaining([
          "portal_access",
          "bereavement_outreach_consent",
          "hipaa_release",
          "42_cfr_part_2_release",
          "dpoa_healthcare",
        ]),
      );
      expect(keys).not.toContain("media_release");
    });

    it("drafts, signs, and revokes a real portal_access consent — real M2 session-delete + M31 grant-revoke cascades fire", async () => {
      // A real patient_portal session and a real portal_access_grant, both genuinely backed by the
      // consent record we are about to sign — not synthetic fixtures for the consumer alone.
      const portalUserRow = await admin.query(
        `INSERT INTO "user" (email) VALUES ('f173-portal-user@x.test') RETURNING id`,
      );
      const portalUserId = portalUserRow.rows[0].id as string;
      const accountRow = await admin.query(
        `INSERT INTO portal_account
         (organization_id, user_id, relationship, display_name_cipher, email_cipher)
       VALUES ($1, $2, 'patient_self', 'cipher-name', 'cipher-email') RETURNING id`,
        [ORG, portalUserId],
      );
      const portalAccountId = accountRow.rows[0].id as string;

      const draft = await service.createDraft(ORG, {
        patientId: PATIENT_LIVING,
        typeKey: "portal_access",
        grantorKind: "patient_self",
        captureMethod: "electronic_portal_signature",
        scopeDescriptor: { portal: true },
        createdById: USER,
      });
      const nowIso = new Date().toISOString();
      await service.signConsent(ORG, draft.id, USER, nowIso, {
        portalSessionId: "portal-session-1",
      });

      // Real session + real grant, both genuinely sourced from this consent record.
      const sessionRow = await admin.query(
        `INSERT INTO session
         (id, user_id, active_organization_id, token, expires_at, session_class, scope)
       VALUES (gen_random_uuid(), $1, $2, 'f173-session-token', now() + interval '1 day',
               'patient_portal', $3::jsonb)
       RETURNING id`,
        [portalUserId, ORG, JSON.stringify({ portalAccountId, patientId: PATIENT_LIVING })],
      );
      const sessionId = sessionRow.rows[0].id as string;
      const grantRow = await admin.query(
        `INSERT INTO portal_access_grant
         (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind,
          scope_set_jsonb, source_consent_record_id, source_consent_version)
       VALUES ($1, $2, $3, $4, 'patient_self', '{}'::jsonb, $5, '1')
       RETURNING id`,
        [ORG, providerEntityId, portalAccountId, PATIENT_LIVING, draft.id],
      );
      const grantId = grantRow.rows[0].id as string;

      const before = await admin.query(
        "SELECT type_key, revocation_cascade_kind FROM consent_type_catalog WHERE type_key='portal_access'",
      );
      expect(before.rows[0].revocation_cascade_kind).toBe("portal_access_revocation");

      await service.revokeConsent(
        ORG,
        draft.id,
        {
          actorIsStaff: false,
          revokedByKind: "patient_self_via_portal",
          revokedById: USER,
          reasonText: "",
          evidenceDocumentId: null,
        },
        new Date().toISOString(),
      );

      // Read back the ACTUAL delivered outbox payload rather than hand-rolling one.
      const eventRow = await admin.query(
        `SELECT payload FROM outbox_event
       WHERE organization_id=$1 AND event_type='m39.consent.revoked'
       ORDER BY created_at DESC LIMIT 1`,
        [ORG],
      );
      const payload = eventRow.rows[0].payload as Record<string, unknown>;
      expect(payload.typeKey).toBe("portal_access");
      expect(payload.cascadeKind).toBe("portal_access_revocation");
      expect(payload.patientId).toBe(PATIENT_LIVING);

      const m2Consumer = buildM2ConsentRevokedConsumer({ db: handle.db });
      await m2Consumer.handle({ organizationId: ORG, payload });
      const m31Consumer = buildM31ConsentRevokedGrantCascadeConsumer({ db: handle.db });
      await m31Consumer.handle({ organizationId: ORG, payload });

      const sessionAfter = await admin.query("SELECT id FROM session WHERE id=$1", [sessionId]);
      expect(sessionAfter.rowCount).toBe(0); // M2's real DELETE fired

      const grantAfter = await admin.query(
        "SELECT revoked_at, revoke_cascade_source FROM portal_access_grant WHERE id=$1",
        [grantId],
      );
      expect(grantAfter.rows[0].revoked_at).not.toBeNull();
      expect(grantAfter.rows[0].revoke_cascade_source).toBe("consent_revoked");
    });

    it("drafts, signs, and revokes a real bereavement_outreach_consent — real M16 opt-out cascade fires against a real bereaved_contact", async () => {
      const planRow = await admin.query(
        `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date)
       VALUES ($1, $2, gen_random_uuid(), $3, 'eligible', CURRENT_DATE)
       RETURNING id`,
        [ORG, PATIENT_DECEASED, providerEntityId],
      );
      const planId = planRow.rows[0].id as string;

      // The FK this pass's seed unblocks: before it, this call 500s on `consent_record.type_key` — the
      // type simply did not exist in the catalog in any deployment.
      const draft = await service.createBereavementOutreachDraft(ORG, {
        patientId: PATIENT_DECEASED,
        grantorKind: "bereaved_person_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: {},
        createdById: USER,
      });
      expect(draft.typeKey).toBe("bereavement_outreach_consent");

      const contactRow = await admin.query(
        `INSERT INTO bereaved_contact
         (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code,
          consent_record_id)
       VALUES ($1, $2, $3, 'active', 'F173 Survivor', 'spouse', $4)
       RETURNING id`,
        [ORG, providerEntityId, planId, draft.id],
      );
      const contactId = contactRow.rows[0].id as string;

      const nowIso = new Date().toISOString();
      await service.signConsent(ORG, draft.id, USER, nowIso, {
        typedSignatureName: "F173 Bereaved Survivor",
      });

      await service.revokeConsent(
        ORG,
        draft.id,
        {
          actorIsStaff: true,
          revokedByKind: "staff",
          revokedById: USER,
          reasonText:
            "F173 live-test revocation — bereaved contact requested no further outreach contact.",
          // Logical FK only (no SQL FK — `packages/db/src/schema/consent/consent-revocation.ts`), a
          // placeholder is fine for this fixture; only its non-nullness is validated at revoke time.
          evidenceDocumentId: "00000000-0000-4000-8000-000000000f73",
        },
        new Date().toISOString(),
      );

      const eventRow = await admin.query(
        `SELECT payload FROM outbox_event
       WHERE organization_id=$1 AND event_type='m39.consent.revoked'
       ORDER BY created_at DESC LIMIT 1`,
        [ORG],
      );
      const payload = eventRow.rows[0].payload as Record<string, unknown>;
      expect(payload.typeKey).toBe("bereavement_outreach_consent");
      expect(payload.cascadeKind).toBe("bereavement_outreach_consent");
      expect(payload.consentRecordId).toBe(draft.id);

      const m16Consumer = buildM16ConsentRevokedConsumer({
        db: handle.db,
        outbox: { publish: async () => {} },
      });
      await m16Consumer.handle({ organizationId: ORG, payload });

      const contactAfter = await admin.query("SELECT status FROM bereaved_contact WHERE id=$1", [
        contactId,
      ]);
      expect(contactAfter.rows[0].status).toBe("opted_out");

      const optOutAfter = await admin.query(
        "SELECT source_kind FROM bereavement_opt_out WHERE bereaved_contact_id=$1",
        [contactId],
      );
      expect(optOutAfter.rowCount).toBe(1);
      expect(optOutAfter.rows[0].source_kind).toBe("m39_revocation_cascade");
    });
  },
);
