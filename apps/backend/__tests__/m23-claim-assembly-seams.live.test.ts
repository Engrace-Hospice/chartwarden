/**
 * M23 claim-assembly seam bindings — LIVE Postgres proof (#250, #251, F-119, F-121, F-122, F-123, F-124, F-209).
 *
 * `boot-assembly.ts` binds TEN of the eleven named `ClaimAssemblySeams` reader ports to real data:
 * `patientPayer` (M5), all FIVE M6 range-shaped seams (F-121, #251: `admission`, `electionPeriods`,
 * `certifications`, `faceToFace`, `levelOfCare`, over `claimAssemblyRangeContextForOrg`),
 * `billableEncounters`/`signedEncounters` (F-122, #251: M8, over `billableEncountersInRangeForOrg`/
 * `signedEncounterSnapshotsInRangeForOrg`), `evvCompliance` (F-123, #251, bridging M8's new
 * `encounterVisitIdsForOrg` and M18's new bulk `complianceStatesForVisitsForOrg`), and — F-124 (#251) —
 * `terminology`, over M38's registered `TerminologyProvider.expand()`; `mdm.resolveProviderEntity` and two
 * of `referenceData`'s four methods are also real (#250). This proves each against real rows under real
 * RLS (`WARDENX_DEV_BYPASSRLS=0` discipline: this test connects as the migrated `wardenx_app` role via
 * `handle.db`, never the admin/superuser client used only to seed). F-122 also fixes a genuine,
 * previously-undocumented production defect: `EncounterReaderStore.encounterFacts` — and therefore
 * `BillableEncounterReader.billability` for EVERY caller, not only M23 — had been live-registered since
 * M8-T08 while still answering `[]` for any id, because the Drizzle store never overrode the in-memory
 * fallback's empty default (the F-093/F-100/F-103 shape again). F-124 fixes an analogous gap one layer
 * down in M38: `CMS_HOSPICE_MODIFIER_VALUE_SET` (the one value set M23's rule registry references) had no
 * curated members anywhere — this suite seeds them directly (`value_set`/`value_set_member`), the same
 * two rows `@wardenx/terminology`'s own seed now curates.
 *
 * The end-to-end `POST /claims/assemble` reachability boundary is unmoved by F-122/F-123/F-124 (stated,
 * not implied): as of F-210 the wall at `referenceData.perDiemRateTable` is a typed, actionable
 * `RATE_TABLE_MISSING` (422) until the tenant enters its rate table (the tenant-entered `hospice_rate_table`;
 * its own suite is `m23-rate-table.live.test.ts`) — no longer `SEAM_UNBOUND`.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-claim-assembly-seams.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CMS_HOSPICE_MODIFIER_VALUE_SET, icd10Sequencing } from "@wardenx/billing";
import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { WardenXError } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildPatientAddressReader } from "../src/modules/05-patient/address-reader";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { claimAssemblyRangeContextForOrg } from "../src/modules/06-admission/index";
import { claimDiagnosesForOrg } from "../src/modules/07-care-plan/index";
import {
  billableEncountersInRangeForOrg,
  createDrizzleEncounterReaderStore,
  encounterVisitIdsForOrg,
  signedEncounterSnapshotsInRangeForOrg,
} from "../src/modules/08-encounters/index";
import { complianceStatesForVisitsForOrg } from "../src/modules/18-evv/index";
import type { ProviderCcnPort } from "../src/modules/23-billing-medicare/routes/write-service";
import { buildM23BootAssemblyService } from "../src/modules/23-billing-medicare/services/boot-assembly";
import {
  buildM23AdmissionRangeAdapters,
  buildM23BillableEncountersAdapter,
  buildM23ClinicalParticipantsAdapter,
  buildM23DiagnosesAdapter,
  buildM23EvvComplianceAdapter,
  buildM23MdmProviderEntityAdapter,
  buildM23PatientPayerAdapter,
  buildM23ReferenceDataAdapter,
  buildM23SignedEncountersAdapter,
  buildM23TerminologyAdapter,
} from "../src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";
import {
  createDbTerminologyStore,
  registerTerminologySeams,
} from "../src/modules/38-terminology/index";
import { createDbConsentStore, registerConsentSeams } from "../src/modules/39-consent/index";
import {
  createDbMdmStore,
  facilityKindsForIds,
  registerMdmSeams,
} from "../src/modules/40-mdm/index";
import { appRoleConnectionString } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

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
  const fiscalYearStarting =
    from.getUTCMonth() + 1 >= 10 ? from.getUTCFullYear() : from.getUTCFullYear() - 1;
  return { range: { from: iso(from), to: iso(to) }, fiscalYearStarting };
}

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
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
    const signedAt = ["signed", "cosign_pending", "cosigned"].includes(input.status)
      ? new Date()
      : null;
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
      [
        orgId,
        providerEntityId,
        locationId,
        visitId,
        patientId,
        membershipId,
        deviceId,
        crypto.randomUUID(),
      ],
    );
    if (kind === "compliant") {
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_out','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)`,
        [
          orgId,
          providerEntityId,
          locationId,
          visitId,
          patientId,
          membershipId,
          deviceId,
          crypto.randomUUID(),
        ],
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
            resolutionReason:
              "attested by the clinician for the F-123 compliance test fixture, 40+ chars",
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
    // F-124 (#251) — M38's registered `TerminologyProvider`, over the SAME real Drizzle store
    // production binds (`index.ts`'s own `registerTerminologySeams(deps.db ? {store: ...} : {})`
    // call), so `buildM23TerminologyAdapter()`'s `getSeam("TerminologyProvider")` default resolves
    // for real rather than needing its own `resolve` override.
    registerTerminologySeams({ store: createDbTerminologyStore(handle.db) });
    // F-214 (#251) — M39's REAL `ConsentEvaluator` over the REAL Drizzle consent store, exactly as `index.ts`
    // registers it, so M7's Part 2 billing gate is proven against real `consent_record` rows (not a stub).
    registerConsentSeams({ store: createDbConsentStore(handle.db) });
    // M39's platform-floor catalog rows `consent_record.type_key` FKs to (the gap-061 precedent).
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
         ('42_cfr_part_2_release','42 CFR Part 2 Release','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'part_2_release',
          true,false,false,false,true,false,'consent_record','v1'),
         ('hipaa_release','HIPAA Release','per_recipient',31536000,31536000,
          ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'hipaa_release',
          true,false,false,false,false,true,'consent_record','v1')`,
    );
    // `cms_hospice_modifiers` (GV/GW) did not exist as real curated data before F-124 — seeded here
    // the same way the seam's own migration-less curation file describes it: two rows in `value_set`
    // + `value_set_member`, no RLS (platform-shared reference data, §3.7).
    await admin.query(
      `INSERT INTO "value_set" (id, name, description, scope) VALUES
         ('${CMS_HOSPICE_MODIFIER_VALUE_SET}', 'CMS hospice-specific HCPCS modifiers',
          'GV, GW', 'platform')`,
    );
    await admin.query(
      `INSERT INTO "value_set_member" (value_set_id, system_id, code, member_effective) VALUES
         ('${CMS_HOSPICE_MODIFIER_VALUE_SET}', 'hcpcs', 'GV', '2020-01-01'),
         ('${CMS_HOSPICE_MODIFIER_VALUE_SET}', 'hcpcs', 'GW', '2020-01-01')`,
    );
    // A tenant extension for ORG_A only (§7.6 add-only) — raw insert rather than the real
    // `addTenantExtension()` route, because hcpcs has no Phase-1 concept table (§2.3) and that
    // method's own add-time validation would refuse ANY hcpcs code as unresolvable; this proves the
    // adapter's `includeTenantExtensions: true` wiring reads the row the store already knows how to
    // return, independent of that separate, real hcpcs-extension-validation gap.
    await admin.query(
      `INSERT INTO "value_set_tenant_extension"
         (value_set_id, organization_id, system_id, code, reason) VALUES
         ('${CMS_HOSPICE_MODIFIER_VALUE_SET}', '${ORG_A}', 'hcpcs', 'GX',
          'org-A local extension seeded for F-124 live coverage')`,
    );
    // F-127 (#251) — M40's registered `MdmEntityProvider`, over the SAME real Drizzle store production
    // binds (`index.ts`'s own `registerMdmSeams({store: createDbMdmStore(db)})` call), so
    // `buildM23ClinicalParticipantsAdapter`'s `getSeam("MdmEntityProvider")` default resolves for real.
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    // Two canonical `external_physician` rows, ids reused as M6_MD/M6_ATTENDING — `activeAdmissionForRange`
    // already sites both as the admission's `hospicePhysicianId` and the (signed) election statement's
    // `attendingPhysicianId`, so seeding M40 canonical rows under those SAME ids is what makes the real
    // M6→M40 identity bridge resolvable rather than inventing a third id nothing else references.
    await admin.query(
      `INSERT INTO "external_physician" (id, npi, first_name, last_name, status) VALUES
         ('${M6_MD}', '1122334455', 'Hospice', 'MD', 'active'),
         ('${M6_ATTENDING}', '1234567893', 'Attending', 'MD', 'deactivated')`,
    );
    // F-209 (#251) — real ICD-10-CM concept rows behind M38's registered provider, so `icd10Billable`
    // resolves against the SAME `lookupBatch` production runs. One active code-system version; then:
    //   C34.90 billable leaf (since 2020) · C34 non-leaf header · J44.9 + I10 billable leaves ·
    //   L89.90 active billable leaf that only takes effect 2026-03-01 (as-of boundary) ·
    //   A00.0 leaf that was retired with end_date 2026-05-31 (a since-retired code at its service date).
    await admin.query(
      `INSERT INTO code_system (id, name, license_source) VALUES ('icd10cm','ICD-10-CM','CDC')
       ON CONFLICT (id) DO NOTHING`,
    );
    const versionId = (
      await admin.query(
        `INSERT INTO code_system_version (code_system_id, version, released_on, effective_from,
           source_file_ref, checksum, status)
         VALUES ('icd10cm','F209-fixture','2020-01-01','2020-01-01','f209','f209','active') RETURNING id`,
      )
    ).rows[0].id as string;
    for (const [code, status, leaf, eff, end] of [
      ["C34.90", "active", true, "2020-01-01", null],
      ["C34", "active", false, "2020-01-01", null],
      ["J44.9", "active", true, "2020-01-01", null],
      ["I10", "active", true, "2020-01-01", null],
      ["L89.90", "active", true, "2026-03-01", null],
      ["A00.0", "retired", true, "2020-01-01", "2026-05-31"],
    ] as const) {
      await admin.query(
        `INSERT INTO concept_icd10cm (code, display, status, effective_date, end_date, version_id, is_billable_leaf)
         VALUES ($1,$1,$2,$3,$4,$5,$6)`,
        [code, status, eff, end, versionId, leaf],
      );
    }
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

    it("names the missing MAC submitter credential (422) instead of reporting the provider entity unresolved", async () => {
      const pe = await seedProviderEntity(ORG_A, "381235");
      const adapter = buildM23MdmProviderEntityAdapter(handle.db, testProviderCcnPort);
      await expect(adapter.resolveProviderEntity(ORG_A, pe)).rejects.toMatchObject({
        code: "MAC_SUBMITTER_CREDENTIAL_MISSING",
        statusCode: 422,
      });
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
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn("381237", 2026, ORG_A)).toEqual({
        factorDecimal: "0.9234",
        cbsaCode: "38900",
      });
    });

    it("returns null (never fabricates a factor) for a CCN/FY the CMS file hasn't loaded", async () => {
      // NOTE: migration 0080_billing_m23_seed.sql pre-seeds 5 REPRESENTATIVE placeholder rows for
      // FY2026 (010001, 050002, 380001, 450003, 999999 — explicitly marked "not authoritative"), so a
      // real null-path proof must use a CCN/FY outside that fixed set, not assume the table is empty.
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn("777777", 2026, ORG_A)).toBeNull();
    });

    it("NEVER prices from a non-authoritative migration-0080 placeholder row (F-211)", async () => {
      // 0280 flips the 5 placeholder rows to is_authoritative = false; they exist (checked) but do not resolve.
      const seeded = await admin.query(
        "SELECT ccn FROM wage_index_factor WHERE ccn = '010001' AND fiscal_year_starting = 2026 AND is_authoritative = false",
      );
      expect(seeded.rowCount).toBe(1);
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      expect(await adapter.wageIndexForCcn("010001", 2026, ORG_A)).toBeNull();
    });
  });

  describe("referenceData.activeSequestrationPolicy", () => {
    it("resolves the policy in effect on the service date", async () => {
      const pe = await seedProviderEntity(ORG_A, "381238");
      await seedSequestrationPolicy(ORG_A, pe, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(handle.db);
      const resolved = await adapter.activeSequestrationPolicy(ORG_A, pe, "2026-06-01");
      expect(resolved?.percentage).toBe("2.00");
      expect(resolved?.effectiveTo).toBeNull();
    });

    it("never resolves another org's sequestration policy (cross-tenant RLS isolation)", async () => {
      const peOrgB = await seedProviderEntity(ORG_B, "381239");
      await seedSequestrationPolicy(ORG_B, peOrgB, "2.00", "2020-01-01");
      const adapter = buildM23ReferenceDataAdapter(handle.db);
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
        rhcPriorHospiceDays: 0, // a first stay: the RHC day count starts here
        rhcPriorStays: [], // …and no earlier stay with us for M23 to merge with the HETS history
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        placeOfDeath: null,
        dischargeEventId: null,
        transferOut: null,
        // F-127 (#251) — `activeAdmissionForRange` names M6_MD as the hospice physician.
        hospicePhysicianId: M6_MD,
      });
      expect(ctx?.electionPeriods).toEqual([
        {
          electionPeriodId: periodId,
          sequence: 1,
          effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          effectiveTo: null,
          revoked: false,
          revocationDate: null,
          // F-127 (#251) — the SIGNED election statement names M6_ATTENDING.
          attendingPhysicianId: M6_ATTENDING,
          // An ordinary period-1 admission: no documented F2F exception (MBPM ch. 9 §20.1(5)(d)).
          f2fExceptionDocumented: false,
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
      expect(await seams.admission.resolveForRange(ORG_A, patientId, range)).toEqual(
        ctx?.admission,
      );
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
        startedAt: "2026-05-05T14:00:00.000Z",
        endedAt: "2026-05-05T14:50:00.000Z", // 50 minutes
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
      // The visit-line facts (CMS ch. 11 §30.3): discipline + type, and the real bracket in minutes (null = a gap).
      expect(byId.get(rnSigned)).toMatchObject({
        billable: true,
        discipline: "rn",
        encounterType: "routine_visit",
        durationMinutes: 50,
      });
      expect(byId.get(lpnAwaitingCosign)).toMatchObject({ durationMinutes: null });
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
      expect(snapById.get(rnSigned)).toMatchObject({
        discipline: "rn",
        encounterType: "routine_visit",
        durationMinutes: 50,
      });
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
      const facts = await runWithRequestContext(
        { organizationId: ORG_A, userId: membershipId },
        () => store.encounterFacts([volunteerEncounter]),
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
      await seedEvvChain(
        ORG_A,
        pe,
        locationId,
        deviceId,
        membershipId,
        compliantVisit,
        patientId,
        "compliant",
      );
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
      await seedEvvChain(
        ORG_B,
        peB,
        locationIdB,
        deviceIdB,
        membershipIdB,
        visitB,
        patientIdB,
        "compliant",
      );
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

  describe("terminology.resolveForClaim: the M38 bulk-expand bridge (F-124, #251)", () => {
    it("resolves the platform CMS hospice-modifier value set, plus the calling org's own tenant extension", async () => {
      const seam = buildM23TerminologyAdapter();
      const resolutionA = await seam.resolveForClaim(ORG_A, "2026-06-01");
      expect(
        resolutionA.valueSetMembership[CMS_HOSPICE_MODIFIER_VALUE_SET]?.slice().sort(),
      ).toEqual(["GV", "GW", "GX"]);
      // F-209: no diagnosis codes asked about => an empty per-code map (no M38 round trip).
      expect(resolutionA.icd10Billable).toEqual({});
    });

    it("never resolves another org's tenant extension (cross-tenant isolation, §7.6)", async () => {
      const seam = buildM23TerminologyAdapter();
      const resolutionB = await seam.resolveForClaim(ORG_B, "2026-06-01");
      // Org B gets the platform members but NOT org A's "GX" extension.
      expect(
        resolutionB.valueSetMembership[CMS_HOSPICE_MODIFIER_VALUE_SET]?.slice().sort(),
      ).toEqual(["GV", "GW"]);
    });
  });

  describe("terminology.resolveForClaim: icd10Billable via M38 lookupBatch (F-209, #251)", () => {
    it("true for an active billable leaf; false for a non-leaf header, a retired code and an unknown code", async () => {
      const seam = buildM23TerminologyAdapter();
      const res = await seam.resolveForClaim(ORG_A, "2026-06-01", [
        "C34.90",
        "C34",
        "A00.0",
        "ZZZ.99",
        "J44.9",
      ]);
      expect(res.icd10Billable).toEqual({
        "C34.90": true,
        C34: false,
        "A00.0": false, // retired: its end_date (2026-05-31) precedes the service date
        "ZZZ.99": false, // unknown to M38 => false, never omitted-as-true
        "J44.9": true,
      });
    });

    it("is as-of the SERVICE date: a code not yet effective is false, effective from its start date on", async () => {
      const seam = buildM23TerminologyAdapter();
      const before = await seam.resolveForClaim(ORG_A, "2026-02-28", ["L89.90"]);
      const onto = await seam.resolveForClaim(ORG_A, "2026-03-01", ["L89.90"]);
      expect(before.icd10Billable).toEqual({ "L89.90": false });
      expect(onto.icd10Billable).toEqual({ "L89.90": true });
    });
  });

  describe("diagnoses: M7 claimDiagnosesForOrg (F-209, #251)", () => {
    const RANGE = { from: "2026-06-01", to: "2026-06-30" };

    async function seedPlan(orgId: string, patientId: string, pe: string): Promise<string> {
      const loc = await seedLocation(pe);
      const row = await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           initial_due_at) VALUES ($1,$2,$3,$4,gen_random_uuid(), now() + interval '5 days')
         RETURNING id`,
        [orgId, pe, loc, patientId],
      );
      return row.rows[0].id as string;
    }

    async function seedProblem(
      orgId: string,
      planId: string,
      pe: string,
      p: {
        code: string | null;
        kind: "terminal" | "related" | "unrelated";
        status?: "active" | "resolved" | "inactive";
        onset?: string | null;
        resolved?: string | null;
        createdAt?: string;
        /** F-214 — `problem.sud_related` (42 CFR Part 2). */
        sud?: boolean;
      },
    ): Promise<void> {
      const loc = (await admin.query("SELECT location_id FROM care_plan WHERE id=$1", [planId]))
        .rows[0].location_id as string;
      await admin.query(
        `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, icd10_code,
           description, kind, status, onset_at, resolved_at, created_at, sud_related)
         VALUES ($1,$2,$3,$4,$5,'F-209 fixture problem',$6,$7::problem_status,$8,$9, COALESCE($10::timestamptz, now()), $11)`,
        [
          orgId,
          pe,
          loc,
          planId,
          p.code,
          p.kind,
          p.status ?? "active",
          p.onset ?? null,
          p.resolved ?? null,
          p.createdAt ?? null,
          p.sud ?? false,
        ],
      );
    }

    it("orders terminal, related, unrelated (then created_at), positions 1..n, code + relationship only", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381290");
      const plan = await seedPlan(ORG_A, patientId, pe);
      // Inserted deliberately OUT of ranking order; the two related rows tie-break on created_at.
      await seedProblem(ORG_A, plan, pe, {
        code: "I10",
        kind: "unrelated",
        createdAt: "2026-01-01",
      });
      await seedProblem(ORG_A, plan, pe, {
        code: "J44.9",
        kind: "related",
        createdAt: "2026-02-02",
      });
      await seedProblem(ORG_A, plan, pe, {
        code: "E11.9",
        kind: "related",
        createdAt: "2026-02-01",
      });
      await seedProblem(ORG_A, plan, pe, {
        code: "C34.90",
        kind: "terminal",
        createdAt: "2026-03-01",
      });
      const seq = (await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE)).sequence;
      expect(seq).toEqual([
        { position: 1, code: "C34.90", relationship: "terminal" },
        { position: 2, code: "E11.9", relationship: "related" },
        { position: 3, code: "J44.9", relationship: "related" },
        { position: 4, code: "I10", relationship: "unrelated" },
      ]);
    });

    it("excludes resolved / inactive / null- and blank-code problems, and de-duplicates a repeated code", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381291");
      const plan = await seedPlan(ORG_A, patientId, pe);
      await seedProblem(ORG_A, plan, pe, { code: "C34.90", kind: "terminal" });
      await seedProblem(ORG_A, plan, pe, { code: "J44.9", kind: "related", status: "resolved" });
      await seedProblem(ORG_A, plan, pe, { code: "I10", kind: "related", status: "inactive" });
      await seedProblem(ORG_A, plan, pe, { code: null, kind: "related" });
      await seedProblem(ORG_A, plan, pe, { code: "  ", kind: "related" });
      await seedProblem(ORG_A, plan, pe, { code: "C34.90", kind: "related" }); // same code again
      const seq = (await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE)).sequence;
      expect(seq).toEqual([{ position: 1, code: "C34.90", relationship: "terminal" }]);
    });

    it("keeps only problems overlapping the service range (onset before its end, not resolved before its start)", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381292");
      const plan = await seedPlan(ORG_A, patientId, pe);
      await seedProblem(ORG_A, plan, pe, {
        code: "C34.90",
        kind: "terminal",
        onset: "2026-01-15T00:00:00Z",
      });
      // Onset on the range's LAST day (any time of day) still overlaps.
      await seedProblem(ORG_A, plan, pe, {
        code: "J44.9",
        kind: "related",
        onset: "2026-06-30T23:00:00Z",
      });
      // Onset the day AFTER the range ends: not yet a problem during the service window.
      await seedProblem(ORG_A, plan, pe, {
        code: "I10",
        kind: "related",
        onset: "2026-07-01T00:00:00Z",
      });
      // Still-`active` row whose resolved_at precedes the range: over before the window began.
      await seedProblem(ORG_A, plan, pe, {
        code: "E11.9",
        kind: "related",
        onset: "2026-01-01T00:00:00Z",
        resolved: "2026-05-31T23:59:59Z",
      });
      // resolved_at inside the range: still overlaps (was active for part of it).
      await seedProblem(ORG_A, plan, pe, {
        code: "L89.90",
        kind: "unrelated",
        onset: "2026-01-01T00:00:00Z",
        resolved: "2026-06-10T00:00:00Z",
      });
      const seq = (await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE)).sequence;
      expect(seq.map((d) => d.code)).toEqual(["C34.90", "J44.9", "L89.90"]);
    });

    it("caps the sequence at 12 positions", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381293");
      const plan = await seedPlan(ORG_A, patientId, pe);
      await seedProblem(ORG_A, plan, pe, { code: "C34.90", kind: "terminal" });
      for (let i = 0; i < 14; i++) {
        await seedProblem(ORG_A, plan, pe, {
          code: `R${String(10 + i)}.0`,
          kind: "related",
          createdAt: `2026-02-${String(i + 1).padStart(2, "0")}`,
        });
      }
      const seq = (await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE)).sequence;
      expect(seq).toHaveLength(12);
      expect(seq.map((d) => d.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(seq[0]).toEqual({ position: 1, code: "C34.90", relationship: "terminal" });
      expect(seq[11]?.code).toBe("R20.0"); // 11 related rows survive, oldest-created first
    });

    it("never resolves another org's problems, or another patient's (cross-tenant + cross-patient isolation)", async () => {
      const patientA = await seedPatient(ORG_A);
      const otherPatientA = await seedPatient(ORG_A);
      const patientB = await seedPatient(ORG_B);
      const peA = await seedProviderEntity(ORG_A, "381294");
      const peB = await seedProviderEntity(ORG_B, "381295");
      const planA = await seedPlan(ORG_A, patientA, peA);
      const planOther = await seedPlan(ORG_A, otherPatientA, peA);
      const planB = await seedPlan(ORG_B, patientB, peB);
      await seedProblem(ORG_A, planA, peA, { code: "C34.90", kind: "terminal" });
      await seedProblem(ORG_A, planOther, peA, { code: "J44.9", kind: "terminal" });
      await seedProblem(ORG_B, planB, peB, { code: "I10", kind: "terminal" });
      // Org A's patient, asked as org A: only its own row.
      expect((await claimDiagnosesForOrg(handle.db, ORG_A, patientA, RANGE)).sequence).toEqual([
        { position: 1, code: "C34.90", relationship: "terminal" },
      ]);
      // Org B asking about org A's patient id: nothing (RLS + explicit organization_id predicate).
      expect((await claimDiagnosesForOrg(handle.db, ORG_B, patientA, RANGE)).sequence).toEqual([]);
      // Org A asking about org B's patient id: nothing.
      expect((await claimDiagnosesForOrg(handle.db, ORG_A, patientB, RANGE)).sequence).toEqual([]);
    });

    it("the explicit organization_id predicate is a second wall: it holds even where RLS does not apply (superuser handle)", async () => {
      const patientA = await seedPatient(ORG_A);
      const peA = await seedProviderEntity(ORG_A, "381297");
      const planA = await seedPlan(ORG_A, patientA, peA);
      await seedProblem(ORG_A, planA, peA, { code: "C34.90", kind: "terminal" });
      // A deliberately RLS-bypassing handle — the ONLY use of the superuser url for a read in this block,
      // so the assertion isolates the query's own organization_id predicate from the row-level policy.
      const superHandle = createDbClient({ connectionString: DB_URL! });
      try {
        expect(
          (await claimDiagnosesForOrg(superHandle.db, ORG_B, patientA, RANGE)).sequence,
        ).toEqual([]);
        expect(
          (await claimDiagnosesForOrg(superHandle.db, ORG_A, patientA, RANGE)).sequence,
        ).toHaveLength(1);
      } finally {
        await superHandle.close();
      }
    });

    // ── F-214 (#251): the 42 CFR Part 2 consent gate, against REAL consent rows on the app role ──────────
    describe("F-214: sud_related diagnoses are consent-gated (42 CFR Part 2)", () => {
      async function seedConsent(
        orgId: string,
        patientId: string,
        o: {
          type?: string;
          status?: "active" | "revoked";
          effective?: string;
          expires?: string | null;
          recipient?: boolean;
        } = {},
      ): Promise<string> {
        const status = o.status ?? "active";
        const row = await admin.query(
          `INSERT INTO consent_record (organization_id, patient_id, type_key, scope_descriptor, grantor_kind,
             effective_at, expires_at, status, capture_method, capture_evidence_jsonb, created_by_id, version,
             signed_at, signed_by_id, revoked_at, revoked_via_id)
           VALUES ($1,$2,$3::consent_type_key,'{}'::jsonb,'patient_self', $4::timestamptz, $5::timestamptz,
             $6::consent_status,'typed_signature_in_app','{}'::jsonb,$7,1, now() - interval '400 days', $7,
             $8::timestamptz, $9)
           RETURNING id`,
          [
            orgId,
            patientId,
            o.type ?? "42_cfr_part_2_release",
            o.effective ?? "2020-01-01T00:00:00Z",
            o.expires === undefined ? null : o.expires,
            status,
            U,
            status === "revoked" ? "2026-01-01T00:00:00Z" : null,
            status === "revoked" ? U : null,
          ],
        );
        const id = row.rows[0].id as string;
        if (o.recipient !== false) {
          await admin.query(
            `INSERT INTO consent_record_recipient (organization_id, consent_record_id, recipient_kind,
               recipient_free_text, recipient_resolved_display_name, added_by_id)
             VALUES ($1,$2,'free_text','Medicare Administrative Contractor','Medicare Administrative Contractor',$3)`,
            [orgId, id, U],
          );
        }
        return id;
      }

      /** Terminal non-SUD + one SUD related + one plain related, for a fresh patient. */
      async function seedSudPatient(orgId: string, ccn: string): Promise<string> {
        const patientId = await seedPatient(orgId);
        const pe = await seedProviderEntity(orgId, ccn);
        const plan = await seedPlan(orgId, patientId, pe);
        await seedProblem(orgId, plan, pe, {
          code: "C34.90",
          kind: "terminal",
          createdAt: "2026-01-01",
        });
        await seedProblem(orgId, plan, pe, {
          code: "F11.20",
          kind: "related",
          sud: true,
          createdAt: "2026-02-01",
        });
        await seedProblem(orgId, plan, pe, {
          code: "J44.9",
          kind: "related",
          createdAt: "2026-03-01",
        });
        return patientId;
      }

      const CODES = (r: { sequence: readonly { code: string }[] }) => r.sequence.map((d) => d.code);

      it("valid active Part 2 release => the SUD code IS included; nothing withheld", async () => {
        const patientId = await seedSudPatient(ORG_A, "381910");
        await seedConsent(ORG_A, patientId);
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(r)).toEqual(["C34.90", "F11.20", "J44.9"]);
        expect(r.withheldForConsentCount).toBe(0);
        expect(r.terminalWithheldForConsent).toBe(false);
      });

      it("no consent on file => code omitted, positions re-ranked, flag raised (count only)", async () => {
        const patientId = await seedSudPatient(ORG_A, "381911");
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(r.sequence).toEqual([
          { position: 1, code: "C34.90", relationship: "terminal" },
          { position: 2, code: "J44.9", relationship: "related" },
        ]);
        expect(r.withheldForConsentCount).toBe(1);
        expect(JSON.stringify(r)).not.toContain("F11.20");
      });

      it("EXPIRED release => omitted + flagged", async () => {
        const patientId = await seedSudPatient(ORG_A, "381912");
        await seedConsent(ORG_A, patientId, {
          effective: "2024-01-01T00:00:00Z",
          expires: "2025-01-01T00:00:00Z",
        });
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(r)).toEqual(["C34.90", "J44.9"]);
        expect(r.withheldForConsentCount).toBe(1);
      });

      it("REVOKED release => omitted + flagged (revocation blocks future disclosure)", async () => {
        const patientId = await seedSudPatient(ORG_A, "381913");
        await seedConsent(ORG_A, patientId, { status: "revoked" });
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(r)).toEqual(["C34.90", "J44.9"]);
        expect(r.withheldForConsentCount).toBe(1);
      });

      it("wrong-scope: a DIFFERENT consent type (hipaa_release), or a Part 2 release with no active recipient, does not cover it", async () => {
        const wrongType = await seedSudPatient(ORG_A, "381914");
        await seedConsent(ORG_A, wrongType, { type: "hipaa_release" });
        const a = await claimDiagnosesForOrg(handle.db, ORG_A, wrongType, RANGE);
        expect(CODES(a)).toEqual(["C34.90", "J44.9"]);
        expect(a.withheldForConsentCount).toBe(1);

        const noRecipient = await seedSudPatient(ORG_A, "381915");
        await seedConsent(ORG_A, noRecipient, { recipient: false });
        const b = await claimDiagnosesForOrg(handle.db, ORG_A, noRecipient, RANGE);
        expect(CODES(b)).toEqual(["C34.90", "J44.9"]);
        expect(b.withheldForConsentCount).toBe(1);
      });

      it("a release for a DIFFERENT patient does not cover this one", async () => {
        const patientId = await seedSudPatient(ORG_A, "381916");
        const other = await seedPatient(ORG_A);
        await seedConsent(ORG_A, other);
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(r)).toEqual(["C34.90", "J44.9"]);
        expect(r.withheldForConsentCount).toBe(1);
      });

      it("a release in ANOTHER ORG (even keyed to the same patient id) does not cover it (cross-tenant, app role)", async () => {
        const patientId = await seedSudPatient(ORG_A, "381917");
        await seedConsent(ORG_B, patientId); // org B holds a consent naming org A's patient id
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(r)).toEqual(["C34.90", "J44.9"]);
        expect(r.withheldForConsentCount).toBe(1);
        // And org B, asking about that patient, sees none of org A's problems (RLS) and withholds nothing.
        const asB = await claimDiagnosesForOrg(handle.db, ORG_B, patientId, RANGE);
        expect(asB.sequence).toEqual([]);
        expect(asB.withheldForConsentCount).toBe(0);
      });

      it("withheld TERMINAL: flagged, NOT replaced — a related diagnosis is never promoted to principal", async () => {
        const patientId = await seedPatient(ORG_A);
        const pe = await seedProviderEntity(ORG_A, "381918");
        const plan = await seedPlan(ORG_A, patientId, pe);
        await seedProblem(ORG_A, plan, pe, { code: "F11.20", kind: "terminal", sud: true });
        await seedProblem(ORG_A, plan, pe, { code: "J44.9", kind: "related" });
        const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(r.sequence).toEqual([{ position: 1, code: "J44.9", relationship: "related" }]);
        expect(r.terminalWithheldForConsent).toBe(true);
        // ...and M23's icd10_sequencing rule fails on exactly that context (real rule, real seam output).
        const verdict = icd10Sequencing.check(
          {
            seams: { terminologyBound: true },
            claim: {
              claimId: "claim-f214",
              icd10Sequence: r.sequence,
              diagnosesWithheldForConsent: r.withheldForConsentCount,
              terminalDiagnosisWithheldForConsent: r.terminalWithheldForConsent,
            },
            terminology: { icd10Billable: { "J44.9": true } },
          } as never,
          {},
        );
        expect(verdict.passed).toBe(false);
        expect(verdict.annotations?.observed?.firstDefect).toContain(
          "principal (terminal) diagnosis is withheld",
        );
        // With a valid release the same patient's claim has its terminal back.
        await seedConsent(ORG_A, patientId);
        const ok = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
        expect(CODES(ok)).toEqual(["F11.20", "J44.9"]);
        expect(ok.terminalWithheldForConsent).toBe(false);
      });

      it("FAILS CLOSED when the consent evaluator throws (even with a valid release on file)", async () => {
        const patientId = await seedSudPatient(ORG_A, "381919");
        await seedConsent(ORG_A, patientId);
        registerSeam("ConsentEvaluator", {
          evaluate: async () => {
            throw new Error("consent store down");
          },
        });
        try {
          const r = await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE);
          expect(CODES(r)).toEqual(["C34.90", "J44.9"]);
          expect(r.withheldForConsentCount).toBe(1);
        } finally {
          registerConsentSeams({ store: createDbConsentStore(handle.db) });
        }
        // and restored: the same patient's code is released again
        expect(CODES(await claimDiagnosesForOrg(handle.db, ORG_A, patientId, RANGE))).toContain(
          "F11.20",
        );
      });

      it("the adapter carries the flag through to M23's diagnoses port (count + terminal flag, no codes)", async () => {
        const patientId = await seedSudPatient(ORG_A, "381920");
        const res = await buildM23DiagnosesAdapter({
          forRange: (orgId, pid, range) => claimDiagnosesForOrg(handle.db, orgId, pid, range),
        }).forRange(ORG_A, patientId, RANGE);
        expect(res.withheldForConsentCount).toBe(1);
        expect(res.terminalWithheldForConsent).toBe(false);
        expect(res.sequence.map((d) => d.code)).toEqual(["C34.90", "J44.9"]);
      });
    });

    it("M7 diagnoses feed M38 billability: a billable terminal leaf and a non-leaf header resolve distinctly", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381296");
      const plan = await seedPlan(ORG_A, patientId, pe);
      await seedProblem(ORG_A, plan, pe, { code: "C34.90", kind: "terminal" });
      await seedProblem(ORG_A, plan, pe, { code: "C34", kind: "related" }); // non-leaf header
      const seq = await buildM23DiagnosesAdapter({
        forRange: (orgId, pid, range) => claimDiagnosesForOrg(handle.db, orgId, pid, range),
      }).forRange(ORG_A, patientId, RANGE);
      const terminology = await buildM23TerminologyAdapter().resolveForClaim(
        ORG_A,
        RANGE.from,
        seq.sequence.map((d) => d.code),
      );
      expect(terminology.icd10Billable).toEqual({ "C34.90": true, C34: false });
    });
  });

  describe("mdm.resolveClinicalParticipants: the physician-identity half (F-127, #251)", () => {
    it("resolves the hospice physician (active) and attending (deactivated) by real NPPES status", async () => {
      const patientId = await seedPatient(ORG_A);
      const pe = await seedProviderEntity(ORG_A, "381280");
      await activeAdmissionForRange(ORG_A, patientId, pe, "2026-01-01T00:00:00.000Z");

      const seam = buildM23ClinicalParticipantsAdapter({
        forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r),
      });
      const { range } = futureClaimRange();
      const resolution = await seam.resolveClinicalParticipants(ORG_A, patientId, range.from);
      expect(resolution.hospicePhysician).toEqual({
        npi: "1122334455",
        // The M40 canonical names ride along so claim assembly can snapshot them (C2).
        firstName: "Hospice",
        lastName: "MD",
        status: "active",
        // Honest, not fabricated — M40 tracks no per-state license expiry date for an external
        // physician (F-127); see `physician-credentials.ts`'s reworded defect message.
        licenseUnexpiredOnServiceDates: false,
      });
      expect(resolution.attending).toEqual({
        npi: "1234567893",
        firstName: "Attending",
        lastName: "MD",
        status: "inactive",
        licenseUnexpiredOnServiceDates: false,
      });
      // Built WITHOUT the F-213 place-of-service ports, so it stays null (its own section below binds them).
      expect(resolution.placeOfService).toBeNull();
    });

    it("resolves null when the admission names no physician on file (no id, not a fabricated defect)", async () => {
      const seam = buildM23ClinicalParticipantsAdapter({
        forRange: async () => null,
      });
      const resolution = await seam.resolveClinicalParticipants(
        ORG_A,
        "no-such-patient",
        "2026-06-01",
      );
      expect(resolution).toEqual({ attending: null, hospicePhysician: null, placeOfService: null });
    });

    it("never resolves another org's physician identity (cross-tenant isolation)", async () => {
      const patientIdB = await seedPatient(ORG_B);
      const peB = await seedProviderEntity(ORG_B, "381281");
      await activeAdmissionForRange(ORG_B, patientIdB, peB, "2026-01-01T00:00:00.000Z");

      const seam = buildM23ClinicalParticipantsAdapter({
        forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r),
      });
      const { range } = futureClaimRange();
      // Org A asking about org B's patient: M6's own org-scoped read finds no admission at all, so the
      // physician ids never resolve and the adapter correctly reports both physicians as null.
      const resolution = await seam.resolveClinicalParticipants(ORG_A, patientIdB, range.from);
      expect(resolution).toEqual({ attending: null, hospicePhysician: null, placeOfService: null });
    });
  });

  describe("mdm.resolveClinicalParticipants: placeOfService from M5 address history + M40 facility.kind (F-213, #252)", () => {
    const POS_RANGE_FROM = "2026-01-01";

    async function seedFacility(kind: string, mergedIntoId: string | null = null): Promise<string> {
      const row = await admin.query(
        `INSERT INTO facility (kind, name, status, merged_into_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [kind, `F213-${crypto.randomUUID()}`, mergedIntoId ? "merged" : "active", mergedIntoId],
      );
      return row.rows[0].id as string;
    }

    async function seedAddress(
      orgId: string,
      patientId: string,
      a: {
        kind: "home" | "facility" | "mailing" | "temporary" | "prior";
        facilityId?: string | null;
        from?: string;
        to?: string | null;
        primary?: boolean;
      },
    ) {
      await admin.query(
        `INSERT INTO patient_address
           (patient_id, organization_id, kind, line1, city, state, postal_code, is_primary,
            effective_from, effective_to, facility_id)
         VALUES ($1,$2,$3,'1 Test St','Portland','OR','97000',$4,$5,$6,$7)`,
        [
          patientId,
          orgId,
          a.kind,
          a.primary ?? true,
          a.from ?? POS_RANGE_FROM,
          a.to ?? null,
          a.facilityId ?? null,
        ],
      );
    }

    /** The exact production wiring: the real M5 reader + the real M40 facility-kind read, real M6 range. */
    function posSeam() {
      const addr = buildPatientAddressReader(handle.db);
      return buildM23ClinicalParticipantsAdapter(
        { forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r) },
        undefined,
        {
          residence: {
            residencesBetween: (orgId, pid, from, to) =>
              addr.residencesBetween(orgId, pid, from, to),
          },
          facilityKinds: { kindsFor: (ids) => facilityKindsForIds(handle.db, ids) },
        },
      );
    }

    /** A patient with an ACTIVE admission and one open routine-home-care LOC period from 2026-01-01. */
    async function rhcPatient(orgId: string, ccn: string): Promise<string> {
      const patientId = await seedPatient(orgId);
      const pe = await seedProviderEntity(orgId, ccn);
      const { admissionId } = await activeAdmissionForRange(
        orgId,
        patientId,
        pe,
        "2026-01-01T00:00:00.000Z",
      );
      await admissionSvc().changeLoc(
        orgId,
        admissionId,
        "routine_home_care",
        null,
        "2026-01-01T00:00:00.000Z",
        "initial LOC",
      );
      return patientId;
    }

    let ccnSeq = 381300;
    const nextCcn = () => String(++ccnSeq);

    it("home address -> the Q5001 label", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      await seedAddress(ORG_A, patientId, { kind: "home" });
      const { range } = futureClaimRange();
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBe("home");
    });

    it.each([
      ["alf", "alf"],
      ["nf", "ltc"],
      ["snf", "snf"],
      ["hospital", "hospital"],
      ["ipu", "ipu"],
      ["ltch", "ltch"],
      ["psych", "psych"],
    ] as const)("facility kind %s -> POS_BY_QCODE label %s", async (kind, label) => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      await seedAddress(ORG_A, patientId, {
        kind: "facility",
        facilityId: await seedFacility(kind),
      });
      const { range } = futureClaimRange();
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBe(label);
    });

    it.each(["clinic", "other"] as const)(
      "unmapped facility kind %s -> null (falls to Q5009, never guessed)",
      async (kind) => {
        const patientId = await rhcPatient(ORG_A, nextCcn());
        await seedAddress(ORG_A, patientId, {
          kind: "facility",
          facilityId: await seedFacility(kind),
        });
        const { range } = futureClaimRange();
        const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
        expect(r.placeOfService).toBeNull();
      },
    );

    it("a non-residence primary address kind (temporary) -> null", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      await seedAddress(ORG_A, patientId, { kind: "temporary" });
      const { range } = futureClaimRange();
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBeNull();
    });

    it("no address history at all -> null", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      const { range } = futureClaimRange();
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBeNull();
    });

    it("chases a merged facility to its SURVIVOR's kind", async () => {
      const survivor = await seedFacility("snf");
      const merged = await seedFacility("alf", survivor);
      const patientId = await rhcPatient(ORG_A, nextCcn());
      await seedAddress(ORG_A, patientId, { kind: "facility", facilityId: merged });
      const { range } = futureClaimRange();
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBe("snf"); // the dead row said alf; the survivor is a SNF
    });

    const shiftDay = (d: string, delta: number) => {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() + delta);
      return x.toISOString().slice(0, 10);
    };

    it("date-effective: a residence that ended BEFORE the range does not count; the range's own residence does", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      const { range } = futureClaimRange();
      await seedAddress(ORG_A, patientId, {
        kind: "facility",
        facilityId: await seedFacility("hospital"),
        from: POS_RANGE_FROM,
        to: shiftDay(range.from, -1),
      });
      await seedAddress(ORG_A, patientId, { kind: "home", from: range.from });
      const r = await posSeam().resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBe("home");
    });

    it("date-effective: a move INSIDE the range -> null (one claim-level Q-code cannot be honest)", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      const { range } = futureClaimRange();
      const moveDay = shiftDay(range.from, 10);
      const lastHomeDay = shiftDay(moveDay, -1);
      await seedAddress(ORG_A, patientId, { kind: "home", from: POS_RANGE_FROM, to: lastHomeDay });
      await seedAddress(ORG_A, patientId, {
        kind: "facility",
        facilityId: await seedFacility("alf"),
        from: moveDay,
      });
      const seam = posSeam();
      const whole = await seam.resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(whole.placeOfService).toBeNull();
      // ... but a sub-range that sits entirely on one side of the move IS answerable.
      const pre = { from: range.from, to: lastHomeDay };
      expect(
        (await seam.resolveClinicalParticipants(ORG_A, patientId, pre.from, pre)).placeOfService,
      ).toBe("home");
      const post = { from: moveDay, to: range.to };
      expect(
        (await seam.resolveClinicalParticipants(ORG_A, patientId, post.from, post)).placeOfService,
      ).toBe("alf");
    });

    it("a general-inpatient period in the range -> null even with a home address (the residence is not the site)", async () => {
      const patientId = await rhcPatient(ORG_A, nextCcn());
      await seedAddress(ORG_A, patientId, { kind: "home" });
      const { range } = futureClaimRange();
      const addr = buildPatientAddressReader(handle.db);
      const gipSeam = buildM23ClinicalParticipantsAdapter(
        {
          forRange: async (orgId, pid, r) => {
            const ctx = await claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r);
            return ctx
              ? {
                  ...ctx,
                  levelOfCarePeriods: [
                    ...ctx.levelOfCarePeriods,
                    {
                      levelOfCarePeriodId: crypto.randomUUID(),
                      levelOfCare: "general_inpatient_care",
                      from: range.from,
                      to: range.to,
                      chcDocumentedHours: null,
                      gipAdmissionCriteriaDocumented: null,
                    },
                  ],
                }
              : ctx;
          },
        },
        undefined,
        {
          residence: {
            residencesBetween: (o, p, f, t) => addr.residencesBetween(o, p, f, t),
          },
          facilityKinds: { kindsFor: (ids) => facilityKindsForIds(handle.db, ids) },
        },
      );
      const r = await gipSeam.resolveClinicalParticipants(ORG_A, patientId, range.from, range);
      expect(r.placeOfService).toBeNull();
    });

    it("never resolves another org's residence (cross-tenant isolation, real NOBYPASSRLS role)", async () => {
      const patientIdB = await rhcPatient(ORG_B, nextCcn());
      await seedAddress(ORG_B, patientIdB, { kind: "home" });
      const { range } = futureClaimRange();
      const seam = posSeam();
      // Org B asking about its own patient works ...
      expect(
        (await seam.resolveClinicalParticipants(ORG_B, patientIdB, range.from, range))
          .placeOfService,
      ).toBe("home");
      // ... org A asking about org B's patient sees no admission, no LOC period and no address.
      expect(
        (await seam.resolveClinicalParticipants(ORG_A, patientIdB, range.from, range))
          .placeOfService,
      ).toBeNull();
    });

    it("M5 residencesBetween itself: org-scoped, primary-only, kind + facility + window only (no address columns)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedAddress(ORG_A, patientId, { kind: "home", primary: true });
      await seedAddress(ORG_A, patientId, { kind: "mailing", primary: false });
      const addr = buildPatientAddressReader(handle.db);
      const rows = await addr.residencesBetween(ORG_A, patientId, "2026-02-01", "2026-02-28");
      expect(rows).toEqual([
        { kind: "home", facilityId: null, effectiveFrom: POS_RANGE_FROM, effectiveTo: null },
      ]);
      expect(await addr.residencesBetween(ORG_B, patientId, "2026-02-01", "2026-02-28")).toEqual(
        [],
      );
    });
  });

  describe("end-to-end boundary: POST /claims/assemble's real SEAM_UNBOUND wall today", () => {
    it("progresses PAST the entire M6 block and fails at referenceData.perDiemRateTable with the typed RATE_TABLE_MISSING when the tenant has entered no rates (F-121 #251, F-210)", async () => {
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
        code: "RATE_TABLE_MISSING",
        statusCode: 422,
        message: expect.stringContaining("/api/v1/billing/rate-tables"),
      });
    });

    it("with NO wage index for the CCN the wall is the typed WAGE_INDEX_UNAVAILABLE naming the entry endpoint, and a tenant entry moves it to RATE_TABLE_MISSING (F-211)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const pe = await seedProviderEntity(ORG_A, "381299");
      await seedMacCredential(ORG_A, pe, "ngs_j6");
      const { range, fiscalYearStarting } = futureClaimRange();
      await activeAdmissionForRange(ORG_A, patientId, pe, "2026-01-01T00:00:00.000Z");
      const service = buildM23BootAssemblyService(handle.db, {
        providerCcn: testProviderCcnPort,
        m6ClaimRange: {
          forRange: (orgId, pid, r) => claimAssemblyRangeContextForOrg(handle.db, orgId, pid, r),
        },
      });
      const assemble = () =>
        service.assemble(
          { organizationId: ORG_A, userId: M6_USER, membershipId: M6_USER, actorKind: "user" },
          {
            providerEntityId: pe,
            patientId,
            serviceFrom: range.from,
            serviceTo: range.to,
            tob: "811",
          },
        );
      await expect(assemble()).rejects.toMatchObject({
        code: "WAGE_INDEX_UNAVAILABLE",
        statusCode: 422,
        message: expect.stringContaining("/api/v1/billing/wage-indexes"),
      });
      // ANOTHER tenant's entry for the same CCN + year must not satisfy this tenant's assembly.
      await admin.query(
        `INSERT INTO tenant_wage_index (organization_id, ccn, fiscal_year_starting, factor_decimal, source_reference, entered_by_membership_id)
         VALUES ($1,'381299',$2,1.0,'other tenant',$3)`,
        [ORG_B, fiscalYearStarting, U],
      );
      await expect(assemble()).rejects.toMatchObject({ code: "WAGE_INDEX_UNAVAILABLE" });
      // This tenant's own entry moves the wall on to the rate table.
      await admin.query(
        `INSERT INTO tenant_wage_index (organization_id, ccn, fiscal_year_starting, factor_decimal, source_reference, entered_by_membership_id)
         VALUES ($1,'381299',$2,0.95,'CMS wage index table',$3)`,
        [ORG_A, fiscalYearStarting, U],
      );
      await expect(assemble()).rejects.toMatchObject({ code: "RATE_TABLE_MISSING" });
    });

    it("with a tenant-entered rate table + sequestration policy the wall MOVES PAST perDiemRateTable/activeSequestrationPolicy to billableEncounters (F-210)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedPatientPayer(ORG_A, patientId, 1, "medicare_ffs", "2020-01-01");
      const pe = await seedProviderEntity(ORG_A, "381242");
      await seedMacCredential(ORG_A, pe, "ngs_j6");
      const { range, fiscalYearStarting } = futureClaimRange();
      await seedWageIndex("381242", fiscalYearStarting, "0.9500", "12060");
      await seedSequestrationPolicy(ORG_A, pe, "2.00", "2020-01-01");
      await admin.query(
        `INSERT INTO hospice_rate_table (organization_id, provider_entity_id, fiscal_year_starting, effective_from, effective_to,
           rhc_days_1_60_per_diem_cents, rhc_days_61_plus_per_diem_cents, chc_per_diem_cents, irc_per_diem_cents,
           gip_per_diem_cents, chc_hourly_rate_cents, labor_share_rhc, labor_share_chc, labor_share_irc, labor_share_gip, entered_by_membership_id)
         VALUES ($1,$2,$3,$4,$5, 21500, 17000, 105600, 49000, 118000, 4400, 0.66, 0.68, 0.54, 0.64, $6)`,
        [
          ORG_A,
          pe,
          fiscalYearStarting,
          `${fiscalYearStarting}-10-01`,
          `${fiscalYearStarting + 1}-09-30`,
          U,
        ],
      );
      await activeAdmissionForRange(ORG_A, patientId, pe, "2026-01-01T00:00:00.000Z");

      // No M8 port injected (unit-test default): the next stub the call order reaches is billableEncounters.
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
        message: expect.stringContaining("BillableEncounterReader"),
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
