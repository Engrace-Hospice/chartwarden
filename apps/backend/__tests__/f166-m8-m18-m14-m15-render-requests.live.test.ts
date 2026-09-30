/**
 * F-166 (#248) — five GENESIS-only §4.11 render requests M22's own `handlers-unbound` group's
 * survey-then-build pass found buildable, proven END TO END over real Postgres:
 *
 *   · `m8.encounter.signed` — template `encounter`, published since the platform-floor
 *     `PLATFORM_TEMPLATE_TABLE` with no consumer wired to it. The LOCKED payload's
 *     `documentRenderPayload: {final, addenda}` has carried the renderable content since the event
 *     existed. `m8.encounter.addendum_signed` was NOT built here at the time — it asked for a SECOND
 *     render against the SAME `aggregateType/aggregateId` this suite's own `.signed` case renders,
 *     which `decideDocumentRequest`'s then-`(aggregateType, aggregateId)`-only idempotency answered
 *     `idempotent_skip` for (the F-162 gap). F-168 (#248) fixed that granularity (migration 0261) and
 *     bound `.addendum_signed` for real — see `f168-document-request-idempotency.live.test.ts` for the
 *     end-to-end proof that it now appends a genuine new version; this suite keeps only the narrower
 *     decider-level assertion that survives the fix (below).
 *   · `m18.evv.aggregator_accepted` — template `evv_verification`. Its declared sibling
 *     `m18.evv.verification_pdf_requested` was checked and found VAPOR (no emit site anywhere in
 *     `18-evv/`) and dropped from the catalog at the source; `aggregator_accepted` is the real,
 *     only-ever-emitted D11 trigger (the F-100 "event NAME is the template" shape).
 *   · `m14.packet.render_requested` / `m14.minutes.signed` — templates `idg_patient_packet` /
 *     `idg_minutes`, real `document_aggregate_type` values since migration 0048 with no
 *     TemplateDescriptor and no subscription (F-162's own finding: "even a first-ever render would
 *     hit `unknown_template` today").
 *   · `m15.plan.version_signed` — ONE event, FOUR templates (`aide_poc`/`msw_plan`/`spiritual_plan`/
 *     `volunteer_plan`) discriminated by the payload's `kind`, all four also real since migration
 *     0048. The event's own payload carried no `patientId` — widened at the source (F-099 "the fact
 *     was already in scope at the emit site" precedent), proven here with the widened field.
 *
 * `m11.order.results_received` is deliberately NOT here: it looked like the same shape (its
 * `lab_results_pdf` template already exists) but is a SEPARATE, dedicated pipeline
 * (`render-variants/lab-backref-*.ts`) genuinely blocked on the M29 `LabObservationReader` seam's
 * real interface not matching the port M22 forward-declared, AND — even fixed — the seam's DTO
 * carries no per-value SUD-class flag §7.16 needs (the F-035 Part-2-disclosure risk). Building the
 * generic REQUEST_SHAPES entry this suite's siblings use would ALSO have collided: keying on
 * `orderId` with `aggregateType: 'order_record'` would silently `idempotent_skip` against the
 * order-form document `m11.order.document_requested` already renders for the same order at sign
 * time. See the F-166 paragraph in `scripts/outbox-deferred-consumers.ts` for the full accounting of
 * every other event in the group this pass investigated and sharpened but did not build.
 *
 * Nothing is stubbed on the M22 side: the real catalog-validating transactional publisher writes
 * each row, the real `createOutboxDispatcher` claims and delivers it, M22's real render consumer
 * resolves the template, renders through the real `DocumentRenderer`, and the real Drizzle seam
 * store writes `document` + `document_version`, under RLS, as the NOBYPASSRLS `wardenx_app` role.
 * M8/M18/M14 have no producer exercised end-to-end here (M8/M18/M14 write services are large,
 * multi-step lifecycles) — every event is published directly through the real catalog-validating
 * publisher with the exact real payload shape each module's own catalog declares, the same
 * already-established proof shape F-161 uses for `m17.caregiver_reminder_due` (no production
 * producer either, at the time that suite landed).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f166:render-requests:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
// F-168 (#248) — a static import (the original test used a dynamic one because it never needed the
// symbol at module scope); kept here so the remaining `alreadyRendered: false` assertion can run
// synchronously.
import { decideDocumentRequest } from "../src/modules/22-documents/outbox-consumers/decide-document-request";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("F-166 — M8/M18/M14/M15 render requests, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const renderedKeys: string[] = [];

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function outboxFor(aggregateId: string): Promise<{ type: string; status: string }[]> {
    const { rows } = await admin.query(
      "SELECT event_type, status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => ({ type: r.event_type as string, status: r.status as string }));
  }
  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.patient_id, d.retention_class, d.title,
              v.mime_type, v.byte_size
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number`,
      [aggregateId],
    );
    return rows;
  }
  function publish(input: {
    eventName: string;
    organizationId: string;
    aggregateKind: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    callerModule: string;
  }) {
    return withOrgContext(handle.db, { organizationId: input.organizationId, userId: "" }, (tx) =>
      publisher.publish(tx as never, input as never),
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f166@x.test')`, [USER]);
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [MEMBER, USER, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // M22's ONE render consumer's `eventTypes` spans every producing module's declared event — the
    // dispatcher refuses to CONSTRUCT when a bound consumer names an event no catalog carries
    // (`assertBindableAgainstCatalog`), so every touched module's catalog must be present.
    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M7_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M9_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M17_OUTBOX_EVENTS,
      M18_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);

    const store = createDrizzleDocumentSeamStore(handle.db);
    const objects = createInMemoryObjectStore();
    const renderer = createDocumentRenderer({ store, objects: objects.store });
    const m22Consumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => ({
        render: (scope, templateKey, payload) => {
          renderedKeys.push(templateKey);
          return renderer.render(scope, templateKey, payload);
        },
      }),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [m22Consumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("m8.encounter.signed requests + renders the encounter note", async () => {
    const encounterId = randomUUID();
    const patientId = randomUUID();
    await publish({
      eventName: "m8.encounter.signed",
      organizationId: ORG_A,
      aggregateKind: "encounter",
      aggregateId: encounterId,
      callerModule: "m8",
      payload: {
        encounterId,
        patientId,
        admissionId: randomUUID(),
        encounterType: "routine_visit",
        discipline: "rn",
        signedByMembershipId: MEMBER,
        signedAt: new Date().toISOString(),
        lateEntryTier: "normal",
        layer2Involved: false,
        evvBracketState: "evv_present",
        requiresCosign: false,
        careplanLinks: [],
        documentRenderPayload: { final: "Patient stable, comfortable.", addenda: [] },
      },
    });

    expect(await documentsFor(encounterId)).toHaveLength(0);
    await dispatcher.tick();

    const docs = await documentsFor(encounterId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("encounter");
    expect(docs[0].patient_id).toBe(patientId);
    expect(docs[0].organization_id).toBe(ORG_A);
    // No overall `status: "dispatched"` check here (unlike this suite's other cases): `m8.encounter
    // .signed` declares SEVEN consumers (`m14`/`m17`/`m18`/`m22`/`m24`/`m31`/`m36`), and the row's
    // aggregate status only advances once every declared consumer bound in the dispatcher has run —
    // this suite registers only M22's binding, so the row correctly stays `pending` on the other six
    // consumers' behalf. The document assertions above are the real proof M22's own binding ran.
  });

  // F-168 (#248) — this test used to prove `m8.encounter.addendum_signed` `idempotent_skip`s against the
  // SAME `encounterId` `.signed` genesis-rendered (the F-162 granularity gap, at the time genuinely
  // unbound). Migration 0261 fixed the underlying idempotency-key granularity and
  // `m8.encounter.addendum_signed` is now bound and appends a real new version — proven end to end in
  // `f168-document-request-idempotency.live.test.ts`, which is the suite to read for that behavior now.
  // What remains true and worth asserting HERE, in this suite's own `alreadyRendered: true` scenario, is
  // the narrower fact the fix preserves: a `sourceEventId` the store has never seen resolves
  // `documentVersionForSourceEvent` to null (never rendered YET), so `decideDocumentRequest` still
  // renders on the FIRST delivery of any request, addendum included.
  it("decideDocumentRequest renders (not idempotent_skip) when the specific request has never been fulfilled", () => {
    const action = decideDocumentRequest(
      "m8.encounter.addendum_signed",
      {
        organizationId: ORG_A,
        templateKey: "encounter",
        aggregateId: randomUUID(),
        patientId: randomUUID(),
        content: { final: "", addenda: [{ addendumId: randomUUID(), reason: "x", text: "" }] },
      },
      {
        // F-168: this is now what a NEVER-before-seen `sourceEventId` resolves to, even against an
        // aggregate that already has other versions — `alreadyRendered` is per-REQUEST, not per-aggregate.
        alreadyRendered: false,
        templateKnown: true,
        aggregateType: "encounter",
        retentionClass: "clinical_record",
      },
    );
    expect(action.kind).toBe("render");
  });

  it("m18.evv.aggregator_accepted requests + renders the visit verification PDF", async () => {
    const submissionId = randomUUID();
    await publish({
      eventName: "m18.evv.aggregator_accepted",
      organizationId: ORG_A,
      aggregateKind: "evv_aggregator_submission",
      aggregateId: submissionId,
      callerModule: "m18",
      payload: {
        submissionId,
        visitId: randomUUID(),
        stateCode: "CA",
        aggregatorTransactionId: randomUUID(),
        acceptedAt: new Date().toISOString(),
      },
    });

    expect(await documentsFor(submissionId)).toHaveLength(0);
    await dispatcher.tick();

    const docs = await documentsFor(submissionId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("evv_verification");
    expect(docs[0].retention_class).toBe("operational");
    // No patientId on this payload (honestly unresolved — see the F-166 finding above).
    expect(docs[0].patient_id).toBeNull();
    expect(docs[0].organization_id).toBe(ORG_A);
  });

  it("m18.evv.verification_pdf_requested is now record-only (dropped as vapor) — no live consumer names it", async () => {
    const { M22_DOCUMENT_REQUEST_EVENTS } = await import(
      "../src/modules/22-documents/outbox-consumers/decide-document-request"
    );
    expect(M22_DOCUMENT_REQUEST_EVENTS).not.toContain("m18.evv.verification_pdf_requested");
  });

  it("m14.packet.render_requested requests + renders the IDG patient packet", async () => {
    const packetId = randomUUID();
    const patientId = randomUUID();
    await publish({
      eventName: "m14.packet.render_requested",
      organizationId: ORG_A,
      aggregateKind: "idg_patient_packet",
      aggregateId: packetId,
      callerModule: "m14",
      payload: {
        meetingId: randomUUID(),
        patientId,
        packetId,
        renderPayload: { sections: ["diagnosis", "plan"] },
      },
    });

    expect(await documentsFor(packetId)).toHaveLength(0);
    await dispatcher.tick();

    const docs = await documentsFor(packetId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("idg_patient_packet");
    expect(docs[0].patient_id).toBe(patientId);
    expect(docs[0].organization_id).toBe(ORG_A);
  });

  it("m14.minutes.signed requests + renders the IDG minutes (patient-independent)", async () => {
    const minutesId = randomUUID();
    await publish({
      eventName: "m14.minutes.signed",
      organizationId: ORG_A,
      aggregateKind: "idg_minutes",
      aggregateId: minutesId,
      callerModule: "m14",
      payload: {
        minutesId,
        meetingId: randomUUID(),
        finalizedByMembershipId: MEMBER,
        renderPayload: { attendees: ["rn", "md"] },
      },
    });

    expect(await documentsFor(minutesId)).toHaveLength(0);
    await dispatcher.tick();

    const docs = await documentsFor(minutesId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("idg_minutes");
    expect(docs[0].patient_id).toBeNull();
    expect(docs[0].organization_id).toBe(ORG_A);
  });

  it("m15.plan.version_signed renders the correct template per `kind` (aide_poc, msw_plan)", async () => {
    const aideVersionId = randomUUID();
    const aidePatientId = randomUUID();
    await publish({
      eventName: "m15.plan.version_signed",
      organizationId: ORG_A,
      aggregateKind: "discipline_care_plan_version",
      aggregateId: aideVersionId,
      callerModule: "m15",
      payload: {
        planId: randomUUID(),
        versionId: aideVersionId,
        patientId: aidePatientId,
        kind: "aide_poc",
        versionKind: "initial",
        snapshot: { tasks: ["bathing", "ambulation"] },
        signers: [{ membershipId: MEMBER, role: "rn", signedAt: new Date().toISOString(), isAcknowledgment: false }],
      },
    });

    const mswVersionId = randomUUID();
    const mswPatientId = randomUUID();
    await publish({
      eventName: "m15.plan.version_signed",
      organizationId: ORG_A,
      aggregateKind: "discipline_care_plan_version",
      aggregateId: mswVersionId,
      callerModule: "m15",
      payload: {
        planId: randomUUID(),
        versionId: mswVersionId,
        patientId: mswPatientId,
        kind: "msw_plan",
        versionKind: "initial",
        snapshot: { goals: ["counseling"] },
        signers: [{ membershipId: MEMBER, role: "msw", signedAt: new Date().toISOString(), isAcknowledgment: false }],
      },
    });

    await dispatcher.tick();

    const aideDocs = await documentsFor(aideVersionId);
    expect(aideDocs).toHaveLength(1);
    expect(aideDocs[0].aggregate_type).toBe("aide_poc");
    expect(aideDocs[0].patient_id).toBe(aidePatientId);

    const mswDocs = await documentsFor(mswVersionId);
    expect(mswDocs).toHaveLength(1);
    expect(mswDocs[0].aggregate_type).toBe("msw_plan");
    expect(mswDocs[0].patient_id).toBe(mswPatientId);
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's F-166 documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document
        WHERE aggregate_type IN ('encounter','evv_verification','idg_patient_packet','idg_minutes','aide_poc','msw_plan')`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document
          WHERE aggregate_type IN ('encounter','evv_verification','idg_patient_packet','idg_minutes','aide_poc','msw_plan')`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
