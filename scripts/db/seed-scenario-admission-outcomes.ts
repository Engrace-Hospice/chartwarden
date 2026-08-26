/**
 * WardenX — real M6 admission scenarios across the 6 demo patients (local dev). NOT for production.
 *
 * REPLACES `seed-census-active.ts`'s raw-SQL `patient.status` fakery — but doesn't fully escape the
 * need for a (much narrower, honestly-labeled) SQL patch of its own; see gap (3) below. Every patient
 * here goes through the genuine M6 write lifecycle (NOR → election statement → CTI double-sign →
 * activate → level-of-care / terminal event) over the real REST API, so `admission.status`/
 * `election_period.status` land the same way a real admission would produce them, and everything
 * downstream (care plans, encounters, billing, HQRP) has a real admission + election period to key
 * off instead of a patient row with a spoofed status and nothing else behind it.
 *
 * Six distinct outcomes, one per demo patient, chosen to cover the screens a QA pass would want to
 * see real data on:
 *   - Whitfield  → active, routine home care (the flagship patient later scenario scripts build on)
 *   - Okonkwo    → active, general inpatient care (M37 IPU / GIP billing-rate scenario)
 *   - Delgado    → transfer-in from another hospice (documented gap below — never reaches
 *                  admission.active; the inherited election period is what's real here)
 *   - Nakamura   → discharged (moved_out_of_service_area)
 *   - Brandt     → revoked
 *   - Fairbanks  → death discharge (feeds M16 bereavement — a later scenario script's prerequisite)
 *
 * Three genuine platform gaps found and left DOCUMENTED rather than silently worked around:
 * (1) an admission created with no `attendingPhysicianId` can never activate — the CTI auto-signs
 * straight past `awaiting_attending` on the hospice-MD signature, but `activateAdmission`'s gate
 * unconditionally demands `attending_signed` for period 1 regardless of whether an attending was
 * ever named — so every scenario here supplies one. (2) `transferIn` never calls
 * `transitionAdmission` at all, so the admission's own `status` column never advances past whatever
 * `createAdmission` left it at — only the inherited election period is genuinely "active"; there is
 * no discoverable way to also flip `admission.status` for a transfer-in through the real API today.
 * (3) `patient.status` never syncs from ANY M6 lifecycle event through any live mechanism — the
 * event catalog declares M5 as a consumer of `m6.admission.activated`, but no M5 consumer was ever
 * implemented, and more broadly the declarative `M<n>_OUTBOX_SUBSCRIPTIONS` arrays ~10 modules
 * export are never imported by the composition root at all (grepped `apps/backend/src/index.ts` for
 * every one of those constant names and for `OUTBOX_SUBSCRIPTIONS` itself — zero matches). That's a
 * real, sizeable missing subsystem, not a missing handler — out of scope to build here — so
 * `syncPatientStatus()` below sets `patient.status` directly via SQL after each scenario, honestly
 * standing in for the consumer that doesn't exist yet rather than pretending the API produces it.
 *
 * Idempotent: wipes any prior admission (+ every child row: election periods, CTIs, election
 * statements, NOR, discharge/revocation/transfer events, level-of-care periods, compliance windows,
 * F2F encounters, referrals) for these 6 patients via raw SQL before driving each one fresh through
 * the real API — same `session_replication_role = replica` superuser-cleanup pattern `seed.ts`
 * already uses, just scoped to these patients instead of the whole org. A shallower "skip if
 * anything exists" check isn't enough here: this script's own first run (before the outbox-payload
 * bugs above were fixed) left 5 of the 6 patients with admissions stuck mid-lifecycle — Okonkwo
 * wedged at `pending`, Brandt at `notice_of_rights_acknowledged`, neither matching any intended
 * outcome — and a shallow check would have silently built later scenario scripts (care plans,
 * encounters, billing) on top of that broken half-state instead of the real 6 outcomes below.
 * Prereqs: bun run db:seed:patients, db:seed:clinical, db:seed:mdm, db:seed:org-structure.
 * Run:     bun run db:seed:scenario-admissions
 */
