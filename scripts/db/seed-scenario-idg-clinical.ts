/**
 * WardenX — recent clinical activity for the IDG demo patients (local dev). NOT for production.
 *
 * WHY. The M14 packet builder (`14-idg/jobs/packet-build.ts`) fills the "since last IDG" sections of a patient
 * packet from real upstream facts, and a demo stack had none for Whitfield / Nakamura / Delgado, so every one of
 * those sections rendered "None recorded". Where each section comes from (checked against the builder, not assumed):
 *   - SIGNED ENCOUNTERS  ← M8 `SignedEncountersReader.signedEncountersForPatientSince` = `encounter` rows in status
 *     `signed`/`cosigned` with `signed_at` strictly after the patient's IDG cursor.
 *   - ASSESSMENT CHANGES ← the Valkey "since last IDG" cache, appended by the M14 consumers of
 *     `m9.assessment.recorded` / `m9.assessment.significant_change`.
 *   - ORDER / MEDICATION CHANGES ← the same cache, appended by the consumers of `m11.order.discontinued` /
 *     `m12.medication_order.discontinued` (only DISCONTINUATIONS reach the cache today).
 * The cursor is `MAX(last_idg_reviewed_at)` over the patient's other packets (an adjourned meeting), else the admission's
 * `activated_at` — and every block is filtered STRICTLY AFTER it. So the activity here is created "now" through the real
 * write paths (its `signed_at` / `effectiveAt` is what the builder sees); only the PRIOR baseline assessments (which give the
 * significant-change detector its delta) are back-dated ~9 days.
 *
 * EVERYTHING GOES THROUGH THE REAL API as the discipline personas (`seed-staff-personas.ts`), so RLS, ABAC, state machines,
 * the outbox and the M14 consumers all run honestly. Two seeds' precedents are reused: `lib/step-up.ts` (the stand-in for a
 * WebAuthn/TOTP ceremony, needed to sign an encounter) and the HearthNote required-section fill of `seed-scenario-clinical-core.ts`.
 * No SQL writes at all (SQL is read-only, for idempotency checks).
 *
 * ADDITIVE + IDEMPOTENT: never deletes or edits an existing row. Each step first checks whether the same activity is already
 * there (signed encounter by that persona for that patient in the window; a marker on assessments/orders/medications) and skips it.
 * No SUD (42 CFR Part 2) scenario: the only Part-2 demo patient (Okonkwo) has no active admission, so no packet ever includes her.
 *
 * Prereqs: db:seed, db:seed:org-admin, db:seed:staff, db:seed:org-structure, db:seed:scenario-admissions,
 * db:seed:scenario-delgado-active, db:seed:scenario-idg-packets (signed care plans); backend + worker running;
 * DATABASE_ADMIN_URL set (the idempotency reads + step-up nudge). Run afterwards `db:idg:packet-build` on an upcoming meeting to see it.
 * Run: DATABASE_ADMIN_URL=... BETTER_AUTH_URL=http://localhost:3000 bun run db:seed:scenario-idg-clinical
 */
import { resolveTemplate } from "@wardenx/hearthnote";
import { VOCABULARY } from "@wardenx/narrative-vocab";
import { Client } from "pg";
import { ScenarioLog, type WxSession, findPatientIdByLastName, signIn } from "./lib/api-session";
import { stepUpSession } from "./lib/step-up";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const log = new ScenarioLog("IDG clinical activity (M8/M9/M11/M12)");
const MDM_PHYSICIAN_ID = "11111111-0000-4000-8000-000000000001"; // db:seed:mdm
const MARK = "[idg-clinical-seed]";
const nowIso = (): string => new Date().toISOString();
const today = (): string => new Date().toISOString().slice(0, 10);

async function sql<T extends Record<string, unknown>>(
  q: string,
  args: unknown[] = [],
): Promise<T[]> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    return (await db.query(q, args)).rows as T[];
  } finally {
    await db.end();
  }
}

async function must<T>(
  what: string,
  p: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok)
    throw new Error(`${what}: HTTP ${r.response.status} ${JSON.stringify(r.error)}`);
  return r.data as T;
}

// ── personas ───────────────────────────────────────────────────────────────────────────────────────────────
interface Personas {
  admin: WxSession;
  rn: WxSession;
  md: WxSession;
  msw: WxSession;
  chaplain: WxSession;
  chha: WxSession;
}

// ── 1. signed encounters ───────────────────────────────────────────────────────────────────────────────────
type Discipline = "rn" | "msw" | "chaplain" | "chha" | "md";
interface EncounterPlan {
  discipline: Discipline;
  encounterType: string;
  vitals?: {
    bp: [number, number];
    hr: number;
    rr: number;
    temp: string;
    spo2: number;
    pain: number;
  };
}

