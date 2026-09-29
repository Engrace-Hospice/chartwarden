/**
 * F-120 (#248) — M11's §4.4 kind-specific signed fan-out, over real Postgres.
 *
 * `packages/orders/src/catalog.ts`'s `downstreamSignedEvents` has computed `hl7_orm_requested` /
 * `supply_fulfillment_requested` / `level_of_care_change_signed` / `recertification_signed` as a
 * `transitionOrder` effect on every SIGN since the pure order machine shipped — `signInternal` called
 * `transitionOrder` only for its guard/throw and discarded `.effects` entirely. A signed lab order never
 * requested an outbound HL7 ORM, a signed dme/supply/comfort_kit order never asked M21 to fulfill it, and a
 * signed level-of-care-change/recertification order never told M6 — despite two of those five events'
 * own catalog descriptions (`events-by-m11.ts`) asserting "M11 emits the typed event today".
 *
 * This proves the three now-wired kinds emit the real catalogued payload (`hl7_orm_requested` is F-178's,
 * wired through injected ports — `m11-orm-requested.live.test.ts`) built from `order_record.data`, which the ROUTE
 * validated at draft time against the exact per-kind TypeBox `packages/orders/src/kinds.ts` uses.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:downstream-signed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import {
  type OrderWriteOutboxPort,
  createDbOrderBackend,
} from "../src/modules/11-orders/orders-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("F-120 — M11 downstream signed fan-out, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let member: string;

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
  async function eventPayload(aggregateId: string, eventType: string): Promise<Record<string, unknown> | null> {
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, eventType],
    );
    return (rows[0]?.payload as Record<string, unknown>) ?? null;
  }
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  async function signedOrder(
    kind: string,
    data: Record<string, unknown>,
    signerDiscipline: string,
  ): Promise<string> {
    const draft = await svc.createDraft(ORG_A, member, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: kind as never,
      drafterDiscipline: signerDiscipline,
      data,
      orderingPhysicianMdmId: PHYSICIAN_MDM,
    });
    await svc.requestSignature(ORG_A, draft.id, { signerDiscipline });
    await svc.signOrder(ORG_A, member, draft.id, {
      signerDiscipline,
      signedAtClient: new Date().toISOString(),
    });
    return draft.id;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f120@x.test')`, [USER]);
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    const outbox: OrderWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    svc = createDbOrderBackend(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a signed level_of_care_change order emits the real level_of_care_change_signed payload", async () => {
    const id = await signedOrder(
      "level_of_care_change",
      {
        fromLevel: "rhc",
        toLevel: "gip",
        effectiveAt: "2026-01-05T00:00:00.000Z",
        clinicalJustification: "Uncontrolled symptom crisis requiring continuous nursing oversight.",
      },
      "medical_director",
    );
    expect(await eventsFor(id)).toContain("m11.order.level_of_care_change_signed");
    const payload = await eventPayload(id, "m11.order.level_of_care_change_signed");
    expect(payload).toMatchObject({
      orderId: id,
      fromLevel: "rhc",
      toLevel: "gip",
      effectiveAt: "2026-01-05T00:00:00.000Z",
      admissionId: ADMISSION,
    });
  });

  it("a signed recertification order emits the real recertification_signed payload", async () => {
    const id = await signedOrder(
      "recertification",
      { periodEndDate: "2026-03-01", certifyingPhysicianMdmId: PHYSICIAN_MDM },
      "hospice_physician",
    );
    expect(await eventsFor(id)).toContain("m11.order.recertification_signed");
    const payload = await eventPayload(id, "m11.order.recertification_signed");
    expect(payload).toMatchObject({
      orderId: id,
      admissionId: ADMISSION,
      periodEndDate: "2026-03-01",
      certifyingPhysicianMdmId: PHYSICIAN_MDM,
    });
  });

  it("a signed comfort_kit order emits supply_fulfillment_requested with its deploymentSite", async () => {
    const id = await signedOrder(
      "comfort_kit",
      { kitSku: "CK-STANDARD", deploymentSite: "home" },
      "rn_case_manager",
    );
    expect(await eventsFor(id)).toContain("m11.order.supply_fulfillment_requested");
    const payload = await eventPayload(id, "m11.order.supply_fulfillment_requested");
    expect(payload).toMatchObject({
      orderId: id,
      kind: "comfort_kit",
      deploymentSite: "home",
      preferredDeliveryWindow: null,
    });
    expect((payload as { supplyDetail: unknown }).supplyDetail).toMatchObject({
      kitSku: "CK-STANDARD",
      deploymentSite: "home",
    });
  });

  it("a signed dme order emits supply_fulfillment_requested with deploymentSite null (dme has no such field)", async () => {
    const id = await signedOrder("dme", { hcpcs: "E0260" }, "rn_case_manager");
    const payload = await eventPayload(id, "m11.order.supply_fulfillment_requested");
    expect(payload).toMatchObject({ orderId: id, kind: "dme", deploymentSite: null });
  });

  it("a signed lab order does NOT emit supply_fulfillment_requested, and emits no hl7_orm_requested WITHOUT the F-178 ORM ports (this suite builds the service bare — m11-orm-requested.live proves the wired path)", async () => {
    const id = await signedOrder(
      "lab",
      { testCodes: [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }], fastingRequired: false },
      "rn_case_manager",
    );
    const events = await eventsFor(id);
    expect(events).toContain("m11.order.signed");
    expect(events).not.toContain("m11.order.hl7_orm_requested");
    expect(events).not.toContain("m11.order.supply_fulfillment_requested");
  });
});
