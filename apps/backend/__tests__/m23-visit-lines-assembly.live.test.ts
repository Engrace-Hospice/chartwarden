/**
 * Phase 3 (DDE/Stedi plan) — hospice claim-line assembly over REAL Postgres, as the NOBYPASSRLS `wardenx_app` role.
 *
 * `claim-assembly.ts` previously emitted only the level-of-care lines, billed CHC as one day-unit and added the SIA
 * add-on into the claim total. This proves the corrected assembly against the real schema (migration 1054 + the
 * `chargeMatches` / `unitPositive` CHECKs, the widened `claim_line_revenue_code` enum, the NPI columns), driving the
 * real `buildClaimAssemblyService` over fake reader seams:
 *   1. a billable RN visit becomes a dated 0551 / G0299 line in 15-minute units, after the per-diem line;
 *   2. CHC (0652) is one dated line per day in 15-minute units, and the billed total is the sum of the lines;
 *   3. a deceased patient's SIA stays out of the billed total (the claim balances) but in the expected payment;
 *   4. the attending / certifying NPIs persist, refresh without a version bump, and a malformed NPI is refused by
 *      the table CHECK;
 *   5. a billable visit with no documented duration fails the assembly closed (422) and persists nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:visit-lines-assembly:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BillingRuleRegistry,
  claimTotalMatchesLines,
  levelOfCareCoherence,
  placeOfServiceConsistency,
  repositories,
  visitLinesReportable,
} from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleVisitChargeService } from "../src/modules/23-billing-medicare/routes/visit-charge-service";
import {
  type ClaimAssemblyActor,
  type ClaimAssemblySeams,
  buildClaimAssemblyService,
} from "../src/modules/23-billing-medicare/services/claim-assembly";
import { buildM23ReferenceDataAdapter } from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";

const RATE_TABLE = {
  rhcDays1to60PerDiemCents: 20_000,
  rhcDays61PlusPerDiemCents: 16_000,
  chcHourlyRateCents: 6_250,
  ircPerDiemCents: 50_000,
  gipPerDiemCents: 100_000,
  rhcLaborShare: "0.6600",
  chcLaborShare: "0.6600",
  ircLaborShare: "0.5400",
  gipLaborShare: "0.6400",
} as const;

const physician = (npi: string, firstName?: string, lastName?: string) => ({
  npi,
  ...(firstName !== undefined && lastName !== undefined ? { firstName, lastName } : {}),
  status: "active" as const,
  licenseUnexpiredOnServiceDates: true,
});

describe.skipIf(!DB_URL)("M23 hospice claim-line assembly — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId: string;
  let membershipId: string;
  let actor: ClaimAssemblyActor;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'phase3@x.test')`, [USER]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'123456','Hospice A','1234567893','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    actor = { organizationId: ORG, userId: USER, membershipId, actorKind: "user" };
    // The tenant-entered visit-charge schedule (migration 1056) every visit is billed from, entered through the real
    // service as the app role.
    await buildDrizzleVisitChargeService(handle.db as never).createVisitCharge(
      { ...actor, roles: ["org_admin"], stepUpRecent: false },
      {
        providerEntityId,
        effectiveFrom: "2025-01-01",
        rnUnitChargeCents: 2_500,
        lpnUnitChargeCents: 2_400,
        aideUnitChargeCents: 1_500,
        mswUnitChargeCents: 3_000,
        ptUnitChargeCents: 3_500,
        otUnitChargeCents: 3_400,
        slpUnitChargeCents: 3_300,
      },
    );
  }, 180_000);

  afterAll(async () => {
    await handle.pool.end();
    await admin.end();
  });

  /** A happy-path seam bundle over fakes; every call opts into the scenario with `overrides`. */
  function seams(overrides: Partial<ClaimAssemblySeams> = {}): ClaimAssemblySeams {
    const registry = new BillingRuleRegistry();
    // The default rules that read claim lines: they must accept a claim that carries visit lines.
    for (const rule of [
      claimTotalMatchesLines,
      levelOfCareCoherence,
      placeOfServiceConsistency,
      visitLinesReportable,
    ])
      registry.registerRule(rule);
    registry.freeze();
    return {
      patientPayer: {
        medicarePrimaryForRange: async () => ({
          patientPayerId: randomUUID(),
          medicarePrimary: true,
        }),
      },
      admission: {
        resolveForRange: async () => ({
          admissionId: randomUUID(),
          hospiceAdmissionDate: "2025-11-01",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      electionPeriods: {
        coveringRange: async () => [
          {
            electionPeriodId: randomUUID(),
            sequence: 1,
            effectiveFrom: "2025-10-01",
            effectiveTo: null,
            revoked: false,
            revocationDate: null,
          },
        ],
      },
      certifications: { forPatient: async () => [] },
      faceToFace: { forPatient: async () => [] },
      levelOfCare: {
        periodsInRange: async () => [
          {
            levelOfCarePeriodId: randomUUID(),
            levelOfCare: "routine_home_care",
            from: "2025-11-01",
            to: "2025-11-07",
            chcDocumentedHours: null,
            gipAdmissionCriteriaDocumented: null,
          },
        ],
      },
      billableEncounters: { forRange: async () => [] },
      diagnoses: {
        forRange: async () => ({
          sequence: [],
          withheldForConsentCount: 0,
          terminalWithheldForConsent: false,
        }),
      },
      signedEncounters: { inWindow: async () => [] },
      evvCompliance: { bracketsForEncounters: async () => [] },
      mdm: {
        resolveProviderEntity: async () => ({
          ccn: "123456",
          macJurisdiction: "ngs_j6" as const,
          cbsaCode: null,
        }),
        resolveClinicalParticipants: async () => ({
          attending: null,
          hospicePhysician: null,
          placeOfService: "home",
        }),
      },
      terminology: { resolveForClaim: async () => ({ valueSetMembership: {}, icd10Billable: {} }) },
      capProjection: {
        projectionForOrg: async () => ({
          status: "unavailable",
          aggregateProjectedCents: null,
          aggregateCapCents: null,
          pctOfCap: null,
          ipuWithinCap: null,
        }),
        projectionForPatient: async () => ({
          status: "unavailable",
          projectedCapCents: null,
          capLimitCents: null,
          withinCap: null,
        }),
      },
      referenceData: {
        perDiemRateTable: async () => RATE_TABLE,
        chcHourlyRateCents: async () => 6_000,
        wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: null }),
        activeSequestrationPolicy: async () => ({
          sequestrationPolicyId: randomUUID(),
          percentage: "2.00",
          effectiveFrom: "2025-01-01",
          effectiveTo: null,
        }),
        // REAL: the windowed read of the schedule entered in beforeAll, under RLS as wardenx_app.
        visitChargeVersions: buildM23ReferenceDataAdapter(handle.db as never).visitChargeVersions,
      },
      ruleRegistry: registry,
      outbox: { publish: async () => {} },
      now: () => new Date("2025-11-10T00:00:00.000Z"),
      ...overrides,
    };
  }

  // A fresh patient per scenario: the claim / validation tables are append-only, so the suite never cleans up.
  const request = (serviceTo = "2025-11-07") => ({
    providerEntityId,
    patientId: randomUUID(),
    serviceFrom: "2025-11-01",
    serviceTo,
    tob: "812" as const,
  });

  const linesOf = async (claimId: string) =>
    (
      await admin.query(
        `SELECT line_number, revenue_code, hcpcs_code, unit_count, unit_rate_cents::int AS unit_rate_cents,
                line_charge_cents::int AS line_charge_cents,
                service_date_from::text AS service_date_from, backing_encounter_ids
           FROM claim_line WHERE claim_id = $1 ORDER BY line_number`,
        [claimId],
      )
    ).rows;

  it("persists an RN visit as a dated 0551/G0299 line in 15-minute units after the per-diem line", async () => {
    const encounterId = randomUUID();
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        billableEncounters: {
          forRange: async () => [
            {
              encounterId,
              serviceDate: "2025-11-03",
              billability: "billable",
              discipline: "rn",
              encounterType: "routine_visit",
              durationMinutes: 50,
            },
          ],
        },
      }),
    );

    const res = await svc.assemble(actor, request());

    expect(res.initialValidationOutcome).toBe("all_pass");
    const lines = await linesOf(res.claimId);
    expect(lines.map((l) => l.revenue_code)).toEqual(["0651", "0551"]);
    expect(lines[1]).toMatchObject({
      hcpcs_code: "G0299",
      service_date_from: "2025-11-03",
      unit_count: 3, // 50 minutes -> nearest 15-minute increment
      unit_rate_cents: 2_500, // the tenant's RN charge per 15-minute unit
      line_charge_cents: 7_500,
      backing_encounter_ids: [encounterId],
    });
    // The billed total is the per-diem line plus the informational visit charge (3 units x $25.00).
    expect(res.totalChargeCents).toBe(7 * 20_000 + 7_500);
  });

  it("bills CHC as one dated line per day in 15-minute units and balances the total to the lines", async () => {
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        levelOfCare: {
          periodsInRange: async () => [
            {
              levelOfCarePeriodId: randomUUID(),
              levelOfCare: "continuous_home_care",
              from: "2025-11-01",
              to: "2025-11-02",
              chcDocumentedHours: 10,
              gipAdmissionCriteriaDocumented: null,
            },
          ],
        },
      }),
    );

    const res = await svc.assemble(actor, request("2025-11-02"));

    const lines = await linesOf(res.claimId);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({
        revenue_code: "0652",
        unit_count: 40,
        unit_rate_cents: 1_563,
        line_charge_cents: 40 * 1_563,
      });
    }
    const claim = (
      await admin.query(
        "SELECT total_charge_cents::int AS charge, total_expected_payment_cents::int AS expected FROM claim WHERE id = $1",
        [res.claimId],
      )
    ).rows[0];
    expect(claim.charge).toBe(2 * 40 * 1_563);
    expect(claim.expected).toBe(122_500); // exact hourly basis, less 2% sequestration
    expect(res.initialValidationOutcome).toBe("all_pass");
  });

  it("keeps the SIA add-on out of the billed total but in the expected payment", async () => {
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        admission: {
          resolveForRange: async () => ({
            admissionId: randomUUID(),
            hospiceAdmissionDate: "2025-11-01",
            dischargeDate: null,
            dischargeReason: null,
            deceasedDate: "2025-11-07",
            placeOfDeath: null,
            transferOut: null,
          }),
        },
        signedEncounters: {
          inWindow: async () => [
            {
              encounterId: randomUUID(),
              serviceDate: "2025-11-06",
              discipline: "RN",
              signed: true as const,
              cosignRequired: false,
              cosigned: false,
              durationMinutes: 120,
            },
          ],
        },
      }),
    );

    const res = await svc.assemble(actor, request());

    const claim = (
      await admin.query(
        "SELECT total_charge_cents::int AS charge, total_expected_payment_cents::int AS expected FROM claim WHERE id = $1",
        [res.claimId],
      )
    ).rows[0];
    expect(claim.charge).toBe(140_000);
    expect(claim.expected).toBe(148_960); // (1,400.00 + 120.00 SIA) less 2%
    expect(res.initialValidationOutcome).toBe("all_pass");
  });

  it("persists the attending / certifying NPIs, refreshes them without a version bump, and refuses a malformed NPI", async () => {
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        mdm: {
          resolveProviderEntity: async () => ({
            ccn: "123456",
            macJurisdiction: "ngs_j6" as const,
            cbsaCode: null,
          }),
          resolveClinicalParticipants: async () => ({
            attending: physician("1234567893", "Ada", "Lovelace"),
            hospicePhysician: physician("1982736455", "Grace", "Hopper"),
            placeOfService: "home",
          }),
        },
        diagnoses: {
          forRange: async () => ({
            sequence: [
              { position: 2, code: "J449", relationship: "related" as const },
              { position: 1, code: "C3490", relationship: "terminal" as const },
            ],
            withheldForConsentCount: 0,
            terminalWithheldForConsent: false,
          }),
        },
      }),
    );
    const res = await svc.assemble(actor, request());

    const read = async () =>
      (
        await admin.query(
          "SELECT attending_physician_npi, certifying_physician_npi, version FROM claim WHERE id = $1",
          [res.claimId],
        )
      ).rows[0];
    expect(await read()).toMatchObject({
      attending_physician_npi: "1234567893",
      certifying_physician_npi: "1982736455",
      version: 0,
    });

    // Migration 1068 — the names and the diagnosis sequence are snapshotted on the same row, in the same transaction.
    expect(
      (
        await admin.query(
          `SELECT attending_physician_first_name AS af, attending_physician_last_name AS al,
                  certifying_physician_first_name AS cf, certifying_physician_last_name AS cl, diagnosis_snapshot AS dx
             FROM claim WHERE id = $1`,
          [res.claimId],
        )
      ).rows[0],
    ).toEqual({
      af: "Ada",
      al: "Lovelace",
      cf: "Grace",
      cl: "Hopper",
      dx: [
        { icd10Code: "C3490", sequence: 1, qualifier: "ABK" },
        { icd10Code: "J449", sequence: 2, qualifier: "ABF" },
      ],
    });
    const snapshot = await withOrgContext(
      handle.db,
      { organizationId: ORG, userId: USER },
      async (tx) => new repositories.ClaimRepository(tx as never).snapshotFor(res.claimId),
    );
    expect(snapshot?.diagnosisSnapshot).toHaveLength(2);

    // A re-validation re-resolves M40: a different attending, no separate certifying physician. The NPIs, names and
    // diagnosis sequence are rewritten together while the claim is VALIDATING (or READY).
    await admin.query("UPDATE claim SET state='VALIDATING' WHERE id=$1", [res.claimId]);
    const changed = await withOrgContext(
      handle.db,
      { organizationId: ORG, userId: USER },
      async (tx) =>
        new repositories.ClaimRepository(tx as never).refreshSnapshot(
          res.claimId,
          { attendingPhysicianNpi: "1245319599", certifyingPhysicianNpi: null },
          {
            attendingPhysicianFirstName: "Alan",
            attendingPhysicianLastName: "Turing",
            certifyingPhysicianFirstName: null,
            certifyingPhysicianLastName: null,
            diagnosisSnapshot: [{ icd10Code: "C787", sequence: 1, qualifier: "ABK" }],
          },
        ),
    );
    expect(changed).toBe(true);
    expect(await read()).toMatchObject({
      attending_physician_npi: "1245319599",
      certifying_physician_npi: null,
      version: 0,
    });
    expect(
      (
        await admin.query(
          `SELECT attending_physician_last_name AS al, certifying_physician_last_name AS cl, diagnosis_snapshot AS dx
             FROM claim WHERE id = $1`,
          [res.claimId],
        )
      ).rows[0],
    ).toEqual({
      al: "Turing",
      cl: null,
      dx: [{ icd10Code: "C787", sequence: 1, qualifier: "ABK" }],
    });

    await expect(
      admin.query("UPDATE claim SET attending_physician_npi = '12345' WHERE id = $1", [
        res.claimId,
      ]),
    ).rejects.toThrow(/claim_attending_physician_npi_chk/);
  });

  it("assembles WITHOUT the line and warns when a billable visit has no documented duration (never guessing units)", async () => {
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        billableEncounters: {
          forRange: async () => [
            {
              encounterId: "enc-no-duration",
              serviceDate: "2025-11-03",
              billability: "billable",
              discipline: "rn",
              encounterType: "routine_visit",
              durationMinutes: null,
            },
          ],
        },
      }),
    );

    const res = await svc.assemble(actor, request());

    expect(res.initialValidationOutcome).toBe("all_pass"); // a warning never fails the run
    expect((await linesOf(res.claimId)).map((l) => l.revenue_code)).toEqual(["0651"]);
    const { rows } = await admin.query(
      `SELECT r.outcome, r.severity, r.remediation FROM validation_result r
         JOIN validation_run v ON v.id = r.validation_run_id
        WHERE v.claim_id = $1 AND r.rule_key = 'visit_lines_reportable'`,
      [res.claimId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "warn", severity: "warn" });
    expect(rows[0].remediation.defects).toEqual([
      expect.objectContaining({
        code: "VISIT_DURATION_MISSING",
        refs: { encounterId: "enc-no-duration" },
      }),
    ]);
  });

  it("fails closed (422 VISIT_CHARGE_MISSING) and persists nothing when a billed discipline has no tenant charge", async () => {
    const svc = buildClaimAssemblyService(
      handle.db as never,
      seams({
        billableEncounters: {
          forRange: async () => [
            {
              encounterId: randomUUID(),
              serviceDate: "2025-11-03",
              billability: "billable",
              discipline: "chha",
              encounterType: "chha_visit",
              durationMinutes: 30,
            },
          ],
        },
        referenceData: {
          ...seams().referenceData,
          // no schedule version covers the claim window => no charge for the billed date
          visitChargeVersions: async () => [],
        },
      }),
    );

    const req = request();
    await expect(svc.assemble(actor, req)).rejects.toMatchObject({
      code: "VISIT_CHARGE_MISSING",
      statusCode: 422,
    });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM claim WHERE patient_id = $1",
      [req.patientId],
    );
    expect(rows[0].n).toBe(0);
  });
});
