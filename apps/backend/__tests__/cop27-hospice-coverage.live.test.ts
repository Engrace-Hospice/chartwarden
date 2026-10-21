/**
 * COP27 workstream B (42 CFR 418.24(c)) — hospice coverage determinations on M12 `medication_order` and M21
 * `supply_request`, END TO END over real Postgres migrated from scratch (through 0385/0386), run as the REAL
 * NOBYPASSRLS `chartwarden_app` role (`_live-app-role.ts`), with the real catalog-validating outbox publisher.
 *
 * Proves:
 *   1. migrations default every existing row to `covered_related` with no determination instant
 *   2. M12 `setCoverageDetermination` writes the determination (session membership as determiner), emits a
 *      catalog-valid `m12.medication_order.coverage_determination_changed` outbox row, and an identical
 *      re-save writes no second row; a not-covered value without a reason is refused (422) with no write
 *   3. the DB CHECK backstops the app rule (not covered + blank reason is rejected by Postgres itself)
 *   4. a corrected order inherits its predecessor's determination (no silent reset off the addendum)
 *   5. M21 `setCoverageDetermination` on a dme request writes + emits; a comfort-kit request is refused (422)
 *   6. the seams list ONLY active not-covered rows for the admission (discontinued / cancelled excluded)
 *   7. cross-tenant isolation under the REAL RLS policy: org B can neither change org A's rows nor see them
 *      through either seam
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:cop27:hospice-coverage:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { NotFoundError, ValidationError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { listNonCoveredMedicationsForAdmission } from "../src/modules/12-dosespot/seams/non-covered-medications";
import {
  M21_OUTBOX_EVENTS,
  buildDrizzleM21ReadService,
  buildDrizzleM21WriteService,
} from "../src/modules/21-supplies/index";
import { SupplyStateError } from "../src/modules/21-supplies/lifecycle/index";
import type { M21WriteActor } from "../src/modules/21-supplies/routes/actor";
import type { WriteOutboxPort } from "../src/modules/21-supplies/routes/write-service";
import { listNonCoveredDmeSuppliesForAdmission } from "../src/modules/21-supplies/seams/non-covered-dme-supplies";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111111c7";
const ORG_B = "22222222-2222-2222-2222-2222222222c7";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-6666666666c7";
const REASON =
  "Cholesterol therapy is unrelated to the terminal illness and not needed for comfort.";

describe.skipIf(!DB_URL)("COP27 — hospice coverage determinations — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let m12: ReturnType<typeof createDbDoseSpotBackend>;
  let m21: ReturnType<typeof buildDrizzleM21WriteService>;
  const org: Record<
    string,
    { pe: string; loc: string; member: string; patient: string; adm: string }
  > = {};

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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
  async function seedOrder(o: string, status = "active"): Promise<string> {
    const s = org[o]!;
    return (
      await admin.query(
        `INSERT INTO medication_order (organization_id, patient_id, admission_id, med_class,
           drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,'standard','Atorvastatin','40 mg','tablet','oral','{}'::jsonb,$4,$5,$6::medication_order_status)
         RETURNING id`,
        [o, s.patient, s.adm, s.member, PHYSICIAN_MDM, status],
      )
    ).rows[0].id as string;
  }
  async function seedSupply(
    o: string,
    kind: "dme" | "supply" | "comfort_kit_deploy",
    status = "requested",
  ): Promise<{ id: string; updatedAt: string }> {
    const s = org[o]!;
    const { rows } = await admin.query(
      `INSERT INTO supply_request
         (organization_id, patient_id, admission_id, location_id, provider_entity_id,
          requested_by_membership_id, kind, data, status, routing_rule_resolved_jsonb)
       VALUES ($1,$2,$3,$4,$5,$6,$7::m21_supply_request_kind,'{"hcpcs":"E0601"}'::jsonb,
               $8::m21_supply_request_status,
               CASE WHEN $8::text = 'requested' THEN NULL ELSE '{}'::jsonb END)
       RETURNING id, updated_at`,
      [o, s.patient, s.adm, s.loc, s.pe, s.member, kind, status],
    );
    return { id: rows[0].id as string, updatedAt: (rows[0].updated_at as Date).toISOString() };
  }
  const actor = (o: string): M21WriteActor => ({
    organizationId: o,
    userId: "",
    membershipId: org[o]!.member as never,
    roles: ["rn_case_manager"],
    locationIds: [],
    stepUpRecent: true,
  });
  const outboxRows = async (eventType: string, aggregateId: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type = $1 AND aggregate_id = $2",
        [eventType, aggregateId],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'cop27-a','COP27 A','COP27 A'),($2,'cop27-b','COP27 B','COP27 B')`,
      [ORG_A, ORG_B],
    );
    for (const o of [ORG_A, ORG_B]) {
      const tag = o.slice(-4);
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [o, `CCN-${o.slice(0, 4)}`, `Hospice ${o.slice(0, 4)}`, `NPI-${o.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `cop27-${o.slice(0, 4)}-${tag}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, o],
        )
      ).rows[0].id as string;
      org[o] = { pe, loc, member, patient: randomUUID(), adm: randomUUID() };
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const publisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M21_OUTBOX_EVENTS]),
    );
    const m12Outbox: DoseSpotWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m12" }),
    };
    const m21Outbox: WriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m21" }),
    };
    m12 = createDbDoseSpotBackend(handle.db, m12Outbox, PASSING_M12_SAFETY_GATES);
    m21 = buildDrizzleM21WriteService(handle.db, buildDrizzleM21ReadService(handle.db), {
      outbox: m21Outbox,
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("defaults every row to covered_related with no determination instant", async () => {
    const orderId = await seedOrder(ORG_A);
    const order = await m12.getOrder(ORG_A, orderId);
    expect(order).toMatchObject({
      hospiceCoverage: "covered_related",
      coverageReason: null,
      coverageDeterminedAt: null,
      coverageDeterminedBy: null,
    });
    const req = await seedSupply(ORG_A, "dme");
    const { rows } = await admin.query(
      "SELECT hospice_coverage, coverage_determined_at FROM supply_request WHERE id = $1",
      [req.id],
    );
    expect(rows[0]).toMatchObject({
      hospice_coverage: "covered_related",
      coverage_determined_at: null,
    });
  });

  it("M12: refuses not-covered without a reason (422, no write), then sets it and emits exactly one event", async () => {
    const orderId = await seedOrder(ORG_A);
    await expect(
      m12.setCoverageDetermination(ORG_A, org[ORG_A]!.member, orderId, {
        hospiceCoverage: "not_covered_unrelated",
        reason: "  ",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await outboxRows("m12.medication_order.coverage_determination_changed", orderId),
    ).toHaveLength(0);

    const view = await m12.setCoverageDetermination(ORG_A, org[ORG_A]!.member, orderId, {
      hospiceCoverage: "not_covered_unrelated",
      reason: REASON,
    });
    expect(view).toMatchObject({
      hospiceCoverage: "not_covered_unrelated",
      coverageReason: REASON,
      coverageDeterminedBy: org[ORG_A]!.member,
      status: "active",
    });
    expect(view.coverageDeterminedAt).not.toBeNull();
    const rows = await outboxRows("m12.medication_order.coverage_determination_changed", orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(ORG_A);
    expect(rows[0].payload).toMatchObject({
      orgId: ORG_A,
      admissionId: org[ORG_A]!.adm,
      patientId: org[ORG_A]!.patient,
      sourceId: orderId,
      hospiceCoverage: "not_covered_unrelated",
      previousHospiceCoverage: "covered_related",
      reason: REASON,
    });

    // identical re-save → no second event
    await m12.setCoverageDetermination(ORG_A, org[ORG_A]!.member, orderId, {
      hospiceCoverage: "not_covered_unrelated",
      reason: REASON,
    });
    expect(
      await outboxRows("m12.medication_order.coverage_determination_changed", orderId),
    ).toHaveLength(1);
  });

  it("the DB CHECK backstops the rule (not covered + blank reason fails in Postgres)", async () => {
    const orderId = await seedOrder(ORG_A);
    await expect(
      admin.query(
        `UPDATE medication_order SET hospice_coverage = 'not_covered_other', coverage_reason = ' ',
           coverage_determined_at = now() WHERE id = $1`,
        [orderId],
      ),
    ).rejects.toThrow(/medication_order_coverage_reason_chk/);
    const req = await seedSupply(ORG_A, "comfort_kit_deploy");
    await expect(
      admin.query(
        `UPDATE supply_request SET hospice_coverage = 'not_covered_other', coverage_reason = 'x',
           coverage_determined_at = now() WHERE id = $1`,
        [req.id],
      ),
    ).rejects.toThrow(/m21_supply_request_coverage_kind/);
  });

  it("M21: sets a dme determination and emits; refuses a comfort-kit request (422)", async () => {
    const req = await seedSupply(ORG_A, "dme");
    const detail = await m21.setCoverageDetermination(actor(ORG_A), req.id, {
      expectedUpdatedAt: req.updatedAt,
      hospiceCoverage: "not_covered_unrelated",
      reason: "CPAP for long-standing sleep apnea, unrelated to the terminal illness.",
    });
    expect(detail).toMatchObject({
      hospiceCoverage: "not_covered_unrelated",
      coverageDeterminedBy: org[ORG_A]!.member,
    });
    const rows = await outboxRows("m21.supply_request.coverage_determination_changed", req.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      sourceId: req.id,
      previousHospiceCoverage: "covered_related",
    });

    const kit = await seedSupply(ORG_A, "comfort_kit_deploy");
    await expect(
      m21.setCoverageDetermination(actor(ORG_A), kit.id, {
        expectedUpdatedAt: kit.updatedAt,
        hospiceCoverage: "not_covered_other",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(SupplyStateError);
  });

  it("the seams list only ACTIVE not-covered rows for the admission", async () => {
    // fresh admission for a clean read
    const s = org[ORG_A]!;
    s.adm = randomUUID();
    const listed = await seedOrder(ORG_A, "active");
    const stopped = await seedOrder(ORG_A, "active");
    const covered = await seedOrder(ORG_A, "active");
    for (const id of [listed, stopped])
      await m12.setCoverageDetermination(ORG_A, s.member, id, {
        hospiceCoverage: "not_covered_unrelated",
        reason: REASON,
      });
    await admin.query("UPDATE medication_order SET status = 'discontinued' WHERE id = $1", [
      stopped,
    ]);
    const meds = await listNonCoveredMedicationsForAdmission(handle.db, ORG_A, s.adm);
    expect(meds.map((m) => m.sourceId)).toEqual([listed]);
    expect(meds[0]).toMatchObject({
      source: "medication",
      category: "drug",
      description: "Atorvastatin 40 mg tablet oral",
      reason: REASON,
      determinedByUserId: s.member,
    });
    expect(meds.map((m) => m.sourceId)).not.toContain(covered);

    const dme = await seedSupply(ORG_A, "dme");
    const gone = await seedSupply(ORG_A, "supply");
    for (const r of [dme, gone])
      await m21.setCoverageDetermination(actor(ORG_A), r.id, {
        expectedUpdatedAt: r.updatedAt,
        hospiceCoverage: "not_covered_other",
        reason: "Not reasonable and necessary for palliation.",
      });
    await admin.query("UPDATE supply_request SET status = 'cancelled' WHERE id = $1", [gone.id]);
    const items = await listNonCoveredDmeSuppliesForAdmission(handle.db, ORG_A, s.adm);
    expect(items.map((i) => i.sourceId)).toEqual([dme.id]);
    expect(items[0]).toMatchObject({
      source: "dme",
      category: "item",
      description: "Durable medical equipment (HCPCS E0601)",
    });
  });

  it("cross-tenant: org B can neither change nor see org A's determinations", async () => {
    const s = org[ORG_A]!;
    const orderId = await seedOrder(ORG_A);
    await m12.setCoverageDetermination(ORG_A, s.member, orderId, {
      hospiceCoverage: "not_covered_unrelated",
      reason: REASON,
    });
    await expect(
      m12.setCoverageDetermination(ORG_B, org[ORG_B]!.member, orderId, {
        hospiceCoverage: "covered_related",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const req = await seedSupply(ORG_A, "dme");
    await expect(
      m21.setCoverageDetermination(actor(ORG_B), req.id, {
        hospiceCoverage: "covered_related",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Even naming org A's admission, org B's seam read is RLS-empty.
    expect(await listNonCoveredMedicationsForAdmission(handle.db, ORG_B, s.adm)).toEqual([]);
    expect(await listNonCoveredDmeSuppliesForAdmission(handle.db, ORG_B, s.adm)).toEqual([]);
    const { rows } = await admin.query(
      "SELECT hospice_coverage FROM medication_order WHERE id = $1",
      [orderId],
    );
    expect(rows[0].hospice_coverage).toBe("not_covered_unrelated");
  });
});