const SLOT_VALUES: Record<string, string> = {
  coping_status: "adequate",
  family_dynamics_note: "the family is engaged and supportive of the plan of care",
  faith_tradition: "Roman Catholic",
  spiritual_intervention: "prayer and scripture reading",
  adl_tasks: "bathing, grooming and linen change",
  edema_grade: "1+",
};
const slotsOf = (phrase: string): string[] =>
  [...phrase.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1] ?? "").filter((k) => k !== "patient");

/** A required-section fill the HearthNote gate accepts: for a section with `allowedCategories`, a vocabulary entry of
 *  that category valid for this discipline/type (its `${slots}` filled from SLOT_VALUES); open sections reuse the
 *  discipline's own entry (nursing/provider disciplines: the generic `nv.cv.stable` observation, the precedent
 *  `seed-scenario-clinical-core.ts` uses). */
function selectionsFor(encounterType: string, discipline: string): unknown {
  const template = resolveTemplate(encounterType as never, discipline as never);
  if (template === undefined)
    throw new Error(`no HearthNote template for ${encounterType} x ${discipline}`);
  const entry = (code: string, phrase: string) => ({
    code,
    ...(slotsOf(phrase).length > 0
      ? {
          params: Object.fromEntries(
            slotsOf(phrase).map((k) => [k, SLOT_VALUES[k] ?? "as documented"]),
          ),
        }
      : {}),
  });
  const pick = (categories: readonly string[] | undefined): ReturnType<typeof entry> => {
    const usable = VOCABULARY.filter(
      (e) =>
        (categories === undefined || categories.includes(e.category)) &&
        (e.disciplines as readonly string[]).includes(discipline) &&
        slotsOf(e.phrase).every((k) => k in SLOT_VALUES),
    );
    const hit =
      usable.find((e) => (e.encounterTypes as readonly string[]).includes(encounterType)) ??
      usable[0];
    if (hit) return entry(hit.code, hit.phrase);
    if (categories === undefined) return { code: "nv.cv.stable" };
    const any = VOCABULARY.find(
      (e) => categories.includes(e.category) && slotsOf(e.phrase).every((k) => k in SLOT_VALUES),
    );
    if (!any) throw new Error(`no vocabulary entry for categories ${categories.join(",")}`);
    return entry(any.code, any.phrase);
  };
  const required = template.sections.filter((s) => s.required);
  const firstCategorised = required.find(
    (s) => (s as { allowedCategories?: readonly string[] }).allowedCategories,
  );
  const own = firstCategorised
    ? pick((firstCategorised as { allowedCategories?: readonly string[] }).allowedCategories)
    : undefined;
  const isSkilled =
    discipline === "rn" || discipline === "md" || discipline === "np" || discipline === "lpn";
  return required.map((s) => {
    const cats = (s as { allowedCategories?: readonly string[] }).allowedCategories;
    return {
      sectionId: s.id,
      entries: [cats ? pick(cats) : isSkilled || !own ? pick(undefined) : own],
    };
  });
}

async function alreadySigned(
  patientId: string,
  membershipEmail: string,
  plan: EncounterPlan,
): Promise<boolean> {
  const rows = await sql<{ n: string }>(
    `SELECT count(*)::text n FROM encounter e
       JOIN membership m ON m.id = e.authored_by_membership_id
       JOIN "user" u ON u.id = m.user_id
      WHERE e.patient_id = $1 AND u.email = $2 AND e.discipline = $3 AND e.encounter_type = $4
        AND e.status IN ('signed','cosigned','cosign_pending') AND e.service_date >= (current_date - 14)`,
    [patientId, membershipEmail, plan.discipline, plan.encounterType],
  );
  return rows[0]?.n !== "0";
}

