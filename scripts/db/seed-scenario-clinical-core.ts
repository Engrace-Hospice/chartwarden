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
 *   - M8 encounter SIGNING is unreachable from a seed: `requireStepUp` gates it and a step-up is a
 *     live re-authentication ceremony (WebAuthn assertion or a TOTP code) that a script cannot perform.
 *     The routes themselves are mounted as of #90 — the older note here that they were never mounted
 *     is no longer true. Encounters stop at `finalized` rather than `signed`.
 *   - M8 FINALIZE pins the assembled narrative under the tenant DEK (#122). This used to refuse with
 *     503 HEARTHNOTE_CIPHER_UNBOUND on every local stack and the note here blamed #105, the unbound
 *     KEK adapter. That was wrong twice over: #105 was fixed when `bootstrap/tenant-kek.ts` landed,
 *     and the KEK was never the missing piece. Two things were — a `tenant_key_ring` row, which the
 *     base seed did not create because it INSERTs its organization directly rather than provisioning
 *     it through M34 (F-082, now fixed in `seed.ts`), and `DATABASE_PLATFORM_URL`, because migration
 *     0052 §5 REVOKES `wardenx_app`'s SELECT on that table by design so only the platform credential
 *     can resolve a wrapped DEK. With both configured the finalize succeeds; the ⊘ branch below is
 *     kept because a stack with no `M34_TENANT_KEK` still legitimately reaches it.
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
import { resolveTemplate } from "@wardenx/hearthnote";
import { Client } from "pg";
import type { WxSession } from "./lib/api-session";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import { stepUpSession } from "./lib/step-up";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const today = (): string => new Date().toISOString().slice(0, 10);
const nowIso = (): string => new Date().toISOString();

/** HOPE items the workflow owns (prefill, SFV, signature) — never answered through the public API. */
const HOPE_WORKFLOW_ITEMS = /^(A0050|A0220|A0250|A0270|J2052[A-C]|J2053[A-H]|Z0350|Z0500B)$/;

type HopeWorkspace = {
  assessment: { version: number };
  sections: Array<{
    items: Array<{
      itemCode: string;
      cmsItemTypeCode: string;
      options: Array<{ valueCode: string; sortOrder: number }>;
    }>;
  }>;
};
type HopeReview = {
  readiness: { readyToSign: boolean; blockers: Array<{ code: string; itemCode?: string }> };
};

/**
 * Answer every applicable HOPE item until the assessment is sign-ready (signing requires it), the same
 * way `m10-hope-write.live.test.ts`'s `answerForSign` does: the first real option for a coded item,
 * `answerDate` for a date, "Test" for text. Returns the assessment version to sign against.
 */
async function answerForSign(session: WxSession, id: string, answerDate: string): Promise<number> {
  const workspace = async (): Promise<HopeWorkspace> => {
    const ws = await session.client.GET("/api/v1/hope/assessments/{id}/workspace", {
      params: { path: { id } },
    });
    if (ws.error || !ws.data) throw new Error(`HOPE workspace failed: ${JSON.stringify(ws.error)}`);
    return ws.data as unknown as HopeWorkspace;
  };
  const patch = async (changes: Record<string, string>): Promise<void> => {
    const ws = await workspace();
    const res = await session.client.PATCH("/api/v1/hope/assessments/{id}/answers", {
      params: { path: { id } },
      body: {
        ifVersion: ws.assessment.version,
        changes: Object.entries(changes).map(([itemCode, value]) => ({
          itemCode,
          action: "set" as const,
          value,
        })),
      } as never,
    });
    if (res.error) throw new Error(`HOPE answer patch failed: ${JSON.stringify(res.error)}`);
  };
  await patch({ A1400A: "1" });
  for (let round = 0; round < 6; round++) {
    const review = await session.client.GET("/api/v1/hope/assessments/{id}/review", {
      params: { path: { id } },
    });
    const readiness = (review.data as unknown as HopeReview | undefined)?.readiness;
    if (review.error || !readiness)
      throw new Error(`HOPE review failed: ${JSON.stringify(review.error)}`);
    if (readiness.readyToSign) return (await workspace()).assessment.version;
    const ws = await workspace();
    const items = new Map(ws.sections.flatMap((s) => s.items).map((i) => [i.itemCode, i]));
    const changes: Record<string, string> = {};
    for (const b of readiness.blockers) {
      if (b.code !== "UNANSWERED_APPLICABLE_ITEM" || !b.itemCode) continue;
      if (HOPE_WORKFLOW_ITEMS.test(b.itemCode)) continue;
      const item = items.get(b.itemCode);
      if (!item) continue;
      const codes = [...item.options]
        .sort((x, y) => x.sortOrder - y.sortOrder)
        .map((o) => o.valueCode);
      const real = codes.filter(
        (c) => !["Text", "YYYYMMDD", "YYYYMM", "YYYY", "^", "-"].includes(c),
      );
      changes[b.itemCode] =
        codes.includes("YYYYMMDD") || /date/i.test(item.cmsItemTypeCode)
          ? answerDate
          : codes.includes("Text")
            ? "Test"
            : (real[0] ?? "0");
    }
    const entries = Object.entries(changes);
    if (entries.length === 0)
      throw new Error(`HOPE ${id} is not sign-ready: ${JSON.stringify(readiness.blockers)}`);
    // The answers route takes at most 32 changes per request.
    for (let i = 0; i < entries.length; i += 32) {
      await patch(Object.fromEntries(entries.slice(i, i + 32)));
    }
  }
  throw new Error(`HOPE ${id} did not reach sign readiness`);
}

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
      await db.query(
        "DELETE FROM care_plan_idg_decision_application WHERE care_plan_version_id = ANY($1)",
        [versionIds],
      );
      await db.query("DELETE FROM care_plan_signature WHERE care_plan_version_id = ANY($1)", [
        versionIds,
      ]);
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
    for (const t of [
      "vitals",
      "mileage",
      "encounter_addendum",
      "encounter_care_plan_link",
      "encounter_signature",
    ]) {
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
  const admissionId = (cert.data as unknown as { admission?: { id?: string } } | undefined)
    ?.admission?.id;
  if (!admissionId)
    throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

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
    }
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
    if (problem.error || !problemData)
      throw new Error(`problem create failed: ${JSON.stringify(problem.error)}`);

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
        originalText:
          "Patient will report pain at or below 3/10 on a 0-10 scale through end of life.",
        source: "clinical",
        measurableOutcome: "Pain score ≤3/10 on daily assessment.",
      },
    });

    await rn.client.POST("/api/v1/care-plans/{planId}/interventions", {
      params: { path: { planId } },
      body: {
        problemId: problemData.id,
        scopeText:
          "RN case management visits to assess symptom burden and coordinate the IDG plan of care.",
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
          scopeText:
            "Titrate comfort medications per physician orders; reassess pain at every visit.",
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
    const finalize = await rn.client.POST(
      "/api/v1/care-plans/{planId}/versions/{versionId}/finalize",
      {
        params: { path: { planId, versionId: v1.id } },
        body: {
          ifVersion: v1.version,
          requiredSignerSet: [
            { role: "rn_case_manager", count: 1 },
            { role: "hospice_physician", count: 1 },
          ],
        },
      },
    );
    if (finalize.error)
      throw new Error(`care-plan finalize failed: ${JSON.stringify(finalize.error)}`);

    // Care-plan signing is step-up gated; see lib/step-up.ts.
    const v2 = await readDraftVersion();
    await stepUpSession(rn.userId);
    const sign1 = await rn.client.POST(
      "/api/v1/care-plans/{planId}/versions/{versionId}/signatures",
      {
        params: { path: { planId, versionId: v2.id } },
        body: { ifVersion: v2.version, signerRole: "rn_case_manager" },
      },
    );
    if (sign1.error) throw new Error(`RN care-plan sign failed: ${JSON.stringify(sign1.error)}`);

    const v3 = await readDraftVersion();
    await stepUpSession(md.userId);
    const sign2 = await md.client.POST(
      "/api/v1/care-plans/{planId}/versions/{versionId}/signatures",
      {
        params: { path: { planId, versionId: v3.id } },
        body: { ifVersion: v3.version, signerRole: "hospice_physician" },
      },
    );
    if (sign2.error) throw new Error(`MD care-plan sign failed: ${JSON.stringify(sign2.error)}`);

    log.ok(
      "Care plan: bootstrapped, 2 problems, 1 goal, 2 interventions, finalized + fully signed",
    );
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
    if (enc.error || !encData)
      throw new Error(`encounter create failed: ${JSON.stringify(enc.error)}`);

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

    // Write the HearthNote before finalizing. The §2.6 Layer-3 gate is real now and refuses an encounter
    // with no documentation — which is correct, and which this seed depended on NOT being true: it
    // captured vitals and finalized a visit note that said nothing. Without this the finalize is a 422
    // with four MISSING_SECTION details, `log.fail` sets exit 1, and `db:seed:all`'s && chain stops.
    const template = resolveTemplate("routine_visit", "rn");
    if (template === undefined) throw new Error("no HearthNote template for routine_visit × rn");
    const sel = await rn.client.PATCH("/api/v1/encounters/{encounterId}/selections", {
      params: { path: { encounterId: encData.id }, header: { "If-Match": "0" } },
      body: {
        sections: template.sections
          .filter((t) => t.required)
          .map((t) => ({ sectionId: t.id, entries: [{ code: "nv.cv.stable" }] })),
      },
    });
    if (sel.error) throw new Error(`encounter selections failed: ${JSON.stringify(sel.error)}`);

    const fin = await rn.client.POST("/api/v1/encounters/{encounterId}/finalize", {
      params: { path: { encounterId: encData.id } },
    });
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

    // Finalize PINS the assembled narrative under the tenant DEK (#122). A deployment that has both
    // halves of M34's key envelope configured — `M34_TENANT_KEK` and `DATABASE_PLATFORM_URL` — seals it
    // and succeeds. One that has neither cannot key this tenant's PHI at all, which is a CONFIGURATION
    // state rather than a seeding bug: name it and carry on rather than failing the whole chain.
    const finErr = fin.error as { error?: { code?: string } } | undefined;
    if (finErr?.error?.code === "HEARTHNOTE_CIPHER_UNBOUND") {
      log.blocked(
        "Encounters: 2 draft visits (vitals + HearthNote captured) — finalize refused, no tenant DEK could be resolved to seal the assembled narrative (set M34_TENANT_KEK + DATABASE_PLATFORM_URL, then re-run db:seed)",
      );
    } else if (fin.error) {
      throw new Error(`encounter finalize failed: ${JSON.stringify(fin.error)}`);
    } else {
      log.ok(
        "Encounters: 1 finalized visit (vitals + HearthNote captured), 1 draft visit — sign unreachable (step-up requires a live step-up ceremony this seed cannot perform)",
      );
    }
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
    // Capture inside the admission timepoint's window. It opens at local midnight of the activation's
    // date, which for an activation in the hours before local midnight is still ahead of "now" — so the
    // target is the later of now and the open 01_admission window's opening.
    const schedules = await rn.client.GET("/api/v1/hope/schedules", {
      params: { query: { patientId, rfaKind: "01_admission", status: "open" } },
    });
    const opensAt = (
      schedules.data as unknown as { schedules?: Array<{ windowOpensAt: string }> } | undefined
    )?.schedules?.[0]?.windowOpensAt;
    const now = nowIso();
    const targetDate = opensAt && opensAt > now ? opensAt : now;
    const hope = await rn.client.POST("/api/v1/admissions/{admissionId}/hope/timepoints", {
      params: { path: { admissionId } },
      body: {
        rfaKind: "01_admission",
        targetDate,
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
    const hopeData = hope.data as unknown as { id: string; version: number } | undefined;
    if (hope.error || !hopeData)
      throw new Error(`HOPE timepoint create failed: ${JSON.stringify(hope.error)}`);

    const signVersion = await answerForSign(rn, hopeData.id, targetDate.slice(0, 10));
    const sign = await rn.client.POST("/api/v1/hope/assessments/{id}/sign", {
      params: { path: { id: hopeData.id } },
      body: { ifVersion: signVersion, attestationConfirmed: true },
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
