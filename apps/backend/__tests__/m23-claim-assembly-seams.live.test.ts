/**
 * M23 claim-assembly seam bindings — LIVE Postgres proof (#250, #251, F-119, F-121, F-122, F-123).
 *
 * `boot-assembly.ts` binds NINE of the eleven named `ClaimAssemblySeams` reader ports to real data:
 * `patientPayer` (M5), all FIVE M6 range-shaped seams (F-121, #251: `admission`, `electionPeriods`,
 * `certifications`, `faceToFace`, `levelOfCare`, over `claimAssemblyRangeContextForOrg`),
 * `billableEncounters`/`signedEncounters` (F-122, #251: M8, over `billableEncountersInRangeForOrg`/
 * `signedEncounterSnapshotsInRangeForOrg`), and — F-123 (#251) — `evvCompliance`, bridging M8's new
 * `encounterVisitIdsForOrg` and M18's new bulk `complianceStatesForVisitsForOrg`; `mdm.resolveProviderEntity`
 * and two of `referenceData`'s four methods are also real (#250). This proves each against real rows under
 * real RLS (`WARDENX_DEV_BYPASSRLS=0` discipline: this test connects as the migrated `wardenx_app` role via
 * `handle.db`, never the admin/superuser client used only to seed). F-122 also fixes a genuine,
 * previously-undocumented production defect: `EncounterReaderStore.encounterFacts` — and therefore
 * `BillableEncounterReader.billability` for EVERY caller, not only M23 — had been live-registered since
 * M8-T08 while still answering `[]` for any id, because the Drizzle store never overrode the in-memory
 * fallback's empty default (the F-093/F-100/F-103 shape again).
 *
 * The end-to-end `POST /claims/assemble` reachability boundary is unmoved by F-122/F-123 (stated, not
 * implied): it still fails at `referenceData.hippsRateTable` (no CMS per-diem rate file has ever been
 * loaded), which sits BEFORE `billableEncounters`/`signedEncounters`/`evvCompliance` in call order —
 * binding them is real, individually-verified progress on three more seam steps, not a further unblock of
 * the live wall.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-claim-assembly-seams.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { appRoleConnectionString } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { registerSeam } from "../src/bootstrap/index";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { claimAssemblyRangeContextForOrg } from "../src/modules/06-admission/index";
import {
  billableEncountersInRangeForOrg,
  createDrizzleEncounterReaderStore,
  encounterVisitIdsForOrg,
  signedEncounterSnapshotsInRangeForOrg,
} from "../src/modules/08-encounters/index";
import { complianceStatesForVisitsForOrg } from "../src/modules/18-evv/index";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { buildM23BootAssemblyService } from "../src/modules/23-billing-medicare/services/boot-assembly";
import {
  buildM23AdmissionRangeAdapters,
  buildM23BillableEncountersAdapter,
  buildM23EvvComplianceAdapter,
  buildM23MdmProviderEntityAdapter,
  buildM23PatientPayerAdapter,
  buildM23ReferenceDataAdapter,
  buildM23SignedEncountersAdapter,
} from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import type { ProviderCcnPort } from "../src/modules/23-billing-medicare/routes/write-service";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { WardenXError } from "@wardenx/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The same real `ProviderCcnPort` implementation `index.ts` binds against the SAME `tx` the adapter
 *  under test opens (its own `withOrgContext`), so these tests exercise the identical query production
 *  runs, not a stub. */
const testProviderCcnPort: ProviderCcnPort = {
  async ccnForProviderEntity(tx, organizationId, providerEntityId) {
    const [provider] = await (tx as DbClient)
      .select({ ccn: schema.providerEntities.ccn })
      .from(schema.providerEntities)
      .where(
        and(
          eq(schema.providerEntities.id, providerEntityId),
          eq(schema.providerEntities.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!provider) throw new WardenXError("NOT_FOUND", "provider CCN unavailable", 404);
    return provider.ccn;
  },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const U = "00000000-0000-0000-0000-0000000000ff";
// M6 admission actors (F-121, #251) — real `"user"` rows, since the M4 audit trigger dereferences
// `app.user_id` as an FK on every M6 write (the `m6-cop-document-renders.live.test.ts` precedent).
const M6_USER = "33333333-3333-3333-3333-333333333333";
const M6_MD = "66666666-6666-6666-6666-666666666666";
const M6_ATTENDING = "77777777-7777-7777-7777-777777777777";
/**
 * A 28-day range starting tomorrow (real wall-clock `now()`, not `admissionAt`) — `activateAdmission`
 * writes the election period's `effective_at` from `activatedAt = now()`, which no test input controls,
 * so a range hardcoded around a fixed calendar date would drift out of coverage as real time passes. Also
 * returns the CMS hospice fiscal year (Oct–Sep) that range's `from` falls in — the same
 * `hospiceFiscalYearStarting` rule `claim-assembly.ts` applies — for seeding a matching wage-index row.
 */
function futureClaimRange(): { range: { from: string; to: string }; fiscalYearStarting: number } {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() + 1);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 27);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fiscalYearStarting = from.getUTCMonth() + 1 >= 10 ? from.getUTCFullYear() : from.getUTCFullYear() - 1;
  return { range: { from: iso(from), to: iso(to) }, fiscalYearStarting };
}

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement: "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: "Metastatic non-small-cell lung cancer with progressive functional decline.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
} as const;

