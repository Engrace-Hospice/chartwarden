/**
 * GAP-130 — LIVE Postgres proof of the M16 ↔ M22 outreach-artifact handshake (D14 / §4.5 / §7.6), both
 * halves, as the NOBYPASSRLS `chartwarden_app` role through the REAL catalog-validating publisher:
 *
 *   1. UPSTREAM — the real `buildDrizzleM16WriteService.startOutreach` on a `sympathy_card` touchpoint emits
 *      `m16.bereavement.outreach_artifact_requested` naming the OUTREACH (validated against the boot catalog
 *      on the mutation's own tx) and stamps `m22_render_requested_at`;
 *   2. M22 — that exact outbox row is drained by the real `buildM22DocumentRequestConsumer` (in-memory
 *      document store; the render decision, template table and announcement are M22's real code), which
 *      files the document against the outreach id and announces `m22.document.rendered`;
 *   3. DOWNSTREAM — the announced payload, checked against M22's own catalog schema, is delivered to the
 *      new `buildM16DocumentRenderedConsumer`, which stamps `rendered_document_id` / `m22_rendered_at` and
 *      (a card is one of §4.5's three auto-complete kinds) completes the outreach with an
 *      `artifact_rendered` contact-log row (mig 0492) and a validated `outreach_completed`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:document-rendered:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M16_OUTBOX_EVENTS,
  buildM16DocumentRenderedConsumer,
} from "../src/modules/16-bereavement/index";
import {
  type M16ReadService,
  type M16WriteActor,
  buildDrizzleM16WriteService,
} from "../src/modules/16-bereavement/routes/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111131";
const ORG_B = "22222222-2222-2222-2222-222222222131";

const RENDERED_SCHEMA = M22_OUTBOX_EVENTS.find(
  (e) => e.eventName === M22_DOCUMENT_RENDERED_EVENT,
)?.payloadSchema;

describe.skipIf(!DB_URL)("GAP-130 — M16 ↔ M22 outreach artifact back-ref — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let counselor: string;
  let svc: ReturnType<typeof buildDrizzleM16WriteService>;
  let consumer: ReturnType<typeof buildM16DocumentRenderedConsumer>;

  const actor = (): M16WriteActor => ({
    organizationId: ORG_A,
    userId: counselor,
    membershipId: counselor,
    roles: [],
    sessionClass: "staff",
    locationIds: [],
    portalAccountId: null,
    stepUpRecent: true,
  });

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

  async function seedOutreach(kind: string, status = "scheduled") {
    const patientId = randomUUID();
    const plan = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at)
       VALUES ($1,$2,$3,$4,'active', CURRENT_DATE - INTERVAL '10 days', $5, now()) RETURNING id`,
      [ORG_A, patientId, randomUUID(), providerA, counselor],
    );
    const planId = plan.rows[0].id as string;
    const contactId = (
      await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
         VALUES ($1,$2,$3,'Jane Roe','spouse','active') RETURNING id`,
        [ORG_A, providerA, planId],
      )
    ).rows[0].id as string;
    const outreachId = (
      await admin.query(
        `INSERT INTO bereavement_outreach
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
            death_anchor_at, due_at, late_grace_until, started_at)
         VALUES ($1,$2,$3,$4,$5::bereavement_outreach_kind,$6::bereavement_outreach_status,
                 now() - interval '10 days', now() + interval '1 day',
                 now() + interval '8 days', CASE WHEN $6::text = 'in_progress' THEN now() ELSE NULL END)
         RETURNING id`,
        [ORG_A, providerA, planId, contactId, kind, status],
      )
    ).rows[0].id as string;
    return { planId, contactId, outreachId, patientId };
  }

  async function outreachRow(id: string) {
    const { rows } = await admin.query(
      `SELECT status, rendered_document_id, m22_render_requested_at, m22_rendered_at, completed_at
         FROM bereavement_outreach WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function logRows(outreachId: string) {
    const { rows } = await admin.query(
      `SELECT kind, outcome, artifact_document_id, logged_by_user_id, source_encounter_id
         FROM bereavement_contact_log WHERE outreach_id = $1`,
      [outreachId],
    );
    return rows;
  }
  async function outbox(eventType: string, outreachId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, event_type, aggregate_kind, aggregate_id, payload, attempt_count, created_at
         FROM outbox_event WHERE event_type = $1 AND payload->>'outreachId' = $2`,
      [eventType, outreachId],
    );
    return rows;
  }

  /** Drain one `outreach_artifact_requested` row through M22's real render consumer; return what it announced. */
  async function renderThroughM22(row: Record<string, unknown>) {
    const { store } = createInMemoryDocumentSeamStore();
    const objects = createInMemoryObjectStore();
    const announced: Record<string, unknown>[] = [];
    const m22 = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
      emitRendered: async (e) => {
        announced.push(e as unknown as Record<string, unknown>);
      },
    });
    await m22.handle({
      id: row.id as string,
      organizationId: row.organization_id as string,
      eventType: row.event_type as string,
      aggregateKind: row.aggregate_kind as string,
      aggregateId: row.aggregate_id as string,
      payload: row.payload,
      attemptCount: 0,
      createdAt: new Date(row.created_at as string),
    });
    return announced;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'gap130-doc-a','GAP130 Doc A','GAP130 Doc A'),
              ($2,'gap130-doc-b','GAP130 Doc B','GAP130 Doc B')`,
      [ORG_A, ORG_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'G130D-A','GAP130 Doc Provider A','1300000021','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    // A REAL user + membership: the M4 write-audit trigger FKs `app.user_id` to `"user"`.
    counselor = (
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES (gen_random_uuid(), 'counselor@gap130.test') RETURNING id`,
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [counselor, ORG_A],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M16_OUTBOX_EVENTS]));
    const outboxM16 = {
      publish: (tx: unknown, emission: unknown) =>
        publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
          ...(emission as Parameters<typeof publisher.publish>[1]),
          callerModule: "m16",
        }),
    };
    const readStub = { getPlan: async () => ({}) } as unknown as M16ReadService;
    svc = buildDrizzleM16WriteService(handle.db, readStub, { outbox: outboxM16 });
    consumer = buildM16DocumentRenderedConsumer({ db: handle.db, outbox: outboxM16 });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("start → M22 render → back-ref stamped and the card completed, end to end", async () => {
    const { planId, contactId, outreachId, patientId } = await seedOutreach("sympathy_card");

    // 1. UPSTREAM — the counselor starts the card touchpoint.
    await svc.startOutreach(actor(), outreachId);
    const started = await outreachRow(outreachId);
    expect(started.status).toBe("in_progress");
    expect(started.m22_render_requested_at).not.toBeNull();
    const requests = await outbox("m16.bereavement.outreach_artifact_requested", outreachId);
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toMatchObject({
      planId,
      patientId,
      contactId,
      outreachId,
      templateKey: "bereavement_letter",
    });

    // 2. M22 — its real consumer files the document against the OUTREACH and announces it.
    const announced = await renderThroughM22(requests[0]);
    expect(announced).toHaveLength(1);
    const rendered = announced[0] as Record<string, unknown>;
    expect(rendered).toMatchObject({
      aggregateType: "bereavement_letter",
      aggregateId: outreachId,
      sourceModule: "m16",
      sourceEvent: "m16.bereavement.outreach_artifact_requested",
    });
    const { organizationId: _org, ...wire } = rendered;
    expect(RENDERED_SCHEMA && Value.Check(RENDERED_SCHEMA, wire)).toBe(true);

    // 3. DOWNSTREAM — M16 stamps and completes.
    await consumer.handle({ organizationId: ORG_A, payload: wire });
    const done = await outreachRow(outreachId);
    expect(done.rendered_document_id).toBe(rendered.documentId);
    expect(done.m22_rendered_at).not.toBeNull();
    expect(done.status).toBe("completed");
    expect(done.completed_at).not.toBeNull();
    const logs = await logRows(outreachId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: "sympathy_card",
      outcome: "artifact_rendered",
      artifact_document_id: rendered.documentId,
      logged_by_user_id: counselor,
      source_encounter_id: null,
    });
    const completed = await outbox("m16.bereavement.outreach_completed", outreachId);
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({ outreachId, outcome: "artifact_rendered" });

    // Redelivery: the back-ref is already set — nothing further is written.
    await consumer.handle({ organizationId: ORG_A, payload: wire });
    expect(await logRows(outreachId)).toHaveLength(1);
    expect(await outbox("m16.bereavement.outreach_completed", outreachId)).toHaveLength(1);
  });

  it("stamps an invitation but leaves it open for the family's response", async () => {
    const { outreachId } = await seedOutreach("group_support_invitation", "in_progress");
    const documentId = randomUUID();
    await consumer.handle({
      organizationId: ORG_A,
      payload: {
        documentId,
        documentVersionId: randomUUID(),
        versionNumber: 1,
        isFirstVersion: true,
        templateKey: "bereavement_letter",
        aggregateType: "bereavement_letter",
        aggregateId: outreachId,
        retentionClass: "bereavement",
        patientId: null,
        sourceEvent: "m16.bereavement.outreach_artifact_requested",
        sourceModule: "m16",
        renderedAt: new Date().toISOString(),
      },
    });
    const row = await outreachRow(outreachId);
    expect(row.rendered_document_id).toBe(documentId);
    expect(row.status).toBe("in_progress");
    expect(await logRows(outreachId)).toHaveLength(0);
  });

  it("starting a phone call requests no render at all", async () => {
    const { outreachId } = await seedOutreach("phone_call");
    await svc.startOutreach(actor(), outreachId);
    expect((await outreachRow(outreachId)).m22_render_requested_at).toBeNull();
    expect(await outbox("m16.bereavement.outreach_artifact_requested", outreachId)).toHaveLength(0);
  });

  it("RLS — an org-B delivery naming org A's outreach stamps nothing", async () => {
    const { outreachId } = await seedOutreach("sympathy_letter", "in_progress");
    await consumer.handle({
      organizationId: ORG_B,
      payload: {
        documentId: randomUUID(),
        aggregateType: "bereavement_letter",
        aggregateId: outreachId,
        templateKey: "bereavement_letter",
        sourceEvent: "m16.bereavement.outreach_artifact_requested",
        sourceModule: "m16",
        renderedAt: new Date().toISOString(),
      },
    });
    const row = await outreachRow(outreachId);
    expect(row.rendered_document_id).toBeNull();
    expect(row.status).toBe("in_progress");
  });
});