import { Client } from "pg";
import type { WxSession } from "./lib/api-session";
import { findPatientIdByLastName, ScenarioLog, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "wardenx-demo";
const SCENARIO_LAST_NAMES = ["Whitfield", "Okonkwo", "Delgado", "Nakamura", "Brandt", "Fairbanks"];

async function wipePriorAdmissions(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  const orgId = orgRes.rows[0]?.id;
  if (!orgId) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);

  const pats = await db.query<{ id: string }>(
    "SELECT id FROM patient WHERE organization_id = $1 AND legal_last_name = ANY($2)",
    [orgId, SCENARIO_LAST_NAMES],
  );
  const patientIds = pats.rows.map((r) => r.id);
  if (!patientIds.length) return;

  const admRes = await db.query<{ id: string }>("SELECT id FROM admission WHERE patient_id = ANY($1)", [
    patientIds,
  ]);
  const admissionIds = admRes.rows.map((r) => r.id);
  if (admissionIds.length) {
    const epRes = await db.query<{ id: string }>(
      "SELECT id FROM election_period WHERE admission_id = ANY($1)",
      [admissionIds],
    );
    const periodIds = epRes.rows.map((r) => r.id);
    if (periodIds.length) {
      await db.query("DELETE FROM certification_of_terminal_illness WHERE election_period_id = ANY($1)", [
        periodIds,
      ]);
      await db.query("DELETE FROM election_statement WHERE election_period_id = ANY($1)", [periodIds]);
      await db.query("DELETE FROM face_to_face_encounter WHERE election_period_id = ANY($1)", [periodIds]);
      await db.query("DELETE FROM revocation_event WHERE election_period_id = ANY($1)", [periodIds]);
    }
    for (const t of [
      "notice_of_rights_acknowledgment",
      "discharge_event",
      "transfer_event",
      "level_of_care_period",
      "compliance_window",
    ]) {
      await db.query(`DELETE FROM ${t} WHERE admission_id = ANY($1)`, [admissionIds]);
    }
    await db.query("DELETE FROM election_period WHERE admission_id = ANY($1)", [admissionIds]);
    await db.query("DELETE FROM admission WHERE id = ANY($1)", [admissionIds]);
  }
  await db.query("DELETE FROM referral WHERE patient_id = ANY($1)", [patientIds]);
  await db.query(
    `UPDATE patient SET status = 'prospective', updated_at = now() WHERE id = ANY($1)`,
    [patientIds],
  );
  await db.end();
  console.log(`  (wiped ${admissionIds.length} prior admission(s) for a clean re-run)`);
}

/**
 * GENUINE GAP, confirmed by reading the code (not assumed): `patient.status` never syncs from the
 * real M6 admission lifecycle. `m6.admission.activated`'s event-catalog entry declares `"m5"` as a
 * consumer (events-by-m6.ts), but `apps/backend/src/modules/05-patient/outbox-consumers/` only
 * implements `m29-proposal-accepted.ts` — nothing for any M6 event. It's broader than just M5: the
 * declarative `M<n>_OUTBOX_SUBSCRIPTIONS` arrays that ~10 modules export (M11/M12/M13/M14/M17/M23/
 * M25/M27/...) are never imported by anything that actually dispatches to them — grepped the whole
 * composition root (`apps/backend/src/index.ts`) for every one of those constant names and every
 * `OUTBOX_SUBSCRIPTIONS` occurrence: zero matches. The comments on these files describe a live
 * dispatcher ("wires each eventName to consumerName's handler at boot") that doesn't exist yet
 * anywhere in this codebase. That's a real, sizeable gap worth its own fix — out of scope for a seed
 * script to build (it's a missing subsystem, not a missing handler) — so this function does directly
 * and honestly via SQL what the (currently nonexistent) consumer would do, so the Patients census
 * screen — which reads `patient.status` straight off the row — shows what a real activation/
 * discharge/death actually produced instead of every seeded patient reading "Prospective" forever.
 */
