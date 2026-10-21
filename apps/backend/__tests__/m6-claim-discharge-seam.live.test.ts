import { randomUUID } from "node:crypto";
/**
 * M6 → M23 claim-assembly seam: the discharge facts the Medicare claim's patient discharge status, condition
 * and occurrence codes are derived from (CMS Pub. 100-04 Ch. 11 §30.3) — proven against real Postgres.
 *
 * `claimAssemblyRangeContextForOrg` (M6 `seams/drizzle-store.ts`) must count ONLY a `completed`
 * `discharge_event`: a `pending_cosign` for-cause filing leaves the admission active until the medical
 * director cosigns (D11) and a `voided` row never happened, so neither may end the claim's stay. It also
 * surfaces the place of death (status 40/41/42) and the transfer-out's receiving care setting (50/51) that
 * migration 0370 added, and the migration's CHECK constraints refuse a place of death on a non-death and a
 * care setting on a transfer-in.
 *
 * Seeds as the superuser; drives every write and the seam read as the NOBYPASSRLS `wardenx_app` role.
 * Gated on a live DB so the default `bun run test` stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:claim-discharge-seam:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bereavementDischargeLegitimacy, deriveDischargeClaimCodes } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  type DischargeDetailsService,
  claimAssemblyRangeContextForOrg,
  claimStayEndFactsForOrg,
  createDbDischargeDetailsService,
  createDbDischargeWorklistService,
} from "../src/modules/06-admission/index";
import {
  claimAttention,
  stayEndDischarge,
} from "../src/modules/23-billing-medicare/services/claim-attention";
import { buildIpuSeams } from "../src/modules/37-ipu/seams";
import { appRoleConnectionString } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";
import { seedPhysicianRole } from "./_physician-signer";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";
const MD = "55555555-5555-5555-5555-555555555555";
const PROVIDER_ENTITY = "77777777-7777-4777-8777-777777777777";
const ATTENDING = "88888888-8888-4888-8888-888888888888";
const DAY_MS = 24 * 3600_000;
const RANGE_HALF_WIDTH_DAYS = 30;

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
/** A claim range straddling today — activation stamps the period with the real wall clock. */
const claimRange = () => ({
  from: isoDay(-RANGE_HALF_WIDTH_DAYS),
  to: isoDay(RANGE_HALF_WIDTH_DAYS),
});