async function seedEncounter(
  who: WxSession,
  rnCosigner: WxSession,
  name: string,
  patientId: string,
  admissionId: string,
  plan: EncounterPlan,
): Promise<void> {
  const label = `${name}: ${plan.discipline} ${plan.encounterType}`;
  if (await alreadySigned(patientId, who.email, plan)) {
    log.dup(`${label} — signed encounter already in the last 14 days`);
    return;
  }
  try {
    // Resume an unfinished draft from an earlier run rather than piling up another one.
    const reuse = await sql<{ id: string; sel: string; vit: string }>(
      `SELECT e.id,
              (SELECT count(*) FROM hearthnote_selection s WHERE s.encounter_id = e.id)::text sel,
              (SELECT count(*) FROM vitals v WHERE v.encounter_id = e.id)::text vit
         FROM encounter e JOIN membership m ON m.id = e.authored_by_membership_id JOIN "user" u ON u.id = m.user_id
        WHERE e.patient_id = $1 AND u.email = $2 AND e.discipline = $3 AND e.encounter_type = $4
          AND e.status = 'draft' AND e.service_date = current_date ORDER BY e.created_at LIMIT 1`,
      [patientId, who.email, plan.discipline, plan.encounterType],
    );
    const prior = reuse[0];
    const enc = prior
      ? { id: prior.id }
      : await must<{ id: string }>(
          `${label} create`,
          who.client.POST("/api/v1/encounters", {
            body: {
              patientId,
              admissionId,
              encounterType: plan.encounterType,
              discipline: plan.discipline,
              serviceDate: today(),
            } as never,
          }),
        );
    if (plan.vitals && (!prior || prior.vit === "0")) {
      const v = plan.vitals;
      await must(
        `${label} vitals`,
        who.client.POST("/api/v1/encounters/{encounterId}/vitals", {
          params: { path: { encounterId: enc.id } },
          body: {
            bpSystolic: v.bp[0],
            bpDiastolic: v.bp[1],
            heartRate: v.hr,
            respiratoryRate: v.rr,
            temperature: v.temp,
            temperatureUnit: "f",
            spo2: v.spo2,
            painScore: v.pain,
            painScale: "nrs_0_10",
          } as never,
        }),
      );
    }
    if (!prior || prior.sel === "0") {
      await must(
        `${label} selections`,
        who.client.PATCH("/api/v1/encounters/{encounterId}/selections", {
          params: { path: { encounterId: enc.id }, header: { "If-Match": "0" } },
          body: { sections: selectionsFor(plan.encounterType, plan.discipline) } as never,
        }),
      );
    }
    const fin = await who.client.POST("/api/v1/encounters/{encounterId}/finalize", {
      params: { path: { encounterId: enc.id } },
    });
    const finCode = (fin.error as { error?: { code?: string } } | undefined)?.error?.code;
    if (finCode === "HEARTHNOTE_CIPHER_UNBOUND") {
      // A CONFIGURATION state, not a seeding bug (same handling as seed-scenario-clinical-core.ts): finalize seals the
      // assembled narrative under the tenant DEK, and this stack has no M34_TENANT_KEK. The draft (vitals + HearthNote
      // selections) is left in place; re-running this seed after the KEK is configured finalizes and signs it.
      log.blocked(
        `${label}: draft ready, finalize refused (HEARTHNOTE_CIPHER_UNBOUND — set M34_TENANT_KEK, then re-run)`,
      );
      return;
    }
    if (fin.error !== undefined || !fin.response.ok)
      throw new Error(
        `${label} finalize: HTTP ${fin.response.status} ${JSON.stringify(fin.error)}`,
      );
    await stepUpSession(who.userId);
    const signed = await must<{ status: string }>(
      `${label} sign`,
      who.client.POST("/api/v1/encounters/{encounterId}/sign", {
        params: { path: { encounterId: enc.id } },
        body: { attestationConfirmed: true } as never,
      }),
    );
    let status = signed.status;
    if (status === "cosign_pending") {
      // LPN/CHHA notes route to an RN cosigner; only a cosigned note is a delivered, attested visit to the packet.
      await must(
        `${label} cosign acknowledge`,
        rnCosigner.client.POST("/api/v1/encounters/{encounterId}/cosignature/acknowledge", {
          params: { path: { encounterId: enc.id } },
        }),
      );
      await stepUpSession(rnCosigner.userId);
      const co = await must<{ status: string }>(
        `${label} cosign`,
        rnCosigner.client.POST("/api/v1/encounters/{encounterId}/cosignature/sign", {
          params: { path: { encounterId: enc.id } },
          body: { attestationConfirmed: true } as never,
        }),
      );
      status = co.status;
    }
    log.ok(`${label} → ${status}`);
  } catch (err) {
    log.fail(String(err));
  }
}

// ── 2. assessments ─────────────────────────────────────────────────────────────────────────────────────────
interface AssessmentPlan {
  scaleType: "pps" | "esas_r" | "painad" | "fast";
  /** `"baseline"` = 5 minutes after admission activation (the earliest instant M9 accepts), else an ISO instant. */
  capturedAt: string;
  data: Record<string, unknown>;
  what: string;
}

async function seedAssessments(
  rn: WxSession,
  name: string,
  patientId: string,
  admissionId: string,
  plans: readonly AssessmentPlan[],
): Promise<void> {
  const act = await sql<{ t: string }>("SELECT activated_at::text t FROM admission WHERE id = $1", [
    admissionId,
  ]);
  const baselineAt = new Date(new Date(act[0]?.t ?? nowIso()).getTime() + 5 * 60_000).toISOString();
  for (const q of plans) {
    const p = { ...q, capturedAt: q.capturedAt === "baseline" ? baselineAt : q.capturedAt };
    const dup = await sql<{ n: string }>(
      `SELECT count(*)::text n FROM clinical_assessment
        WHERE patient_id = $1 AND scale_type = $2 AND captured_at > now() - interval '15 days' AND data @> $3::jsonb`,
      [patientId, p.scaleType, JSON.stringify(p.data)],
    );
    if (dup[0]?.n !== "0") {
      log.dup(`${name}: ${p.scaleType} (${p.what}) already recorded`);
      continue;
    }
    try {
      await must(
        `${name} ${p.scaleType}`,
        rn.client.POST("/api/v1/patients/{patientId}/assessments", {
          params: { path: { patientId } },
          body: {
            admissionId,
            scaleType: p.scaleType,
            capturedAt: p.capturedAt,
            data: p.data,
          } as never,
        }),
      );
      log.ok(`${name}: ${p.scaleType} — ${p.what}`);
    } catch (err) {
      log.fail(String(err));
    }
  }
}

