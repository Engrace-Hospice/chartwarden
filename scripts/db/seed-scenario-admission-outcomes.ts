/**
 * ChartWarden — real M6 admission scenarios across the 6 demo patients (local dev). NOT for production.
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
 *   - Delgado    → transfer-in from another hospice (mid benefit period 2). This script stops at the
 *                  transfer-in itself; `db:seed:scenario-delgado-active` (run right after) signs her
 *                  election statement and activates the admission — see "Transfer-in activation" below
 *   - Nakamura   → discharged (moved_out_of_service_area)
 *   - Brandt     → revoked
 *   - Fairbanks  → death discharge (feeds M16 bereavement — a later scenario script's prerequisite)
 *
 * Genuine platform gaps found and left DOCUMENTED rather than silently worked around (the original
 * (1), activation demanding an attending CTI signature, is gone: since #241 the hospice-MD signature
 * alone signs the CTI). (2) — "`transferIn` never reaches `admission.active`" — was a REAL M6 bug and is
 * FIXED (D9): `gateFacts` hard-wired the activation period to `sequence_number = 1`, which a transfer-in
 * never has (it gets the inherited active period + the next pending one), so the gate could never see her
 * election statement and demanded a CTI the receiving hospice does not owe on the inherited period; and
 * signing the election statement was refused because the inherited period is already `active`. Both are
 * fixed in `admission-route-service-db.ts` (live test in m6-admission-write-lifecycle.live.test.ts).
 * Transfer-in activation: a transfer-in still needs the ordinary election-statement + NOR ceremony, which
 * this script does not drive — run `bun run db:seed:scenario-delgado-active` after it.
 * (3) `patient.status` never syncs from ANY M6 lifecycle event through any live mechanism — the
 * event catalog declares M5 as a consumer of `m6.admission.activated`, but no M5 consumer was ever
 * implemented, and more broadly the declarative `M<n>_OUTBOX_SUBSCRIPTIONS` arrays ~10 modules
 * export are never imported by the composition root at all (grepped `apps/backend/src/index.ts` for
 * every one of those constant names and for `OUTBOX_SUBSCRIPTIONS` itself — zero matches). That's a
 * real, sizeable missing subsystem, not a missing handler — out of scope to build here — so
 * `syncPatientStatus()` below sets `patient.status` directly via SQL after each scenario, honestly
 * standing in for the consumer that doesn't exist yet rather than pretending the API produces it.
 *
 * Benefit-period dating through the real API: activation stamps period 1 `[today, today+89]` (so
 * Whitfield/Okonkwo are period 1, recert ~90 days out, F2F not required); the only lever that dates
 * a period relative to an arbitrary day is transfer-in's `priorElectionStartDate`, so Delgado is seeded
 * mid-cycle (period 2 started 80 days ago → recert/period 3 due in 10 days, F2F window open, F2F booked).
 * There is no API to backdate an activation or attest-then-age a period, so an "overdue"/"attested"
 * example would need raw SQL and is deliberately not seeded here.
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
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "chartwarden-demo";
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

  const admRes = await db.query<{ id: string }>(
    "SELECT id FROM admission WHERE patient_id = ANY($1)",
    [patientIds],
  );
  const admissionIds = admRes.rows.map((r) => r.id);
  if (admissionIds.length) {
    const epRes = await db.query<{ id: string }>(
      "SELECT id FROM election_period WHERE admission_id = ANY($1)",
      [admissionIds],
    );
    const periodIds = epRes.rows.map((r) => r.id);
    if (periodIds.length) {
      await db.query(
        "DELETE FROM certification_of_terminal_illness WHERE election_period_id = ANY($1)",
        [periodIds],
      );
      await db.query("DELETE FROM election_statement WHERE election_period_id = ANY($1)", [
        periodIds,
      ]);
      await db.query("DELETE FROM face_to_face_encounter WHERE election_period_id = ANY($1)", [
        periodIds,
      ]);
      await db.query("DELETE FROM revocation_event WHERE election_period_id = ANY($1)", [
        periodIds,
      ]);
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
  // A prior run's post-admission privacy flag (see PRIVACY_FLAGS) would block this run's activation.
  await db.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id = ANY($1)", [
    patientIds,
  ]);
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
async function syncPatientStatus(
  patientId: string,
  status: string,
  deceasedDate?: string,
): Promise<void> {
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

/**
 * The Part-2/SUD restriction db:seed:clinical describes for Okonkwo (its `flags` column), recorded here
 * AFTER his admission activates. M6 readiness refuses activation while any privacy flag is active and
 * asks for an "authorized review" no route performs yet (`overrideAllowed` is returned but unused), so a
 * flag recorded first would leave him un-admittable. A restriction recorded mid-stay is also realistic.
 */
