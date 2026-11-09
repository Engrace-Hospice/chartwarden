/**
 * #845 (audit CW-QA-0001) — LIVE Postgres proof that a rank holds exactly one coverage on any day, and that the billing
 * gates refuse a window whose primary payer is not the same coverage on every day.
 *
 * Runs as the real NOBYPASSRLS `chartwarden_app` role (the admin client only seeds and inspects):
 *   - migration 1291 repairs pre-existing overlaps deterministically (applied over legacy rows seeded BEFORE it runs),
 *     per tenant, reports every repaired row a claim references, keeps that row's id, and refuses an RLS-subject role;
 *   - a same-day, cross-kind replacement through the real M5 writer leaves one rank-1 coverage per day (the repro);
 *   - a payer switch strictly inside the window is seen (M23 and M41 refuse it);
 *   - two concurrent replacements at one rank: one wins, the other is a typed 409, and nothing overlaps;
 *   - the exclusion constraint itself rejects an overlapping row written directly (and admits an empty window);
 *   - M23 and M24 claim assembly refuse a window whose payer changes, before any claim row is written.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m5:payer-intervals:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { hasNonVoidMedicareClaimForPatientPayer } from "../src/modules/23-billing-medicare/index";
import { buildClaimAssemblyService } from "../src/modules/23-billing-medicare/services/claim-assembly";
import { buildM23PatientPayerAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import {
  buildDrizzleM24WriteService,
  buildM24MedicaidCoverageResolver,
  hasNonVoidMedicaidClaimForPatientPayer,
} from "../src/modules/24-billing-medicaid/index";
import {
  hasNonVoidCommercialClaimForPatientPayer,
  resolveCoverages,
} from "../src/modules/41-billing-commercial/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const REPAIR_MIGRATION = "1291_m5_patient_payer_rank_no_overlap.sql";
const ORG = "aaaaaaaa-0845-4000-8000-0000000000a1";
const LEGACY_ORG = "bbbbbbbb-0845-4000-8000-0000000000b1";
const LEGACY_ORG_B = "cccccccc-0845-4000-8000-0000000000c1";
const CLAIM_PE = "f0000000-0845-4000-8000-0000000000e1";
const STAFF = "d0000000-0845-4000-8000-000000000001";
const MEDICARE = "e0000000-0845-4000-8000-000000000001";
const COMMERCIAL = "e0000000-0845-4000-8000-000000000002";

const PATIENT_PAYER_CLAIM_REFERENCES = {
  async hasNonVoidClaim(
    tx: Parameters<typeof hasNonVoidMedicareClaimForPatientPayer>[0],
    organizationId: string,
    payerRowId: string,
  ) {
    if (await hasNonVoidMedicareClaimForPatientPayer(tx, organizationId, payerRowId)) return true;
    if (await hasNonVoidMedicaidClaimForPatientPayer(tx, organizationId, payerRowId)) return true;
    return hasNonVoidCommercialClaimForPatientPayer(tx, organizationId, payerRowId);
  },
};

describe.skipIf(!DB_URL)("#845 — patient_payer interval integrity — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;
  let reader: ReturnType<typeof buildPatientCoverageReader>;
  const legacy: Record<string, string> = {};
  const notices: string[] = [];
  let stampedClaimId = "";

  async function seedPatient(organizationId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Synthetic', 'Patient', '1950-01-01', 'female', 'active') RETURNING id`,
      [organizationId, `MRN-${Math.random().toString(36).slice(2, 10)}`],
    );
    return row.rows[0].id as string;
  }

  async function legacyRow(
    patientId: string,
    rank: number,
    kind: string,
    from: string,
    to: string | null,
    organizationId = LEGACY_ORG,
  ): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient_payer
         (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,'SUB',$6,$7) RETURNING id`,
      [patientId, organizationId, MEDICARE, rank, kind, from, to],
    );
    return row.rows[0].id as string;
  }

  const add = (patientId: string, rank: number, coverageKind: string, effectiveFrom: string) =>
    service.addPayer(
      ORG,
      patientId,
      {
        payerId: coverageKind === "medicare_ffs" ? MEDICARE : COMMERCIAL,
        rank,
        coverageKind,
        subscriberId: coverageKind === "medicare_ffs" ? "1EG4TE5MK73" : "MEM-1",
        effectiveFrom,
      },
      STAFF,
    );

  const datesOf = async (id: string) =>
    (
      await admin.query(
        "SELECT effective_from::text AS f, effective_to::text AS t FROM patient_payer WHERE id=$1",
        [id],
      )
    ).rows[0] as { f: string; t: string | null };

  const overlappingPairs = async () =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM patient_payer a JOIN patient_payer b
           ON a.organization_id=b.organization_id AND a.patient_id=b.patient_id AND a.rank=b.rank AND a.id < b.id
         WHERE (a.effective_to IS NULL OR a.effective_to >= a.effective_from)
           AND (b.effective_to IS NULL OR b.effective_to >= b.effective_from)
           AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')`,
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const cut = files.indexOf(REPAIR_MIGRATION);
    expect(cut).toBeGreaterThan(0);
    for (const f of files.slice(0, cut))
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    // Legacy rows, written the way the pre-#845 writer wrote them, BEFORE the repair migration runs.
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'cw845-legacy','L','L'), ($2,'cw845-legacy-b','LB','LB')",
      [LEGACY_ORG, LEGACY_ORG_B],
    );
    const p1 = await seedPatient(LEGACY_ORG);
    legacy.sameDayOld = await legacyRow(p1, 1, "medicare_ffs", "2026-01-01", "2026-01-15");
    legacy.sameDayNew = await legacyRow(p1, 1, "commercial", "2026-01-15", null);
    legacy.untouchedRank2 = await legacyRow(p1, 2, "medicaid", "2025-06-01", null);
    const p2 = await seedPatient(LEGACY_ORG);
    legacy.sameStartOld = await legacyRow(p2, 1, "medicare_ffs", "2026-02-01", "2026-02-01");
    legacy.sameStartNew = await legacyRow(p2, 1, "commercial", "2026-02-01", null);
    const p3 = await seedPatient(LEGACY_ORG);
    legacy.inverted = await legacyRow(p3, 1, "medicare_ffs", "2026-03-01", "2026-02-20");
    legacy.invertedSuccessor = await legacyRow(p3, 1, "commercial", "2026-02-20", null);
    // A second tenant: its own overlap, plus a row on org A's patient id that would overlap org A's rows if the repair
    // (or the constraint) ignored organization_id. Neither tenant's rows may move because of the other's.
    const pB = await seedPatient(LEGACY_ORG_B);
    legacy.orgBOld = await legacyRow(
      pB,
      1,
      "medicare_ffs",
      "2026-01-01",
      "2026-01-10",
      LEGACY_ORG_B,
    );
    legacy.orgBNew = await legacyRow(pB, 1, "commercial", "2026-01-10", null, LEGACY_ORG_B);
    legacy.orgBOnOrgAPatient = await legacyRow(
      p1,
      1,
      "commercial",
      "2026-01-05",
      "2026-01-20",
      LEGACY_ORG_B,
    );
    // A claim already stamped with the row the repair will shrink (default partition; no PHI).
    stampedClaimId = (
      await admin.query(
        `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         state, claim_control_number, mac_jurisdiction, total_expected_payment_cents,
         sequestration_applied_pct, sequestration_policy_id, created_by_membership_id, patient_status_code)
       VALUES ($1,$2,$3,$2,$2,$2,$4,'811','2026-01-01','2026-01-14','READY','cw845-1','ngs_j6',100000,'2.00',$2,$2,'01')
       RETURNING id`,
        [LEGACY_ORG, CLAIM_PE, p1, legacy.sameDayOld],
      )
    ).rows[0].id as string;
    expect(await overlappingPairs()).toBe(3);

    admin.on("notice", (n) => notices.push(n.message ?? ""));
    for (const f of files.slice(cut))
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'cw845','O','O')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s@cw845.test')`, [STAFF]);
    await admin.query(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [STAFF, ORG],
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // The real catalog-validating publisher: `m5.patient.payer_changed` must still validate on every replacement.
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: Parameters<typeof txPublisher.publish>[0], input: never) =>
        txPublisher.publish(tx, { ...(input as object), callerModule: "m5" } as never),
    };
    service = createDbPatientRouteService(handle.db, outbox as never, {
      payerClaimReferences: PATIENT_PAYER_CLAIM_REFERENCES,
    });
    reader = buildPatientCoverageReader(handle.db);
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("1291 repaired pre-existing overlaps by shrinking the earlier row, and left the rest alone", async () => {
    expect(await overlappingPairs()).toBe(0);
    expect(await datesOf(legacy.sameDayOld as string)).toEqual({
      f: "2026-01-01",
      t: "2026-01-14",
    });
    expect(await datesOf(legacy.sameDayNew as string)).toEqual({ f: "2026-01-15", t: null });
    expect(await datesOf(legacy.untouchedRank2 as string)).toEqual({ f: "2025-06-01", t: null });
    // Same start day: the earlier-created row shrinks to an empty window (never in force), its id kept.
    expect(await datesOf(legacy.sameStartOld as string)).toEqual({
      f: "2026-02-01",
      t: "2026-01-31",
    });
    expect(await datesOf(legacy.sameStartNew as string)).toEqual({ f: "2026-02-01", t: null });
    // An already-inverted legacy row is outside the constraint and untouched.
    expect(await datesOf(legacy.inverted as string)).toEqual({ f: "2026-03-01", t: "2026-02-20" });
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='patient_payer.update'",
      [LEGACY_ORG],
    );
    expect(audited.rows[0].n).toBe(2);
  });

  it("1291 repairs each tenant on its own: org B's rows never move org A's, nor the reverse", async () => {
    expect(await datesOf(legacy.orgBOld as string)).toEqual({ f: "2026-01-01", t: "2026-01-09" });
    expect(await datesOf(legacy.orgBNew as string)).toEqual({ f: "2026-01-10", t: null });
    // Would have been cut to 2026-01-14 by org A's successor if the partition ignored the tenant.
    expect(await datesOf(legacy.orgBOnOrgAPatient as string)).toEqual({
      f: "2026-01-05",
      t: "2026-01-20",
    });
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='patient_payer.update'",
      [LEGACY_ORG_B],
    );
    expect(audited.rows[0].n).toBe(1);
  });

  it("1291 reports a repaired row a claim references, keeps its id, and the claim still resolves it", async () => {
    const rowNotice = notices.find((m) => m.includes(legacy.sameDayOld as string));
    expect(rowNotice).toContain(`m23:${stampedClaimId}`);
    expect(rowNotice).toContain("2026-01-14");
    expect(notices).toContain(
      "1291 repair: 3 patient_payer row(s) shrunk, 1 of them referenced by a claim",
    );
    const claim = await admin.query("SELECT patient_payer_id FROM claim WHERE id=$1", [
      stampedClaimId,
    ]);
    expect(claim.rows[0].patient_payer_id).toBe(legacy.sameDayOld);
    const patientId = (
      await admin.query("SELECT patient_id FROM patient_payer WHERE id=$1", [legacy.sameDayOld])
    ).rows[0].patient_id as string;
    const coverages = await reader.coveragesForPatient({ organizationId: LEGACY_ORG, patientId });
    expect(coverages.find((c) => c.id === legacy.sameDayOld)).toMatchObject({
      coverageKind: "medicare_ffs",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-01-14",
    });
  });

  it("#874 gives every claim-reference refusal a tenant-leading payer-row index", async () => {
    const names = [
      "claim_org_patient_payer_ix",
      "medicaid_claim_org_patient_payer_ix",
      "commercial_claim_org_primary_patient_payer_ix",
      "commercial_claim_org_secondary_patient_payer_ix",
    ];
    const rows = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname='public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [names],
    );
    expect(rows.rows.map((row) => row.indexname).sort()).toEqual([...names].sort());
    for (const row of rows.rows) {
      expect(row.indexdef).toMatch(
        /\(organization_id, (patient_payer_id|primary_patient_payer_id|secondary_patient_payer_id)\)/,
      );
    }
    expect(
      rows.rows.find((row) => row.indexname === "commercial_claim_org_secondary_patient_payer_ix")
        ?.indexdef,
    ).toContain("WHERE (secondary_patient_payer_id IS NOT NULL)");
  });

  it("1291 refuses to run under an RLS-subject role instead of repairing zero rows", async () => {
    const app = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await app.connect();
    try {
      await expect(
        app.query(readFileSync(join(MIGRATIONS_DIR, REPAIR_MIGRATION), "utf8")),
      ).rejects.toThrow(/must run as a superuser \/ BYPASSRLS role/);
    } finally {
      await app.end();
    }
  });

  it("same-day cross-kind replacement: one rank-1 coverage per day, and M23 sees commercial on the transition date (the repro)", async () => {
    const patientId = await seedPatient(ORG);
    const ffs = await add(patientId, 1, "medicare_ffs", "2026-01-01");
    const commercial = await add(patientId, 1, "commercial", "2026-01-15");
    expect(await datesOf(ffs.id)).toEqual({ f: "2026-01-01", t: "2026-01-14" });

    const on = (coverageKind: string, onDate: string) =>
      reader.activeCoverageOfKind({ organizationId: ORG, patientId, coverageKind, onDate });
    expect(await on("medicare_ffs", "2026-01-15")).toBeNull();
    expect((await on("commercial", "2026-01-15"))?.id).toBe(commercial.id);
    expect((await on("medicare_ffs", "2026-01-14"))?.id).toBe(ffs.id);

    const m23 = buildM23PatientPayerAdapter(() => reader);
    const transition = await m23.medicarePrimaryForRange(ORG, patientId, {
      from: "2026-01-15",
      to: "2026-01-15",
    });
    expect(transition).toBeNull(); // no Medicare FFS row is in force that day: commercial is the only primary
    const before = await m23.medicarePrimaryForRange(ORG, patientId, {
      from: "2026-01-01",
      to: "2026-01-14",
    });
    expect(before).toEqual({ patientPayerId: ffs.id, medicarePrimary: true });
  });

  it("refuses a replacement that starts on or before the current row's start, leaving the row intact", async () => {
    const patientId = await seedPatient(ORG);
    const ffs = await add(patientId, 1, "medicare_ffs", "2026-04-01");
    await expect(add(patientId, 1, "commercial", "2026-04-01")).rejects.toMatchObject({
      code: "PAYER_REPLACEMENT_NOT_AFTER_CURRENT",
      statusCode: 409,
    });
    expect(await datesOf(ffs.id)).toEqual({ f: "2026-04-01", t: null });
  });

  it("#874 refuses a claimed payer row, then voids it as an audited empty window after the claim is void", async () => {
    const patientId = await seedPatient(ORG);
    const payer = await add(patientId, 1, "medicare_ffs", "2026-04-01");

    await expect(
      service.voidPayer(LEGACY_ORG, patientId, payer.id, "wrong_payer", STAFF),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(await datesOf(payer.id)).toEqual({ f: "2026-04-01", t: null });

    const claimId = (
      await admin.query(
        `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         state, claim_control_number, mac_jurisdiction, total_expected_payment_cents,
         sequestration_applied_pct, sequestration_policy_id, created_by_membership_id, patient_status_code)
       VALUES ($1,$2,$3,$2,$2,$2,$4,'811','2026-04-01','2026-04-30','READY',$5,'ngs_j6',100000,'2.00',$2,$2,'01')
       RETURNING id`,
        [ORG, CLAIM_PE, patientId, payer.id, `cw874-${crypto.randomUUID()}`],
      )
    ).rows[0].id as string;

    await expect(
      service.voidPayer(ORG, patientId, payer.id, "wrong_payer", STAFF),
    ).rejects.toMatchObject({ code: "PAYER_ROW_IN_USE", statusCode: 409 });
    expect(await datesOf(payer.id)).toEqual({ f: "2026-04-01", t: null });

    await admin.query("UPDATE claim SET state='VOIDED' WHERE id=$1", [claimId]);
    await expect(
      service.voidPayer(ORG, patientId, payer.id, "wrong_payer", STAFF),
    ).resolves.toMatchObject({
      id: payer.id,
      current: false,
      effectiveFrom: "2026-04-01",
      effectiveTo: "2026-03-31",
    });
    expect(await datesOf(payer.id)).toEqual({ f: "2026-04-01", t: "2026-03-31" });

    const auditRows = await admin.query(
      `SELECT severity, context FROM audit_event
       WHERE organization_id=$1 AND event_type='patient.payer_voided' AND resource_id=$2::uuid`,
      [ORG, payer.id],
    );
    expect(auditRows.rows).toEqual([
      expect.objectContaining({
        severity: "critical",
        context: expect.objectContaining({ payerRowId: payer.id, reason: "wrong_payer" }),
      }),
    ]);
    const outboxRows = await admin.query(
      `SELECT count(*)::int AS n FROM outbox_event
       WHERE organization_id=$1 AND event_type='m5.patient.payer_changed' AND aggregate_id=$2`,
      [ORG, patientId],
    );
    expect(outboxRows.rows[0].n).toBe(2);
  });

  it("interior-of-range payer switch: M23 and M41 both refuse a window whose primary changes inside it", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicare_ffs", "2026-05-01");
    await add(patientId, 1, "commercial", "2026-05-10");
    await add(patientId, 1, "medicare_ffs", "2026-05-20");
    const range = { from: "2026-05-01", to: "2026-05-31" };

    expect(await reader.coverageForRange({ organizationId: ORG, patientId, ...range })).toEqual({
      status: "changes",
      onDate: "2026-05-10",
    });
    const m23 = buildM23PatientPayerAdapter(() => reader);
    expect(await m23.medicarePrimaryForRange(ORG, patientId, range)).toMatchObject({
      medicarePrimary: false,
    });

    // M41's old endpoint sampling missed a rank-1 payer that starts AND ends inside the window over a rank-2 commercial plan.
    const m41Patient = await seedPatient(ORG);
    await add(m41Patient, 2, "commercial", "2026-05-01");
    await admin.query(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from, effective_to)
       VALUES ($1,$2,$3,1,'medicare_ffs','1EG4TE5MK73','2026-05-10','2026-05-12')`,
      [m41Patient, ORG, MEDICARE],
    );
    const q = { organizationId: ORG, patientId: m41Patient };
    const [coverages, primary] = await Promise.all([
      reader.coveragesForPatient(q),
      reader.coverageForRange({ ...q, ...range }),
    ]);
    expect(() => resolveCoverages(coverages, primary, range)).toThrow(
      expect.objectContaining({ code: "COVERAGE_CHANGES_IN_WINDOW" }),
    );
  });

  it("#877: a transaction-bound coverage snapshot blocks replacement until the claim transaction ends", async () => {
    const patientId = await seedPatient(ORG);
    const payer = await add(patientId, 1, "medicare_ffs", "2026-05-01");
    const updater = new Client({ connectionString: DB_URL });
    await updater.connect();
    try {
      await withOrgContext(handle.db, { organizationId: ORG, userId: STAFF }, async (tx) => {
        const snapshot = await reader.coverageSnapshotForRangeInTransaction(tx, {
          organizationId: ORG,
          patientId,
          from: "2026-05-01",
          to: "2026-05-31",
        });
        expect(snapshot.resolution).toMatchObject({
          status: "uniform",
          coverage: { id: payer.id },
        });

        await updater.query("BEGIN");
        await updater.query("SET LOCAL lock_timeout = '250ms'");
        await expect(
          updater.query("UPDATE patient_payer SET effective_to='2026-05-15' WHERE id=$1", [
            payer.id,
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
        await updater.query("ROLLBACK");
      });

      await updater.query("UPDATE patient_payer SET effective_to='2026-05-15' WHERE id=$1", [
        payer.id,
      ]);
      expect(await datesOf(payer.id)).toEqual({ f: "2026-05-01", t: "2026-05-15" });
    } finally {
      await updater.end();
    }
  });

  it("#877: the patient namespace lock blocks a higher-priority payer INSERT until the claim transaction ends", async () => {
    const patientId = await seedPatient(ORG);
    const secondary = await add(patientId, 2, "commercial", "2026-05-01");
    let pendingInsert: ReturnType<typeof add> | undefined;

    await withOrgContext(handle.db, { organizationId: ORG, userId: STAFF }, async (tx) => {
      const snapshot = await reader.coverageSnapshotForRangeInTransaction(tx, {
        organizationId: ORG,
        patientId,
        from: "2026-05-01",
        to: "2026-05-31",
      });
      expect(snapshot.resolution).toMatchObject({
        status: "uniform",
        coverage: { id: secondary.id, rank: 2 },
      });

      pendingInsert = add(patientId, 1, "medicare_ffs", "2026-05-01");

      // Wait for the real M5 writer to reach PostgreSQL and block on the patient-row namespace
      // lock. This proves the production path participates, without relying on a timing-only race.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const waits = await admin.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype='transactionid'",
        );
        blocked = waits.rows[0].n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    });

    await expect(pendingInsert).resolves.toMatchObject({ rank: 1, coverageKind: "medicare_ffs" });
    expect(
      await reader.coverageForRange({
        organizationId: ORG,
        patientId,
        from: "2026-05-01",
        to: "2026-05-31",
      }),
    ).toMatchObject({ status: "uniform", coverage: { rank: 1, coverageKind: "medicare_ffs" } });
  });

  it("two concurrent replacements at one rank serialize safely: each applies or returns a typed 409, nothing overlaps", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicare_ffs", "2026-06-01");
    const results = await Promise.allSettled([
      add(patientId, 1, "commercial", "2026-06-10"),
      add(patientId, 1, "commercial", "2026-06-20"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const result of lost) {
      const rejection = (result as PromiseRejectedResult).reason as {
        code?: string;
        statusCode?: number;
      };
      expect(rejection.statusCode).toBe(409);
      // The patient namespace lock serializes both writers. If June 20 wins first, June 10 is
      // rejected; if June 10 wins first, June 20 is a valid subsequent history row.
      expect(["PAYER_RANK_OVERLAP", "PAYER_REPLACEMENT_NOT_AFTER_CURRENT"]).toContain(
        rejection.code,
      );
    }
    const rows = await admin.query(
      "SELECT count(*)::int AS n FROM patient_payer WHERE patient_id=$1 AND rank=1",
      [patientId],
    );
    expect(rows.rows[0].n).toBe(1 + won.length);
    expect(await overlappingPairs()).toBe(0);
  });

  it("the exclusion constraint rejects an overlapping row written directly by the app role, and admits an empty window", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicare_ffs", "2026-07-01");
    const insert = (from: string, to: string | null) =>
      withOrgContext(handle.db, { organizationId: ORG, userId: STAFF }, (tx) =>
        tx.insert(schema.patientPayers).values({
          organizationId: ORG,
          patientId,
          payerId: COMMERCIAL,
          rank: 1,
          coverageKind: "commercial",
          subscriberId: "MEM-2",
          effectiveFrom: from,
          effectiveTo: to,
        }),
      );
    await expect(insert("2026-06-01", "2026-07-01")).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23P01",
        constraint: "patient_payer_rank_no_overlap",
      }),
    });
    await expect(insert("2026-06-01", "2026-06-30")).resolves.toBeDefined();
    await expect(insert("2026-07-05", "2026-07-04")).resolves.toBeDefined(); // empty window: never in force
  });

  it("M23 claim assembly refuses the transition-day window before writing any claim row", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicare_ffs", "2026-08-01");
    await add(patientId, 1, "commercial", "2026-08-15");
    const claimsBefore = (await admin.query("SELECT count(*)::int AS n FROM claim")).rows[0].n;
    const m23 = buildClaimAssemblyService(
      handle.db as never,
      { patientPayer: buildM23PatientPayerAdapter(() => reader) } as never,
    );
    await expect(
      m23.assemble(
        { organizationId: ORG, userId: STAFF, actorKind: "user" } as never,
        {
          providerEntityId: "f0000000-0845-4000-8000-000000000001",
          patientId,
          serviceFrom: "2026-08-01",
          serviceTo: "2026-08-31",
        } as never,
      ),
    ).rejects.toMatchObject({ code: "NON_MEDICARE_PRIMARY_PAYER", statusCode: 409 });
    expect((await admin.query("SELECT count(*)::int AS n FROM claim")).rows[0].n).toBe(
      claimsBefore,
    );
  });

  it("M24 claim assembly refuses a window whose Medicaid coverage changes mid-window, writing no claim", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicaid", "2026-09-01");
    await add(patientId, 1, "medicaid", "2026-09-16"); // e.g. a corrected recipient id: a new row mid-window
    const m24 = buildDrizzleM24WriteService(
      handle.db,
      undefined,
      undefined,
      buildM24MedicaidCoverageResolver(() => reader),
    );
    const assemble = (serviceFrom: string, serviceTo: string) =>
      m24.assembleClaim(
        { organizationId: ORG, userId: STAFF, roles: [] },
        {
          patientId,
          admissionId: "f0000000-0845-4000-8000-0000000000a2",
          providerEntityId: CLAIM_PE,
          serviceFrom,
          serviceTo,
          kind: "hospice_only",
        },
      );
    const before = (await admin.query("SELECT count(*)::int AS n FROM medicaid_claim")).rows[0].n;
    await expect(assemble("2026-09-01", "2026-09-30")).rejects.toMatchObject({
      code: "MEDICAID_COVERAGE_NOT_IN_FORCE",
      statusCode: 409,
    });
    // Coverage that ends mid-window (a gap) is refused the same way.
    const lapsed = await seedPatient(ORG);
    await admin.query(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from, effective_to)
       VALUES ($1,$2,$3,1,'medicaid','MCD-1','2026-09-01','2026-09-10')`,
      [lapsed, ORG, COMMERCIAL],
    );
    await expect(
      m24.assembleClaim(
        { organizationId: ORG, userId: STAFF, roles: [] },
        {
          patientId: lapsed,
          admissionId: "f0000000-0845-4000-8000-0000000000a3",
          providerEntityId: CLAIM_PE,
          serviceFrom: "2026-09-01",
          serviceTo: "2026-09-30",
          kind: "hospice_only",
        },
      ),
    ).rejects.toMatchObject({ code: "MEDICAID_COVERAGE_NOT_IN_FORCE" });
    expect((await admin.query("SELECT count(*)::int AS n FROM medicaid_claim")).rows[0].n).toBe(
      before,
    );
  });
});