// ── 3. orders ──────────────────────────────────────────────────────────────────────────────────────────────
interface OrderPlan {
  kind: "dme" | "lab";
  data: Record<string, unknown>;
  /** Discontinue right after activation (feeds the packet's "order changes" via `m11.order.discontinued`). */
  discontinue?: {
    reason: "clinical_judgement" | "patient_request" | "level_of_care_change";
    notes: string;
  };
  what: string;
}

async function seedOrders(
  md: WxSession,
  name: string,
  patientId: string,
  admissionId: string,
  plans: readonly OrderPlan[],
): Promise<void> {
  for (const p of plans) {
    const dup = await sql<{ n: string }>(
      "SELECT count(*)::text n FROM order_record WHERE patient_id = $1 AND kind = $2 AND data::text LIKE $3",
      [patientId, p.kind, `%${p.what}%`],
    );
    if (dup[0]?.n !== "0") {
      log.dup(`${name}: ${p.kind} order (${p.what}) already present`);
      continue;
    }
    try {
      const draft = await must<{ id: string }>(
        `${name} ${p.kind} draft`,
        md.client.POST("/api/v1/orders", {
          body: {
            patientId,
            admissionId,
            kind: p.kind,
            drafterDiscipline: "hospice_physician",
            data: { ...p.data, seedMarker: `${MARK} ${p.what}` },
            orderingPhysicianMdmId: MDM_PHYSICIAN_ID,
          } as never,
        }),
      );
      await must(
        `${name} ${p.kind} request-signature`,
        md.client.POST("/api/v1/orders/{id}/request-signature", {
          params: { path: { id: draft.id } },
          body: { signerDiscipline: "hospice_physician" },
        }),
      );
      await must(
        `${name} ${p.kind} sign`,
        md.client.POST("/api/v1/orders/{id}/sign", {
          params: { path: { id: draft.id } },
          body: { signerDiscipline: "hospice_physician", signedAtClient: nowIso() },
        }),
      );
      if (p.discontinue) {
        await must(
          `${name} ${p.kind} discontinue`,
          md.client.POST("/api/v1/orders/{id}/discontinue", {
            params: { path: { id: draft.id } },
            body: {
              reason: p.discontinue.reason,
              effectiveAt: nowIso(),
              notes: p.discontinue.notes,
            },
          }),
        );
      }
      log.ok(
        `${name}: ${p.kind} order — ${p.what}${p.discontinue ? " (signed, then discontinued)" : " (signed)"}`,
      );
    } catch (err) {
      log.fail(String(err));
    }
  }
}

// ── 4. medications ─────────────────────────────────────────────────────────────────────────────────────────
interface MedPlan {
  drugName: string;
  rxcui: string | null;
  strength: string;
  doseForm: string;
  route: string;
  sig: { qty: number; unit: string; freq: string; prn?: string };
  sigText: string;
  indication: string;
  /** "start" leaves it active; "discontinue" activates then discontinues; "dose_change" activates, then issues a corrected order. */
  change: "start" | "discontinue" | "dose_change";
  corrected?: { strength: string; sig: MedPlan["sig"]; sigText: string };
  notes?: string;
}

function medBody(patientId: string, admissionId: string, m: MedPlan, over?: Partial<MedPlan>) {
  const x = { ...m, ...over };
  return {
    patientId,
    admissionId,
    medClass: "standard",
    rxnormRxcui: x.rxcui,
    ndc: null,
    drugName: x.drugName,
    strength: x.strength,
    doseForm: x.doseForm,
    route: x.route,
    data: {
      sigStructured: {
        doseQuantity: x.sig.qty,
        doseUnit: x.sig.unit,
        route: x.route,
        frequencyCode: x.sig.freq,
        asNeeded: x.sig.prn !== undefined,
        ...(x.sig.prn ? { asNeededReasonCode: x.sig.prn } : {}),
      },
      sigFreeText: `${x.sigText} ${MARK}`,
      indication: x.indication,
      refillsAuthorized: 0,
      dispenseQuantity: { value: 30, unit: x.doseForm === "solution" ? "mL" : "tablet" },
      daysSupply: 14,
      daw: false,
    },
    prescriberDiscipline: "hospice_physician",
    prescribingPhysicianMdmId: MDM_PHYSICIAN_ID,
    refillsAuthorized: 0,
  };
}

type MedRow = { id: string; status: string };

