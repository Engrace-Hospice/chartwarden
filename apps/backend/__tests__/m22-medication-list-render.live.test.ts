/**
 * F-171 (#248) — the LIVE `m12.medication_order.list_changed` → `patient_medication_list` render, END TO
 * END over real Postgres.
 *
 * The event's own catalogued payload (`{patientId, addedOrderIds, removedOrderIds}`) is a DIFF, never the
 * full active-medication list a `patient_medication_list` document needs to render, and M22's generic
 * `render-consumer.ts`/`REQUEST_SHAPES` pipeline only ever projects fields already present on the
 * delivered payload — it has no live seam-fetch step. `medication-list-bindings.ts` is the third dedicated
 * (non-generic) render pipeline this module has: it resolves the patient's CURRENT active-medication set
 * fresh, at delivery time, via M12's real, REGISTERED `MedicationOrderProvider.getActiveMedications` seam
 * (never from the diff payload), and writes a NEW `document_version` per genuinely distinct delivered
 * event (the F-168 per-request idempotency granularity, applied outside the generic pipeline).
 *
 * Nothing is stubbed on the read path under test: a real `medication_order` row (seeded directly — no
 * DoseSpot vendor transmission simulation, matching this module's own `m12-dosespot-read-service.live
 * .test.ts` convention) is read back through the REAL `createMedicationOrderProvider` seam over the REAL
 * `createDrizzleDoseSpotSeamStore`, registered into the actual M1 seam registry exactly as boot does — the
 * consumer resolves it via `getSeam("MedicationOrderProvider")`, wrapped in `runWithRequestContext`
 * because the backing read opens `withOrgContextFromRequest` and a dispatcher tick is not a request. The
 * render itself goes through the REAL `DocumentRenderer`/`DocumentSeamStore`, under RLS throughout.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m22:medication-list-render:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M12_OUTBOX_EVENTS,
  createDrizzleDoseSpotSeamStore,
  createMedicationOrderProvider,
} from "../src/modules/12-dosespot/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
  M22_OUTBOX_EVENTS,
  buildM22MedicationListConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ADMISSION_A = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("F-171 — M22 medication-list render, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const memberOf: Record<string, string> = {};
  /** Every render call the consumer made: `{templateKey, payload}` — the direct proof of WHAT content the
   *  seam resolved, cheaper and more precise than decoding the stand-in PDF bytes from the object store. */
  let renderedCalls: { templateKey: string; payload: Record<string, unknown> }[] = [];
  /** Overridable per-test — defaults to "no consent" so a SUD row redacts unless a test flips this. */
  let consentPresent = false;
  const refusals: { detail: string }[] = [];

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one real `medication_order` row directly (the `m12-dosespot-read-service.live.test.ts`
   *  convention — no DoseSpot vendor transmission simulation needed to prove the READ seam). */
  async function seedMedOrder(args: {
    org: string;
    patientId: string;
    drugName: string;
    status?: string;
    isSudTreatment?: boolean;
  }): Promise<string> {
    const {
      rows: [row],
    } = await admin.query(
      `INSERT INTO medication_order
         (organization_id, patient_id, admission_id, med_class, is_sud_treatment, drug_name, strength,
          dose_form, route, data, prescriber_membership_id, prescribing_physician_mdm_id, status)
       VALUES ($1,$2,$3,'standard',$4,$5,'5 mg','tablet','oral',
               '{"sigStructured":{"doseQuantity":2,"doseUnit":"tablet","route":"oral","frequencyCode":"BID","asNeeded":false}}'::jsonb,
               $6,$7,$8)
       RETURNING id`,
      [
        args.org,
        args.patientId,
        ADMISSION_A,
        args.isSudTreatment ?? false,
        args.drugName,
        memberOf[args.org],
        PHYSICIAN_MDM,
        args.status ?? "active",
      ],
    );
    return row.id as string;
  }

  /** Publish the REAL `m12.medication_order.list_changed` event through the catalog-validating publisher —
   *  the same shape M12's own real producer (`verbal-expired-binding.ts`) emits. */
  async function publishListChanged(args: {
    org: string;
    patientId: string;
    addedOrderIds?: string[];
    removedOrderIds?: string[];
  }): Promise<string> {
    await withOrgContext(handle.db, { organizationId: args.org, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m12.medication_order.list_changed",
        payload: {
          patientId: args.patientId,
          addedOrderIds: args.addedOrderIds ?? [],
          removedOrderIds: args.removedOrderIds ?? [],
        },
        organizationId: args.org,
        aggregateKind: "patient",
        aggregateId: args.patientId,
        callerModule: "m12",
      }),
    );
    // `publish()` returns void (OutboxPublishPort's contract) — re-query for the row it just inserted, the
    // most recent `.list_changed` row for this org (superuser read; RLS is asserted separately elsewhere).
    const { rows } = await admin.query(
      `SELECT id FROM outbox_event WHERE event_type='m12.medication_order.list_changed'
         AND organization_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [args.org],
    );
    return rows[0].id as string;
  }

  async function documentsFor(patientId: string, org: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.aggregate_id, d.patient_id, d.retention_class,
              v.version_number, v.mime_type, v.byte_size, v.source_event_id
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_type='patient_medication_list' AND d.aggregate_id=$1 AND d.organization_id=$2
        ORDER BY v.version_number`,
      [patientId, org],
    );
    return rows;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f172@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL M12 seam — registered into the SAME M1 registry singleton the consumer's default
    // `resolveActiveMedicationsForPatient` resolves via `getSeam("MedicationOrderProvider")`. Exactly the
    // boot-time wiring (M12-T07), not a test double.
    registerSeam(
      "MedicationOrderProvider",
      createMedicationOrderProvider(createDrizzleDoseSpotSeamStore(handle.db)),
    );

    const catalog = buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);

    objects = createInMemoryObjectStore();
    const store = createDrizzleDocumentSeamStore(handle.db);
    const renderer = createDocumentRenderer({ store, objects: objects.store });

    const consumer = buildM22MedicationListConsumer({
      store,
      renderer: () => ({
        render: (scope, templateKey, payload) => {
          renderedCalls.push({ templateKey, payload: payload as Record<string, unknown> });
          return renderer.render(scope, templateKey, payload);
        },
      }),
      // Injected for deterministic SUD-redaction assertions — the M39 `ConsentEvaluator` seam itself is
      // exercised elsewhere (consent-gate.ts's own callers); this suite's subject is the M12 content
      // resolution + per-request append semantics, not the consent apparatus a second time.
      resolveConsentPresent: async () => consentPresent,
      onRefusal: (r) => refusals.push({ detail: r.detail }),
      emitRendered: ({ organizationId, ...payload }) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          publisher.publish(tx as never, {
            eventName: M22_DOCUMENT_RENDERED_EVENT,
            payload,
            organizationId,
            aggregateKind: "document",
            aggregateId: payload.documentId,
            callerModule: "m22",
          }),
        ),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [consumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 120_000);

  beforeEach(() => {
    renderedCalls = [];
    consentPresent = false;
    refusals.length = 0;
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("resolves the real current active-medication list via the real M12 seam and renders a document version", async () => {
    const patient = randomUUID();
    const morphine = await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Morphine" });
    const acetaminophen = await seedMedOrder({
      org: ORG_A,
      patientId: patient,
      drugName: "Acetaminophen",
    });
    // Discontinued — must be excluded (getActiveMedications filters status === 'active').
    await seedMedOrder({
      org: ORG_A,
      patientId: patient,
      drugName: "Discontinued Drug",
      status: "discontinued",
    });

    expect(await documentsFor(patient, ORG_A)).toHaveLength(0);
    const eventId = await publishListChanged({
      org: ORG_A,
      patientId: patient,
      addedOrderIds: [morphine, acetaminophen],
    });
    await dispatcher.tick();

    expect(renderedCalls).toHaveLength(1);
    expect(renderedCalls[0].templateKey).toBe("patient_medication_list");
    const medications = renderedCalls[0].payload.medications as { drugName: string }[];
    expect(medications.map((m) => m.drugName).sort()).toEqual(["Acetaminophen", "Morphine"]);
    expect(renderedCalls[0].payload.aggregateId).toBe(patient);
    expect(renderedCalls[0].payload.patientId).toBe(patient);
    expect(renderedCalls[0].payload.sourceEventId).toBe(eventId);

    const docs = await documentsFor(patient, ORG_A);
    expect(docs).toHaveLength(1);
    expect(docs[0].organization_id).toBe(ORG_A);
    expect(docs[0].patient_id).toBe(patient);
    expect(docs[0].retention_class).toBe("clinical_record");
    expect(Number(docs[0].version_number)).toBe(1);
    expect(docs[0].source_event_id).toBe(eventId);
    expect(refusals).toHaveLength(0);

    // The §7.2 downstream half was announced (harmless — nothing back-refs this aggregate type today).
    const announced = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
      [M22_DOCUMENT_RENDERED_EVENT, docs[0].id],
    );
    expect(announced.rows).toHaveLength(1);
    expect(announced.rows[0].payload).toMatchObject({
      sourceModule: "m12",
      sourceEvent: "m12.medication_order.list_changed",
      aggregateType: "patient_medication_list",
      aggregateId: patient,
    });
  });

  it("a redelivery of the identical outbox event does not double-render", async () => {
    const patient = randomUUID();
    await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Furosemide" });
    const eventId = await publishListChanged({ org: ORG_A, patientId: patient });
    await dispatcher.tick();
    expect(await documentsFor(patient, ORG_A)).toHaveLength(1);
    expect(renderedCalls).toHaveLength(1);

    // Simulate the dispatcher's own documented crash window: `handle()` succeeded but the
    // `(event_id, consumer_name)` completion receipt was never committed (§4.11) — the ACTUAL mechanism
    // that would otherwise skip re-invoking this consumer for the same row, independent of
    // `outbox_event.status`. Deleting the receipt (never written, in the crash this simulates) alongside
    // reverting the row to `pending` is what makes the next tick redeliver to THIS consumer specifically.
    await admin.query(
      "DELETE FROM outbox_consumer_receipt WHERE event_id=$1 AND consumer_name='m22.medication-list-renderer'",
      [eventId],
    );
    await admin.query(
      "UPDATE outbox_event SET status='pending', dispatched_at=NULL, next_attempt_at=NULL WHERE id=$1",
      [eventId],
    );
    renderedCalls = [];
    await dispatcher.tick();

    // No second render call, no second document_version — the SAME single version is re-announced.
    expect(renderedCalls).toHaveLength(0);
    const docs = await documentsFor(patient, ORG_A);
    expect(docs).toHaveLength(1);
    expect(Number(docs[0].version_number)).toBe(1);
    const announced = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
      [M22_DOCUMENT_RENDERED_EVENT, docs[0].id],
    );
    // Genesis announce + the redelivery re-announce.
    expect(announced.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("a genuinely later, different list_changed event for the same patient renders a NEW version", async () => {
    const patient = randomUUID();
    const first = await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Warfarin" });
    await publishListChanged({ org: ORG_A, patientId: patient, addedOrderIds: [first] });
    await dispatcher.tick();
    expect(await documentsFor(patient, ORG_A)).toHaveLength(1);

    // A genuine second occurrence: another order changes the set, a DIFFERENT outbox event.
    const second = await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Enoxaparin" });
    renderedCalls = [];
    await publishListChanged({ org: ORG_A, patientId: patient, addedOrderIds: [second] });
    await dispatcher.tick();

    expect(renderedCalls).toHaveLength(1);
    const medications = renderedCalls[0].payload.medications as { drugName: string }[];
    expect(medications.map((m) => m.drugName).sort()).toEqual(["Enoxaparin", "Warfarin"]);

    const docs = await documentsFor(patient, ORG_A);
    expect(docs).toHaveLength(2); // two versions, same document
    expect(new Set(docs.map((d) => d.id)).size).toBe(1);
    expect(docs.map((d) => Number(d.version_number)).sort()).toEqual([1, 2]);
  });

  it("redacts a SUD-treatment medication's drug name/sig without consent, and renders plaintext with it", async () => {
    const patient = randomUUID();
    await seedMedOrder({
      org: ORG_A,
      patientId: patient,
      drugName: "Buprenorphine",
      isSudTreatment: true,
    });
    await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Ibuprofen" });

    consentPresent = false;
    await publishListChanged({ org: ORG_A, patientId: patient });
    await dispatcher.tick();

    const noConsentMeds = renderedCalls[0].payload.medications as {
      drugName: string | null;
      isSudTreatment: boolean;
      redacted: boolean;
    }[];
    const redactedRow = noConsentMeds.find((m) => m.isSudTreatment);
    const plainRow = noConsentMeds.find((m) => !m.isSudTreatment);
    expect(redactedRow?.redacted).toBe(true);
    expect(redactedRow?.drugName).not.toBe("Buprenorphine");
    expect(plainRow?.drugName).toBe("Ibuprofen");
    expect(renderedCalls[0].payload.sudRedacted).toBe(true);

    // A genuinely later event, now WITH consent — the same drug renders in plaintext.
    consentPresent = true;
    renderedCalls = [];
    const anotherOrder = await seedMedOrder({
      org: ORG_A,
      patientId: patient,
      drugName: "Naproxen",
    });
    await publishListChanged({ org: ORG_A, patientId: patient, addedOrderIds: [anotherOrder] });
    await dispatcher.tick();

    const withConsentMeds = renderedCalls[0].payload.medications as {
      drugName: string | null;
      isSudTreatment: boolean;
      redacted: boolean;
    }[];
    const nowPlain = withConsentMeds.find((m) => m.isSudTreatment);
    expect(nowPlain?.redacted).toBe(false);
    expect(nowPlain?.drugName).toBe("Buprenorphine");
  });

  it("cross-tenant isolation: org B's read for org A's patient id resolves nothing, never leaks org A's medications", async () => {
    const patient = randomUUID();
    await seedMedOrder({ org: ORG_A, patientId: patient, drugName: "Metoprolol" });

    // Org B publishes ITS OWN event, but the patient id numerically collides with org A's real patient —
    // RLS must scope the read to org B, never resolve org A's rows.
    await publishListChanged({ org: ORG_B, patientId: patient });
    await dispatcher.tick();

    expect(renderedCalls).toHaveLength(1);
    const medications = renderedCalls[0].payload.medications as unknown[];
    expect(medications).toHaveLength(0); // resolved (not refused) — an honest empty list under org B's RLS
    expect(refusals).toHaveLength(0);

    const orgBDocs = await documentsFor(patient, ORG_B);
    expect(orgBDocs).toHaveLength(1);
    // Org A never had a `.list_changed` PUBLISHED for this patient in this test — no document there either,
    // even though org A genuinely holds the (invisible-to-org-B) medication row.
    const orgADocs = await documentsFor(patient, ORG_A);
    expect(orgADocs).toHaveLength(0);
  });

  it("a malformed payload (no patientId) is refused, never silently dropped", async () => {
    // Superuser insert — bypasses the catalog-validating publisher deliberately, to construct the
    // malformed-payload case the publisher itself would otherwise refuse to write.
    await admin.query(
      `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload, status)
       VALUES ($1,'m12.medication_order.list_changed','patient',$2,$3,'pending')`,
      [ORG_A, randomUUID(), JSON.stringify({ addedOrderIds: [], removedOrderIds: [] })],
    );
    await dispatcher.tick();
    const { rows } = await admin.query(
      `SELECT status, attempt_count FROM outbox_event
        WHERE event_type='m12.medication_order.list_changed' AND payload->>'patientId' IS NULL`,
    );
    expect(rows[0].status).not.toBe("dispatched"); // retried, not silently marked delivered
  });
});
