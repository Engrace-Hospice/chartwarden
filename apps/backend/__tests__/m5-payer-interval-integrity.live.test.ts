/**
 * #845 (audit CW-QA-0001) — LIVE Postgres proof that a rank holds exactly one coverage on any day, and that the billing
 * gates refuse a window whose primary payer is not the same coverage on every day.
 *
 * Runs as the real NOBYPASSRLS `chartwarden_app` role (the admin client only seeds and inspects):
 *   - migration 1291 repairs pre-existing overlaps deterministically (applied over legacy rows seeded BEFORE it runs);
 *   - a same-day, cross-kind replacement through the real M5 writer leaves one rank-1 coverage per day (the repro);
 *   - a payer switch strictly inside the window is seen (M23 and M41 refuse it);
 *   - two concurrent replacements at one rank: one wins, the other is a typed 409, and nothing overlaps;
 *   - the exclusion constraint itself rejects an overlapping row written directly (and admits an empty window);
 *   - M23 claim assembly refuses the transition-day window before any claim row is written.
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
import { buildClaimAssemblyService } from "../src/modules/23-billing-medicare/services/claim-assembly";
import { buildM23PatientPayerAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import { resolveCoverages } from "../src/modules/41-billing-commercial/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const REPAIR_MIGRATION = "1291_m5_patient_payer_rank_no_overlap.sql";
const ORG = "aaaaaaaa-0845-4000-8000-0000000000a1";
const LEGACY_ORG = "bbbbbbbb-0845-4000-8000-0000000000b1";
const STAFF = "d0000000-0845-4000-8000-000000000001";
const MEDICARE = "e0000000-0845-4000-8000-000000000001";
const COMMERCIAL = "e0000000-0845-4000-8000-000000000002";

describe.skipIf(!DB_URL)("#845 — patient_payer interval integrity — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;
  let reader: ReturnType<typeof buildPatientCoverageReader>;
  const legacy: Record<string, string> = {};

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
  ): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient_payer
         (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,'SUB',$6,$7) RETURNING id`,
      [patientId, LEGACY_ORG, MEDICARE, rank, kind, from, to],
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'cw845-legacy','L','L')",
      [LEGACY_ORG],
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
    expect(await overlappingPairs()).toBe(2);

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
    service = createDbPatientRouteService(handle.db, outbox as never);
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
    expect(transition).toEqual({ patientPayerId: commercial.id, medicarePrimary: false });
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
    expect(await m23.medicarePrimaryForRange(ORG, patientId, range)).toBeNull();

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

  it("two concurrent replacements at one rank: one wins, the other is a typed 409, nothing overlaps", async () => {
    const patientId = await seedPatient(ORG);
    await add(patientId, 1, "medicare_ffs", "2026-06-01");
    const results = await Promise.allSettled([
      add(patientId, 1, "commercial", "2026-06-10"),
      add(patientId, 1, "commercial", "2026-06-20"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PAYER_RANK_OVERLAP",
      statusCode: 409,
    });
    const rows = await admin.query(
      "SELECT count(*)::int AS n FROM patient_payer WHERE patient_id=$1 AND rank=1",
      [patientId],
    );
    expect(rows.rows[0].n).toBe(2);
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
});