describe.skipIf(!DB_URL)("M23 claim-assembly seam bindings — LIVE Postgres (#250)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  async function seedOrg(orgId: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [orgId, slug, slug],
    );
  }

  async function seedProviderEntity(orgId: string, ccn: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, $2, 'Test Hospice', $3, 'enc', '0930') RETURNING id`,
      [orgId, ccn, `${ccn}0000001`],
    );
    return row.rows[0].id as string;
  }

  async function seedMacCredential(orgId: string, providerEntityId: string, jurisdiction: string) {
    await admin.query(
      `INSERT INTO mac_submitter_credential
         (organization_id, provider_entity_id, mac_jurisdiction, submitter_id, trading_partner_id,
          client_id, client_secret_cipher, client_secret_dek_version, set_by_membership_id)
       VALUES ($1, $2, $3, 'sub-1', 'tp-1', 'client-1', 'cipher-1', 1, $4)`,
      [orgId, providerEntityId, jurisdiction, U],
    );
  }

  async function seedWageIndex(ccn: string, fy: number, factor: string, cbsa: string | null) {
    await admin.query(
      `INSERT INTO wage_index_factor (ccn, fiscal_year_starting, cbsa_code, factor_decimal, load_source_ref)
       VALUES ($1, $2, $3, $4, 'test-fixture')`,
      [ccn, fy, cbsa, factor],
    );
  }

  async function seedSequestrationPolicy(
    orgId: string,
    providerEntityId: string,
    pct: string,
    effectiveFrom: string,
  ) {
    await admin.query(
      `INSERT INTO sequestration_policy
         (organization_id, provider_entity_id, percentage, effective_from, set_by_membership_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, providerEntityId, pct, effectiveFrom, U],
    );
  }

  async function seedPatient(orgId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Jane', 'Doe', '1950-01-01', 'female', 'active') RETURNING id`,
      [orgId, `mrn-${Math.random().toString(36).slice(2)}`],
    );
    return row.rows[0].id as string;
  }

  async function seedPatientPayer(
    orgId: string,
    patientId: string,
    rank: number,
    coverageKind: string,
    effectiveFrom: string,
  ) {
    await admin.query(
      `INSERT INTO patient_payer
         (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
       VALUES ($1, $2, $3, $4, $5, 'mbi-1', $6)`,
      [patientId, orgId, U, rank, coverageKind, effectiveFrom],
    );
  }

  /** A real membership for `encounter.authored_by_membership_id` (F-122, #251) — one user+membership
   *  per call, since these encounter tests do not otherwise need a stable identity. */
  async function seedMembership(orgId: string): Promise<string> {
    const userId = crypto.randomUUID();
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [userId, `${userId}@x.test`]);
    const row = await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [userId, orgId],
    );
    return row.rows[0].id as string;
  }

  /** A minimal `encounter` row (F-122, #251) — `admission_id` is a logical, unenforced reference, so any
   *  uuid is valid here; the two new M8 range reads never join through it. */
  async function seedEncounter(input: {
    orgId: string;
    providerEntityId: string;
    patientId: string;
    membershipId: string;
    discipline: string;
    status: string;
    serviceDate: string;
    startedAt?: string | null;
    endedAt?: string | null;
    visitId?: string | null;
  }): Promise<string> {
    const signedAt = ["signed", "cosign_pending", "cosigned"].includes(input.status) ? new Date() : null;
    // `encounter_vocab_pinned_when_finalized` requires a non-null vocab_version_id for every non-draft
    // status — an app-validated uuid, not a real FK (`vocab-version.ts`'s own schema comment).
    const vocabVersionId = input.status === "draft" ? null : crypto.randomUUID();
    // `encounter_voided_consistency` requires all three together for status='voided'.
    const voided = input.status === "voided";
    const row = await admin.query(
      `INSERT INTO encounter
         (organization_id, provider_entity_id, patient_id, admission_id, encounter_type, discipline,
          authored_by_membership_id, service_date, started_at, ended_at, status, signed_at,
          vocab_version_id, voided_at, voided_by, voided_reason, visit_id)
       VALUES ($1,$2,$3,$4,'routine_visit',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        input.orgId,
        input.providerEntityId,
        input.patientId,
        crypto.randomUUID(),
        input.discipline,
        input.membershipId,
        input.serviceDate,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.status,
        signedAt,
        vocabVersionId,
        voided ? new Date() : null,
        voided ? input.membershipId : null,
        voided ? "voided for the F-122 billability test fixture, forty-plus characters" : null,
        input.visitId ?? null,
      ],
    );
    return row.rows[0].id as string;
  }

  /** A `location` row (F-123, #251) — `evv_event.location_id` is NOT NULL. */
  async function seedLocation(providerEntityId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
      [providerEntityId, `Loc-${crypto.randomUUID()}`],
    );
    return row.rows[0].id as string;
  }

  /** An `evv_device` row (F-123, #251) — `m2_device_attestation_id` carries no SQL FK (app-validated). */
  async function seedEvvDevice(orgId: string, membershipId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
         m2_device_attestation_id)
       VALUES ($1,$2,'ios',$3,$4) RETURNING id`,
      [orgId, membershipId, `fp-${crypto.randomUUID()}`, crypto.randomUUID()],
    );
    return row.rows[0].id as string;
  }

  /** The `m18-evv-read-service.live.test.ts` precedent: `evv_event.visit_id`/`patient_id` carry NO SQL FK,
   *  so `visitId` is a plain literal — no real `visit` row is needed for these compliance reads (F-123,
   *  #251). `kind`: 'compliant' (check-in + check-out), 'unresolved_missing' (check-in only, an OPEN
   *  resolution), 'documented_missing' (check-in only, a CLOSED-attested resolution). */
  async function seedEvvChain(
    orgId: string,
    providerEntityId: string,
    locationId: string,
    deviceId: string,
    membershipId: string,
    visitId: string,
    patientId: string,
    kind: "compliant" | "unresolved_missing" | "documented_missing",
  ): Promise<void> {
    await admin.query(
      `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
         service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
         captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
         device_attestation_id_at_record)
       VALUES ($1,$2,$3,$4,$5,'check_in','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)`,
      [orgId, providerEntityId, locationId, visitId, patientId, membershipId, deviceId, crypto.randomUUID()],
    );
    if (kind === "compliant") {
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_out','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)`,
        [orgId, providerEntityId, locationId, visitId, patientId, membershipId, deviceId, crypto.randomUUID()],
      );
      return;
    }
    const status = kind === "unresolved_missing" ? "open" : "closed_clinician_attested";
    const resolvedFields =
      status === "open"
        ? { resolvedByMembershipId: null, resolvedAt: null, resolutionReason: null }
        : {
            resolvedByMembershipId: membershipId,
            resolvedAt: new Date(),
            resolutionReason: "attested by the clinician for the F-123 compliance test fixture, 40+ chars",
          };
    await admin.query(
      `INSERT INTO evv_missing_resolution
         (organization_id, visit_id, kind, detected_by_source, status, resolved_by_membership_id,
          resolved_at, resolution_reason)
       VALUES ($1,$2,'missing_checkout','sync_reconcile',$3,$4,$5,$6)`,
      [
        orgId,
        visitId,
        status,
        resolvedFields.resolvedByMembershipId,
        resolvedFields.resolvedAt,
        resolvedFields.resolutionReason,
      ],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await seedOrg(ORG_A, "org-a");
    await seedOrg(ORG_B, "org-b");
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f121a@x.test'),($2,'f121md@x.test'),($3,'f121at@x.test')`,
      [M6_USER, M6_MD, M6_ATTENDING],
    );

    // `_live-app-role.ts` (GAP-086): grants wardenx_app LOGIN + a password and PROVES the returned url
    // actually connects as the NOBYPASSRLS app role, not a superuser — a bare-superuser handle would
    // make every "never resolves another org's row" assertion below pass vacuously.
    const appConnectionString = await appRoleConnectionString(admin, DB_URL!);
    handle = createDbClient({ connectionString: appConnectionString });

    // M5's seam registry entry, so `getSeam("PatientCoverageReader")` resolves for real (the
    // adapter under test calls through the registry exactly as boot-assembly.ts does).
    registerSeam("PatientCoverageReader", buildPatientCoverageReader(handle.db));
    // The two M5 seams M6 intake consults (referral qualify/accept + activation readiness) — the
    // `_m6-admit.ts` precedent, over the same app-role handle.
    registerM5IntakeSeams(handle.db);
  }, 120_000);

  const admissionSvc = () =>
    createDbAdmissionRouteService(handle.db, undefined, undefined, {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    });

  /**
   * The real §418.24 chain through the production M6 write service — referral → qualify → accept →
   * election draft+sign → CTI draft+sign → activate — landing an ACTIVE admission with period 1's
   * `effective_at` set to `admissionAt`. `orgId` must be {@link ORG_A} or {@link ORG_B} (both have the
   * M6 actor users seeded); `providerEntityId` sites the election statement (F-100's `#44` precedent).
   */
  async function activeAdmissionForRange(
    orgId: string,
    patientId: string,
    providerEntityId: string,
    admissionAt: string,
  ): Promise<{ admissionId: string; periodId: string }> {
    const svc = admissionSvc();
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      organizationId: orgId,
      actorUserId: M6_USER,
      patientId,
      hospicePhysicianId: M6_MD,
      admissionAt,
    });
    const periods = await svc.listElectionPeriods(orgId, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      orgId,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      M6_USER,
    );
    const es = await svc.draftElectionStatement(orgId, admissionId, periodId, {
      electedProviderEntityId: providerEntityId,
      electedAttendingPhysicianId: M6_ATTENDING,
      waiverAcknowledged: true,
    });
    await svc.signElection(orgId, es.id, es.version, M6_USER, {
      signingPatientName: "Pat Patient",
      signingRole: "patient",
    });
    const cti = await svc.draftCti(
      orgId,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: M6_MD,
        attendingPhysicianId: M6_ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      M6_USER,
    );
    await svc.signCtiHospiceMd(orgId, cti.id, cti.version, M6_USER);
    const active = await svc.activateAdmission(orgId, admissionId, nor.version);
    expect(active.state).toBe("active");
    return { admissionId, periodId };
  }

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  describe("mdm.resolveProviderEntity", () => {
    it("resolves the real CCN + admin-configured MAC jurisdiction, cbsaCode null", async () => {
      const pe = await seedProviderEntity(ORG_A, "381234");
      await seedMacCredential(ORG_A, pe, "ngs_j6");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      const resolved = await adapter.resolveProviderEntity(ORG_A, pe);
      expect(resolved).toEqual({ ccn: "381234", macJurisdiction: "ngs_j6", cbsaCode: null });
    });

    it("returns null when the provider entity has no MAC submitter credential yet", async () => {
      const pe = await seedProviderEntity(ORG_A, "381235");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      expect(await adapter.resolveProviderEntity(ORG_A, pe)).toBeNull();
    });

    it("never resolves another org's provider entity (cross-tenant RLS isolation)", async () => {
      const peOrgB = await seedProviderEntity(ORG_B, "381236");
      await seedMacCredential(ORG_B, peOrgB, "cgs_j15");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      expect(await adapter.resolveProviderEntity(ORG_A, peOrgB)).toBeNull();
    });
  });

  describe("referenceData.wageIndexForCcn", () => {
    it("resolves a loaded CMS wage-index factor for (ccn, fiscal year)", async () => {
      await seedWageIndex("381237", 2026, "0.9234", "38900");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new WardenXError("SEAM_UNBOUND", "hipps", 503);
        },
        () => {
          throw new WardenXError("SEAM_UNBOUND", "chc", 503);
        },
      );
      expect(await adapter.wageIndexForCcn("381237", 2026)).toEqual({
        factorDecimal: "0.9234",
        cbsaCode: "38900",
      });
    });

    it("returns null (never fabricates a factor) for a CCN/FY the CMS file hasn't loaded", async () => {
      // NOTE: migration 0080_billing_m23_seed.sql pre-seeds 5 REPRESENTATIVE placeholder rows for
      // FY2026 (010001, 050002, 380001, 450003, 999999 — explicitly marked "not authoritative"), so a
      // real null-path proof must use a CCN/FY outside that fixed set, not assume the table is empty.
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      expect(await adapter.wageIndexForCcn("777777", 2026)).toBeNull();
    });
  });

  describe("referenceData.activeSequestrationPolicy", () => {
    it("resolves the policy in effect on the service date", async () => {
      const pe = await seedProviderEntity(ORG_A, "381238");
      await seedSequestrationPolicy(ORG_A, pe, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      const resolved = await adapter.activeSequestrationPolicy(ORG_A, pe, "2026-06-01");
      expect(resolved?.percentage).toBe("2.00");
      expect(resolved?.effectiveTo).toBeNull();
    });

    it("never resolves another org's sequestration policy (cross-tenant RLS isolation)", async () => {
      const peOrgB = await seedProviderEntity(ORG_B, "381239");
      await seedSequestrationPolicy(ORG_B, peOrgB, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(
        handle.db,
        () => {
          throw new Error("unreachable");
        },
        () => {
          throw new Error("unreachable");
        },
      );
      expect(await adapter.activeSequestrationPolicy(ORG_A, peOrgB, "2026-06-01")).toBeNull();
    });
  });

  describe("patientPayer.medicarePrimaryForRange", () => {
    it("resolves Medicare FFS as primary when rank 1 covers the whole range", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved?.medicarePrimary).toBe(true);
    });

    it("resolves Medicare FFS as NOT primary when it is rank 2 behind a commercial payer", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "commercial", "2020-01-01");
      await seedPatientPayer(ORG_A, patientId, 2, "medicare_ffs", "2020-01-01");
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved?.medicarePrimary).toBe(false);
    });

    it("returns null when no medicare_ffs coverage is in force across the whole range", async () => {
      const patientId = await seedPatient(ORG_A);
      const adapter = buildM23PatientPayerAdapter();
      const resolved = await adapter.medicarePrimaryForRange(ORG_A, patientId, {
        from: "2026-01-01",
        to: "2026-01-31",
      });
      expect(resolved).toBeNull();
    });
  });

  describe("M6 range seams: admission/electionPeriods/certifications/faceToFace/levelOfCare (F-121, #251)", () => {
    it("resolves the real admission + period + CTI + LOC period for a range the admission covers", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381250");
      const { admissionId, periodId } = await activeAdmissionForRange(
        ORG_A,
        patientId,
        pe,
        "2026-01-01T00:00:00.000Z",
      );
      await admissionSvc().changeLoc(
        ORG_A,
        admissionId,
        "routine_home_care",
        null,
        "2026-01-01T00:00:00.000Z",
        "initial LOC",
      );
      // `draftCti`'s real write path hardcodes `attending_md_id: null` regardless of any attending
      // named at draft (a separate, out-of-scope gap: this admission chain has no live way to capture
      // one) — set it directly to prove the READER reports "cosign required, not yet captured" honestly
      // when the fact DOES exist on the row, rather than asserting a false the write path can't produce.
      await admin.query(
        "UPDATE certification_of_terminal_illness SET attending_md_id=$1 WHERE election_period_id=$2",
        [M6_ATTENDING, periodId],
      );

      // NOTE: `activateAdmission` writes the election period's `effective_at` from `activatedAt = now()`
      // (real wall-clock time), NOT from the `admissionAt` this test requested — so the claim range has to
      // straddle "now", and `effectiveFrom` below is asserted as a real calendar date, not the requested
      // "2026-01-01" (that value stays `admission.hospiceAdmissionDate`'s own, unaffected column read).
      const { range } = futureClaimRange();
      const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, patientId, range);
      expect(ctx?.admission).toEqual({
        admissionId,
        hospiceAdmissionDate: "2026-01-01",
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
      });
      expect(ctx?.electionPeriods).toEqual([
        {
          electionPeriodId: periodId,
          sequence: 1,
          effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          effectiveTo: null,
          revoked: false,
          revocationDate: null,
        },
      ]);
      expect(ctx?.certifications).toHaveLength(1);
      expect(ctx?.certifications[0]).toMatchObject({
        electionPeriodSequence: 1,
        ctiSigned: true,
        // `draftCti` named an attending physician, so the co-sign is required — but `signCtiHospiceMd`
        // (the only signature this admission's real chain calls) never sets `attending_md_signed_at`, so
        // the honest read is "required, not (yet) captured" — a real fact, not a fabricated true.
        attendingCosignRequired: true,
        attendingCosigned: false,
      });
      expect(ctx?.certifications[0]?.ctiSignedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Period 1 never requires an F2F (only periods ≥ 3 do) and none was drafted — the honest empty list,
      // not a fabricated "not attested" row.
      expect(ctx?.faceToFace).toEqual([]);
      expect(ctx?.levelOfCarePeriods).toHaveLength(1);
      expect(ctx?.levelOfCarePeriods[0]).toEqual({
        levelOfCarePeriodId: expect.any(String),
        levelOfCare: "routine_home_care",
        from: "2026-01-01",
        to: range.to, // still open — clamped to the claim range's own end, not fabricated
        chcDocumentedHours: null,
        gipAdmissionCriteriaDocumented: null,
      });

      // Wrapped in the ClaimAssemblySeams shape the way `boot-assembly.ts` actually consumes it.
      const seams = buildM23AdmissionRangeAdapters({
        forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r),
      });
      expect(await seams.admission.resolveForRange(ORG_A, patientId, range)).toEqual(ctx?.admission);
      expect(await seams.levelOfCare.periodsInRange(ORG_A, patientId, range)).toEqual(
        ctx?.levelOfCarePeriods,
      );
    });

    it("returns null when no admission covers the range (before the admission started)", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381251");
      await activeAdmissionForRange(ORG_A, patientId, pe, "2026-01-01T00:00:00.000Z");
      const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, patientId, {
        from: "2025-01-01",
        to: "2025-01-31",
      });
      expect(ctx).toBeNull();
    });

    it("never resolves another org's admission (cross-tenant RLS isolation)", async () => {
      const patientIdB = await seedPatient(ORG_B);
      const peB = await seedProviderEntity(ORG_B, "381252");
      await activeAdmissionForRange(ORG_B, patientIdB, peB, "2026-01-01T00:00:00.000Z");
      const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_A, patientIdB, {
        from: "2026-02-01",
        to: "2026-02-28",
      });
      expect(ctx).toBeNull();
    });
  });

  describe("M8 range seams: billableEncounters/signedEncounters (F-122, #251)", () => {
    it("billableEncountersInRangeForOrg: billable / awaiting_cosignature / not_billable, honestly derived", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381260");
      const membershipId = await seedMembership(ORG_A);
      const range = { from: "2026-05-01", to: "2026-05-31" };

      const rnSigned = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-05-05",
      });
      const lpnAwaitingCosign = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "lpn",
        status: "cosign_pending",
        serviceDate: "2026-05-06",
      });
      const voided = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "voided",
        serviceDate: "2026-05-07",
      });
      // Never signed — excluded from the result entirely, not reported as "not_billable" (F-122's own
      // scoping: a draft has no clinical content a claim line could point at).
      await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "draft",
        serviceDate: "2026-05-08",
      });

      const rows = await billableEncountersInRangeForOrg(handle.db, ORG_A, pe, patientId, range);
      const byId = new Map(rows.map((r) => [r.encounterId, r]));
      expect(byId.get(rnSigned)).toMatchObject({ billable: true });
      expect(byId.get(lpnAwaitingCosign)).toMatchObject({
        billable: false,
        reason: "awaiting_cosignature",
      });
      expect(byId.get(voided)).toMatchObject({ billable: false, reason: "voided" });
      expect(rows).toHaveLength(3); // the draft row is absent

      // Wrapped in the ClaimAssemblySeams shape the way `boot-assembly.ts` actually consumes it.
      const seam = buildM23BillableEncountersAdapter({
        inRange: (orgId, providerEntityId, pid, r) =>
          billableEncountersInRangeForOrg(handle.db, orgId, providerEntityId, pid, r),
      });
      const snapshots = await seam.forRange(ORG_A, pe, patientId, range);
      const snapById = new Map(snapshots.map((s) => [s.encounterId, s]));
      expect(snapById.get(rnSigned)?.billability).toBe("billable");
      expect(snapById.get(lpnAwaitingCosign)?.billability).toBe("awaiting_cosignature");
      expect(snapById.get(voided)?.billability).toBe("not_billable"); // M8's 4 reasons collapse to 3
    });

    it("never resolves another org's encounters (cross-tenant RLS isolation)", async () => {
      const patientIdB = await seedPatient(ORG_B);
      const peB = await seedProviderEntity(ORG_B, "381261");
      const membershipIdB = await seedMembership(ORG_B);
      await seedEncounter({
        orgId: ORG_B,
        providerEntityId: peB,
        patientId: patientIdB,
        membershipId: membershipIdB,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-05-05",
      });
      const rows = await billableEncountersInRangeForOrg(handle.db, ORG_A, peB, patientIdB, {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      expect(rows).toEqual([]);
    });

    it("signedEncounterSnapshotsInRangeForOrg: real duration minutes, discipline-derived cosignRequired", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381262");
      const membershipId = await seedMembership(ORG_A);
      const range = { from: "2026-06-01", to: "2026-06-30" };

      const rnWithBracket = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-06-10",
        startedAt: "2026-06-10T14:00:00.000Z",
        endedAt: "2026-06-10T15:30:00.000Z", // 90 minutes
      });
      const lpnCosignedNoBracket = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "lpn",
        status: "cosigned",
        serviceDate: "2026-06-11",
      });

      const rows = await signedEncounterSnapshotsInRangeForOrg(handle.db, ORG_A, patientId, range);
      const byId = new Map(rows.map((r) => [r.encounterId, r]));
      expect(byId.get(rnWithBracket)).toMatchObject({
        discipline: "rn",
        signed: true,
        cosignRequired: false, // rn is not in COSIGN_REQUIRED_DISCIPLINES
        cosigned: false,
        durationMinutes: 90,
      });
      expect(byId.get(lpnCosignedNoBracket)).toMatchObject({
        discipline: "lpn",
        signed: true,
        cosignRequired: true, // lpn IS in COSIGN_REQUIRED_DISCIPLINES
        cosigned: true,
        durationMinutes: 0, // no bracket — a documentation gap, never fabricated
      });

      // Wrapped in the ClaimAssemblySeams shape.
      const seam = buildM23SignedEncountersAdapter({
        inRange: (orgId, pid, r) => signedEncounterSnapshotsInRangeForOrg(handle.db, orgId, pid, r),
      });
      expect(await seam.inWindow(ORG_A, patientId, range)).toEqual(rows);
    });

    it("encounterFacts (F-122): the general BillableEncounterReader.billability seam is no longer a no-op", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381263");
      const membershipId = await seedMembership(ORG_A);
      const volunteerEncounter = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "volunteer",
        status: "signed",
        serviceDate: "2026-07-01",
      });
      const store = createDrizzleEncounterReaderStore(handle.db);
      const facts = await runWithRequestContext({ organizationId: ORG_A, userId: membershipId }, () =>
        store.encounterFacts([volunteerEncounter]),
      );
      // Before F-122 this was always `[]` regardless of the id — the store never overrode the in-memory
      // fallback's empty default.
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ encounterId: volunteerEncounter, discipline: "volunteer" });
    });
  });

  describe("evvCompliance: the M8→M18 bridge (F-123, #251)", () => {
    it("bracketsForEncounters: compliant / unresolved_missing / documented_missing / not_required", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381270");
      const membershipId = await seedMembership(ORG_A);
      const locationId = await seedLocation(pe);
      const deviceId = await seedEvvDevice(ORG_A, membershipId);

      const compliantVisit = crypto.randomUUID();
      const unresolvedVisit = crypto.randomUUID();
      const documentedVisit = crypto.randomUUID();
      await seedEvvChain(ORG_A, pe, locationId, deviceId, membershipId, compliantVisit, patientId, "compliant");
      await seedEvvChain(
        ORG_A,
        pe,
        locationId,
        deviceId,
        membershipId,
        unresolvedVisit,
        patientId,
        "unresolved_missing",
      );
      await seedEvvChain(
        ORG_A,
        pe,
        locationId,
        deviceId,
        membershipId,
        documentedVisit,
        patientId,
        "documented_missing",
      );

      const compliantEncounter = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-08-01",
        visitId: compliantVisit,
      });
      const unresolvedEncounter = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-08-02",
        visitId: unresolvedVisit,
      });
      const documentedEncounter = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-08-03",
        visitId: documentedVisit,
      });
      // No visit at all — an ad-hoc encounter. `not_required`, not a fabricated verdict.
      const adHocEncounter = await seedEncounter({
        orgId: ORG_A,
        providerEntityId: pe,
        patientId,
        membershipId,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-08-04",
        visitId: null,
      });

      const seam = buildM23EvvComplianceAdapter(
        { forEncounters: (orgId, ids) => encounterVisitIdsForOrg(handle.db, orgId, ids) },
        { forVisits: (orgId, ids) => complianceStatesForVisitsForOrg(handle.db, orgId, ids) },
      );
      const snapshots = await seam.bracketsForEncounters(ORG_A, [
        compliantEncounter,
        unresolvedEncounter,
        documentedEncounter,
        adHocEncounter,
      ]);
      const byId = new Map(snapshots.map((s) => [s.encounterId, s.bracketState]));
      expect(byId.get(compliantEncounter)).toBe("compliant");
      expect(byId.get(unresolvedEncounter)).toBe("unresolved_missing");
      expect(byId.get(documentedEncounter)).toBe("documented_missing");
      expect(byId.get(adHocEncounter)).toBe("not_required");
    });

    it("never resolves another org's visit compliance (cross-tenant RLS isolation)", async () => {
      const patientIdB = await seedPatient(ORG_B);
      const peB = await seedProviderEntity(ORG_B, "381271");
      const membershipIdB = await seedMembership(ORG_B);
      const locationIdB = await seedLocation(peB);
      const deviceIdB = await seedEvvDevice(ORG_B, membershipIdB);
      const visitB = crypto.randomUUID();
      await seedEvvChain(ORG_B, peB, locationIdB, deviceIdB, membershipIdB, visitB, patientIdB, "compliant");
      const encounterB = await seedEncounter({
        orgId: ORG_B,
        providerEntityId: peB,
        patientId: patientIdB,
        membershipId: membershipIdB,
        discipline: "rn",
        status: "signed",
        serviceDate: "2026-08-05",
        visitId: visitB,
      });

      const seam = buildM23EvvComplianceAdapter(
        { forEncounters: (orgId, ids) => encounterVisitIdsForOrg(handle.db, orgId, ids) },
        { forVisits: (orgId, ids) => complianceStatesForVisitsForOrg(handle.db, orgId, ids) },
      );
      // Org A asking about org B's encounter id: M8's org-scoped read finds no matching row at all, so the
      // encounter→visit map is empty and the adapter correctly reports `not_required` rather than leaking
      // org B's real "compliant" verdict.
      const snapshots = await seam.bracketsForEncounters(ORG_A, [encounterB]);
      expect(snapshots).toEqual([{ encounterId: encounterB, bracketState: "not_required" }]);
    });
  });

  describe("end-to-end boundary: POST /claims/assemble's real SEAM_UNBOUND wall today", () => {
    it("progresses PAST the entire M6 block and fails at referenceData.hippsRateTable (F-121, #251)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const pe = await seedProviderEntity(ORG_A, "381240");
      await seedMacCredential(ORG_A, pe, "ngs_j6");
      // The claim range has to straddle "now" — see `futureClaimRange`'s own doc — so the matching
      // wage-index fiscal year is derived the same way, not hardcoded.
      const { range, fiscalYearStarting } = futureClaimRange();
      await seedWageIndex("381240", fiscalYearStarting, "0.9500", "12060");
      await activeAdmissionForRange(ORG_A, patientId, pe, "2026-01-01T00:00:00.000Z");

      const service = buildM23BootAssemblyService(handle.db, {
        providerCcn: testProviderCcnPort,
        m6ClaimRange: {
          forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r),
        },
      });
      await expect(
        service.assemble(
          { organizationId: ORG_A, userId: M6_USER, membershipId: M6_USER, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: range.from,
            serviceTo: range.to,
            tob: "811",
          },
        ),
      ).rejects.toMatchObject({
        code: "SEAM_UNBOUND",
        message: expect.stringContaining("BillingReferenceDataReader"),
      });
    });

    it("still fails at admission.resolveForRange (M6) when the M6 seam port is not injected (unit-test default)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const pe = await seedProviderEntity(ORG_A, "381249");
      const service = buildM23BootAssemblyService(handle.db); // no m6ClaimRange port
      await expect(
        service.assemble(
          { organizationId: ORG_A, userId: U, membershipId: U, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            tob: "811",
          },
        ),
      ).rejects.toMatchObject({
        code: "SEAM_UNBOUND",
        message: expect.stringContaining("AdmissionContextReader"),
      });
    });

    it("still fails BEFORE admission when patientPayer itself resolves to non-Medicare-primary (D15 gate, unchanged)", async () => {
      const patientId = await seedPatient(ORG_A);
      // no medicare_ffs coverage seeded at all
      const pe = await seedProviderEntity(ORG_A, "381241");
      const service = buildM23BootAssemblyService(handle.db);
      await expect(
        service.assemble(
          { organizationId: ORG_A, userId: U, membershipId: U, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: "2026-01-01",
            serviceTo: "2026-01-31",
            tob: "811",
          },
        ),
      ).rejects.toMatchObject({ code: "NON_MEDICARE_PRIMARY_PAYER" });
    });
  });
});