async function signMed(md: WxSession, label: string, row: MedRow): Promise<void> {
  if (row.status === "draft") {
    await must(
      `${label} request-signature`,
      md.client.POST("/api/v1/medication-orders/{id}/request-signature", {
        params: { path: { id: row.id } },
        body: { signerDiscipline: "hospice_physician" },
      }),
    );
  }
  await must(
    `${label} sign`,
    md.client.POST("/api/v1/medication-orders/{id}/sign", {
      params: { path: { id: row.id } },
      body: {
        signerDiscipline: "hospice_physician",
        signedAtClient: nowIso(),
        signerIsOrderingPhysician: true,
      },
    }),
  );
}

const medRow = async (where: string, args: unknown[]): Promise<MedRow | undefined> =>
  (
    await sql<MedRow>(
      `SELECT id, status FROM medication_order WHERE ${where} ORDER BY created_at LIMIT 1`,
      args,
    )
  )[0];

/** Resumable: a previous run that stopped mid-flow (draft left behind, active order not yet discontinued/corrected) is
 *  continued rather than duplicated. Every row this creates carries `MARK` in its sig text. */
async function seedMeds(
  md: WxSession,
  name: string,
  patientId: string,
  admissionId: string,
  plans: readonly MedPlan[],
): Promise<void> {
  for (const m of plans) {
    const label = `${name} ${m.drugName}`;
    try {
      let acted = false;
      let row = await medRow(
        "patient_id = $1 AND drug_name = $2 AND data::text LIKE $3 AND replaces_medication_order_id IS NULL",
        [patientId, m.drugName, `%${MARK}%`],
      );
      if (!row) {
        const d = await must<{ id: string }>(
          `${label} draft`,
          md.client.POST("/api/v1/medication-orders", {
            body: medBody(patientId, admissionId, m) as never,
          }),
        );
        row = { id: d.id, status: "draft" };
        acted = true;
      }
      if (row.status === "draft" || row.status === "pending_signature") {
        if (row.status === "draft") {
          // A draft left by an earlier (failed) run may predate a data fix — refresh its payload before signing.
          await md.client.PATCH("/api/v1/medication-orders/{id}", {
            params: { path: { id: row.id } },
            body: { data: medBody(patientId, admissionId, m).data } as never,
          });
        }
        await signMed(md, label, row);
        row = (await medRow("id = $1", [row.id])) ?? row;
        acted = true;
      }
      if (m.change === "discontinue" && row.status !== "discontinued") {
        await must(
          `${label} discontinue`,
          md.client.POST("/api/v1/medication-orders/{id}/discontinue", {
            params: { path: { id: row.id } },
            body: {
              reason: "clinical_judgement",
              effectiveAt: nowIso(),
              notes: m.notes ?? "No longer needed per IDG plan of care.",
            },
          }),
        );
        acted = true;
      } else if (m.change === "dose_change" && m.corrected) {
        let child = await medRow("replaces_medication_order_id = $1", [row.id]);
        if (!child) {
          const c = await must<{ newOrderId: string }>(
            `${label} correct`,
            md.client.POST("/api/v1/medication-orders/{id}/correct", {
              params: { path: { id: row.id } },
              body: medBody(patientId, admissionId, m, {
                strength: m.corrected.strength,
                sig: m.corrected.sig,
                sigText: m.corrected.sigText,
              }) as never,
            }),
          );
          child = { id: c.newOrderId, status: "draft" };
          acted = true;
        }
        if (child.status === "draft" || child.status === "pending_signature") {
          if (child.status === "draft") {
            await md.client.PATCH("/api/v1/medication-orders/{id}", {
              params: { path: { id: child.id } },
              body: {
                data: medBody(patientId, admissionId, m, {
                  strength: m.corrected.strength,
                  sig: m.corrected.sig,
                  sigText: m.corrected.sigText,
                }).data,
              } as never,
            });
          }
          await signMed(md, `${label} (corrected)`, child);
          acted = true;
        }
      }
      if (acted) log.ok(`${name}: ${m.drugName} — ${m.change}`);
      else log.dup(`${name}: ${m.drugName} (${m.change}) already complete`);
    } catch (err) {
      log.fail(String(err));
    }
  }
}

/** `encounter.scope` / caseload gate: an OPEN `patient_assignment` row for the calling user (same SQL anchor
 *  `seed-scenario-idg-packets.ts#ensureCaseload` and `seed-staff-personas.ts` write). Additive: only where missing. */
