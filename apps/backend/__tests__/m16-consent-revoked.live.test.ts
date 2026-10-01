/**
 * F-151 (#248) — LIVE Postgres proof that M16's §2.6 / D6 M39 consent-revocation cascade
 * (`buildM16ConsentRevokedConsumer`) actually writes real `bereaved_contact` / `bereavement_opt_out` /
 * `bereavement_outreach` rows under RLS.
 *
 * `decideConsentRevocationCascade` (`lifecycle/cascades.ts`) has been a complete, pure, unit-tested
 * decider since M16-T03 with no live binding anywhere — `m39.consent.revoked` sat in
 * `scripts/outbox-deferred-consumers.ts`'s m16 `handlers-unbound` group. This proves the real binding:
 * the contact resolved by `consent_record_id`, the `optOut` machine transition, the real catalog-
 * validating outbox publish of `m16.bereavement.contact_opted_out`, the `bereavement_opt_out` insert with
 * `recorded_by_user_id = NULL` / `source_kind = 'm39_revocation_cascade'`, future scheduled outreach
 * cancelled, idempotency on redelivery (a contact already `opted_out` is a no-op), and cross-tenant
 * isolation. It also proves the narrow decider/machine mismatch the consumer's own header documents:
 * a `proposed` (not yet confirmed) contact's consent revocation throws `ILLEGAL_TRANSITION` rather than
 * silently guessing a new transition.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m16:consent-revoked:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M16_OUTBOX_EVENTS,
  buildM16ConsentRevokedConsumer,
} from "../src/modules/16-bereavement/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("F-151 — M16's M39 consent-revocation cascade — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let providerB: string;
  let consumer: ReturnType<typeof buildM16ConsentRevokedConsumer>;

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

  /** Seed a bereavement_plan + one bereaved_contact directly (this consumer is not the plan creator). */
  async function seedContact(opts: {
    organizationId: string;
    providerEntityId: string;
    consentRecordId: string;
    status: "active" | "proposed" | "opted_out";
  }): Promise<{ planId: string; contactId: string }> {
    const planRow = await admin.query(
      `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, 'eligible', CURRENT_DATE)
         RETURNING id`,
      [opts.organizationId, opts.providerEntityId],
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
    return { planId, contactId: contactRow.rows[0].id as string };
  }

  async function scheduleOutreach(
    contactId: string,
    planId: string,
    organizationId: string,
    providerEntityId: string,
  ) {
    await admin.query(
      `INSERT INTO bereavement_outreach
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
            death_anchor_at, due_at, late_grace_until)
         VALUES ($1, $2, $3, $4, 'phone_call', 'scheduled',
                 CURRENT_DATE, now() + interval '7 days', now() + interval '14 days')`,
      [organizationId, providerEntityId, planId, contactId],
    );
  }

  async function contactRow(contactId: string) {
    const { rows } = await admin.query(
      `SELECT status, version, opted_out_at FROM bereaved_contact WHERE id = $1`,
      [contactId],
    );
    return rows[0];
  }

  async function optOutRows(contactId: string) {
    const { rows } = await admin.query(
      `SELECT opt_out_kind, source_kind, recorded_by_user_id FROM bereavement_opt_out
         WHERE bereaved_contact_id = $1`,
      [contactId],
    );
    return rows;
  }

  async function outreachStatuses(contactId: string) {
    const { rows } = await admin.query(
      `SELECT status FROM bereavement_outreach WHERE bereaved_contact_id = $1`,
      [contactId],
    );
    return rows.map((r) => r.status as string);
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
         VALUES ($1,'m16-consent-revoked-a','M16 Consent Revoked A','M16 Consent Revoked A'),
                ($2,'m16-consent-revoked-b','M16 Consent Revoked B','M16 Consent Revoked B')`,
      [ORG_A, ORG_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16CR-A','Consent Revoked Provider A','1100000001','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerB = (
      await admin.query(
        `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16CR-B','Consent Revoked Provider B','1100000002','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = new Map<string, unknown>(M16_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
    consumer = buildM16ConsentRevokedConsumer({
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
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("cascades an active contact to opted_out, publishes the event, and cancels future outreach", async () => {
    const consentId = "aaaaaaaa-0000-4000-8000-000000000001";
    const { planId, contactId } = await seedContact({
      organizationId: ORG_A,
      providerEntityId: providerA,
      consentRecordId: consentId,
      status: "active",
    });
    await scheduleOutreach(contactId, planId, ORG_A, providerA);

    await consumer.handle({
      organizationId: ORG_A,
      payload: { consentRecordId: consentId },
    });

    const contact = await contactRow(contactId);
    expect(contact.status).toBe("opted_out");
    expect(contact.opted_out_at).not.toBeNull();
    expect(contact.version).toBe(1);

    const optOuts = await optOutRows(contactId);
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0].opt_out_kind).toBe("full");
    expect(optOuts[0].source_kind).toBe("m39_revocation_cascade");
    expect(optOuts[0].recorded_by_user_id).toBeNull();

    expect(await outreachStatuses(contactId)).toEqual(["cancelled"]);

    const events = await outboxRows(ORG_A, "m16.bereavement.contact_opted_out");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      planId,
      contactId,
      optOutKind: "full",
      source: "m39_revocation_cascade",
    });
  });

  it("is a no-op redelivery once the contact already opted out (idempotent)", async () => {
    const consentId = "aaaaaaaa-0000-4000-8000-000000000002";
    const { contactId } = await seedContact({
      organizationId: ORG_A,
      providerEntityId: providerA,
      consentRecordId: consentId,
      status: "opted_out",
    });

    await consumer.handle({
      organizationId: ORG_A,
      payload: { consentRecordId: consentId },
    });

    expect(await optOutRows(contactId)).toHaveLength(0);
    const contact = await contactRow(contactId);
    expect(contact.version).toBe(0);
  });

  it("is a no-op for a consent id no contact in this org tracks", async () => {
    await expect(
      consumer.handle({
        organizationId: ORG_A,
        payload: { consentRecordId: "aaaaaaaa-0000-4000-8000-0000000000ff" },
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ILLEGAL_TRANSITION for a still-proposed (unconfirmed) contact — the documented decider/machine gap", async () => {
    const consentId = "aaaaaaaa-0000-4000-8000-000000000003";
    await seedContact({
      organizationId: ORG_A,
      providerEntityId: providerA,
      consentRecordId: consentId,
      status: "proposed",
    });

    await expect(
      consumer.handle({
        organizationId: ORG_A,
        payload: { consentRecordId: consentId },
      }),
    ).rejects.toThrow(/ILLEGAL_TRANSITION|cannot optOut from 'proposed'/);
  });

  it("does not cross tenants — org B's identical consent id is invisible to org A's delivery", async () => {
    const sharedConsentId = "aaaaaaaa-0000-4000-8000-000000000004";
    const { contactId: contactB } = await seedContact({
      organizationId: ORG_B,
      providerEntityId: providerB,
      consentRecordId: sharedConsentId,
      status: "active",
    });

    await consumer.handle({
      organizationId: ORG_A,
      payload: { consentRecordId: sharedConsentId },
    });

    const contact = await contactRow(contactB);
    expect(contact.status).toBe("active"); // org A's delivery never touched org B's contact
    expect(await optOutRows(contactB)).toHaveLength(0);
  });
});