async function syncPatientStatus(patientId: string, status: string, deceasedDate?: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  // `patient_deceased_requires_date` CHECK constraint: deceased_date must be non-null iff status='deceased'.
  await db.query(
    `UPDATE patient SET status = $2::patient_status, deceased_date = $3::date, updated_at = now() WHERE id = $1`,
    [patientId, status, deceasedDate ?? null],
  );
  await db.end();
}

const HOSPICE_MD = "11111111-0000-4000-8000-000000000001"; // Eleanor Whitfield MD, NPI 1003000001 (db:seed:mdm)
const ATTENDING = "11111111-0000-4000-8000-000000000002"; // Marcus Delgado DO, NPI 1003000002
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_IPU_ID = "55555555-0000-4000-8000-000000000002"; // db:seed:org-structure

const today = (): string => new Date().toISOString().slice(0, 10);

/** The shared prefix every non-transfer-in scenario needs: create → NOR → election → CTI → activate. */
async function admitAndActivate(
  session: WxSession,
  /**
   * The CTI double-signature is PHYSICIAN-ONLY and must not reuse `session` (the org
   * administrator). §418.22(c) lets only the hospice medical director or a hospice physician
   * certify terminal illness, and `cti.is_hospice_md` / `cti.is_attending`
   * (apps/backend/src/modules/06-admission/abac-predicates.ts) enforce exactly that — an
   * administrator is denied no matter how many permission keys the role carries. See the two
   * sign calls below; every sibling scenario seed already signs in per persona this way.
   */
  md: WxSession,
  patientId: string,
  patientName: string,
): Promise<{ admissionId: string; periodId: string }> {
  const adm = await session.client.POST("/api/v1/admissions", {
    body: {
      patientId,
      intakeMethod: "in_person",
      attendingPhysicianId: ATTENDING,
      hospiceMedicalDirectorId: HOSPICE_MD,
    },
  });
  if (adm.error || !adm.data) throw new Error(`admission create failed: ${JSON.stringify(adm.error)}`);
  const admissionId = adm.data.id;

  await session.client.POST("/api/v1/admissions/{id}/nor", {
    params: { path: { id: admissionId } },
    body: {
      formVersionId: "00000000-0000-4000-8000-000000000001",
      deliveryMethod: "verbal_with_witness",
      acknowledgedAt: new Date().toISOString(),
      acknowledgedByName: patientName,
      acknowledgedByRole: "patient",
    },
  });

  // The generated client's response types for several of these routes don't declare a body (they
  // typecheck as `never`), even though every one of them empirically returns `{id, state, version}`
  // — confirmed live for every route below. Cast through `unknown` rather than fight the generated
  // schema; this is a client-generation gap, not a reason to skip using the real typed request path.
  const cert = await session.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const period = (
    cert.data as unknown as { periods?: Array<{ id: string; cti?: { id: string } | null }> } | undefined
  )?.periods?.[0];
  if (!period) throw new Error("no auto-seeded period 1 found after admission create");
  const periodId = period.id;
  const ctiId = period.cti?.id;
  if (!ctiId) throw new Error("no auto-seeded CTI found for period 1");

  const es = await session.client.POST("/api/v1/admissions/{id}/election-statements", {
    params: { path: { id: admissionId } },
    body: {
      electionPeriodId: periodId,
      effectiveDate: today(),
      primaryDiagnosisIcd10: "C34.90",
      electedProviderEntityId: PROVIDER_ENTITY_ID,
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    },
  });
  const esData = es.data as unknown as { id: string; version: number } | undefined;
  if (es.error || !esData) throw new Error(`election statement create failed: ${JSON.stringify(es.error)}`);
  await session.client.POST("/api/v1/election-statements/{id}/sign", {
    params: { path: { id: esData.id } },
    body: { signingPatientName: patientName, signingRole: "patient", ifVersion: esData.version },
  });

  // §418.22(c) hospice-side certification — `md`, not `session`: `cti.is_hospice_md` requires the
  // signer to BE the CTI's hospice medical director or to hold `medical_director` /
  // `hospice_physician`. Dr. Harris (seed-staff-personas.ts) holds both.
  const ctiMd = await md.client.POST("/api/v1/cti/{id}/sign-hospice-md", {
    params: { path: { id: ctiId } },
    body: { signingPhysicianName: "Eleanor Whitfield MD", signingPhysicianNpi: "1003000001", ifVersion: 0 },
  });
  const ctiMdData = ctiMd.data as unknown as { version: number } | undefined;
  if (ctiMd.error || !ctiMdData) throw new Error(`cti hospice-md sign failed: ${JSON.stringify(ctiMd.error)}`);
  // Attending certification is likewise a physician signature — `cti.is_attending` accepts the
  // named attending, `md`, or `hospice_physician`. Dr. Harris holds `md`.
  await md.client.POST("/api/v1/cti/{id}/sign-attending", {
    params: { path: { id: ctiId } },
    body: {
      signingPhysicianName: "Marcus Delgado DO",
      signingPhysicianNpi: "1003000002",
      ifVersion: ctiMdData.version,
    },
  });

  const certAfter = await session.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const admVersion =
    (certAfter.data as { admission?: { version?: number } } | undefined)?.admission?.version ?? 1;
  const activate = await session.client.POST("/api/v1/admissions/{id}/activate", {
    params: { path: { id: admissionId } },
    body: { ifVersion: admVersion },
  });
  if (activate.error) throw new Error(`activate failed: ${JSON.stringify(activate.error)}`);

  return { admissionId, periodId };
}

