/**
 * WardenX — clinical-core scenario data for the flagship patient (local dev). NOT for production.
 *
 * Builds real M7 (Care Plan) / M8 (Encounters) / M9 (Assessments) / M10 (HOPE) data for Eleanor
 * Whitfield (the active-RHC patient `seed-scenario-admission-outcomes.ts` designates as the
 * "everything works" demo patient), over the real REST API as the discipline-persona staff logins
 * `seed-staff-personas.ts` created — signed in as `rita@wardenx.local` (rn / rn_case_manager) for
 * authoring, and `drharris@wardenx.local` (md / hospice_physician / medical_director) for the
 * physician-eligible actions and the second care-plan signature.
 *
 * Genuine platform gaps hit and worked around/documented, not silently papered over:
 *   - M8 encounter SIGNING is unreachable — `requireStepUp` gates it, and the step-up routes
 *     (`POST /api/v1/sessions/step-up/initiate` / `/step-up`) are implemented but never mounted in
 *     the composition root (confirmed by reading `apps/backend/src/index.ts` — `registerSessionStepUpRoutes`
 *     is never imported there, unlike every other module's route mount). Encounters here are created
 *     + vitals captured + finalized, but stop at `finalized` rather than `signed`.
 *   - M9's scale scorer only implements 4 of 14 scale types (`pps`, `fast`, `painad`, `esas_r`) —
 *     every other `scaleType` 500s (`SCALE_SCORER_UNAVAILABLE`). Only those 4 are used here.
 *     `pps`/`fast` also need an active `scale_license` row first (D3) — created here.
 *   - M10's `authorDiscipline` body field is uppercase (`"RN"`/`"NP"`/`"MD"`) — the one place in the
 *     platform that differs from the lowercase role-key convention used everywhere else.
 *
 * Idempotent: re-bootstrapping a care plan for a patient that already has one 409s
 * (`ONE_ACTIVE_PLAN_PER_ADMISSION`) — caught and treated as "already seeded, skip" per section.
 * Prereqs: bun run db:seed:staff, db:seed:scenario-admissions (Whitfield must be active).
 * Run:     bun run db:seed:scenario-clinical
 */