const PRIVACY_FLAGS: Readonly<Record<string, readonly string[]>> = { Okonkwo: ["sud_part2"] };

async function recordPrivacyFlags(patientId: string, flags: readonly string[]): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const [org] = (
    await db.query<{ organization_id: string }>(
      "SELECT organization_id FROM patient WHERE id = $1",
      [patientId],
    )
  ).rows;
  if (!org) throw new Error(`patient ${patientId} not found for privacy flags`);
  await db.query(
    `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, captured_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (patient_id) DO UPDATE SET flags = EXCLUDED.flags, captured_at = now()`,
    [patientId, org.organization_id, [...flags]],
  );
  await db.end();
}

const HOSPICE_MD = "11111111-0000-4000-8000-000000000001"; // Samuel Harris MD (persona Dr. Sam Harris), NPI 1003000001 (db:seed:mdm)
const ATTENDING = "11111111-0000-4000-8000-000000000002"; // Marcus Tillman DO, NPI 1003000002
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_IPU_ID = "55555555-0000-4000-8000-000000000002"; // db:seed:org-structure

const today = (): string => new Date().toISOString().slice(0, 10);
/** `today()` shifted by `days` (UTC calendar days; negative = past). */
const daysFromToday = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/**
 * The admission day: yesterday (UTC). A same-day admission dated with the UTC date sits in the org's
 * timezone "tomorrow" for the hours before local midnight, so HOPE's admission window (opening at local
 * midnight of the admission day) would not be open yet when db:seed:scenario-clinical records it.
 */
const admissionDay = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// The CTI signatures are physician certifications (§418.22(c)): `cti.is_hospice_md` / `cti.is_attending`
// admit only the medical director / hospice physician / MD roles, which the org admin does not hold.
// They are signed as the seeded Hospice Medical Director persona (db:seed:staff), set in main().
let physicianSession: WxSession | null = null;

/**
 * The signing physician's §418.22(b)(3) narrative. The auto-seeded CTI draft carries none, and the
 * sign route answers 422 `CTI_NARRATIVE_REQUIRED` unless the physician supplies >= 200 characters
 * at signature, so the seed supplies one — as the real hospice physician does in the web app.
 */
const CTI_NARRATIVE =
  "Synthetic demo narrative. Patient has a terminal illness with progressive functional decline, " +
  "recurrent symptom burden and declining oral intake over recent months. In my clinical judgment, " +
  "if the disease runs its normal course, life expectancy is six months or less. Hospice comfort " +
  "care is appropriate and the patient and family have elected it.";

/** A 418.26(b) physician discharge order signed now by the seeded Hospice Medical Director. */
function physicianDischargeOrder(orderText: string): {
  signedByUserId: string;
  signedAt: string;
  capacity: "medical_director";
  orderText: string;
} {
  if (!physicianSession) throw new Error("physician session not initialised");
  return {
    signedByUserId: physicianSession.userId,
    signedAt: new Date().toISOString(),
    capacity: "medical_director",
    orderText,
  };
}

