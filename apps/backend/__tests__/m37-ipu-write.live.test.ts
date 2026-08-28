/**
 * M37-T11 — the IPU write lifecycle proven against real Postgres. Drives the production
 * `buildDrizzleIpuRouteService` as the NOBYPASSRLS `wardenx_app` role: unit create, the admission
 * lifecycle (open → request-bed → assign-bed → discharge with the bed-cleaning cross-effects), the restraint
 * workflow (apply → reassess), and the `ipu_record` destruction eraser. Gated on a live DB:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m37:write:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eraseIpuRecord } from "../src/modules/37-ipu/eraser";
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";
const PATIENT = "55555555-5555-5555-5555-555555555555";
const PE = "66666666-6666-6666-6666-666666666666";

// ── F-069 — the fake M11 order register the restraint gate reads ──────────────────────────────────
//
// `hasOrderingOrder` used to be `body.orderingOrderId.length > 0`, so a restraint rested on whatever
// the caller typed. It resolves through `OrderProvider` now, and these four rows are the four answers
// that matter: a signed order for this patient, one for SOMEBODY ELSE, an unsigned draft, and an order
// naming no ordering physician.
const PHYSICIAN = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const OTHER_PATIENT = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const SIGNED_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffff01";
const OTHER_PATIENTS_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffff02";
const UNSIGNED_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffff03";
const ORDER_WITHOUT_PHYSICIAN = "ffffffff-ffff-4fff-8fff-ffffffffff04";
const UNKNOWN_ORDER = "ffffffff-ffff-4fff-8fff-ffffffffff99";

const ORDER_ROWS = new Map([
  [
    SIGNED_ORDER,
    {
      orderId: SIGNED_ORDER,
      patientId: PATIENT,
      status: "active",
      signedAt: "2026-08-27T09:00:00.000Z",
      orderingPhysicianMdmId: PHYSICIAN,
    },
  ],
  [
    OTHER_PATIENTS_ORDER,
    {
      orderId: OTHER_PATIENTS_ORDER,
      patientId: OTHER_PATIENT,
      status: "active",
      signedAt: "2026-08-27T09:00:00.000Z",
      orderingPhysicianMdmId: PHYSICIAN,
    },
  ],
  [
    UNSIGNED_ORDER,
    {
      orderId: UNSIGNED_ORDER,
      patientId: PATIENT,
      status: "draft",
      signedAt: null,
      orderingPhysicianMdmId: PHYSICIAN,
    },
  ],
  [
    ORDER_WITHOUT_PHYSICIAN,
    {
      orderId: ORDER_WITHOUT_PHYSICIAN,
      patientId: PATIENT,
      status: "active",
      signedAt: "2026-08-27T09:00:00.000Z",
      orderingPhysicianMdmId: null,
    },
  ],
]);
const ORDERS = {
  getOrder: async ({ orderId }: { orderId: string }) => ORDER_ROWS.get(orderId) ?? null,
};

const actor = {
  organizationId: ORG_A,
  userId: USER,
  roles: [] as string[],
  membershipId: MEMBER,
  stepUpRecent: true,
};
const readActor = { organizationId: ORG_A, userId: USER, roles: [] as string[] };

describe.skipIf(!DB_URL)("M37 IPU write lifecycle — LIVE Postgres (M37-T11)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof buildDrizzleIpuRouteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m37@x.test')`, [USER]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // NOOP outbox — this suite asserts state + effects. The `orders` seam is supplied because the
    // restraint gate now RESOLVES the physician order rather than checking the caller's string is
    // non-empty (F-069); `ORDERS` below is the fake M11 register.
    svc = buildDrizzleIpuRouteService(handle.db, { orders: ORDERS });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("creates a unit and lists it", async () => {
    const unit = await svc.createUnit(actor, { facilityId: PE, displayName: "IPU 1", bedCount: 4 });
    expect(unit.isActive).toBe(true);
    const list = await svc.listUnits(readActor);
    expect(list.map((u) => u.id)).toContain(unit.id);
  });

  it("walks the admission lifecycle open → request-bed → assign-bed → discharge with bed cross-effects", async () => {
    const [unit] = await svc.listUnits(readActor);
    if (!unit)
      throw new Error("expected the unit from the 'creates a unit and lists it' test to exist");
    // Seed a room + a ready bed + an RN-coverage window for the current hour (as admin).
    const roomId = (
      await admin.query(
        "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,'101','private',1) RETURNING id",
        [ORG_A, unit.id],
      )
    ).rows[0].id;
    const bedId = (
      await admin.query(
        "INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label,cleaning_status) VALUES ($1,$2,$3,'A','ready') RETURNING id",
        [ORG_A, roomId, unit.id],
      )
    ).rows[0].id;
    await admin.query(
      "INSERT INTO ipu_rn_coverage_window (organization_id,unit_id,hour_start_at,is_covered,rn_assignment_ids) VALUES ($1,$2,date_trunc('hour', now()),true,'{}')",
      [ORG_A, unit.id],
    );

    // open GIP admission (RN coverage active → passes the machine gate).
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "77777777-7777-7777-7777-777777777777",
      levelOfCarePeriodId: "88888888-8888-8888-8888-888888888888",
      providerEntityId: PE,
      unitId: unit.id,
      kind: "gip",
    });
    expect(adm.state).toBe("pending");

    const requested = await svc.requestBed(actor, adm.id, { unitId: unit.id });
    expect(requested.state).toBe("bed_pending");

    const assigned = await svc.assignBed(actor, adm.id, { bedId });
    expect(assigned.state).toBe("bed_assigned");
    // The bed is now reserved.
    const bedAfterAssign = (
      await admin.query("SELECT cleaning_status FROM ipu_bed WHERE id=$1", [bedId])
    ).rows[0];
    expect(bedAfterAssign.cleaning_status).toBe("reserved");

    // confirm() (bed_assigned → active) is the system-internal M6-ack route (§4.1 #15, not yet built); force
    // the state to `active` + the bed to `occupied` so the discharge path can be exercised end-to-end.
    await admin.query("UPDATE ipu_admission SET state='active' WHERE id=$1", [adm.id]);
    await admin.query("UPDATE ipu_bed SET cleaning_status='occupied' WHERE id=$1", [bedId]);

    const discharged = await svc.discharge(actor, adm.id, {
      reason: "to_home",
      dischargeEventExists: true,
    });
    expect(discharged.state).toBe("discharged");
    // The bed went discharged_dirty and the assignment ended.
    const bedAfterDc = (
      await admin.query("SELECT cleaning_status FROM ipu_bed WHERE id=$1", [bedId])
    ).rows[0];
    expect(bedAfterDc.cleaning_status).toBe("discharged_dirty");
    const ba = (
      await admin.query("SELECT ended_at FROM ipu_bed_assignment WHERE ipu_admission_id=$1", [
        adm.id,
      ])
    ).rows[0];
    expect(ba.ended_at).not.toBeNull();
  });

  it("blocks a GIP open when the unit is RN-uncovered (412)", async () => {
    const unit2 = await svc.createUnit(actor, {
      facilityId: "12121212-1212-4121-8121-121212121212",
      displayName: "IPU 2 (no coverage)",
      bedCount: 2,
    });
    await expect(
      svc.openAdmission(actor, {
        patientId: "99999999-9999-9999-9999-999999999999",
        admissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        levelOfCarePeriodId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        providerEntityId: PE,
        unitId: unit2.id,
        kind: "gip",
      }),
    ).rejects.toMatchObject({ code: "IPU_RN_COVERAGE_UNAVAILABLE", statusCode: 412 });
  });

  it("applies + reassesses a restraint", async () => {
    // Open an arranged admission (bypasses the coverage gate) to hang a restraint on.
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      levelOfCarePeriodId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      providerEntityId: PE,
      remoteFacilityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      kind: "arranged",
    });
    const restraint = await svc.applyRestraint(actor, adm.id, {
      restraintKind: "soft_limb",
      restraintJustificationText: "x".repeat(120),
      orderingOrderId: SIGNED_ORDER,
      category: "behavioral",
      reassessmentIntervalMinutes: 15,
    });
    expect(restraint.state).toBe("active");
    // F-069 — the ordering physician comes from the ORDER, not from a second uuid the caller sends.
    const { rows: stored } = await admin.query(
      "SELECT ordering_physician_id, ordering_order_id FROM ipu_restraint_event WHERE id=$1",
      [restraint.id],
    );
    expect(stored[0].ordering_physician_id).toBe(PHYSICIAN);
    expect(stored[0].ordering_order_id).toBe(SIGNED_ORDER);
    const reassessed = await svc.reassessRestraint(actor, restraint.id, {
      outcome: "release",
      nextDueAt: new Date().toISOString(),
    });
    expect(reassessed.state).toBe("released");
  });

  // TASK-050A/TEST-001 fix verification (was a universal-deny bug on the route guard; the fix moved
  // enforcement into applyRestraint itself, mirroring openAdmission/requestBed's existing pattern) —
  // proves the new check works BOTH ways on a real GIP admission, not just that `arranged` bypasses it
  // (the case above already covered that).
  it("applies a restraint on a GIP admission when the unit's RN coverage is active", async () => {
    const unit = await svc.createUnit(actor, {
      facilityId: "77777777-7777-4777-8777-777777777771",
      displayName: "IPU Restraint Coverage",
      bedCount: 1,
    });
    await admin.query(
      "INSERT INTO ipu_rn_coverage_window (organization_id,unit_id,hour_start_at,is_covered,rn_assignment_ids) VALUES ($1,$2,date_trunc('hour', now()),true,'{}')",
      [ORG_A, unit.id],
    );
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "11111111-2222-4222-8222-222222222222",
      levelOfCarePeriodId: "22222222-3333-4333-8333-333333333333",
      providerEntityId: PE,
      unitId: unit.id,
      kind: "gip",
    });
    const restraint = await svc.applyRestraint(actor, adm.id, {
      restraintKind: "posey_vest",
      restraintJustificationText: "x".repeat(120),
      orderingOrderId: SIGNED_ORDER,
      category: "medical",
      reassessmentIntervalMinutes: 120,
    });
    expect(restraint.state).toBe("active");
  });

  it("rejects a restraint on a GIP admission when the unit's RN coverage is inactive (412)", async () => {
    const unit = await svc.createUnit(actor, {
      facilityId: "77777777-7777-4777-8777-777777777772",
      displayName: "IPU Restraint No Coverage",
      bedCount: 1,
    });
    // No ipu_rn_coverage_window row inserted for this unit — an unbuilt coverage grid reads uncovered.
    // Open as `arranged` (bypasses openAdmission's own coverage gate — already proven separately by
    // the "blocks a GIP open when the unit is RN-uncovered" case above), then flip it to a GIP admission
    // on the uncovered unit directly, isolating applyRestraint's own check as the thing under test.
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "44444444-5555-4555-8555-555555555555",
      levelOfCarePeriodId: "66666666-7777-4777-8777-777777777777",
      providerEntityId: PE,
      remoteFacilityId: "77777777-8888-4888-8888-888888888888",
      kind: "arranged",
    });
    await admin.query(
      "UPDATE ipu_admission SET kind='gip', unit_id=$2, remote_facility_id=NULL WHERE id=$1",
      [adm.id, unit.id],
    );
    await expect(
      svc.applyRestraint(actor, adm.id, {
        restraintKind: "side_rail_4",
        restraintJustificationText: "x".repeat(120),
        orderingOrderId: SIGNED_ORDER,
        category: "medical",
        reassessmentIntervalMinutes: 120,
      }),
    ).rejects.toMatchObject({ code: "IPU_RN_COVERAGE_UNAVAILABLE", statusCode: 412 });
  });

  // ── F-069 · the CoP 418.110 physician-order requirement ─────────────────────────────────────────
  //
  // `validateRestraintApply` refuses without `hasOrderingOrder` and quotes the regulation, and the
  // service used to answer that with `body.orderingOrderId.length > 0`. Every case below passed before
  // this change — including the one where the order belongs to a different patient.
  it("refuses a restraint whose order does not exist, is another patient's, is unsigned, or names no physician", async () => {
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "99999999-1111-4111-8111-111111111111",
      levelOfCarePeriodId: "99999999-2222-4222-8222-222222222222",
      providerEntityId: PE,
      remoteFacilityId: "99999999-3333-4333-8333-333333333333",
      kind: "arranged",
    });
    const apply = (orderingOrderId: string) =>
      svc.applyRestraint(actor, adm.id, {
        restraintKind: "mitt",
        restraintJustificationText: "x".repeat(120),
        orderingOrderId,
        category: "medical",
        reassessmentIntervalMinutes: 120,
      });

    for (const orderId of [
      UNKNOWN_ORDER,
      OTHER_PATIENTS_ORDER,
      UNSIGNED_ORDER,
      ORDER_WITHOUT_PHYSICIAN,
    ]) {
      await expect(apply(orderId)).rejects.toMatchObject({ code: "RESTRAINT_ORDER_REQUIRED" });
    }

    // Nothing was written: a refused restraint leaves no row behind.
    const { rows } = await admin.query(
      "SELECT count(*)::int n FROM ipu_restraint_event WHERE ipu_admission_id=$1",
      [adm.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses a restraint when the order seam is unbound — unreadable is not absent", async () => {
    const unbound = buildDrizzleIpuRouteService(handle.db);
    const adm = await svc.openAdmission(actor, {
      patientId: PATIENT,
      admissionId: "99999999-4444-4444-8444-444444444444",
      levelOfCarePeriodId: "99999999-5555-4555-8555-555555555555",
      providerEntityId: PE,
      remoteFacilityId: "99999999-6666-4666-8666-666666666666",
      kind: "arranged",
    });
    await expect(
      unbound.applyRestraint(actor, adm.id, {
        restraintKind: "mitt",
        restraintJustificationText: "x".repeat(120),
        orderingOrderId: SIGNED_ORDER,
        category: "medical",
        reassessmentIntervalMinutes: 120,
      }),
    ).rejects.toThrow(/OrderProvider is not bound/);
  });

  it("erases the patient's IPU record under a destruction cert", async () => {
    const before = (
      await admin.query("SELECT count(*)::int n FROM ipu_admission WHERE patient_id=$1", [PATIENT])
    ).rows[0].n;
    expect(before).toBeGreaterThan(0);
    const erased = await eraseIpuRecord(handle.db, ORG_A, PATIENT);
    expect(erased).toBeGreaterThan(0);
    const after = (
      await admin.query("SELECT count(*)::int n FROM ipu_admission WHERE patient_id=$1", [PATIENT])
    ).rows[0].n;
    expect(after).toBe(0);
    // The restraint event (a satellite) is gone too.
    const re = (await admin.query("SELECT count(*)::int n FROM ipu_restraint_event", [])).rows[0].n;
    expect(re).toBe(0);
  });
});
