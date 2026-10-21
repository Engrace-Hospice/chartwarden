/**
 * GAP-130 — LIVE Postgres proof that M16's §4.5 `m8.encounter.signed` binding
 * (`buildM16EncounterSignedConsumer`) completes an in-person bereavement outreach off a signed
 * `bereavement_contact` encounter (D15 / §7.5): one `in_person_visit` contact-log row carrying
 * `source_encounter_id`, the outreach `completed`, and `m16.bereavement.outreach_completed` published
 * through the REAL catalog-validating publisher (`buildTxOutboxPublisher` over the boot catalog, callerModule
 * `m16`) — all as the NOBYPASSRLS `wardenx_app` role, so the cross-tenant case is a real RLS assertion.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:encounter-signed:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M16_OUTBOX_EVENTS,
  buildM16EncounterSignedConsumer,
} from "../src/modules/16-bereavement/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111130";
const ORG_B = "22222222-2222-2222-2222-222222222130";

describe.skipIf(!DB_URL)("GAP-130 — M16 m8.encounter.signed in-person completion — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let consumer: ReturnType<typeof buildM16EncounterSignedConsumer>;

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

  /** An active plan with one active survivor; returns the decedent identity the encounter names. */
  async function seedPlan(status: "active" | "closed_completed" = "active") {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const plan = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5::bereavement_plan_status, CURRENT_DATE - INTERVAL '10 days', $6, now(),
               CASE WHEN $5::text = 'active' THEN NULL ELSE now() END)
       RETURNING id`,
      [ORG_A, patientId, admissionId, providerA, status, randomUUID()],
    );
    const planId = plan.rows[0].id as string;
    const contact = await admin.query(
      `INSERT INTO bereaved_contact
         (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
       VALUES ($1,$2,$3,'Jane Roe','spouse','active') RETURNING id`,
      [ORG_A, providerA, planId],
    );
    return { planId, contactId: contact.rows[0].id as string, patientId, admissionId };
  }

  async function seedOutreach(
    planId: string,
    contactId: string,
    opts: { kind?: string; status?: string; dueInDays: number },
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_outreach
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
          death_anchor_at, due_at, late_grace_until, started_at)
       VALUES ($1,$2,$3,$4,$5::bereavement_outreach_kind,$6::bereavement_outreach_status,
               now() - interval '10 days',
               now() + ($7::text || ' days')::interval,
               now() + ($7::text || ' days')::interval + interval '7 days',
               CASE WHEN $6::text = 'in_progress' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        ORG_A,
        providerA,
        planId,
        contactId,
        opts.kind ?? "in_person_visit",
        opts.status ?? "scheduled",
        String(opts.dueInDays),
      ],
    );
    return rows[0].id as string;
  }

  const signed = (
    organizationId: string,
    ids: { patientId: string; admissionId: string },
    over: Record<string, unknown> = {},
  ) => ({
    organizationId,
    payload: {
      encounterId: randomUUID(),
      patientId: ids.patientId,
      admissionId: ids.admissionId,
      encounterType: "bereavement_contact",
      discipline: "bereavement",
      signedByMembershipId: randomUUID(),
      signedAt: new Date().toISOString(),
      ...over,
    },
  });

  async function outreachRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, started_at, completed_at FROM bereavement_outreach WHERE id = $1",
      [id],
    );
    return rows[0];
  }
  async function logRows(outreachId: string) {
    const { rows } = await admin.query(
      `SELECT kind, outcome, source_encounter_id, logged_by_user_id, contact_responded_directly
         FROM bereavement_contact_log WHERE outreach_id = $1`,
      [outreachId],
    );
    return rows;
  }
  async function completedEvents(outreachId: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, aggregate_kind, payload FROM outbox_event
        WHERE event_type = 'm16.bereavement.outreach_completed' AND payload->>'outreachId' = $1`,
      [outreachId],
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
       VALUES ($1,'gap130-enc-a','GAP130 Enc A','GAP130 Enc A'),
              ($2,'gap130-enc-b','GAP130 Enc B','GAP130 Enc B')`,
      [ORG_A, ORG_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'G130E-A','GAP130 Provider A','1300000011','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // THE REAL PUBLISHER: the boot catalog's payload validation + namespace check, the composition root's
    // `bindCallerModule(txOutboxPublisher, "m16")` reproduced (it is private to index.ts).
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M16_OUTBOX_EVENTS]));
    consumer = buildM16EncounterSignedConsumer({
      db: handle.db,
      outbox: {
        publish: (tx, emission) =>
          publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
            ...(emission as Parameters<typeof publisher.publish>[1]),
            callerModule: "m16",
          }),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("completes the due in-person visit: one encounter-backed log row + a validated outreach_completed", async () => {
    const ids = await seedPlan();
    const outreachId = await seedOutreach(ids.planId, ids.contactId, { dueInDays: 1 });
    const delivery = signed(ORG_A, ids);

    await consumer.handle(delivery);

    const row = await outreachRow(outreachId);
    expect(row.status).toBe("completed");
    expect(row.started_at).not.toBeNull(); // opened by the signature itself (startContact)
    expect(row.completed_at).not.toBeNull();

    const logs = await logRows(outreachId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: "in_person_visit",
      outcome: "engaged",
      source_encounter_id: delivery.payload.encounterId,
      logged_by_user_id: delivery.payload.signedByMembershipId,
      contact_responded_directly: true,
    });

    const events = await completedEvents(outreachId);
    expect(events).toHaveLength(1);
    expect(events[0].organization_id).toBe(ORG_A);
    expect(events[0].payload).toMatchObject({
      planId: ids.planId,
      contactId: ids.contactId,
      outreachId,
      outcome: "engaged",
      sourceEncounterId: delivery.payload.encounterId,
    });

    // A redelivery of the SAME event finds the encounter already fulfilling a touchpoint: nothing new.
    await consumer.handle(delivery);
    expect(await logRows(outreachId)).toHaveLength(1);
    expect(await completedEvents(outreachId)).toHaveLength(1);
  });

  it("prefers the visit the counselor already started over a nearer scheduled one", async () => {
    const ids = await seedPlan();
    const started = await seedOutreach(ids.planId, ids.contactId, {
      status: "in_progress",
      dueInDays: 60,
    });
    const nearer = await seedOutreach(ids.planId, ids.contactId, { dueInDays: 0 });

    await consumer.handle(signed(ORG_A, ids));

    expect((await outreachRow(started)).status).toBe("completed");
    expect((await outreachRow(nearer)).status).toBe("scheduled");
  });

  it("writes nothing for a non-bereavement encounter, an ad-hoc visit, or a closed plan", async () => {
    const ids = await seedPlan();
    const visit = await seedOutreach(ids.planId, ids.contactId, { dueInDays: 1 });
    await consumer.handle(signed(ORG_A, ids, { encounterType: "routine_visit" }));
    expect((await outreachRow(visit)).status).toBe("scheduled");

    // Only a phone-call touchpoint is open: the signed visit is ad-hoc, route 26's business.
    const adHoc = await seedPlan();
    const call = await seedOutreach(adHoc.planId, adHoc.contactId, {
      kind: "phone_call",
      dueInDays: 1,
    });
    await consumer.handle(signed(ORG_A, adHoc));
    expect((await outreachRow(call)).status).toBe("scheduled");
    expect(await logRows(call)).toHaveLength(0);

    const closed = await seedPlan("closed_completed");
    const closedVisit = await seedOutreach(closed.planId, closed.contactId, { dueInDays: 1 });
    await consumer.handle(signed(ORG_A, closed));
    expect((await outreachRow(closedVisit)).status).toBe("scheduled");
  });

  it("RLS — an org-B delivery naming org A's decedent cannot see, let alone complete, org A's visit", async () => {
    const ids = await seedPlan();
    const visit = await seedOutreach(ids.planId, ids.contactId, { dueInDays: 1 });

    await consumer.handle(signed(ORG_B, ids));

    expect((await outreachRow(visit)).status).toBe("scheduled");
    expect(await logRows(visit)).toHaveLength(0);
    expect(await completedEvents(visit)).toHaveLength(0);
  });
});