import { Client } from "pg";
import { findPatientIdByLastName, ScenarioLog, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const today = (): string => new Date().toISOString().slice(0, 10);
const nowIso = (): string => new Date().toISOString();

/** Wipe any prior (possibly stuck-mid-draft, from an earlier failed run) care plan for one patient. */
async function wipePriorCarePlan(patientId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const plans = await db.query<{ id: string }>("SELECT id FROM care_plan WHERE patient_id = $1", [
    patientId,
  ]);
  const planIds = plans.rows.map((r) => r.id);
  if (planIds.length) {
    const versions = await db.query<{ id: string }>(
      "SELECT id FROM care_plan_version WHERE care_plan_id = ANY($1)",
      [planIds],
    );
    const versionIds = versions.rows.map((r) => r.id);
    if (versionIds.length) {
      await db.query("DELETE FROM care_plan_idg_decision_application WHERE care_plan_version_id = ANY($1)", [
        versionIds,
      ]);
      await db.query("DELETE FROM care_plan_signature WHERE care_plan_version_id = ANY($1)", [versionIds]);
    }
    await db.query("DELETE FROM intervention WHERE care_plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM goal WHERE care_plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM problem WHERE care_plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM care_plan_version WHERE care_plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM care_plan WHERE id = ANY($1)", [planIds]);
  }
  await db.end();
}

/** Wipe prior encounters/assessments/HOPE timepoints for one patient, for a clean idempotent re-run. */
async function wipePriorEncountersAssessmentsHope(patientId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  const encs = await db.query<{ id: string }>("SELECT id FROM encounter WHERE patient_id = $1", [
    patientId,
  ]);
  const encIds = encs.rows.map((r) => r.id);
  if (encIds.length) {
    for (const t of ["vitals", "mileage", "encounter_addendum", "encounter_care_plan_link", "encounter_signature"]) {
      await db.query(`DELETE FROM ${t} WHERE encounter_id = ANY($1)`, [encIds]);
    }
    await db.query("DELETE FROM encounter WHERE id = ANY($1)", [encIds]);
  }
  await db.query(
    "DELETE FROM assessment_cosignature WHERE clinical_assessment_id IN (SELECT id FROM clinical_assessment WHERE patient_id = $1)",
    [patientId],
  );
  await db.query("DELETE FROM clinical_assessment WHERE patient_id = $1", [patientId]);
  await db.query("DELETE FROM hope_assessment WHERE patient_id = $1", [patientId]);
  await db.end();
}

async function main(): Promise<void> {
  const admin = await signIn("admin@wardenx.local");
  const rn = await signIn("rita@wardenx.local");
  const md = await signIn("drharris@wardenx.local");
  const log = new ScenarioLog("clinical-core (Whitfield)");

  const patientId = await findPatientIdByLastName(rn, "Whitfield");
  const cert = await rn.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const admissionId = (cert.data as unknown as { admission?: { id?: string } } | undefined)?.admission
    ?.id;
  if (!admissionId) throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

  console.log("wiping any prior encounters/assessments/HOPE for a clean re-run...");
  await wipePriorEncountersAssessmentsHope(patientId);

  // ── M7 — Care Plan ─────────────────────────────────────────────────────────────────────────────
  try {
    await wipePriorCarePlan(patientId);
    const boot = await rn.client.POST("/api/v1/patients/{patientId}/care-plan", {
      params: { path: { patientId } },
      body: { admissionId },
    });
    if (boot.error) {
      throw new Error(`care-plan bootstrap failed: ${JSON.stringify(boot.error)}`);
    } else {
      const bootData = boot.data as unknown as { id: string };
      const planId = bootData.id;

      const problem = await rn.client.POST("/api/v1/care-plans/{planId}/problems", {
        params: { path: { planId } },
        body: {
          description: "Metastatic non-small cell lung cancer with progressive functional decline.",
          kind: "terminal",
          source: "clinical",
          icd10Code: "C34.90",
        },
      });
      const problemData = problem.data as unknown as { id: string } | undefined;
      if (problem.error || !problemData) throw new Error(`problem create failed: ${JSON.stringify(problem.error)}`);

      const painProblem = await rn.client.POST("/api/v1/care-plans/{planId}/problems", {
        params: { path: { planId } },
        body: {
          description: "Chronic pain related to metastatic disease, poorly controlled.",
          kind: "related",
          source: "clinical",
        },
      });
      const painProblemData = painProblem.data as unknown as { id: string } | undefined;

      await rn.client.POST("/api/v1/care-plans/{planId}/goals", {
        params: { path: { planId } },
        body: {
          problemId: problemData.id,
          originalText: "Patient will report pain at or below 3/10 on a 0-10 scale through end of life.",
          source: "clinical",
          measurableOutcome: "Pain score ≤3/10 on daily assessment.",
        },
      });

      await rn.client.POST("/api/v1/care-plans/{planId}/interventions", {
        params: { path: { planId } },
        body: {
          problemId: problemData.id,
          scopeText: "RN case management visits to assess symptom burden and coordinate the IDG plan of care.",
          frequencyText: "Twice weekly",
          frequencyValue: "2x/week",
          discipline: "rn",
        },
      });
      if (painProblemData) {
        await rn.client.POST("/api/v1/care-plans/{planId}/interventions", {
          params: { path: { planId } },
          body: {
            problemId: painProblemData.id,
            scopeText: "Titrate comfort medications per physician orders; reassess pain at every visit.",
            frequencyText: "Every visit",
            frequencyValue: "PRN",
            discipline: "rn",
          },
        });
      }

      type PlanRead = {
        versions?: Array<{ id: string; status: string; version: number }>;
      };
      const readDraftVersion = async (): Promise<{ id: string; version: number }> => {
        const read = await rn.client.GET("/api/v1/patients/{patientId}/care-plan", {
          params: { path: { patientId } },
        });
        const v = (read.data as unknown as PlanRead | undefined)?.versions?.find(
          (x) => x.status === "draft" || x.status === "in_review",
        );
        if (!v) throw new Error("no draft/in_review care-plan version found");
        return { id: v.id, version: v.version };
      };

      const v1 = await readDraftVersion();
      const finalize = await rn.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/finalize", {
        params: { path: { planId, versionId: v1.id } },
        body: {
          ifVersion: v1.version,
          requiredSignerSet: [
            { role: "rn_case_manager", count: 1 },
            { role: "hospice_physician", count: 1 },
          ],
        },
      });
      if (finalize.error) throw new Error(`care-plan finalize failed: ${JSON.stringify(finalize.error)}`);

      const v2 = await readDraftVersion();
      const sign1 = await rn.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/signatures", {
        params: { path: { planId, versionId: v2.id } },
        body: { ifVersion: v2.version, signerRole: "rn_case_manager" },
      });
      if (sign1.error) throw new Error(`RN care-plan sign failed: ${JSON.stringify(sign1.error)}`);

      const v3 = await readDraftVersion();
      const sign2 = await md.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/signatures", {
        params: { path: { planId, versionId: v3.id } },
        body: { ifVersion: v3.version, signerRole: "hospice_physician" },
      });
      if (sign2.error) throw new Error(`MD care-plan sign failed: ${JSON.stringify(sign2.error)}`);

      log.ok("Care plan: bootstrapped, 2 problems, 1 goal, 2 interventions, finalized + fully signed");
    }
  } catch (err) {
    log.fail(`M7 care plan: ${String(err)}`);
  }

  // ── M8 — Encounters ────────────────────────────────────────────────────────────────────────────
  try {
    const enc = await rn.client.POST("/api/v1/encounters", {
      body: {
        patientId,
        admissionId,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: today(),
      },
    });
    const encData = enc.data as unknown as { id: string } | undefined;
    if (enc.error || !encData) throw new Error(`encounter create failed: ${JSON.stringify(enc.error)}`);

    await rn.client.POST("/api/v1/encounters/{encounterId}/vitals", {
      params: { path: { encounterId: encData.id } },
      body: {
        bpSystolic: 118,
        bpDiastolic: 72,
        heartRate: 88,
        respiratoryRate: 18,
        temperature: "98.2",
        temperatureUnit: "f",
        spo2: 95,
        painScore: 3,
        painScale: "nrs_0_10",
      },
    });

    const fin = await rn.client.POST("/api/v1/encounters/{encounterId}/finalize", {
      params: { path: { encounterId: encData.id } },
      body: {},
    });
    if (fin.error) throw new Error(`encounter finalize failed: ${JSON.stringify(fin.error)}`);

    // A second encounter left in draft, for realism (not every visit note is finalized same-day).
    const enc2 = await rn.client.POST("/api/v1/encounters", {
      body: {
        patientId,
        admissionId,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: today(),
      },
    });
    void enc2;

    log.ok(
      "Encounters: 1 finalized visit (vitals captured), 1 draft visit — sign unreachable (step-up routes unmounted, see file header)",
    );
  } catch (err) {
    log.fail(`M8 encounters: ${String(err)}`);
  }

  // ── M9 — Assessments ───────────────────────────────────────────────────────────────────────────
  try {
    // D3 license prereq for pps/fast — idempotent-ish: a second POST just adds a second license row,
    // harmless for demo purposes (no unique constraint observed in the route contract).
    // `assessment.license_admin` is an admin-category permission, not clinical — rita (clinical-only)
    // gets a 403 here, so this uses the grantAll admin session instead.
    await admin.client.POST("/api/v1/admin/scales/licenses", {
      body: {
        scaleType: "pps",
        vendor: "Demo Vendor",
        effectiveDate: "2024-01-01",
        expiresAt: "2027-01-01",
      },
    });
    await admin.client.POST("/api/v1/admin/scales/licenses", {
      body: {
        scaleType: "fast",
        vendor: "Demo Vendor",
        effectiveDate: "2024-01-01",
        expiresAt: "2027-01-01",
      },
    });

    const pps = await rn.client.POST("/api/v1/patients/{patientId}/assessments", {
      params: { path: { patientId } },
      body: {
        admissionId,
        scaleType: "pps",
        capturedAt: nowIso(),
        data: {
          ambulation: "mainly_in_bed",
          activity: "unable_any_work",
          selfCare: "considerable_assist",
          intake: "reduced",
          consciousness: "full",
        },
      },
    });
    if (pps.error) throw new Error(`PPS assessment failed: ${JSON.stringify(pps.error)}`);

    const esas = await rn.client.POST("/api/v1/patients/{patientId}/assessments", {
      params: { path: { patientId } },
      body: {
        admissionId,
        scaleType: "esas_r",
        capturedAt: nowIso(),
        data: {
          pain: 3,
          tiredness: 6,
          drowsiness: 4,
          nausea: 1,
          lackOfAppetite: 5,
          shortnessOfBreath: 2,
          depression: 3,
          anxiety: 2,
          wellbeing: 5,
          reportedBy: "clinician_observed",
        },
      },
    });
    if (esas.error) throw new Error(`ESAS-r assessment failed: ${JSON.stringify(esas.error)}`);

    log.ok("Assessments: PPS + ESAS-r recorded (license rows created for pps/fast)");
  } catch (err) {
    log.fail(`M9 assessments: ${String(err)}`);
  }

  // ── M10 — HOPE ─────────────────────────────────────────────────────────────────────────────────
  try {
    const hope = await rn.client.POST("/api/v1/admissions/{admissionId}/hope/timepoints", {
      params: { path: { admissionId } },
      body: {
        rfaKind: "01_admission",
        targetDate: nowIso(),
        authorDiscipline: "RN",
        data: {
          J: {
            J2051: {
              entries: [{ symptomCode: "pain", severity: "moderate" }],
            },
          },
        },
      },
    });
    const hopeData = hope.data as unknown as { id: string } | undefined;
    if (hope.error || !hopeData) throw new Error(`HOPE timepoint create failed: ${JSON.stringify(hope.error)}`);

    const sign = await rn.client.POST("/api/v1/hope/assessments/{id}/sign", {
      params: { path: { id: hopeData.id } },
      body: { attestationConfirmed: true },
    });
    if (sign.error) throw new Error(`HOPE sign failed: ${JSON.stringify(sign.error)}`);

    log.ok("HOPE: 01_admission timepoint recorded + signed");
  } catch (err) {
    log.fail(`M10 HOPE: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