describe.skipIf(!DB_URL)("M6 claim-assembly discharge seam — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let details: DischargeDetailsService;

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

  /** Full activation through the real write path → an ACTIVE, period-1 admission. */
  async function activeAdmission(patientId: string): Promise<string> {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    const periodId = periods![0].id;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: OTHER,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
    return admissionId;
  }

  async function fileForCause(admissionId: string) {
    return svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "for_cause",
        dischargeDate: isoDay(0),
        narrative: "documented safety threat to staff",
        forCauseReason: "repeated credible threats of violence to visiting nurses",
      },
      USER,
    );
  }

  const seamAdmission = async (patientId: string) =>
    (await claimAssemblyRangeContextForOrg(handle.db, ORG_A, patientId, claimRange()))?.admission;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m6cd-a@x.test'),($2,'m6cd-b@x.test'),($3,'m6cd-md@x.test')`,
      [USER, OTHER, MD],
    );
    await admin.query(
      `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'CCN-M6CD','M6 CD Hospice','NPI-M6CD','enc','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await seedPhysicianRole(admin, ORG_A, MD);
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerM5IntakeSeams(handle.db);
    svc = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(),
      buildIpuSeams(handle.db).IpuBedAssignmentProvider,
      {
        async belongsToOrg(organizationId, providerEntityId) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
    );
    details = createDbDischargeDetailsService(handle.db, validatingM6Outbox());
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a pending_cosign for-cause filing does not end the claim's stay", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const filed = await fileForCause(admissionId);
    expect(filed.state).toBe("pending_cosign");

    expect(await seamAdmission(patientId)).toMatchObject({
      admissionId,
      dischargeDate: null,
      dischargeReason: null,
      deceasedDate: null,
      placeOfDeath: null,
      transferOut: null,
    });
  });

  it("a voided discharge does not end the claim's stay", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const filed = await fileForCause(admissionId);
    // A rejected for-cause filing is voided; the row stays for the audit trail.
    await admin.query("UPDATE discharge_event SET status='voided' WHERE id=$1", [filed.id]);

    expect(await seamAdmission(patientId)).toMatchObject({
      admissionId,
      dischargeDate: null,
      dischargeReason: null,
      placeOfDeath: null,
    });
  });

  it("a cosigned for-cause discharge DOES end the stay (the filter is on status, not reason)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const filed = await fileForCause(admissionId);
    await svc.cosignDischarge(
      ORG_A,
      filed.id,
      // 42 CFR 418.26(b): the cosigner signs as a physician the authority port recognises.
      {
        cosignerName: "Dr. Med Director",
        cosignerNpi: "1234567893",
        actorRoleKeys: ["medical_director"],
      },
      filed.version,
      MD,
    );

    expect(await seamAdmission(patientId)).toMatchObject({
      admissionId,
      dischargeDate: isoDay(0),
      dischargeReason: "for_cause",
      placeOfDeath: null,
    });
  });

  it("a completed death surfaces its place of death (claim status 40/41/42)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "death",
        dischargeDate: isoDay(0),
        narrative: "expired peacefully in the nursing facility",
        deathCertifierId: MD,
        placeOfDeath: "facility",
      },
      USER,
    );

    expect(await seamAdmission(patientId)).toMatchObject({
      admissionId,
      dischargeDate: isoDay(0),
      dischargeReason: "death",
      deceasedDate: isoDay(0),
      placeOfDeath: "facility",
      transferOut: null,
    });
  });

  it("a death without a place of death is refused before any write", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    await expect(
      svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "death",
          dischargeDate: isoDay(0),
          narrative: "expired peacefully at home",
          deathCertifierId: MD,
        },
        USER,
      ),
    ).rejects.toMatchObject({ code: "PLACE_OF_DEATH_REQUIRED", statusCode: 422 });
    const { rows } = await admin.query("SELECT id FROM discharge_event WHERE admission_id=$1", [
      admissionId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("a transfer-out surfaces its receiving care setting (claim status 50/51)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    await svc.transferOut(
      ORG_A,
      admissionId,
      {
        effectiveDate: isoDay(0),
        otherHospiceName: "Sunrise Hospice",
        receivingCareSetting: "facility",
        narrative: "patient moved to a nursing facility served by another hospice",
      },
      USER,
    );
    const { rows } = await admin.query(
      "SELECT receiving_care_setting FROM transfer_event WHERE admission_id=$1 AND direction='out'",
      [admissionId],
    );
    expect(rows[0].receiving_care_setting).toBe("facility");

    expect(await seamAdmission(patientId)).toMatchObject({
      admissionId,
      dischargeDate: null,
      transferOut: { effectiveDate: isoDay(0), receivingCareSetting: "facility" },
    });
  });

  it("never resolves another org's discharge facts (cross-tenant RLS)", async () => {
    const patientId = randomUUID();
    await activeAdmission(patientId);
    const ctx = await claimAssemblyRangeContextForOrg(handle.db, ORG_B, patientId, claimRange());
    expect(ctx).toBeNull();
  });

  it("migration 0370's CHECKs refuse a place of death on a non-death and a care setting on a transfer-in", async () => {
    const admissionId = await activeAdmission(randomUUID());
    const filed = await fileForCause(admissionId);
    await expect(
      admin.query("UPDATE discharge_event SET place_of_death='home' WHERE id=$1", [filed.id]),
    ).rejects.toThrow(/discharge_event_place_of_death_death_only_chk/);
    await expect(
      admin.query("UPDATE transfer_event SET receiving_care_setting='home' WHERE direction='in'"),
    ).resolves.toBeDefined(); // no transfer-in rows yet: vacuous, proves the statement itself is valid
    await expect(
      admin.query(
        "UPDATE transfer_event SET receiving_care_setting='hospital' WHERE direction='out'",
      ),
    ).rejects.toThrow(/transfer_event_receiving_care_setting_chk/);
  });

  // ── after-the-fact discharge details (POST /discharges/:id/place-of-death, /transfers/:id/receiving-care-setting)

  /** A death recorded BEFORE migration 0370 captured the place (the column NULL, as on historic rows). */
  async function historicDeath(patientId: string) {
    const admissionId = await activeAdmission(patientId);
    const de = await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "death",
        dischargeDate: isoDay(0),
        narrative: "expired peacefully at home",
        deathCertifierId: MD,
        placeOfDeath: "home",
      },
      USER,
    );
    await admin.query("UPDATE discharge_event SET place_of_death = NULL WHERE id=$1", [de.id]);
    const { rows } = await admin.query("SELECT version FROM discharge_event WHERE id=$1", [de.id]);
    return { admissionId, dischargeEventId: de.id, version: Number(rows[0].version) };
  }

  /** The discharge rule's verdict for a final claim whose window ends today, from the LIVE stay-end facts. */
  async function ruleFor(admissionId: string) {
    const [facts] = await claimStayEndFactsForOrg(handle.db, ORG_A, [admissionId]);
    const discharge = stayEndDischarge(facts!);
    const serviceTo = isoDay(0);
    const claim = {
      claimId: "claim-live",
      admissionId,
      tob: "811",
      dischargeDate: discharge?.effectiveDate ?? null,
      dischargeReason: discharge?.kind ?? null,
      dischargeClaimCodes: deriveDischargeClaimCodes({ serviceTo, discharge }),
      dischargeSourceEventId: discharge?.sourceEventId ?? null,
    };
    const result = bereavementDischargeLegitimacy.check(
      { claim, lines: [] } as never,
      bereavementDischargeLegitimacy.defaultParameters ?? {},
    );
    const attention = claimAttention(
      { claimId: "claim-live", admissionId, tob: "811", state: "ready", serviceTo },
      facts,
    );
    return { result, attention, codes: claim.dischargeClaimCodes };
  }

  it("a historic death blocks the claim (PLACE_OF_DEATH_MISSING); recording the place clears it", async () => {
    const patientId = randomUUID();
    const { admissionId, dischargeEventId, version } = await historicDeath(patientId);

    const before = await ruleFor(admissionId);
    expect(before.result.passed).toBe(false);
    expect(before.result.annotations?.defects?.[0]).toMatchObject({
      code: "PLACE_OF_DEATH_MISSING",
      refs: { admissionId, dischargeEventId },
    });
    expect(before.attention.flags).toEqual(["missing_discharge_details"]);
    expect((await details.getForAdmission(ORG_A, admissionId))?.missing).toBe("place_of_death");

    const saved = await details.recordPlaceOfDeath(
      ORG_A,
      dischargeEventId,
      { value: "facility", ifVersion: version },
      USER,
    );
    expect(saved).toMatchObject({ changed: true, previousValue: null, claimPatientStatus: "41" });
    expect(saved.version).toBe(version + 1);

    const after = await ruleFor(admissionId);
    expect(after.codes.patientStatus).toBe("41");
    expect(after.result.passed).toBe(true);
    expect(after.attention.flags).toEqual([]);
    // The catalog-validated outbox row M23's revalidate trigger consumes.
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m6.discharge.details_recorded' AND aggregate_id=$1",
      [dischargeEventId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      admissionId,
      patientId,
      detail: "place_of_death",
      dischargeEventId,
      value: "facility",
      previousValue: null,
      corrected: false,
    });
  });

  it("refuses a stale version, and a correction without a reason; stores the reason with a correction", async () => {
    const { dischargeEventId, version } = await historicDeath(randomUUID());
    await expect(
      details.recordPlaceOfDeath(
        ORG_A,
        dischargeEventId,
        { value: "home", ifVersion: version + 5 },
        USER,
      ),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    const first = await details.recordPlaceOfDeath(
      ORG_A,
      dischargeEventId,
      { value: "home", ifVersion: version },
      USER,
    );
    // Same value again: a no-op (no bump, no second event).
    const again = await details.recordPlaceOfDeath(
      ORG_A,
      dischargeEventId,
      { value: "home", ifVersion: first.version },
      USER,
    );
    expect(again).toMatchObject({ changed: false, version: first.version });
    await expect(
      details.recordPlaceOfDeath(
        ORG_A,
        dischargeEventId,
        { value: "unknown", ifVersion: first.version },
        USER,
      ),
    ).rejects.toMatchObject({
      code: "DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED",
      statusCode: 409,
    });
    const corrected = await details.recordPlaceOfDeath(
      ORG_A,
      dischargeEventId,
      {
        value: "unknown",
        ifVersion: first.version,
        correctionReason: "family could not confirm where the death occurred",
      },
      USER,
    );
    expect(corrected).toMatchObject({ changed: true, previousValue: "home" });
    const { rows } = await admin.query(
      "SELECT place_of_death, place_of_death_correction_reason FROM discharge_event WHERE id=$1",
      [dischargeEventId],
    );
    expect(rows[0]).toEqual({
      place_of_death: "unknown",
      place_of_death_correction_reason: "family could not confirm where the death occurred",
    });
  });

  it("records a historic transfer-out's receiving care setting; a death is not a transfer", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const xfer = await svc.transferOut(
      ORG_A,
      admissionId,
      {
        effectiveDate: isoDay(0),
        otherHospiceName: "Sunrise Hospice",
        receivingCareSetting: "home",
        narrative: "patient moved closer to family served by another hospice",
      },
      USER,
    );
    await admin.query("UPDATE transfer_event SET receiving_care_setting = NULL WHERE id=$1", [
      xfer.id,
    ]);
    const before = await ruleFor(admissionId);
    expect(before.result.annotations?.defects?.[0]?.code).toBe("RECEIVING_CARE_SETTING_MISSING");
    expect(before.attention.missingDischargeDetail?.transferEventId).toBe(xfer.id);

    const view = await details.getForAdmission(ORG_A, admissionId);
    expect(view?.missing).toBe("receiving_care_setting");
    const saved = await details.recordReceivingCareSetting(
      ORG_A,
      xfer.id,
      { value: "facility", ifVersion: view!.transferOut!.version },
      USER,
    );
    expect(saved.claimPatientStatus).toBe("51");
    expect((await ruleFor(admissionId)).codes.patientStatus).toBe("51");
  });

  it("is RLS-scoped: another org cannot see, resolve or update the record", async () => {
    const { admissionId, dischargeEventId, version } = await historicDeath(randomUUID());
    expect(await details.getForAdmission(ORG_B, admissionId)).toBeNull();
    expect(await details.admissionIdForDischarge(ORG_B, dischargeEventId)).toBeNull();
    await expect(
      details.recordPlaceOfDeath(
        ORG_B,
        dischargeEventId,
        { value: "home", ifVersion: version },
        USER,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await claimStayEndFactsForOrg(handle.db, ORG_B, [admissionId])).toEqual([
      expect.objectContaining({ admissionId, dischargeDate: null, transferOut: null }),
    ]);
    const { rows } = await admin.query("SELECT place_of_death FROM discharge_event WHERE id=$1", [
      dischargeEventId,
    ]);
    expect(rows[0].place_of_death).toBeNull();
  });

  it("migration 0372 refuses a correction reason shorter than 20 characters", async () => {
    const { dischargeEventId } = await historicDeath(randomUUID());
    await expect(
      admin.query(
        "UPDATE discharge_event SET place_of_death_correction_reason='short' WHERE id=$1",
        [dischargeEventId],
      ),
    ).rejects.toThrow(/discharge_event_pod_correction_reason_len_chk/);
  });

  // ── the end-of-episode worklist (GET /api/v1/discharges/worklist, the web "Discharge / transfer" hub)

  it("worklist buckets: ready / needs_details / awaiting_cosign, caseload-narrowed and RLS-scoped", async () => {
    const worklist = createDbDischargeWorklistService(handle.db);
    const ORG_WIDE = { patientIds: null };
    const ids = async (org: string, bucket: "ready" | "needs_details" | "awaiting_cosign") =>
      (await worklist.list(org, { bucket, limit: 200 }, ORG_WIDE)).items;

    const readyPatient = randomUUID();
    const ready = await activeAdmission(readyPatient);
    const pending = await activeAdmission(randomUUID());
    const filed = await fileForCause(pending);
    const death = await historicDeath(randomUUID());
    const xferAdmission = await activeAdmission(randomUUID());
    const xfer = await svc.transferOut(
      ORG_A,
      xferAdmission,
      {
        effectiveDate: isoDay(0),
        otherHospiceName: "Sunrise Hospice",
        receivingCareSetting: "home",
        narrative: "patient moved closer to family served by another hospice",
      },
      USER,
    );
    await admin.query("UPDATE transfer_event SET receiving_care_setting = NULL WHERE id=$1", [
      xfer.id,
    ]);

    const readyItems = await ids(ORG_A, "ready");
    expect(readyItems.map((i) => i.admissionId)).toContain(ready);
    // A for-cause filing awaiting cosign keeps the admission active but is not offered a second discharge.
    expect(readyItems.map((i) => i.admissionId)).not.toContain(pending);
    expect(readyItems.find((i) => i.admissionId === ready)).toMatchObject({
      patientId: readyPatient,
      admissionState: "active",
      missing: null,
    });

    const cosign = await ids(ORG_A, "awaiting_cosign");
    expect(cosign.find((i) => i.admissionId === pending)).toMatchObject({
      dischargeEventId: filed.id,
      dischargeType: "for_cause",
      effectiveDate: isoDay(0),
    });

    const needs = await ids(ORG_A, "needs_details");
    expect(needs.find((i) => i.admissionId === death.admissionId)).toMatchObject({
      missing: "place_of_death",
      dischargeEventId: death.dischargeEventId,
      dischargeType: "death",
    });
    expect(needs.find((i) => i.admissionId === xferAdmission)).toMatchObject({
      missing: "receiving_care_setting",
      transferEventId: xfer.id,
      dischargeType: "transfer_out",
    });
    expect(needs.map((i) => i.admissionId)).not.toContain(ready);

    // Recording the place of death takes the admission off the list.
    await details.recordPlaceOfDeath(
      ORG_A,
      death.dischargeEventId,
      { value: "home", ifVersion: death.version },
      USER,
    );
    expect((await ids(ORG_A, "needs_details")).map((i) => i.admissionId)).not.toContain(
      death.admissionId,
    );

    // Caseload narrowing (GAP-020) and an empty caseload.
    const narrowed = await worklist.list(
      ORG_A,
      { bucket: "ready", limit: 200 },
      { patientIds: [readyPatient] },
    );
    expect(narrowed.items.map((i) => i.admissionId)).toEqual([ready]);
    expect((await worklist.list(ORG_A, { bucket: "ready" }, { patientIds: [] })).items).toEqual([]);

    // Pagination cursor.
    const first = await worklist.list(ORG_A, { bucket: "ready", limit: 1 }, ORG_WIDE);
    expect(first.items).toHaveLength(1);
    if (first.nextCursor !== null) {
      const second = await worklist.list(
        ORG_A,
        { bucket: "ready", limit: 1, cursor: first.nextCursor },
        ORG_WIDE,
      );
      expect(second.items[0]?.admissionId).not.toBe(first.items[0]?.admissionId);
    }

    // RLS: another org sees none of it.
    for (const bucket of ["ready", "needs_details", "awaiting_cosign"] as const) {
      expect(await ids(ORG_B, bucket)).toEqual([]);
    }
  });
});
