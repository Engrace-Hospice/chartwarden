/**
 * F-168 (#248) — the m22 `handlers-unbound` group's standing "idempotency-key-granularity collision"
 * (first found F-162, re-confirmed F-166), fixed and proven END TO END over real Postgres.
 *
 * `decideDocumentRequest`'s `alreadyRendered` fact used to be resolved from
 * `store.renderedDocumentForAggregate({aggregateType, aggregateId})` — "does ANY document exist for this
 * aggregate" — which made every SECOND render request against an aggregate that already had one document
 * silently `idempotent_skip` forever: correct for a genuine crash-and-retry redelivery of the SAME outbox
 * row, wrong for a genuinely different request (even the same event TYPE) that needs a NEW version. Fixed
 * by keying `alreadyRendered` on the specific delivered outbox event id (migration 0261,
 * `document_version.source_event_id`, written in the SAME insert as the version row — no separate receipt
 * table with its own lost-write crash window).
 *
 * This suite proves BOTH halves of the fix, over the real Drizzle store, the real catalog-validating
 * publisher, and the real dispatcher, under RLS as the NOBYPASSRLS `wardenx_app` role:
 *
 *   1. A genuinely DIFFERENT request against an aggregate that already has a document now renders a NEW
 *      VERSION rather than silently no-op'ing — `m8.encounter.addendum_signed` after `.signed`,
 *      `m14.minutes.amended` after `.signed`, `m12.medication_order.transmitted` after
 *      `.document_requested`, all three now bound in `M22_DOCUMENT_REQUEST_EVENTS`.
 *   2. A genuine crash-and-retry REDELIVERY of the IDENTICAL outbox event (same `event.id`) still does
 *      NOT double-render — proven by invoking the real consumer's `handle()` directly twice with the same
 *      `DispatchableOutboxEvent` object, the exact shape a receipt-write crash between `handle()`
 *      succeeding and the dispatcher's own `(event_id, consumer_name)` receipt being recorded would
 *      reproduce (see `outbox-dispatcher.ts`'s own per-binding receipt-then-insert sequence).
 *
 * `m12.medication_order.transmitted` is published directly (no production producer exists for it yet —
 * see the `scripts/outbox-deferred-consumers.ts` m22 entry — the F-161 `m17.caregiver_reminder_due`
 * posture: the M22-side binding is real and tested against the real catalogued payload, reported not
 * fixed on the producer side).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f168:document-request-idempotency:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
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
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import {
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { MEDICATION_ORDER } from "./_m22-form-fixtures";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("F-168 — document-request idempotency granularity, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let m22Consumer: ReturnType<typeof buildM22DocumentRequestConsumer>;
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
  async function versionsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id AS document_id, d.organization_id, d.aggregate_type, d.patient_id,
              v.id AS version_id, v.version_number, v.source_event_id
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number::int`,
      [aggregateId],
    );
    return rows as {
      document_id: string;
      organization_id: string;
      aggregate_type: string;
      patient_id: string | null;
      version_id: string;
      version_number: string;
      source_event_id: string | null;
    }[];
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f168@x.test')`, [USER]);
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [MEMBER, USER, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // M22's ONE render consumer's `eventTypes` spans every producing module's declared event — the
    // dispatcher refuses to CONSTRUCT when a bound consumer names an event no catalog carries
    // (`assertBindableAgainstCatalog`), so every touched module's catalog must be present (the f166
    // precedent).
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
      M19_OUTBOX_EVENTS,
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
    m22Consumer = buildM22DocumentRequestConsumer({
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

  // ── half 1: a genuinely different request produces a NEW version, not a silent no-op ────────────────

  it("m8.encounter.addendum_signed appends a NEW version onto the SAME encounter .signed genesis-rendered", async () => {
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
        documentRenderPayload: { final: "", addenda: [] },
      },
    });
    await dispatcher.tick();
    expect(await versionsFor(encounterId)).toHaveLength(1);

    const addendumId = randomUUID();
    await publish({
      eventName: "m8.encounter.addendum_signed",
      organizationId: ORG_A,
      aggregateKind: "encounter",
      aggregateId: encounterId,
      callerModule: "m8",
      payload: {
        encounterId,
        addendumId,
        signedByMembershipId: MEMBER,
        signedAt: new Date().toISOString(),
        reason: "clarifying the pain assessment documented at the original visit",
        documentRenderPayload: {
          final: "",
          addenda: [{ addendumId, reason: "clarify", text: "" }],
        },
      },
    });
    await dispatcher.tick();

    // The fix, proven directly: TWO versions on the SAME document, never a silent idempotent_skip.
    const versions = await versionsFor(encounterId);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.document_id).toBe(versions[1]?.document_id);
    expect(versions.map((v) => v.version_number)).toEqual(["1", "2"]);
    // Each version carries the specific outbox event that requested it — the new dedup key.
    expect(versions[0]?.source_event_id).not.toBeNull();
    expect(versions[1]?.source_event_id).not.toBeNull();
    expect(versions[0]?.source_event_id).not.toBe(versions[1]?.source_event_id);
  });

  it("m14.minutes.amended appends a NEW version onto the SAME idg_minutes .signed genesis-rendered", async () => {
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
        renderPayload: {
          attendanceSnapshot: [],
          decisionListSnapshot: [],
          actionItemListSnapshot: [],
        },
      },
    });
    await dispatcher.tick();
    expect(await versionsFor(minutesId)).toHaveLength(1);

    await publish({
      eventName: "m14.minutes.amended",
      organizationId: ORG_A,
      aggregateKind: "idg_minutes",
      aggregateId: minutesId,
      callerModule: "m14",
      payload: {
        amendmentId: randomUUID(),
        minutesId,
        requestedByMembershipId: MEMBER,
        approvedByMembershipId: MEMBER,
        amendmentReasonHash: randomUUID(),
        renderPayload: {
          attendanceSnapshot: [{ membershipId: MEMBER, status: "present" }],
          decisionListSnapshot: [],
          actionItemListSnapshot: [],
        },
      },
    });
    await dispatcher.tick();

    const versions = await versionsFor(minutesId);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version_number)).toEqual(["1", "2"]);
    expect(versions[0]?.aggregate_type).toBe("idg_minutes");
  });

  it("m12.medication_order.transmitted appends a NEW version onto the SAME order .document_requested genesis-rendered", async () => {
    const orderId = randomUUID();
    const patientId = randomUUID();
    // GAP-033 - both requests carry the typed medication-order payload the form draws (the genesis one as the
    // signing transaction builds it; the append adds the `transmission` block). An id-only request is refused.
    const typed = {
      ...MEDICATION_ORDER,
      orderId,
      patientId,
      patient: { ...MEDICATION_ORDER.patient, patientId },
    };
    await publish({
      eventName: "m12.medication_order.document_requested",
      organizationId: ORG_A,
      aggregateKind: "medication_order",
      aggregateId: orderId,
      callerModule: "m12",
      payload: {
        orderId,
        formTemplate: "medication_order",
        renderPayload: { admissionId: randomUUID(), isControlledSubstance: false, ...typed },
      },
    });
    await dispatcher.tick();
    expect(await versionsFor(orderId)).toHaveLength(1);

    await publish({
      eventName: "m12.medication_order.transmitted",
      organizationId: ORG_A,
      aggregateKind: "medication_order",
      aggregateId: orderId,
      callerModule: "m12",
      payload: {
        orderId,
        dosespotPrescriptionId: randomUUID(),
        transmittedAt: new Date().toISOString(),
        dispensingPharmacyMdmId: null,
        renderPayload: {
          ...typed,
          transmission: { transmittedAt: new Date().toISOString(), prescriptionRef: randomUUID() },
        },
      },
    });
    await dispatcher.tick();

    const versions = await versionsFor(orderId);
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.version_number)).toEqual(["1", "2"]);
    expect(versions[0]?.aggregate_type).toBe("medication_order");
  });

  // ── half 2: a genuine crash-and-retry redelivery of the IDENTICAL event still does not double-render ──

  it("a genuine redelivery of the IDENTICAL outbox row (same event.id) still does not double-render", async () => {
    const encounterId = randomUUID();
    const patientId = randomUUID();
    const signedPayload = {
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
      documentRenderPayload: { final: "", addenda: [] },
    };
    await publish({
      eventName: "m8.encounter.signed",
      organizationId: ORG_A,
      aggregateKind: "encounter",
      aggregateId: encounterId,
      callerModule: "m8",
      payload: signedPayload,
    });
    await dispatcher.tick();
    expect(await versionsFor(encounterId)).toHaveLength(1);

    const addendumId = randomUUID();
    const addendumEvent: DispatchableOutboxEvent = {
      id: randomUUID(), // the outbox row's own id — the dedup key this fix now uses
      organizationId: ORG_A,
      eventType: "m8.encounter.addendum_signed",
      aggregateKind: "encounter",
      aggregateId: encounterId,
      payload: {
        encounterId,
        addendumId,
        signedByMembershipId: MEMBER,
        signedAt: new Date().toISOString(),
        reason: "a correction filed after the original note was signed",
        documentRenderPayload: {
          final: "",
          addenda: [{ addendumId, reason: "correction", text: "" }],
        },
      },
      attemptCount: 0,
      createdAt: new Date(),
    };

    // First delivery: renders a second version. Simulates the real dispatcher path but calls the
    // consumer directly so the SAME event object (and therefore the same `id`) can be redelivered —
    // exactly the shape a crash between `handle()` succeeding and the dispatcher's own
    // `(event_id, consumer_name)` receipt insert would produce (outbox-dispatcher.ts's own sequence).
    await m22Consumer.handle(addendumEvent);
    const afterFirst = await versionsFor(encounterId);
    expect(afterFirst).toHaveLength(2);

    // Second delivery of the IDENTICAL event object (same id, same payload) — a genuine crash-retry
    // redelivery. Must NOT produce a third version.
    await m22Consumer.handle(addendumEvent);
    const afterSecond = await versionsFor(encounterId);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.map((v) => v.version_id)).toEqual(afterFirst.map((v) => v.version_id));

    // And a THIRD, genuinely different addendum on the same encounter still gets its OWN version — the
    // redelivery guard is scoped to the specific event id, not to "this aggregate already has a v2".
    const secondAddendumId = randomUUID();
    await publish({
      eventName: "m8.encounter.addendum_signed",
      organizationId: ORG_A,
      aggregateKind: "encounter",
      aggregateId: encounterId,
      callerModule: "m8",
      payload: {
        encounterId,
        addendumId: secondAddendumId,
        signedByMembershipId: MEMBER,
        signedAt: new Date().toISOString(),
        reason: "a second, independent correction filed later the same week",
        documentRenderPayload: {
          final: "",
          addenda: [{ addendumId: secondAddendumId, reason: "second correction", text: "" }],
        },
      },
    });
    await dispatcher.tick();
    const afterThird = await versionsFor(encounterId);
    expect(afterThird).toHaveLength(3);
    expect(afterThird.map((v) => v.version_number)).toEqual(["1", "2", "3"]);
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's F-168 documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document
        WHERE aggregate_type IN ('encounter', 'idg_minutes', 'medication_order')`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document_version
          JOIN document d ON d.id = document_version.document_id
          WHERE d.aggregate_type IN ('encounter', 'idg_minutes', 'medication_order')`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