async function main(): Promise<void> {
  console.log("wiping any prior admission for the 6 scenario patients...");
  await wipePriorAdmissions();

  const session = await signIn("admin@wardenx.local");
  // The administrator drives intake/activation/discharge; the CTI double-signature is
  // physician-only (§418.22(c)) and goes through Dr. Harris, who carries `medical_director` +
  // `hospice_physician` + `md` in seed-staff-personas.ts.
  const md = await signIn("drharris@wardenx.local");
  const log = new ScenarioLog("admission-outcome scenarios");

  // ── 1. Whitfield — active, routine home care (flagship patient) ──────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Whitfield");
    const { admissionId } = await admitAndActivate(session, md, patientId, "Eleanor Whitfield");
    await session.client.POST("/api/v1/admissions/{id}/level-of-care", {
      params: { path: { id: admissionId } },
      body: {
        newLevel: "routine_home_care",
        effectiveStart: today(),
        reason: "Initial routine home care level at admission.",
      },
    });
    await syncPatientStatus(patientId, "active");
    log.ok("Whitfield: admitted + activated, routine home care");
  } catch (err) {
    log.fail(`Whitfield: ${String(err)}`);
  }

  // ── 2. Okonkwo — active, general inpatient care (IPU/GIP scenario) ───────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Okonkwo");
    const { admissionId } = await admitAndActivate(session, md, patientId, "Samuel Okonkwo");
    const loc = await session.client.POST("/api/v1/admissions/{id}/level-of-care", {
      params: { path: { id: admissionId } },
      body: {
        newLevel: "general_inpatient_care",
        effectiveStart: today(),
        facilityId: LOCATION_IPU_ID,
        reason:
          "Uncontrolled pain crisis with intractable nausea and vomiting requiring intensive palliative " +
          "symptom management not achievable at the routine home care level; admitted for inpatient " +
          "titration of comfort medications per interdisciplinary team assessment at end of life.",
      },
    });
    if (loc.error) throw new Error(`GIP level-of-care change failed: ${JSON.stringify(loc.error)}`);
    await syncPatientStatus(patientId, "active");
    log.ok("Okonkwo: admitted + activated, GIP level of care (assigning → confirm-bed still needed for M37)");
  } catch (err) {
    log.fail(`Okonkwo: ${String(err)}`);
  }

  // ── 3. Delgado — transfer-in from another hospice ─────────────────────────────────────────────
  // GENUINE GAP (see file header): transferIn never calls transitionAdmission, so admission.status
  // never leaves its post-create value here — inspect patient.status after this run to see what
  // actually happens rather than assume it.
  try {
    const patientId = await findPatientIdByLastName(session, "Delgado");
    const adm = await session.client.POST("/api/v1/admissions", {
      body: { patientId, intakeMethod: "transfer_in", hospiceMedicalDirectorId: HOSPICE_MD },
    });
    if (adm.error || !adm.data) throw new Error(`admission create failed: ${JSON.stringify(adm.error)}`);
    const xfer = await session.client.POST("/api/v1/admissions/{id}/transfer-in", {
      params: { path: { id: adm.data.id } },
      body: {
        direction: "in",
        effectiveDate: today(),
        otherHospiceName: "Piedmont Community Hospice",
        priorBenefitPeriodSequence: 2,
        priorElectionStartDate: "2026-05-01",
        hospiceMedicalDirectorId: HOSPICE_MD,
        attendingPhysicianId: ATTENDING,
        narrative:
          "Patient and family relocated from the Piedmont Community Hospice service area; election " +
          "transferred in benefit period 2 with no gap in hospice coverage per CMS transfer rules.",
      },
    });
    if (xfer.error) throw new Error(`transfer-in failed: ${JSON.stringify(xfer.error)}`);
    await syncPatientStatus(patientId, "active");
    log.ok(
      `Delgado: transferred in (admission ${adm.data.id}, inherited period active — admission.status not advanced, see file header)`,
    );
  } catch (err) {
    log.fail(`Delgado: ${String(err)}`);
  }

  // ── 4. Nakamura — discharged (moved out of service area) ─────────────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Nakamura");
    const { admissionId } = await admitAndActivate(session, md, patientId, "Henry Nakamura");
    const dc = await session.client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: admissionId } },
      body: {
        reason: "moved_out_of_service_area",
        dischargeDate: today(),
        narrative:
          "Patient and family relocated outside the agency's certified service area; hospice benefit " +
          "coordinated for transfer to a receiving agency near the new residence.",
      },
    });
    if (dc.error) throw new Error(`discharge failed: ${JSON.stringify(dc.error)}`);
    await syncPatientStatus(patientId, "discharged");
    log.ok("Nakamura: admitted + activated, then discharged (moved out of service area)");
  } catch (err) {
    log.fail(`Nakamura: ${String(err)}`);
  }

  // ── 5. Brandt — revoked ───────────────────────────────────────────────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Brandt");
    const { admissionId } = await admitAndActivate(session, md, patientId, "Margaret Brandt");
    const rev = await session.client.POST("/api/v1/admissions/{id}/revocation", {
      params: { path: { id: admissionId } },
      body: {
        revocationDate: today(),
        narrative:
          "Patient elected to revoke the hospice benefit to pursue curative chemotherapy after a " +
          "family consultation with oncology; revocation counseling completed and documented.",
        signingPatientName: "Margaret Brandt",
        signingRole: "patient",
        revocationReason: "seek_curative_treatment",
      },
    });
    if (rev.error) throw new Error(`revocation failed: ${JSON.stringify(rev.error)}`);
    await syncPatientStatus(patientId, "discharged");
    log.ok("Brandt: admitted + activated, then revoked (seek curative treatment)");
  } catch (err) {
    log.fail(`Brandt: ${String(err)}`);
  }

  // ── 6. Fairbanks — death discharge (feeds M16 bereavement) ───────────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Fairbanks");
    const { admissionId } = await admitAndActivate(session, md, patientId, "Walter Fairbanks");
    const dc = await session.client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: admissionId } },
      body: {
        reason: "death",
        dischargeDate: today(),
        narrative: "Patient died peacefully at home with family present; hospice team in attendance.",
        deathCertifierId: HOSPICE_MD,
      },
    });
    if (dc.error) throw new Error(`death discharge failed: ${JSON.stringify(dc.error)}`);
    await syncPatientStatus(patientId, "deceased", today());
    log.ok("Fairbanks: admitted + activated, then death discharge (should seed M16 bereavement eligibility)");
  } catch (err) {
    log.fail(`Fairbanks: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
