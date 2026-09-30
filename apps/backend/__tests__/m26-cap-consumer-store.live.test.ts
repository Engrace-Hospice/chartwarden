/**
 * F-131 (#248) — LIVE Postgres proof of the Drizzle-backed `CapConsumerStore`
 * (`apps/backend/src/modules/26-cap/consumers/drizzle-store.ts`).
 *
 * `./handlers.ts`'s five §4.4 consumer handlers (`handleRemittancePosted`, `handleClaimReversed`,
 * `handleInpatientDay`, `handleFreeze`, `handleTransfer`) have been complete, pure and unit-tested since
 * they landed, with no store to drive — `cap_beneficiary_accrual.mbi_normalized` /
 * `.first_election_in_period` are NOT NULL and nothing in this repository ever resolved either fact for
 * a background consumer. This proves the real binding: the two new org-explicit read ports
 * (`mbiNormalizedForPatient` in M5, `firstElectionEffectiveDateInRangeForOrg` in M6) injected into the
 * new Drizzle store, the lazy `cap_beneficiary_accrual` row creation, idempotent line inserts on
 * redelivery, the `cap_inpatient_accrual` upsert-and-fold under two different revenue codes, freeze/weight
 * writes, the two honest no-op cases (no MBI on file; no cap_period open for the event's year), and
 * cross-tenant isolation on the injected ports themselves.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m26:cap-consumer-store:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capYearForDate, capYearWindow } from "@wardenx/cap-management";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstElectionEffectiveDateInRangeForOrg } from "../src/modules/06-admission/seams/cap-election-context";
import { createDrizzleCapConsumerStore } from "../src/modules/26-cap/consumers/drizzle-store";
import { handleClaimReversed } from "../src/modules/26-cap/consumers/handlers";
import { mbiNormalizedForPatient } from "../src/modules/05-patient/seams/mbi-reader";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT_A = "aaaaaaaa-0000-4000-8000-0000000000a1"; // has an MBI, an election in FY2026
const PATIENT_NO_MBI = "aaaaaaaa-0000-4000-8000-0000000000a2"; // no patient_identifier row at all
const MBI_A = "1EG4TE5MK73";

describe.skipIf(!DB_URL)("F-131 — M26 CapConsumerStore — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleCapConsumerStore>;
  let capYear: string; // the CURRENT cap year, computed the same way the store does — no wall-clock flakiness
  let window: { startsOn: string; endsOn: string };

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

  async function accrualRow(organizationId: string, patientId: string) {
    const { rows } = await admin.query(
      `SELECT mbi_normalized, first_election_in_period, paid_cents, deceased_at, methodology_weight
         FROM cap_beneficiary_accrual WHERE organization_id = $1 AND patient_id = $2`,
      [organizationId, patientId],
    );
    return rows[0] ?? null;
  }
  async function accrualLineCount(organizationId: string, patientId: string) {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM cap_beneficiary_accrual_line
         WHERE organization_id = $1 AND patient_id = $2`,
      [organizationId, patientId],
    );
    return Number(rows[0].n);
  }
  async function inpatientAccrual(organizationId: string, capPeriodId: string) {
    const { rows } = await admin.query(
      `SELECT gip_days, irc_days FROM cap_inpatient_accrual
         WHERE organization_id = $1 AND cap_period_id = $2`,
      [organizationId, capPeriodId],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();

    capYear = capYearForDate(new Date().toISOString().slice(0, 10));
    window = capYearWindow(capYear);

    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m26-consumer-store-a','M26 Consumer Store A','M26 Consumer Store A'),
              ($2,'m26-consumer-store-b','M26 Consumer Store B','M26 Consumer Store B')`,
      [ORG_A, ORG_B],
    );

    // cap_period for the CURRENT cap year — org A only. ccn is the '000000' sentinel `openPeriod` itself
    // still writes (§4.4 fallback); the store resolves by (org, cap_year) alone, matching that.
    await admin.query(
      `INSERT INTO cap_period (organization_id, ccn, cap_year, starts_on, ends_on,
         aggregate_cap_amount_cents, inpatient_cap_pct, status, opened_by)
       VALUES ($1,'000000',$2,$3,$4,3446534,0.2000,'open',gen_random_uuid())`,
      [ORG_A, capYear, window.startsOn, window.endsOn],
    );

    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1,$2,'MRN-CAP-A1','Cap','ConsumerA','1940-01-01','F','active'),
              ($3,$2,'MRN-CAP-A2','Cap','ConsumerA2','1941-02-02','M','active')`,
      [PATIENT_A, ORG_A, PATIENT_NO_MBI],
    );
    await admin.query(
      `INSERT INTO patient_identifier (organization_id, patient_id, kind, value, effective_from)
       VALUES ($1,$2,'mbi',$3,'2020-01-01')`,
      [ORG_A, PATIENT_A, MBI_A],
    );

    // One admission + one activated election period for PATIENT_A, effective mid-cap-year — the fact
    // firstElectionEffectiveDateInRangeForOrg reads.
    const { rows: adm } = await admin.query(
      `INSERT INTO admission (organization_id, patient_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [ORG_A, PATIENT_A],
    );
    const electionEffectiveAt = window.startsOn; // election started exactly at the cap-year open
    await admin.query(
      `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status, effective_at)
       VALUES ($1,$2,1,'ninety_day','active',$3)`,
      [ORG_A, adm[0].id, electionEffectiveAt],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    store = createDrizzleCapConsumerStore(handle.db, {
      mbi: { mbiNormalizedForPatient: (org, pt) => mbiNormalizedForPatient(handle.db, org, pt) },
      firstElection: {
        firstElectionEffectiveDateInRange: (org, pt, from, to) =>
          firstElectionEffectiveDateInRangeForOrg(handle.db, org, pt, from, to),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("records the first accrual line, lazily creating the roll-up row with the real MBI + first-election facts", async () => {
    const midYear = `${window.startsOn.slice(0, 4)}-11-15`; // safely inside the window
    const result = await store.recordAccrualLine({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-000000000001",
      amountCents: 500_000,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-01`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-15`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(result).toEqual({ recorded: true });

    const row = await accrualRow(ORG_A, PATIENT_A);
    expect(row).not.toBeNull();
    expect(row.mbi_normalized).toBe(MBI_A);
    expect(new Date(row.first_election_in_period).toISOString().slice(0, 10)).toBe(window.startsOn);
    expect(Number(row.paid_cents)).toBe(500_000);
    expect(await accrualLineCount(ORG_A, PATIENT_A)).toBe(1);
  });

  it("a second, distinct line for the same patient increments paid_cents rather than overwriting it", async () => {
    const midYear = `${window.startsOn.slice(0, 4)}-12-01`;
    const result = await store.recordAccrualLine({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-000000000002",
      amountCents: 250_000,
      serviceFrom: `${window.startsOn.slice(0, 4)}-12-01`,
      serviceTo: `${window.startsOn.slice(0, 4)}-12-01`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(result).toEqual({ recorded: true });

    const row = await accrualRow(ORG_A, PATIENT_A);
    expect(Number(row.paid_cents)).toBe(750_000); // 500,000 + 250,000
    expect(await accrualLineCount(ORG_A, PATIENT_A)).toBe(2);
  });

  it("a redelivery of the SAME source line is an idempotent no-op — no double count", async () => {
    const midYear = `${window.startsOn.slice(0, 4)}-11-15`;
    const result = await store.recordAccrualLine({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-000000000001", // same sourceId as the first test
      amountCents: 500_000,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-01`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-15`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(result).toEqual({ recorded: false });

    const row = await accrualRow(ORG_A, PATIENT_A);
    expect(Number(row.paid_cents)).toBe(750_000); // unchanged
    expect(await accrualLineCount(ORG_A, PATIENT_A)).toBe(2); // unchanged
  });

  it("a patient with no MBI on file records nothing — honest refusal, not a fabricated join key", async () => {
    const midYear = `${window.startsOn.slice(0, 4)}-11-20`;
    const result = await store.recordAccrualLine({
      organizationId: ORG_A,
      patientId: PATIENT_NO_MBI,
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-000000000099",
      amountCents: 100_000,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-20`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-20`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(result).toEqual({ recorded: false });
    expect(await accrualRow(ORG_A, PATIENT_NO_MBI)).toBeNull();
  });

  it("an event dated outside any open cap_period records nothing", async () => {
    const result = await store.recordAccrualLine({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-0000000000fe",
      amountCents: 100_000,
      serviceFrom: "2019-01-01",
      serviceTo: "2019-01-01",
      postedAt: "2019-01-15T00:00:00.000Z", // FY2019 — no cap_period seeded for it
    });
    expect(result).toEqual({ recorded: false });
  });

  it("cross-tenant: org B resolving org A's patient sees no MBI and records nothing", async () => {
    const result = await store.recordAccrualLine({
      organizationId: ORG_B,
      patientId: PATIENT_A, // org A's patient id, presented under org B
      sourceKind: "remittance",
      sourceId: "cccccccc-0000-4000-8000-0000000000fd",
      amountCents: 999_999,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-01`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-01`,
      postedAt: `${window.startsOn.slice(0, 4)}-11-01T00:00:00.000Z`,
    });
    expect(result).toEqual({ recorded: false }); // no org-B cap_period AND no org-B-visible MBI either way
    expect(await accrualRow(ORG_B, PATIENT_A)).toBeNull();
    // org A's own row is untouched by the cross-tenant attempt
    const rowA = await accrualRow(ORG_A, PATIENT_A);
    expect(Number(rowA.paid_cents)).toBe(750_000);
  });

  it("records inpatient days, folding a second revenue code into the SAME (org, period) roll-up", async () => {
    const midYear = `${window.startsOn.slice(0, 4)}-11-10`;
    const r1 = await store.recordInpatientDay({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceId: "dddddddd-0000-4000-8000-000000000001",
      revCode: "0656", // GIP
      days: 3,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-08`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-10`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(r1).toEqual({ recorded: true });

    const r2 = await store.recordInpatientDay({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceId: "dddddddd-0000-4000-8000-000000000002",
      revCode: "0655", // IRC
      days: 2,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-11`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-12`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(r2).toEqual({ recorded: true });

    const { rows: periodRows } = await admin.query(
      `SELECT id FROM cap_period WHERE organization_id = $1 AND cap_year = $2`,
      [ORG_A, capYear],
    );
    const acc = await inpatientAccrual(ORG_A, periodRows[0].id);
    expect(acc).toEqual({ gip_days: 3, irc_days: 2 });

    // redelivery of the first day-line is an idempotent no-op — no double count
    const replay = await store.recordInpatientDay({
      organizationId: ORG_A,
      patientId: PATIENT_A,
      sourceId: "dddddddd-0000-4000-8000-000000000001",
      revCode: "0656",
      days: 3,
      serviceFrom: `${window.startsOn.slice(0, 4)}-11-08`,
      serviceTo: `${window.startsOn.slice(0, 4)}-11-10`,
      postedAt: `${midYear}T00:00:00.000Z`,
    });
    expect(replay).toEqual({ recorded: false });
    const accAfterReplay = await inpatientAccrual(ORG_A, periodRows[0].id);
    expect(accAfterReplay).toEqual({ gip_days: 3, irc_days: 2 }); // unchanged
  });

  it("freezes the patient's accrual row on the (first) death/revocation date, idempotently", async () => {
    const frozenAt = `${window.startsOn.slice(0, 4)}-12-05`;
    const r1 = await store.freezePatient(ORG_A, PATIENT_A, `${frozenAt}T00:00:00.000Z`);
    expect(r1).toEqual({ frozen: true });
    let row = await accrualRow(ORG_A, PATIENT_A);
    expect(new Date(row.deceased_at).toISOString().slice(0, 10)).toBe(frozenAt);

    // a second freeze call (a later, redundant fact — e.g. m6.revocation.created after m5.patient.deceased)
    // does NOT overwrite the first-recorded freeze date
    const laterDate = `${window.startsOn.slice(0, 4)}-12-20`;
    const r2 = await store.freezePatient(ORG_A, PATIENT_A, `${laterDate}T00:00:00.000Z`);
    expect(r2).toEqual({ frozen: false });
    row = await accrualRow(ORG_A, PATIENT_A);
    expect(new Date(row.deceased_at).toISOString().slice(0, 10)).toBe(frozenAt); // unchanged
  });

  it("sets the proportional methodology weight, anchored on the current cap period", async () => {
    const result = await store.setProportionalWeight(ORG_A, PATIENT_A, 0.6543);
    expect(result).toEqual({ updated: true });
    const row = await accrualRow(ORG_A, PATIENT_A);
    expect(Number(row.methodology_weight)).toBeCloseTo(0.6543, 6);
  });

  // F-163 (#248) — M26's last originally-deferred pair: `m25.remittance.claim_recouped` now carries
  // `patientId`/`recoupedAmountCents`/`serviceFrom`/`serviceTo`, so `handleClaimReversed` (the SAME
  // handler `m23.claim.replaced`/`.voided` already bind to) can record a real negative reversal line
  // through the live Drizzle store end to end, not merely at the store layer.
  describe("handleClaimReversed (F-163) — the real handler, not just the store", () => {
    it("a claim_recouped-shaped payload posts a negative reversal line, reducing paid_cents", async () => {
      const before = await accrualRow(ORG_A, PATIENT_A);
      const midYear = `${window.startsOn.slice(0, 4)}-12-10`;
      const result = await handleClaimReversed(store, {
        organizationId: ORG_A,
        patientId: PATIENT_A,
        claimId: "eeeeeeee-0000-4000-8000-000000000001",
        recoupedAmountCents: 300_000,
        serviceFrom: `${window.startsOn.slice(0, 4)}-12-01`,
        serviceTo: `${window.startsOn.slice(0, 4)}-12-10`,
        postedAt: `${midYear}T00:00:00.000Z`,
      });
      expect(result).toEqual({ recorded: true });
      const after = await accrualRow(ORG_A, PATIENT_A);
      expect(Number(after.paid_cents)).toBe(Number(before.paid_cents) - 300_000);
      expect(await accrualLineCount(ORG_A, PATIENT_A)).toBeGreaterThan(0);
    });

    it("a redelivery of the SAME claimId is an idempotent no-op — no double reversal", async () => {
      const before = await accrualRow(ORG_A, PATIENT_A);
      const midYear = `${window.startsOn.slice(0, 4)}-12-10`;
      const result = await handleClaimReversed(store, {
        organizationId: ORG_A,
        patientId: PATIENT_A,
        claimId: "eeeeeeee-0000-4000-8000-000000000001", // same claimId as the prior test
        recoupedAmountCents: 300_000,
        serviceFrom: `${window.startsOn.slice(0, 4)}-12-01`,
        serviceTo: `${window.startsOn.slice(0, 4)}-12-10`,
        postedAt: `${midYear}T00:00:00.000Z`,
      });
      expect(result).toEqual({ recorded: false });
      const after = await accrualRow(ORG_A, PATIENT_A);
      expect(Number(after.paid_cents)).toBe(Number(before.paid_cents)); // unchanged
    });

    it("missing serviceFrom/serviceTo refuses rather than hitting the NOT NULL date columns", async () => {
      const before = await accrualRow(ORG_A, PATIENT_A);
      const result = await handleClaimReversed(store, {
        organizationId: ORG_A,
        patientId: PATIENT_A,
        claimId: "eeeeeeee-0000-4000-8000-000000000002",
        recoupedAmountCents: 100_000,
        postedAt: `${window.startsOn.slice(0, 4)}-12-11T00:00:00.000Z`,
        // serviceFrom/serviceTo intentionally omitted — the 835's DTM claim-service-period is optional
      });
      expect(result).toEqual({ recorded: false });
      const after = await accrualRow(ORG_A, PATIENT_A);
      expect(Number(after.paid_cents)).toBe(Number(before.paid_cents)); // untouched
    });

    it("an m23.claim.replaced/.voided-shaped payload (no patientId, no amount) still no-ops — F-131 confirmed still live", async () => {
      const before = await accrualRow(ORG_A, PATIENT_A);
      const result = await handleClaimReversed(store, {
        organizationId: ORG_A,
        originalClaimId: "eeeeeeee-0000-4000-8000-000000000003",
        replacementClaimId: "eeeeeeee-0000-4000-8000-000000000004",
        reason: "correction",
      });
      expect(result).toEqual({ recorded: false });
      const after = await accrualRow(ORG_A, PATIENT_A);
      expect(Number(after.paid_cents)).toBe(Number(before.paid_cents)); // untouched
    });
  });
});
