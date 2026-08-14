/**
 * WX-PR-009 — production M39 consent lifecycle against real Postgres.
 *
 * Exercises the Drizzle service (not the in-memory reference implementation), including row-lock
 * serialization, transactional outbox writes, Part 2 recipient gating, immutable signed rows, and
 * single-success renewal under concurrent requests.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m39-consent-lifecycle.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M39_OUTBOX_EVENTS,
  createDbConsentEvaluator,
  createDbConsentRouteService,
} from "../src/modules/39-consent";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** A patient of its own, so the workforce-recipient release is the ONLY governing Part 2 record for
 *  it — two same-version active releases on one patient make `pickGoverning`'s tie arbitrary. */
const PATIENT_WF = "44444444-4444-4444-4444-444444444401";
/** Two staff memberships: one the release names, one it does not. */
const NAMED_MEMBERSHIP = "55555555-5555-5555-5555-555555555551";
const UNNAMED_MEMBERSHIP = "55555555-5555-5555-5555-555555555552";

describe.skipIf(!DB_URL)("M39 consent lifecycle — LIVE Postgres (WX-PR-009)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbConsentRouteService>;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m39-live@x.test')`, [USER]);
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
         ('portal_access','Portal Access','categorical',86400,86400,
          ARRAY['electronic_portal_signature']::text[],ARRAY['1_day']::text[],'portal_access',
          false,false,false,false,false,true,'consent_record','v1'),
         ('42_cfr_part_2_release','Part 2 Release','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'part_2',
          true,false,true,false,true,true,'consent_record','v1')`,
    );
    await admin.query("ALTER ROLE wardenx_app LOGIN PASSWORD 'wardenx-m39-test'");
    const appUrl = new URL(DB_URL as string);
    appUrl.username = "wardenx_app";
    appUrl.password = "wardenx-m39-test";
    handle = createDbClient({
      connectionString: appUrl.toString(),
    });
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

  it("serializes concurrent signing and keeps the signed row immutable", async () => {
    const draft = await service.createDraft(ORG, {
      patientId: PATIENT,
      typeKey: "portal_access",
      grantorKind: "patient_self",
      captureMethod: "electronic_portal_signature",
      scopeDescriptor: { portal: true },
      createdById: USER,
    });
    const now = new Date().toISOString();
    const results = await Promise.allSettled([
      service.signConsent(ORG, draft.id, USER, now, { portalSessionId: "portal-session-1" }),
      service.signConsent(ORG, draft.id, USER, now, { portalSessionId: "portal-session-2" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      service.updateDraft(ORG, draft.id, { scopeDescriptor: { altered: true } }, now),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const persisted = await admin.query(
      "SELECT status, capture_evidence_jsonb FROM consent_record WHERE id=$1",
      [draft.id],
    );
    expect(persisted.rows[0].status).toBe("active");
    expect(persisted.rows[0].capture_evidence_jsonb.portalSessionId).toMatch(/^portal-session-/);
    const events = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
      [draft.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "m39.consent.created",
      "m39.consent.signed",
    ]);
  });

  it("refuses Part 2 activation until a named recipient exists", async () => {
    const draft = await service.createDraft(ORG, {
      patientId: PATIENT,
      typeKey: "42_cfr_part_2_release",
      grantorKind: "patient_self",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: { categories: ["SUD"] },
      createdById: USER,
    });
    const now = new Date().toISOString();
    await expect(
      service.signConsent(ORG, draft.id, USER, now, { typedSignatureName: "Patient One" }),
    ).rejects.toMatchObject({ code: "validation" });
    await service.addRecipient(
      ORG,
      draft.id,
      {
        recipientKind: "free_text",
        recipientEntityId: null,
        recipientFreeText: "Named treatment provider",
        recipientDisplayName: "Named treatment provider",
        addedById: USER,
      },
      now,
    );
    await expect(
      service.signConsent(ORG, draft.id, USER, now, { typedSignatureName: "Patient One" }),
    ).resolves.toMatchObject({ status: "active" });
  });

  // mig 0209 — `workforce_member`, the one INTERNAL recipient class, and the per-actor Part 2 verdict
  // it makes answerable. Worth proving LIVE rather than only over the in-memory store: the value has
  // to survive the enum, the `crr_freetext_or_entity` CHECK (which demands an entity id for every
  // non-free_text kind), the route service's recipient write, and the Drizzle store's kind mapping —
  // and if RESOLVED_KINDS drops it back to `undefined`, the release silently reverts to program-wide.
  it("a Part 2 release naming workforce members restricts it to them (per-actor, end to end)", async () => {
    const draft = await service.createDraft(ORG, {
      patientId: PATIENT_WF,
      typeKey: "42_cfr_part_2_release",
      grantorKind: "patient_self",
      captureMethod: "typed_signature_in_app",
      scopeDescriptor: { categories: ["SUD"] },
      createdById: USER,
    });
    const now = new Date().toISOString();
    const evaluator = createDbConsentEvaluator(handle.db);
    const ask = (membershipId: string | null) =>
      evaluator.evaluateForInternalAccess({
        organizationId: ORG,
        patientId: PATIENT_WF,
        actor: { membershipId },
        callerModule: "m7",
      });

    // Before signing there is no governing release at all.
    expect(await ask(NAMED_MEMBERSHIP)).toMatchObject({
      redactSubstanceUseDisorderFields: true,
      basis: "no_active_release",
    });

    await service.addRecipient(
      ORG,
      draft.id,
      {
        recipientKind: "workforce_member",
        recipientEntityId: NAMED_MEMBERSHIP,
        recipientFreeText: null,
        recipientDisplayName: "Ana Ruiz, RN",
        addedById: USER,
      },
      now,
    );
    await service.signConsent(ORG, draft.id, USER, now, { typedSignatureName: "Patient One" });

    // The named member is cleared; nobody else is, whoever they are.
    expect(await ask(NAMED_MEMBERSHIP)).toMatchObject({
      redactSubstanceUseDisorderFields: false,
      basis: "release_names_actor",
      consentRecordId: draft.id,
    });
    expect(await ask(UNNAMED_MEMBERSHIP)).toMatchObject({
      redactSubstanceUseDisorderFields: true,
      basis: "release_names_others",
    });
    expect(await ask(null)).toMatchObject({
      redactSubstanceUseDisorderFields: true,
      basis: "actor_unidentified",
    });

    // The patient-scope primitive is UNCHANGED by the restriction — a release exists, so ingress
    // persistence still un-redacts. The two questions stay separate.
    expect(
      await evaluator.evaluateForIngressRedaction({
        organizationId: ORG,
        patientId: PATIENT_WF,
        callerModule: "m29",
      }),
    ).toMatchObject({ redactSubstanceUseDisorderFields: false });

    // Removing the named recipient lifts the restriction rather than sealing the record forever.
    await admin.query(
      "UPDATE consent_record_recipient SET removed_at = now() WHERE consent_record_id = $1",
      [draft.id],
    );
    expect(await ask(UNNAMED_MEMBERSHIP)).toMatchObject({
      redactSubstanceUseDisorderFields: false,
      basis: "release_covers_program",
    });
  });

  it("allows exactly one concurrent renewal of a terminal consent", async () => {
    const draft = await service.createDraft(ORG, {
      patientId: PATIENT,
      typeKey: "portal_access",
      grantorKind: "patient_self",
      captureMethod: "electronic_portal_signature",
      scopeDescriptor: { portal: true },
      createdById: USER,
    });
    const now = new Date().toISOString();
    await service.signConsent(ORG, draft.id, USER, now, { portalSessionId: "portal-renew-old" });
    await admin.query("UPDATE consent_record SET status='expired' WHERE id=$1", [draft.id]);

    const renew = () =>
      service.renewConsent(
        ORG,
        draft.id,
        {
          scopeDescriptor: { portal: true },
          captureMethod: "electronic_portal_signature",
          grantorKind: "patient_self",
          createdById: USER,
          captureEvidence: { portalSessionId: "portal-renew-new" },
        },
        new Date().toISOString(),
      );
    const results = await Promise.allSettled([renew(), renew()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const count = await admin.query(
      "SELECT count(*)::int AS n FROM consent_record WHERE renewed_from_consent_record_id=$1",
      [draft.id],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