/** The shared prefix every non-transfer-in scenario needs: create → NOR → election → CTI → activate. */
async function admitAndActivate(
  session: WxSession,
  patientId: string,
  patientName: string,
): Promise<{ admissionId: string; periodId: string }> {
  const adm = await session.client.POST("/api/v1/admissions", {
    body: {
      patientId,
      intakeMethod: "in_person",
      // UB-04 FL 14 / FL 15 — claims are blocked without them (rule admission_codes_present).
      admissionTypeCode: "3",
      admissionSourceCode: "1",
      attendingPhysicianId: ATTENDING,
      hospiceMedicalDirectorId: HOSPICE_MD,
    },
  });
  if (adm.error || !adm.data)
    throw new Error(`admission create failed: ${JSON.stringify(adm.error)}`);
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
    cert.data as unknown as
      | { periods?: Array<{ id: string; cti?: { id: string } | null }> }
      | undefined
  )?.periods?.[0];
  if (!period) throw new Error("no auto-seeded period 1 found after admission create");
  const periodId = period.id;
  const ctiId = period.cti?.id;
  if (!ctiId) throw new Error("no auto-seeded CTI found for period 1");

  const es = await session.client.POST("/api/v1/admissions/{id}/election-statements", {
    params: { path: { id: admissionId } },
    body: {
      electionPeriodId: periodId,
      effectiveDate: admissionDay(),
      primaryDiagnosisIcd10: "C34.90",
      electedProviderEntityId: PROVIDER_ENTITY_ID,
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    },
  });
  const esData = es.data as unknown as { id: string; version: number } | undefined;
  if (es.error || !esData)
    throw new Error(`election statement create failed: ${JSON.stringify(es.error)}`);
  await session.client.POST("/api/v1/election-statements/{id}/sign", {
    params: { path: { id: esData.id } },
    body: { signingPatientName: patientName, signingRole: "patient", ifVersion: esData.version },
  });

  const signer = physicianSession ?? session;
  const ctiMd = await signer.client.POST("/api/v1/cti/{id}/sign-hospice-md", {
    params: { path: { id: ctiId } },
    body: {
      signingPhysicianName: "Samuel Harris MD",
      signingPhysicianNpi: "1003000001",
      narrative: CTI_NARRATIVE,
      ifVersion: 0,
    },
  });
  if (ctiMd.error || !ctiMd.data)
    throw new Error(`cti hospice-md sign failed: ${JSON.stringify(ctiMd.error)}`);
  // #241: the hospice-MD signature alone signs the CTI; the attending's signature gates billing, not
  // activation, so there is no attending step here.

  const certAfter = await session.client.GET(
    "/api/v1/patients/{patientId}/election-certification",
    {
      params: { path: { patientId } },
    },
  );
  const certVersion =
    (certAfter.data as { admission?: { version?: number } } | undefined)?.admission?.version ?? 1;
  // Admission details: activation readiness requires an admission date (`admission_details`).
  const details = await session.client.PATCH("/api/v1/admissions/{id}", {
    params: { path: { id: admissionId } },
    body: { admissionAt: `${admissionDay()}T12:00:00.000Z`, ifVersion: certVersion },
  });
  const detailsData = details.data as unknown as { version: number } | undefined;
  if (details.error || !detailsData)
    throw new Error(`admission details update failed: ${JSON.stringify(details.error)}`);
  const admVersion = detailsData.version;
  // #50 — activation SITES the admission at a service location. The demo hospice has two active sites
  // (Main Office + Inpatient Unit, db:seed:org-structure), so the server refuses to guess and requires
  // one to be named. Resolved through the real M1 directory route rather than hardcoding the seeded id,
  // so this exercises the same lookup the activation ceremony's picker uses.
  const locations = await session.client.GET("/api/v1/locations", {
    params: { query: { providerEntityId: PROVIDER_ENTITY_ID, status: "active" } },
  });
  const locationId = (
    locations.data as { items?: Array<{ id: string; name: string }> } | undefined
  )?.items?.find((l) => l.name.includes("Main Office"))?.id;
  if (!locationId) {
    throw new Error(
      `no active Main Office location under ${PROVIDER_ENTITY_ID} — run db:seed:org-structure first`,
    );
  }
  const activate = await session.client.POST("/api/v1/admissions/{id}/activate", {
    params: { path: { id: admissionId } },
    body: { ifVersion: admVersion, locationId },
  });
  if (activate.error) throw new Error(`activate failed: ${JSON.stringify(activate.error)}`);

  return { admissionId, periodId };
}

