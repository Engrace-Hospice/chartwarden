/**
 * F-232 (#248) — `m21 <- m11.order.supply_fulfillment_requested` bound for `dme`/`supply`, over real Postgres.
 *
 * F-229 stopped here for want of an order contract and a full-address seam. F-232 publishes `dme.v2` /
 * `supply.v2` (`{skuId, quantity, ...}`, closed — no address, no HCPCS on the order) and binds the consumer
 * over the already-built `decideSupplyFulfillmentIntake`. Nothing is stubbed except the clock:
 *
 *   REAL M11 write service (as the NOBYPASSRLS `wardenx_app` role) creates + signs the order → the REAL
 *   catalog-validating publisher writes `m11.order.supply_fulfillment_requested` → the REAL
 *   `createOutboxDispatcher` delivers it → M21's intake consumer reads the order (M11 `OrderProvider`), the
 *   admission (M6 `AdmissionStatusReader`), the SKU (`supply_item`) and PULLS the address through M5's
 *   `PatientAddressReader.primaryAddress`, then writes the `supply_request` through `insertSupplyRequest`.
 *
 * Proves: the row + its D1 `data` (HCPCS from the catalog, unit defaulting from the catalog, the address
 * snapshot); the address NEVER rides the outbox; the `status_changed` (fromStatus null) emit and NO
 * `created_from_external`; redelivery + concurrent delivery are idempotent on `sourceOrderId`; every
 * unresolvable contract / SKU / address SETTLES (delivered, no row, no retry loop); the post-care posture
 * opens-and-cancels; an unresolvable serving Location THROWS (retried, not settled); v1 orders keep working.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:supply-fulfillment-intake:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { buildPatientAddressReader } from "../src/modules/05-patient/address-reader";
import {
  createAdmissionStatusReader,
  createDeathDischargeReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import {
  M11_OUTBOX_EVENTS,
  type OrderWriteOutboxPort,
  createDbOrderBackend,
} from "../src/modules/11-orders/index";
import { createOrderProvider } from "../src/modules/11-orders/seams/index";
import { createDrizzleOrderSeamStore } from "../src/modules/11-orders/seams/index";
import {
  M21_OUTBOX_EVENTS,
  buildM21SupplyFulfillmentIntakeConsumer,
  runSupplyFulfillmentIntake,
} from "../src/modules/21-supplies/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { seedM5Patient } from "./_m6-admit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const STREET = "742 Evergreen Terrace";

describe.skipIf(!DB_URL)("F-232 — M21 supply-fulfillment intake, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let orderSvc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publisherFor: (module: string) => OrderWriteOutboxPort;
  let providerEntityId: string;
  let locationId: string;
  let memberId: string;
  let hcpcsSku: string; // E0260, unit 'each'
  let supplySku: string; // A4620 with default_unit 'box'
  let noHcpcsSku: string; // non-billable, no hcpcs

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

  /** A patient + an ACTIVE admission sited at `locationId` (null = not yet sited) + optionally a primary address. */
  async function seedPatientAdmission(opts: {
    address?: { line1?: string; state?: string | null; postal?: string } | null;
    sited?: boolean;
  }): Promise<{ patientId: string; admissionId: string }> {
    const patientId = randomUUID();
    await seedM5Patient(admin, ORG_A, patientId);
    const admissionId = (
      await admin.query(
        `INSERT INTO admission (organization_id,provider_entity_id,location_id,patient_id,status,activated_at)
         VALUES ($1,$2,$3,$4,'active',now()) RETURNING id`,
        [ORG_A, providerEntityId, opts.sited === false ? null : locationId, patientId],
      )
    ).rows[0].id as string;
    if (opts.address !== null) {
      const a = opts.address ?? {};
      await admin.query(
        `INSERT INTO patient_address
           (patient_id, organization_id, kind, line1, city, state, postal_code, country, is_primary, effective_from)
         VALUES ($1,$2,'home',$3,'Portland',$4,$5,$6,true,'2026-01-01')`,
        [
          patientId,
          ORG_A,
          a.line1 ?? STREET,
          a.state === undefined ? "OR" : a.state,
          a.postal ?? "97000",
          a.state === null ? "CA" : "US", // a non-US address legitimately has no state
        ],
      );
    }
    return { patientId, admissionId };
  }

  async function signedOrder(
    patientId: string,
    admissionId: string,
    kind: string,
    data: Record<string, unknown>,
    kindVersion?: string,
  ): Promise<string> {
    const discipline = "rn_case_manager";
    const draft = await orderSvc.createDraft(ORG_A, memberId, {
      patientId,
      admissionId,
      kind: kind as never,
      drafterDiscipline: discipline,
      data,
      orderingPhysicianMdmId: PHYSICIAN_MDM,
      ...(kindVersion ? { kindVersion } : {}),
    });
    await orderSvc.requestSignature(ORG_A, draft.id, { signerDiscipline: discipline });
    await orderSvc.signOrder(ORG_A, memberId, draft.id, {
      signerDiscipline: discipline,
      signedAtClient: new Date().toISOString(),
    });
    return draft.id;
  }

  async function requestsFor(orderId: string) {
    const { rows } = await admin.query(
      `SELECT id, kind, status, data, routing_rule_resolved_jsonb, cancellation_reason, location_id,
              provider_entity_id, patient_id, admission_id
         FROM supply_request WHERE source_order_id=$1 ORDER BY created_at`,
      [orderId],
    );
    return rows as Array<{
      id: string;
      kind: string;
      status: string;
      data: Record<string, unknown>;
      cancellation_reason: string | null;
      location_id: string;
      provider_entity_id: string;
      patient_id: string;
      admission_id: string;
    }>;
  }
  async function outboxOf(aggregateId: string) {
    const { rows } = await admin.query(
      "SELECT event_type, payload, status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows as Array<{ event_type: string; payload: Record<string, unknown>; status: string }>;
  }
  async function fulfillmentEvent(orderId: string) {
    const rows = await outboxOf(orderId);
    const row = rows.find((r) => r.event_type === "m11.order.supply_fulfillment_requested");
    if (!row) throw new Error("no supply_fulfillment_requested for order");
    return row;
  }
  async function fulfillmentEventRow(orderId: string) {
    const { rows } = await admin.query(
      `SELECT id, status, attempt_count FROM outbox_event
        WHERE aggregate_id=$1 AND event_type='m11.order.supply_fulfillment_requested'`,
      [orderId],
    );
    return rows[0] as { id: string; status: string; attempt_count: number };
  }
  /** Runs the consumer directly against the stored event payload (exactly what the dispatcher hands it). */
  async function runDirect(orderId: string) {
    const ev = await fulfillmentEvent(orderId);
    return runSupplyFulfillmentIntake(
      { db: handle.db, outbox: publisherFor("m21") as never },
      ORG_A,
      ev.payload,
    );
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f232@x.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-A','Hospice A','NPI-A','\\x00','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    locationId = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    memberId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    hcpcsSku = (
      await admin.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit)
           VALUES ('E0260','Semi-electric hospital bed','E','each') RETURNING id`,
      )
    ).rows[0].id as string;
    supplySku = (
      await admin.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit)
           VALUES ('A4620','Tracheostomy inner cannula','A','box') RETURNING id`,
      )
    ).rows[0].id as string;
    noHcpcsSku = (
      await admin.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit, is_billable)
           VALUES (NULL,'Agency gloves','internal','box', false) RETURNING id`,
      )
    ).rows[0].id as string;

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL seams M21's intake reads (production boot registers the same Drizzle-backed ones).
    registerSeam("OrderProvider", createOrderProvider(createDrizzleOrderSeamStore(handle.db)));
    registerSeam(
      "AdmissionStatusReader",
      createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
    );
    registerSeam("DeathDischargeReader", createDeathDischargeReader(handle.db));
    registerSeam("PatientAddressReader", buildPatientAddressReader(handle.db));

    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);
    publisherFor = (module: string) =>
      ({
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: module } as never),
      }) as OrderWriteOutboxPort;
    orderSvc = createDbOrderBackend(handle.db, publisherFor("m11"));

    const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM21SupplyFulfillmentIntakeConsumer({
          db: handle.db,
          outbox: publisherFor("m21") as never,
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a signed dme.v2 order opens a requested supply_request: HCPCS from the catalog, address PULLED", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 1, rentalCadence: "monthly", needsInstallation: true },
      "dme.v2",
    );
    // The address is NOT in the event the producer published (PHI never rides the outbox).
    const ev = await fulfillmentEvent(order);
    expect(JSON.stringify(ev.payload)).not.toContain(STREET);
    expect(ev.payload).toMatchObject({ orderId: order, kind: "dme" });

    await dispatcher.tick();

    const rows = await requestsFor(order);
    expect(rows).toHaveLength(1);
    const row = rows[0] as NonNullable<(typeof rows)[number]>;
    expect(row).toMatchObject({
      kind: "dme",
      status: "requested",
      patient_id: patientId,
      admission_id: admissionId,
      provider_entity_id: providerEntityId,
      location_id: locationId,
    });
    expect(row.data).toMatchObject({
      skuId: hcpcsSku,
      hcpcs: "E0260",
      hcpcsModifiers: [],
      quantity: 1,
      rentalCadence: "monthly",
      needsInstallation: true,
      needsPatientEducation: false,
      deliveryAddress: { line1: STREET, city: "Portland", state: "OR", postalCode: "97000" },
    });
    expect((row.data.deliveryAddress as { capturedAt?: string }).capturedAt).toBeTruthy();

    const events = await outboxOf(row.id);
    const names = events.map((e) => e.event_type);
    expect(names).toContain("m21.supply_request.status_changed");
    expect(names).not.toContain("m21.supply_request.created_from_external"); // §7.1 acceptance 3
    const created = events.find((e) => e.event_type === "m21.supply_request.status_changed");
    expect(created?.payload).toMatchObject({
      fromStatus: null,
      toStatus: "requested",
      sourceOrderId: order,
    });
    // the event M21 emits does not leak the address either
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(STREET);
    // and the source event was delivered (settled as done), not left pending
    expect((await fulfillmentEventRow(order)).status).toBe("dispatched");
  });

  it("a signed supply.v2 order defaults the unit from the catalog and carries the SKU's HCPCS", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(
      patientId,
      admissionId,
      "supply",
      { skuId: supplySku, quantity: 3 },
      "supply.v2",
    );
    await dispatcher.tick();
    const rows = await requestsFor(order);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "supply", status: "requested" });
    expect(rows[0]?.data).toMatchObject({
      skuId: supplySku,
      hcpcs: "A4620",
      quantity: 3,
      unit: "box",
    });
  });

  it("a supply.v2 order on a non-billable SKU (no HCPCS) opens a request with no hcpcs — supply's is optional", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(
      patientId,
      admissionId,
      "supply",
      { skuId: noHcpcsSku, quantity: 2, unit: "pair" },
      "supply.v2",
    );
    await dispatcher.tick();
    const rows = await requestsFor(order);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.hcpcs).toBeUndefined();
    expect(rows[0]?.data).toMatchObject({ unit: "pair" });
  });

  it("is idempotent on sourceOrderId: a redelivery and two CONCURRENT deliveries write exactly one row", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 1 },
      "dme.v2",
    );
    await dispatcher.tick();
    expect(await requestsFor(order)).toHaveLength(1);
    const again = await runDirect(order);
    expect(again).toMatchObject({ kind: "settled", reason: "already_applied" });

    const second = await seedPatientAdmission({});
    const order2 = await signedOrder(
      second.patientId,
      second.admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 2 },
      "dme.v2",
    );
    const results = await Promise.all([runDirect(order2), runDirect(order2)]);
    expect(results.filter((r) => r.kind === "opened")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "settled")).toHaveLength(1);
    expect(await requestsFor(order2)).toHaveLength(1);
  });

  it("SETTLES (no row, delivered once, no retry loop) on an order with no v2 contract — a v1 open blob", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    // The default stamp is dme.v1 (an open object): older orders keep signing and validating under v1.
    const order = await signedOrder(patientId, admissionId, "dme", { hcpcs: "E0260" });
    const outcome = await runDirect(order);
    expect(outcome).toMatchObject({ kind: "settled", reason: "order_contract_unresolved" });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(await requestsFor(order)).toHaveLength(0);
    const ev = await fulfillmentEventRow(order);
    expect(ev.status).toBe("dispatched");
    expect(ev.attempt_count).toBeLessThanOrEqual(1);
  });

  it("SETTLES on an unknown SKU, an inactive SKU, and a dme SKU with no HCPCS", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const unknown = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: randomUUID(), quantity: 1 },
      "dme.v2",
    );
    expect(await runDirect(unknown)).toMatchObject({ kind: "settled", reason: "sku_unresolved" });

    const inactiveSku = (
      await admin.query(
        `INSERT INTO supply_item (hcpcs, name, sku_class, default_unit, is_active)
           VALUES ('E1390','Retired concentrator','E','each', false) RETURNING id`,
      )
    ).rows[0].id as string;
    const inactive = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: inactiveSku, quantity: 1 },
      "dme.v2",
    );
    expect(await runDirect(inactive)).toMatchObject({ kind: "settled", reason: "sku_unresolved" });

    const noHcpcs = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: noHcpcsSku, quantity: 1 },
      "dme.v2",
    );
    expect(await runDirect(noHcpcs)).toMatchObject({
      kind: "settled",
      reason: "sku_unresolved",
      detail: "dme_sku_has_no_hcpcs",
    });
    for (const o of [unknown, inactive, noHcpcs]) expect(await requestsFor(o)).toHaveLength(0);
  });

  it("SETTLES when the patient has no primary address, or one with no 2-letter state", async () => {
    const none = await seedPatientAdmission({ address: null });
    const o1 = await signedOrder(
      none.patientId,
      none.admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 1 },
      "dme.v2",
    );
    expect(await runDirect(o1)).toMatchObject({ kind: "settled", reason: "address_unresolved" });

    const noState = await seedPatientAdmission({ address: { state: null } });
    const o2 = await signedOrder(
      noState.patientId,
      noState.admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 1 },
      "dme.v2",
    );
    expect(await runDirect(o2)).toMatchObject({ kind: "settled", reason: "address_unresolved" });
    await dispatcher.tick();
    expect(await requestsFor(o1)).toHaveLength(0);
    expect(await requestsFor(o2)).toHaveLength(0);
    expect((await fulfillmentEventRow(o1)).status).toBe("dispatched");
  });

  it("SETTLES a comfort_kit order with comfort_kit_contract_not_published (unbound kind), writing nothing", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(patientId, admissionId, "comfort_kit", {
      kitSku: "CK-STANDARD",
      deploymentSite: "home",
    });
    expect(await runDirect(order)).toMatchObject({
      kind: "settled",
      reason: "comfort_kit_contract_not_published",
    });
    await dispatcher.tick();
    expect(await requestsFor(order)).toHaveLength(0);
  });

  it("opens AND cancels (§7.1 edge 4) when the patient was discharged between M11's emit and M21's consume", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const order = await signedOrder(
      patientId,
      admissionId,
      "supply",
      { skuId: supplySku, quantity: 1 },
      "supply.v2",
    );
    await admin.query(
      "UPDATE admission SET status='discharged', discharged_at=current_date WHERE id=$1",
      [admissionId],
    );
    await dispatcher.tick();
    const rows = await requestsFor(order);
    expect(rows).toHaveLength(1);
    const row = rows[0] as NonNullable<(typeof rows)[number]>;
    expect(row.status).toBe("cancelled");
    expect(row.cancellation_reason).toMatch(/_pre_dispatch$/);
    const names = (await outboxOf(row.id)).map((e) => e.event_type);
    expect(names.filter((n) => n === "m21.supply_request.status_changed")).toHaveLength(2);
    expect(names).toContain("m21.supply_request.cancelled");
  });

  it("THROWS (retry, never settles) when the admission has no serving Location — the decider's dead-letter path", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({ sited: false });
    const order = await signedOrder(
      patientId,
      admissionId,
      "dme",
      { skuId: hcpcsSku, quantity: 1 },
      "dme.v2",
    );
    await expect(runDirect(order)).rejects.toMatchObject({
      code: "M21_SERVING_LOCATION_UNRESOLVED",
    });
    await dispatcher.tick();
    const ev = await fulfillmentEventRow(order);
    expect(ev.status).toBe("pending"); // retried, not dispatched
    expect(ev.attempt_count).toBeGreaterThanOrEqual(1);
    expect(await requestsFor(order)).toHaveLength(0);
  });

  it("older order kinds keep validating: an order created with NO kindVersion stays dme.v1, and an unsupported version is refused", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const v1 = await orderSvc.createDraft(ORG_A, memberId, {
      patientId,
      admissionId,
      kind: "dme" as never,
      drafterDiscipline: "rn_case_manager",
      data: { anything: { goes: true } },
      orderingPhysicianMdmId: PHYSICIAN_MDM,
    });
    const { rows } = await admin.query("SELECT kind_version FROM order_record WHERE id=$1", [
      v1.id,
    ]);
    expect(rows[0].kind_version).toBe("dme.v1");
    await expect(
      orderSvc.createDraft(ORG_A, memberId, {
        patientId,
        admissionId,
        kind: "dme" as never,
        drafterDiscipline: "rn_case_manager",
        data: {},
        orderingPhysicianMdmId: PHYSICIAN_MDM,
        kindVersion: "dme.v9",
      }),
    ).rejects.toThrow(/Unsupported order payload version/);
    await expect(
      orderSvc.createDraft(ORG_A, memberId, {
        patientId,
        admissionId,
        kind: "comfort_kit" as never,
        drafterDiscipline: "rn_case_manager",
        data: {},
        orderingPhysicianMdmId: PHYSICIAN_MDM,
        kindVersion: "comfort_kit.v2",
      }),
    ).rejects.toThrow(/Unsupported order payload version/);
  });

  it("a dme.v2 order that violates the contract cannot be signed (skuId/quantity required; no address may ride it)", async () => {
    const { patientId, admissionId } = await seedPatientAdmission({});
    const draft = await orderSvc.createDraft(ORG_A, memberId, {
      patientId,
      admissionId,
      kind: "dme" as never,
      drafterDiscipline: "rn_case_manager",
      data: { skuId: hcpcsSku, quantity: 1, deliveryAddress: { line1: STREET } },
      orderingPhysicianMdmId: PHYSICIAN_MDM,
      kindVersion: "dme.v2",
    });
    await expect(
      orderSvc.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" }),
    ).rejects.toThrow();
  });
});