async function ensureCaseload(name: string, patientId: string): Promise<void> {
  const roles = [
    ["case_manager_msw", "mira@wardenx.local"],
    ["chaplain", "cole@wardenx.local"],
    ["aide", "amy@wardenx.local"],
  ] as const;
  for (const [role, email] of roles) {
    const u = await sql<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
    const org = await sql<{ organization_id: string }>(
      "SELECT organization_id FROM patient WHERE id = $1",
      [patientId],
    );
    const uid = u[0]?.id;
    const orgId = org[0]?.organization_id;
    if (!uid || !orgId) continue;
    const open = await sql(
      "SELECT 1 FROM patient_assignment WHERE patient_id = $1 AND role = $2 AND clinician_user_id = $3 AND unassigned_at IS NULL",
      [patientId, role, uid],
    );
    if (open.length > 0) continue;
    await sql(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4, CURRENT_DATE)`,
      [patientId, orgId, uid, role],
    );
    log.ok(`${name}: ${role} -> ${email} (patient_assignment, caseload anchor)`);
  }
}

// ── the scenario ───────────────────────────────────────────────────────────────────────────────────────────
const ESAS_BASE = {
  tiredness: 5,
  drowsiness: 3,
  nausea: 1,
  lackOfAppetite: 4,
  shortnessOfBreath: 2,
  depression: 3,
  anxiety: 2,
  wellbeing: 5,
  reportedBy: "clinician_observed",
};

interface PatientPlan {
  name: string;
  encounters: EncounterPlan[];
  assessments: AssessmentPlan[];
  orders: OrderPlan[];
  meds: MedPlan[];
}

const PLANS: PatientPlan[] = [
  {
    name: "Whitfield",
    encounters: [
      {
        discipline: "rn",
        encounterType: "routine_visit",
        vitals: { bp: [112, 68], hr: 92, rr: 20, temp: "98.4", spo2: 93, pain: 6 },
      },
      { discipline: "msw", encounterType: "msw_followup" },
      { discipline: "chaplain", encounterType: "chaplain_visit" },
      { discipline: "chha", encounterType: "chha_visit" },
      {
        discipline: "md",
        encounterType: "telephonic",
        vitals: { bp: [112, 68], hr: 92, rr: 20, temp: "98.4", spo2: 93, pain: 6 },
      },
    ],
    assessments: [
      {
        scaleType: "pps",
        capturedAt: "baseline",
        what: "baseline PPS 50%",
        data: {
          ambulation: "mainly_sit_lie",
          activity: "unable_any_work",
          selfCare: "considerable_assist",
          intake: "reduced",
          consciousness: "full",
        },
      },
      {
        scaleType: "pps",
        capturedAt: nowIso(),
        what: "PPS declined to 20%",
        data: {
          ambulation: "totally_bed_bound",
          activity: "unable_any_work",
          selfCare: "total_care",
          intake: "minimal_to_sips",
          consciousness: "full",
        },
      },
      {
        scaleType: "painad",
        capturedAt: nowIso(),
        what: "PAINAD 6 moderate pain, grimacing",
        data: {
          breathing: 1,
          negativeVocalization: 1,
          facialExpression: 2,
          bodyLanguage: 1,
          consolability: 1,
        },
      },
      {
        scaleType: "esas_r",
        capturedAt: nowIso(),
        what: "ESAS-r pain and dyspnea up",
        data: { ...ESAS_BASE, pain: 7, shortnessOfBreath: 6 },
      },
    ],
    orders: [
      {
        kind: "dme",
        what: "Hospital bed with alternating-pressure overlay",
        data: {
          itemDescription: "Semi-electric hospital bed with alternating-pressure mattress overlay",
          reason: "Bed-bound, PPS 30%, skin-integrity risk",
        },
      },
      {
        kind: "dme",
        what: "Oxygen concentrator 2 L/min (superseded)",
        data: {
          itemDescription: "Oxygen concentrator 2 L/min nasal cannula",
          reason: "Dyspnea with SpO2 93%",
        },
        discontinue: {
          reason: "clinical_judgement",
          notes: "Replaced by 3 L/min concentrator per RN reassessment.",
        },
      },
      {
        kind: "lab",
        what: "Comfort-focused CMP",
        data: {
          testCodes: [
            {
              system: "http://loinc.org",
              code: "24323-8",
              display: "Comprehensive metabolic panel",
            },
          ],
          fastingRequired: false,
          clinicalJustification: "Evaluate renal function before opioid titration",
        },
      },
    ],
    meds: [
      {
        drugName: "Morphine sulfate oral solution",
        rxcui: "197696",
        strength: "20 mg/mL",
        doseForm: "solution",
        route: "oral",
        sig: { qty: 0.25, unit: "mL", freq: "Q2H", prn: "pain" },
        sigText: "0.25 mL PO every 2 hours PRN pain or dyspnea",
        indication: "Pain or dyspnea at end of life",
        change: "dose_change",
        corrected: {
          strength: "20 mg/mL",
          sig: { qty: 0.5, unit: "mL", freq: "Q2H", prn: "pain" },
          sigText: "0.5 mL PO every 2 hours PRN pain or dyspnea",
        },
      },
      {
        drugName: "Lorazepam tablet",
        rxcui: "197901",
        strength: "0.5 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "Q6H", prn: "anxiety" },
        sigText: "1 tablet PO every 6 hours PRN anxiety or restlessness",
        indication: "Anxiety / terminal restlessness",
        change: "start",
      },
      {
        drugName: "Docusate sodium capsule",
        rxcui: "1099",
        strength: "100 mg",
        doseForm: "capsule",
        route: "oral",
        sig: { qty: 1, unit: "capsule", freq: "BID" },
        sigText: "1 capsule PO twice daily",
        indication: "Opioid-induced constipation prophylaxis",
        change: "discontinue",
        notes: "Unable to swallow capsules; changed to liquid senna.",
      },
    ],
  },
  {
    name: "Nakamura",
    encounters: [
      {
        discipline: "rn",
        encounterType: "routine_visit",
        vitals: { bp: [104, 62], hr: 96, rr: 18, temp: "98.0", spo2: 95, pain: 5 },
      },
      { discipline: "msw", encounterType: "msw_followup" },
      { discipline: "chaplain", encounterType: "chaplain_visit" },
      { discipline: "chha", encounterType: "chha_visit" },
    ],
    assessments: [
      {
        scaleType: "pps",
        capturedAt: "baseline",
        what: "baseline PPS 60%",
        data: {
          ambulation: "reduced",
          activity: "unable_hobby_work",
          selfCare: "occasional_assist",
          intake: "normal_or_reduced",
          consciousness: "full",
        },
      },
      {
        scaleType: "pps",
        capturedAt: nowIso(),
        what: "PPS declined to 30%",
        data: {
          ambulation: "totally_bed_bound",
          activity: "unable_any_work",
          selfCare: "total_care",
          intake: "reduced",
          consciousness: "full",
        },
      },
      {
        scaleType: "painad",
        capturedAt: nowIso(),
        what: "PAINAD 5 moderate pain",
        data: {
          breathing: 1,
          negativeVocalization: 1,
          facialExpression: 1,
          bodyLanguage: 1,
          consolability: 1,
        },
      },
      {
        scaleType: "esas_r",
        capturedAt: nowIso(),
        what: "ESAS-r nausea and appetite worse",
        data: { ...ESAS_BASE, pain: 5, nausea: 7, lackOfAppetite: 8 },
      },
    ],
    orders: [
      {
        kind: "dme",
        what: "Bedside commode and wheelchair",
        data: {
          itemDescription: "Drop-arm bedside commode and lightweight transport wheelchair",
          reason: "Progressive weakness; fall-risk with transfers",
        },
      },
      {
        kind: "dme",
        what: "Standard walker (no longer safe)",
        data: {
          itemDescription: "Standard front-wheeled walker",
          reason: "Ambulating short distances",
        },
        discontinue: {
          reason: "level_of_care_change",
          notes: "No longer ambulating safely; replaced by wheelchair.",
        },
      },
    ],
    meds: [
      {
        drugName: "Ondansetron ODT",
        rxcui: "198052",
        strength: "4 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "Q8H", prn: "nausea" },
        sigText: "1 tablet dissolved on tongue every 8 hours PRN nausea",
        indication: "Nausea related to pancreatic malignancy",
        change: "start",
      },
      {
        drugName: "Dexamethasone tablet",
        rxcui: "197577",
        strength: "2 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "DAILY" },
        sigText: "1 tablet PO every morning",
        indication: "Appetite and nausea",
        change: "dose_change",
        corrected: {
          strength: "4 mg",
          sig: { qty: 1, unit: "tablet", freq: "DAILY" },
          sigText: "1 tablet (4 mg) PO every morning",
        },
      },
      {
        drugName: "Metoclopramide tablet",
        rxcui: "311296",
        strength: "10 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "QID" },
        sigText: "1 tablet PO before meals and at bedtime",
        indication: "Nausea",
        change: "discontinue",
        notes: "Ineffective; replaced by ondansetron.",
      },
    ],
  },
  {
    name: "Delgado",
    encounters: [
      {
        discipline: "rn",
        encounterType: "routine_visit",
        vitals: { bp: [134, 82], hr: 88, rr: 22, temp: "97.9", spo2: 91, pain: 2 },
      },
      { discipline: "msw", encounterType: "msw_followup" },
      {
        discipline: "md",
        encounterType: "telephonic",
        vitals: { bp: [134, 82], hr: 88, rr: 22, temp: "97.9", spo2: 91, pain: 2 },
      },
    ],
    assessments: [
      {
        scaleType: "pps",
        capturedAt: "baseline",
        what: "baseline PPS 50%",
        data: {
          ambulation: "mainly_sit_lie",
          activity: "unable_any_work",
          selfCare: "considerable_assist",
          intake: "normal_or_reduced",
          consciousness: "full",
        },
      },
      {
        scaleType: "pps",
        capturedAt: nowIso(),
        what: "PPS declined to 20%",
        data: {
          ambulation: "totally_bed_bound",
          activity: "unable_any_work",
          selfCare: "total_care",
          intake: "minimal_to_sips",
          consciousness: "full",
        },
      },
      {
        scaleType: "esas_r",
        capturedAt: nowIso(),
        what: "ESAS-r dyspnea 8 (heart failure)",
        data: { ...ESAS_BASE, pain: 2, shortnessOfBreath: 8, tiredness: 7, anxiety: 6 },
      },
    ],
    orders: [
      {
        kind: "dme",
        what: "Home oxygen concentrator 3 L/min",
        data: {
          itemDescription: "Oxygen concentrator 3 L/min with 50 ft tubing and portable tanks",
          reason: "Progressive dyspnea, SpO2 91% on room air",
        },
      },
      {
        kind: "lab",
        what: "BMP for diuretic adjustment",
        data: {
          testCodes: [
            { system: "http://loinc.org", code: "24320-4", display: "Basic metabolic panel" },
          ],
          fastingRequired: false,
          clinicalJustification: "Renal function and potassium with furosemide increase",
        },
      },
    ],
    meds: [
      {
        drugName: "Furosemide tablet",
        rxcui: "310429",
        strength: "40 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "DAILY" },
        sigText: "1 tablet PO every morning",
        indication: "Volume overload / dyspnea from heart failure",
        change: "dose_change",
        corrected: {
          strength: "40 mg",
          sig: { qty: 1, unit: "tablet", freq: "BID" },
          sigText: "1 tablet PO twice daily",
        },
      },
      {
        drugName: "Morphine sulfate oral solution",
        rxcui: "197696",
        strength: "20 mg/mL",
        doseForm: "solution",
        route: "oral",
        sig: { qty: 0.25, unit: "mL", freq: "Q4H", prn: "dyspnea" },
        sigText: "0.25 mL PO every 4 hours PRN dyspnea",
        indication: "Dyspnea at end of life",
        change: "start",
      },
      {
        drugName: "Lisinopril tablet",
        rxcui: "314077",
        strength: "10 mg",
        doseForm: "tablet",
        route: "oral",
        sig: { qty: 1, unit: "tablet", freq: "DAILY" },
        sigText: "1 tablet PO daily",
        indication: "Heart failure (pre-hospice regimen)",
        change: "discontinue",
        notes: "Hypotension and no comfort benefit; stopped per hospice plan of care.",
      },
    ],
  },
];

async function activeAdmissionId(patientId: string): Promise<string | undefined> {
  const r = await sql<{ id: string }>(
    "SELECT id FROM admission WHERE patient_id = $1 AND status = 'active' LIMIT 1",
    [patientId],
  );
  return r[0]?.id;
}

async function main(): Promise<void> {
  const p: Personas = {
    admin: await signIn("admin@wardenx.local"),
    rn: await signIn("rita@wardenx.local"),
    md: await signIn("drharris@wardenx.local"),
    msw: await signIn("mira@wardenx.local"),
    chaplain: await signIn("cole@wardenx.local"),
    chha: await signIn("amy@wardenx.local"),
  };
  const byDiscipline: Record<Discipline, WxSession> = {
    rn: p.rn,
    md: p.md,
    msw: p.msw,
    chaplain: p.chaplain,
    chha: p.chha,
  };

  // pps/fast are licensed scales (D3); a second identical licence row is harmless (see seed-scenario-clinical-core.ts).
  const licences = await sql<{ n: string }>(
    "SELECT count(*)::text n FROM scale_license WHERE scale_type = 'pps'",
  ).catch(() => [{ n: "0" }]);
  if (licences[0]?.n === "0") {
    for (const scaleType of ["pps", "fast"]) {
      await p.admin.client.POST("/api/v1/admin/scales/licenses", {
        body: {
          scaleType,
          vendor: "Demo Vendor",
          effectiveDate: "2024-01-01",
          expiresAt: "2027-01-01",
        } as never,
      });
    }
  }

  for (const plan of PLANS) {
    console.log(`\n${plan.name}`);
    let patientId: string;
    try {
      patientId = await findPatientIdByLastName(p.admin, plan.name);
    } catch (err) {
      log.blocked(`${plan.name}: not found (${String(err)})`);
      continue;
    }
    const admissionId = await activeAdmissionId(patientId);
    if (!admissionId) {
      log.blocked(`${plan.name}: no active admission — packets never include them; skipped`);
      continue;
    }
    await ensureCaseload(plan.name, patientId);
    // Baseline assessments first (the detector needs the prior reading to compute the PPS delta).
    await seedAssessments(p.rn, plan.name, patientId, admissionId, plan.assessments);
    for (const e of plan.encounters) {
      await seedEncounter(byDiscipline[e.discipline], p.rn, plan.name, patientId, admissionId, e);
    }
    await seedOrders(p.md, plan.name, patientId, admissionId, plan.orders);
    await seedMeds(p.md, plan.name, patientId, admissionId, plan.meds);
  }
  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