async function main(): Promise<void> {
  console.log("wiping any prior admission for the 6 scenario patients...");
  await wipePriorAdmissions();

  const session = await signIn("admin@chartwarden.local");
  physicianSession = await signIn("drharris@chartwarden.local");
  const log = new ScenarioLog("admission-outcome scenarios");

  // ── 1. Whitfield — active, routine home care (flagship patient) ──────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Whitfield");
    const { admissionId } = await admitAndActivate(session, patientId, "Eleanor Whitfield");
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
    const { admissionId } = await admitAndActivate(session, patientId, "Samuel Okonkwo");
    const loc = await session.client.POST("/api/v1/admissions/{id}/level-of-care", {
      params: { path: { id: admissionId } },
      body: {
        newLevel: "general_inpatient_care",
        effectiveStart: today(),
        facilityId: LOCATION_IPU_ID,
        // D12: GIP is refused (412 GIP_DOCUMENTATION_INCOMPLETE) unless all three are attested true.
        gipAttestations: {
          symptomsNotManageableElsewhere: true,
          intensityWarrantsGip: true,
          inpatientSettingIdentified: true,
        },
        reason:
          "Uncontrolled pain crisis with intractable nausea and vomiting requiring intensive palliative " +
          "symptom management not achievable at the routine home care level; admitted for inpatient " +
          "titration of comfort medications per interdisciplinary team assessment at end of life.",
      },
    });
    if (loc.error) throw new Error(`GIP level-of-care change failed: ${JSON.stringify(loc.error)}`);
    await syncPatientStatus(patientId, "active");
    await recordPrivacyFlags(patientId, PRIVACY_FLAGS.Okonkwo ?? []);
    log.ok(
      "Okonkwo: admitted + activated, GIP level of care (assigning → confirm-bed still needed for M37)",
    );
  } catch (err) {
    log.fail(`Okonkwo: ${String(err)}`);
  }

  // ── 3. Delgado — transfer-in from another hospice ─────────────────────────────────────────────
  // Stops at the transfer-in (inherited period active, next period pending). Activation is the ordinary
  // election-statement + NOR ceremony, driven by `db:seed:scenario-delgado-active` (see file header, D9).
  try {
    const patientId = await findPatientIdByLastName(session, "Delgado");
    const adm = await session.client.POST("/api/v1/admissions", {
      body: {
        patientId,
        intakeMethod: "transfer_in",
        admissionTypeCode: "3",
        admissionSourceCode: "6", // transfer from another health care facility (another hospice)
        hospiceMedicalDirectorId: HOSPICE_MD,
      },
    });
    if (adm.error || !adm.data)
      throw new Error(`admission create failed: ${JSON.stringify(adm.error)}`);
    const xfer = await session.client.POST("/api/v1/admissions/{id}/transfer-in", {
      params: { path: { id: adm.data.id } },
      body: {
        direction: "in",
        effectiveDate: today(),
        otherHospiceName: "Piedmont Community Hospice",
        priorBenefitPeriodSequence: 2,
        // DATED RELATIVE TO TODAY (was a hard-coded 2026-05-01, which drifts into "recert long overdue"
        // as the calendar advances, and left the M14 IDG "Recert & F2F windows" pane on a stale/undated
        // period). The inherited period's window is `[start, start + 89]` (90-day period, 42 CFR 418.21),
        // so starting it 80 days ago puts the recertification (period 3) due in 10 days, with the
        // period-3 face-to-face window (`[due - 30, due - 1]`, 418.22(a)(4)) OPEN right now.
        priorElectionStartDate: daysFromToday(-80),
        hospiceMedicalDirectorId: HOSPICE_MD,
        attendingPhysicianId: ATTENDING,
        narrative:
          "Patient and family relocated from the Piedmont Community Hospice service area; election " +
          "transferred in benefit period 2 with no gap in hospice coverage per CMS transfer rules.",
      },
    });
    if (xfer.error) throw new Error(`transfer-in failed: ${JSON.stringify(xfer.error)}`);
    // Book (not attest) the period-3 face-to-face inside its open window so the IDG pane can show
    // "window open, F2F scheduled". Best-effort: the dated periods above are the load-bearing part.
    try {
      const eps = await session.client.GET("/api/v1/admissions/{id}/election-periods", {
        params: { path: { id: adm.data.id } },
      });
      // The list is ordered by sequence_number and carries no sequence field: the transfer-in's NEXT
      // (pending, period 3) period is the last row.
      const next = (
        eps.data as unknown as { items?: Array<{ id: string; state?: string }> } | undefined
      )?.items?.at(-1);
      if (!next || next.state !== "pending") throw new Error("pending period 3 not found");
      const f2f = await session.client.POST("/api/v1/admissions/{id}/face-to-face", {
        params: { path: { id: adm.data.id } },
        body: {
          electionPeriodId: next.id,
          scheduledDate: daysFromToday(3),
          windowStart: daysFromToday(-20),
          windowEnd: daysFromToday(9),
          clinicianRole: "hospice_md",
          scheduledClinicianId: (physicianSession ?? session).userId,
        },
      });
      if (f2f.error) throw new Error(JSON.stringify(f2f.error));
    } catch (err) {
      console.log(`  (Delgado: F2F booking skipped — ${String(err)})`);
    }
    await syncPatientStatus(patientId, "active");
    log.ok(
      `Delgado: transferred in (admission ${adm.data.id}, inherited period active — run db:seed:scenario-delgado-active to activate)`,
    );
  } catch (err) {
    log.fail(`Delgado: ${String(err)}`);
  }

  // ── 4. Nakamura — discharged (moved out of service area) ─────────────────────────────────────
  try {
    const patientId = await findPatientIdByLastName(session, "Nakamura");
    const { admissionId } = await admitAndActivate(session, patientId, "Henry Nakamura");
    const dc = await session.client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: admissionId } },
      body: {
        reason: "moved_out_of_service_area",
        dischargeDate: today(),
        narrative:
          "Patient and family relocated outside the agency's certified service area; hospice benefit " +
          "coordinated for transfer to a receiving agency near the new residence.",
        // 42 CFR 418.26(b): a live discharge on/after 2026-10-01 needs a written physician discharge
        // order, signed by a user the server can back with the claimed signer capacity.
        dischargeOrder: physicianDischargeOrder("Discharge: moved out of the service area."),
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
    const { admissionId } = await admitAndActivate(session, patientId, "Margaret Brandt");
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
    const { admissionId } = await admitAndActivate(session, patientId, "Walter Fairbanks");
    const dc = await session.client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id: admissionId } },
      body: {
        reason: "death",
        dischargeDate: today(),
        narrative:
          "Patient died peacefully at home with family present; hospice team in attendance.",
        deathCertifierId: HOSPICE_MD,
        placeOfDeath: "home",
      },
    });
    if (dc.error) throw new Error(`death discharge failed: ${JSON.stringify(dc.error)}`);
    await syncPatientStatus(patientId, "deceased", today());
    log.ok(
      "Fairbanks: admitted + activated, then death discharge (should seed M16 bereavement eligibility)",
    );
  } catch (err) {
    log.fail(`Fairbanks: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
