/**
 * COP27 API seed — the M6 admission ceremony, step by step, over the public routes.
 *
 * Two ways in:
 *   · intake (a referral accepted into an admission): hospice physician → NOR → election statement (drafted +
 *     patient-signed) → admission date → CTI drafted + signed by the hospice physician → physician admission
 *     recommendation → activate. Activation dates the election TODAY; no route back-dates an activation.
 *   · transfer-in: the inherited benefit period is dated from `priorElectionStartDate` — the only public lever
 *     that gives an election an effective date in the past ("effective 2026-07-xx", "effective ~2026-10-02").
 *     The receiving hospice owes NOR + election statement + admission date on the inherited period but no CTI
 *     (D9); its own CTI is for the NEXT period — drafted by the transfer-in without a narrative, which the
 *     physician supplies at signature (see `ensureRecertCtiSigned` in ./certification).
 *
 * State is read from the admission aggregate's readiness checklist (admission-scoped, so the admin can read it
 * while the admission is unsited) and, where ids are needed, from the patient's election-certification
 * aggregate (patient-scoped: needs caseload or org-wide scope, i.e. the physician account).
 */
import type { SeedContext } from "./context";
import { pastInstantOn } from "./dates";
import { ApiError, type Session, SkipStep, asAnyone, readAsAnyone } from "./http";
import type { DemoPatient } from "./patients";
import type { ScenarioRun } from "./run";

export const TERMINAL_DX = { icd10: "C34.90", text: "Malignant neoplasm of lung, unspecified" };

export interface CertPeriod {
  id: string;
  sequenceNumber: number;
  periodKind: string;
  effectiveAt: string | null;
  scheduledEndAt: string | null;
  status: string;
  electionStatement: { id: string; status: string } | null;
  cti: { id: string; status: string; hospiceMdSigned: boolean } | null;
  faceToFace: {
    id: string;
    status: string;
    performerRole: string;
    encounterDate: string | null;
    attested: boolean;
  } | null;
}

export interface CertView {
  admission: { id: string; state: string; admissionAt: string | null; version: number } | null;
  periods: CertPeriod[];
  complianceWindows: Array<{
    id: string;
    windowKind: string;
    status: string;
    mustCompleteBy: string;
  }>;
}

export interface AdmissionView {
  id: string;
  state: string;
  version: number;
  admissionAt: string | null;
  hospicePhysicianId: string | null;
  admissionRecommendation: unknown;
  readiness?: { requirements: Array<{ code: string; status: string }> };
}

export interface AdmissionHandle {
  readonly id: string;
  readonly patient: DemoPatient;
}

/** The patient-scoped certification aggregate, or null when no available account can read it. */
export async function readCert(ctx: SeedContext, patientId: string): Promise<CertView | null> {
  const view = await readAsAnyone<CertView>("read election-certification", ctx.sessions, (s) =>
    s.client.GET("/api/v1/patients/{patientId}/election-certification", {
      params: { path: { patientId } },
    }),
  );
  return view
    ? { ...view, periods: [...view.periods].sort((a, b) => a.sequenceNumber - b.sequenceNumber) }
    : null;
}

export async function readAdmission(ctx: SeedContext, id: string): Promise<AdmissionView | null> {
  return readAsAnyone<AdmissionView>("read admission", ctx.sessions, (s) =>
    s.client.GET("/api/v1/admissions/{id}", { params: { path: { id } } }),
  );
}

/** A readiness-checklist item's status (`complete`, `awaiting_signature`, `action_required`, …). */
export function requirement(adm: AdmissionView | null, code: string): string | null {
  return adm?.readiness?.requirements.find((r) => r.code === code)?.status ?? null;
}

const NOT_STARTED = new Set(["action_required", "pending", "blocked", "overdue"]);

/** States an admission has reached once it was activated (or ended after activation). */
export const POST_ACTIVATION_STATES = new Set([
  "active",
  "on_hold",
  "discharged",
  "bereavement",
  "closed",
]);

const PHYSICIAN_NEEDED =
  "needs a signed-in medical_director / hospice_physician account (the admin holds neither role); set CHARTWARDEN_SEED_PHYSICIAN_EMAIL/PASSWORD to an existing physician account";

export function requirePhysician(ctx: SeedContext): Session {
  if (!ctx.physician) throw new SkipStep(PHYSICIAN_NEEDED);
  return ctx.physician;
}

export interface TransferInPlan {
  /** The benefit period the patient was in at the sending hospice. */
  readonly priorSequence: number;
  /** The election's effective date at the sending hospice — becomes this admission's election date. */
  readonly priorElectionStartDate: string;
  /** The change-of-hospice date (on/after the election date, not in the future). */
  readonly transferDate: string;
  readonly otherHospiceName: string;
}

export interface AdmissionPlan {
  readonly patient: DemoPatient;
  /** The admission the referral conversion opened (intake path). Absent ⇒ transfer-in. */
  readonly intakeAdmissionId?: string;
  readonly transferIn?: TransferInPlan;
  /** The election statement's effective date. */
  readonly electionEffectiveDate: string;
  /** Sign the period-1 CTI (intake path). */
  readonly signCti: boolean;
  /** Record the 418.25(a) physician admission recommendation. */
  readonly recommendation: boolean;
  readonly activate: boolean;
}

interface OrgSetup {
  providerEntityId: string;
  locationId: string;
  hospiceMdId: string;
}

export function requireOrgSetup(ctx: SeedContext, run: ScenarioRun): OrgSetup {
  if (!ctx.providerEntity) run.stop("org setup", "the organization has no active provider entity");
  if (!ctx.location) run.stop("org setup", "the provider entity has no active service location");
  if (!ctx.hospiceMd) run.stop("org setup", "the MDM directory has no active physician");
  return {
    providerEntityId: ctx.providerEntity.id,
    locationId: ctx.location.id,
    hospiceMdId: ctx.hospiceMd.id,
  };
}

export async function ensureAdmission(
  run: ScenarioRun,
  ctx: SeedContext,
  plan: AdmissionPlan,
): Promise<AdmissionHandle> {
  const setup = requireOrgSetup(ctx, run);
  const adm: AdmissionHandle = plan.intakeAdmissionId
    ? { id: plan.intakeAdmissionId, patient: plan.patient }
    : await ensureTransferInAdmission(run, ctx, plan, setup);

  if (plan.intakeAdmissionId) await ensureHospicePhysician(run, ctx, adm, setup.hospiceMdId);
  await ensureNor(run, ctx, adm);
  await ensureElectionStatement(run, ctx, adm, plan.electionEffectiveDate, setup.providerEntityId);
  await ensureAdmissionDate(
    run,
    ctx,
    adm,
    plan.transferIn?.transferDate ?? plan.electionEffectiveDate,
  );
  if (plan.signCti) {
    await ensureCtiDraft(run, ctx, adm, 0, setup.hospiceMdId, false);
    await signPeriodCti(run, ctx, adm, 0, "CTI signed (hospice physician)");
  }
  if (plan.recommendation) await ensureRecommendation(run, ctx, adm);
  if (plan.activate) await ensureActive(run, ctx, adm, setup.locationId);
  return adm;
}

async function ensureTransferInAdmission(
  run: ScenarioRun,
  ctx: SeedContext,
  plan: AdmissionPlan,
  setup: OrgSetup,
): Promise<AdmissionHandle> {
  const t = plan.transferIn;
  if (!t) throw new Error("a transfer-in plan is required without an intake admission");
  const { patient } = plan;
  const admission = await run.ensure(
    "admission (transfer-in intake)",
    async () => {
      const r = await readAsAnyone<{ items: Array<{ id: string; state: string }> }>(
        "list patient admissions",
        ctx.sessions,
        (s) =>
          s.client.GET("/api/v1/patients/{patientId}/admissions", {
            params: { path: { patientId: patient.id } },
          }),
      );
      return r?.items[0] ?? null;
    },
    () =>
      asAnyone<{ id: string; state: string }>("create admission", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions", {
          body: {
            patientId: patient.id,
            intakeMethod: "transfer_in",
            admissionTypeCode: "3",
            admissionSourceCode: "6",
            hospiceMedicalDirectorId: setup.hospiceMdId,
            ...(ctx.attending ? { attendingPhysicianId: ctx.attending.id } : {}),
          },
        }),
      ),
    (a) => `admission ${a.id}`,
  );
  const handle: AdmissionHandle = { id: admission.id, patient };
  await run.ensure(
    "transfer-in (inherited benefit period)",
    async () => {
      const cert = await readCert(ctx, patient.id);
      const inherited = cert?.periods.find((p) => p.effectiveAt !== null);
      return inherited ?? null;
    },
    async () => {
      await asAnyone("transfer-in", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/transfer-in", {
          params: { path: { id: handle.id } },
          body: {
            direction: "in",
            effectiveDate: t.transferDate,
            otherHospiceName: t.otherHospiceName,
            priorBenefitPeriodSequence: t.priorSequence,
            priorElectionStartDate: t.priorElectionStartDate,
            hospiceMedicalDirectorId: setup.hospiceMdId,
            ...(ctx.attending ? { attendingPhysicianId: ctx.attending.id } : {}),
            narrative:
              `DEMO DATA — the family relocated; the election transferred from ${t.otherHospiceName} in ` +
              `benefit period ${t.priorSequence} with no gap in hospice coverage.`,
          },
        }),
      );
      const cert = await readCert(ctx, patient.id);
      const inherited = cert?.periods.find((p) => p.effectiveAt !== null);
      if (!inherited) throw new Error("no dated inherited period after transfer-in");
      return inherited;
    },
    (p) => `period ${p.sequenceNumber} effective ${p.effectiveAt} → ${p.scheduledEndAt}`,
  );
  return handle;
}

async function ensureHospicePhysician(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  hospiceMdId: string,
): Promise<void> {
  await run.ensure(
    "hospice physician on admission",
    async () => {
      const a = await readAdmission(ctx, adm.id);
      return a?.hospicePhysicianId ?? null;
    },
    async () => {
      const a = await readAdmission(ctx, adm.id);
      await asAnyone("set hospice physician", ctx.sessions, (s) =>
        s.client.PATCH("/api/v1/admissions/{id}", {
          params: { path: { id: adm.id } },
          body: {
            hospicePhysicianId: hospiceMdId,
            ...(ctx.attending ? { attendingPhysicianId: ctx.attending.id } : {}),
            ifVersion: a?.version ?? 0,
          },
        }),
      );
      return hospiceMdId;
    },
  );
}

async function ensureNor(run: ScenarioRun, ctx: SeedContext, adm: AdmissionHandle): Promise<void> {
  await run.ensure(
    "notice of rights",
    async () => {
      const a = await readAdmission(ctx, adm.id);
      return requirement(a, "notice_of_rights") === "complete" ||
        (a !== null && POST_ACTIVATION_STATES.has(a.state))
        ? true
        : null;
    },
    async () => {
      await asAnyone("acknowledge NOR", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/nor", {
          params: { path: { id: adm.id } },
          body: {
            deliveryMethod: "verbal_with_witness",
            acknowledgedAt: new Date(Date.now() - 300_000).toISOString(),
            acknowledgedByName: adm.patient.displayName,
            acknowledgedByRole: "patient",
          },
        }),
      );
      return true;
    },
  );
}

/** The period the election statement belongs to: the inherited one for a transfer-in, else period 1. */
function electionPeriod(cert: CertView): CertPeriod | undefined {
  return (
    cert.periods.find((p) => p.effectiveAt !== null && p.status === "active") ?? cert.periods[0]
  );
}

async function ensureElectionStatement(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  effectiveDate: string,
  providerEntityId: string,
): Promise<void> {
  let draftedId: string | null = null;
  await run.ensure(
    "election statement drafted",
    async () => {
      // The chart's ladder names the statement once drafted; the readiness item only says "complete" once it is
      // signed, so a drafted-unsigned statement is recognized from the ladder when an account can read it.
      const cert = await readCert(ctx, adm.patient.id);
      const drafted = cert ? electionPeriod(cert)?.electionStatement : null;
      if (drafted) return drafted.status;
      const a = await readAdmission(ctx, adm.id);
      if (a && POST_ACTIVATION_STATES.has(a.state)) return a.state;
      const status = requirement(a, "election_statement");
      return status !== null && !NOT_STARTED.has(status) ? status : null;
    },
    async () => {
      const periods = await readAsAnyone<{ items: Array<{ id: string; state: string }> }>(
        "list election periods",
        ctx.sessions,
        (s) =>
          s.client.GET("/api/v1/admissions/{id}/election-periods", {
            params: { path: { id: adm.id } },
          }),
      );
      const cert = await readCert(ctx, adm.patient.id);
      const periodId = (cert ? electionPeriod(cert)?.id : undefined) ?? periods?.items[0]?.id;
      if (!periodId) throw new Error("admission has no election period");
      const es = await asAnyone<{ id: string; state: string }>(
        "draft election statement",
        ctx.sessions,
        (s) =>
          s.client.POST("/api/v1/admissions/{id}/election-statements", {
            params: { path: { id: adm.id } },
            body: {
              electionPeriodId: periodId,
              effectiveDate,
              primaryDiagnosisIcd10: TERMINAL_DX.icd10,
              electedProviderEntityId: providerEntityId,
              ...(ctx.attending ? { electedAttendingPhysicianId: ctx.attending.id } : {}),
              waiverAcknowledged: true,
            },
          }),
      );
      draftedId = es.id;
      return es.state;
    },
    () => `effective ${effectiveDate}`,
  );
  await run.ensure(
    "election statement signed (patient)",
    async () => {
      const a = await readAdmission(ctx, adm.id);
      return requirement(a, "election_statement") === "complete" ||
        (a !== null && POST_ACTIVATION_STATES.has(a.state))
        ? true
        : null;
    },
    async () => {
      const cert = await readCert(ctx, adm.patient.id);
      const id = draftedId ?? (cert ? electionPeriod(cert)?.electionStatement?.id : undefined);
      if (!id) {
        throw new SkipStep(
          "the drafted statement's id is only readable from the patient's chart, which no available account can open",
        );
      }
      const cur = await asAnyone<{ version: number }>(
        "read election statement",
        ctx.sessions,
        (s) => s.client.GET("/api/v1/election-statements/{id}", { params: { path: { id } } }),
      );
      await asAnyone("sign election statement", ctx.sessions, (s) =>
        s.client.POST("/api/v1/election-statements/{id}/sign", {
          params: { path: { id } },
          body: {
            signingPatientName: adm.patient.displayName,
            signingRole: "patient",
            ifVersion: cur.version,
          },
        }),
      );
      return true;
    },
  );
}

async function ensureAdmissionDate(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  date: string,
): Promise<void> {
  await run.ensure(
    "admission date",
    async () => (await readAdmission(ctx, adm.id))?.admissionAt ?? null,
    async () => {
      const a = await readAdmission(ctx, adm.id);
      await asAnyone("set admission date", ctx.sessions, (s) =>
        s.client.PATCH("/api/v1/admissions/{id}", {
          params: { path: { id: adm.id } },
          body: { admissionAt: pastInstantOn(date, new Date()), ifVersion: a?.version ?? 0 },
        }),
      );
      return date;
    },
    (d) => `admitted ${d.slice(0, 10)}`,
  );
}

async function draftCti(
  ctx: SeedContext,
  periodId: string,
  hospiceMdId: string,
  isRecert: boolean,
): Promise<void> {
  await asAnyone("draft CTI", ctx.sessions, (s) =>
    s.client.POST("/api/v1/election-periods/{id}/cti", {
      params: { path: { id: periodId } },
      body: {
        hospiceMedicalDirectorId: hospiceMdId,
        ...(ctx.attending ? { attendingPhysicianId: ctx.attending.id } : {}),
        terminalDiagnosisIcd10: TERMINAL_DX.icd10,
        secondaryDiagnoses: ["J96.11 Chronic respiratory failure with hypoxia", "R64 Cachexia"],
        prognosisStatement:
          "Life expectancy of six months or less if the illness runs its normal course.",
        // 418.22(b)(3): the physician's own narrative; M6's adequacy check wants at least 200 characters.
        narrative:
          "DEMO DATA — metastatic non-small-cell lung cancer with progression after second-line therapy and " +
          "no further disease-directed treatment planned. Palliative Performance Scale 40% (was 60% three " +
          "months ago), 9% unintentional weight loss over three months, dyspnea at rest on 3 L oxygen, two " +
          "falls this month and increasing time in bed. In my clinical judgment the prognosis is six months " +
          "or less if the illness runs its normal course.",
        clinicalFindings: { pps: 40, weightLossPct3mo: 9, oxygenLpm: 3 },
        isRecert,
      },
    }),
  );
}

/** Draft a period's CTI when it has none (the referral conversion does not draft one). */
export async function ensureCtiDraft(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  periodIndex: number,
  hospiceMdId: string,
  isRecert: boolean,
): Promise<void> {
  await run.ensure(
    `CTI drafted (period ${periodIndex + 1})`,
    async () => (await readCert(ctx, adm.patient.id))?.periods[periodIndex]?.cti ?? null,
    async () => {
      const cert = await readCert(ctx, adm.patient.id);
      if (!cert) throw new SkipStep(PHYSICIAN_NEEDED);
      const period = cert.periods[periodIndex];
      if (!period) throw new Error(`no election period ${periodIndex + 1}`);
      await draftCti(ctx, period.id, hospiceMdId, isRecert);
      const after = await readCert(ctx, adm.patient.id);
      const cti = after?.periods[periodIndex]?.cti;
      if (!cti) throw new Error("CTI not visible after draft");
      return cti;
    },
    (c) => `cti ${c.id}`,
  );
}

/**
 * Sign a CTI as the hospice physician. A CTI drafted at transfer-in carries no 418.22(b)(3) narrative, and M6
 * answers 422 `CTI_NARRATIVE_REQUIRED` until the signing physician supplies one; only then is
 * `narrativeIfMissing` sent with the signature (a CTI that already has its narrative keeps it).
 */
export async function signCti(
  ctx: SeedContext,
  physician: Session,
  ctiId: string,
  narrativeIfMissing?: string,
): Promise<void> {
  const sign = async (narrative?: string) => {
    const cur = await asAnyone<{ version: number }>("read CTI", ctx.sessions, (s) =>
      s.client.GET("/api/v1/cti/{id}", { params: { path: { id: ctiId } } }),
    );
    await asAnyone("sign CTI (hospice MD)", [physician], (s) =>
      s.client.POST("/api/v1/cti/{id}/sign-hospice-md", {
        params: { path: { id: ctiId } },
        body: { ifVersion: cur.version, ...(narrative ? { narrative } : {}) },
      }),
    );
  };
  try {
    await sign();
  } catch (err) {
    const narrativeOwed =
      err instanceof ApiError && err.status === 422 && err.code === "CTI_NARRATIVE_REQUIRED";
    if (!narrativeOwed || !narrativeIfMissing) throw err;
    await sign(narrativeIfMissing);
  }
}

async function signPeriodCti(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  periodIndex: number,
  step: string,
): Promise<void> {
  await run.ensure(
    step,
    async () => {
      const cti = (await readCert(ctx, adm.patient.id))?.periods[periodIndex]?.cti;
      return cti?.hospiceMdSigned ? cti : null;
    },
    async () => {
      const physician = requirePhysician(ctx);
      const cti = (await readCert(ctx, adm.patient.id))?.periods[periodIndex]?.cti;
      if (!cti) throw new Error(`period ${periodIndex + 1} has no CTI draft`);
      await signCti(ctx, physician, cti.id);
      return { ...cti, hospiceMdSigned: true };
    },
    (c) => `cti ${c.id}`,
  );
}

export async function physicianSigners(
  ctx: SeedContext,
  admissionId: string,
): Promise<Array<{ userId: string; name: string | null; capacities: string[] }>> {
  const r = await asAnyone<{
    items: Array<{ userId: string; name: string | null; capacities: string[] }>;
  }>("list physician signers", ctx.sessions, (s) =>
    s.client.GET("/api/v1/admissions/{id}/physician-signers", {
      params: { path: { id: admissionId } },
    }),
  );
  return r.items;
}

/** The preferred 418.26(b)/418.25(a) signer: the medical director, else a physician designee. */
export async function pickSigner(
  ctx: SeedContext,
  admissionId: string,
): Promise<{ userId: string; name: string; capacity: "medical_director" | "physician_designee" }> {
  const signers = await physicianSigners(ctx, admissionId);
  for (const capacity of ["medical_director", "physician_designee"] as const) {
    const hit = signers.find((s) => s.capacities.includes(capacity));
    if (hit) return { userId: hit.userId, name: hit.name ?? "Hospice physician", capacity };
  }
  throw new SkipStep(
    "no user in the organization holds medical_director / hospice_physician (GET /admissions/:id/physician-signers is empty)",
  );
}

async function ensureRecommendation(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<void> {
  await run.soft(
    "physician admission recommendation (418.25(a))",
    async () => ((await readAdmission(ctx, adm.id))?.admissionRecommendation ? "on file" : null),
    async () => {
      const signer = await pickSigner(ctx, adm.id);
      const a = await readAdmission(ctx, adm.id);
      await asAnyone("record admission recommendation", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/admission-recommendation", {
          params: { path: { id: adm.id } },
          body: {
            recommendedByUserId: signer.userId,
            recommendedAt: new Date(Date.now() - 240_000).toISOString(),
            capacity: signer.capacity,
            attendingConsulted: true,
            attendingConsultNote:
              "DEMO DATA — the attending physician agreed with hospice admission by phone.",
            ifVersion: a?.version ?? 0,
          },
        }),
      );
      return `${signer.name} (${signer.capacity})`;
    },
    (who) => who,
  );
}

async function ensureActive(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
  locationId: string,
): Promise<void> {
  await run.ensure(
    "activate",
    async () => {
      const a = await readAdmission(ctx, adm.id);
      return a && POST_ACTIVATION_STATES.has(a.state) ? a.state : null;
    },
    async () => {
      const a = await readAdmission(ctx, adm.id);
      await asAnyone("activate admission", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/activate", {
          params: { path: { id: adm.id } },
          body: { ifVersion: a?.version ?? 0, locationId },
        }),
      );
      return "active";
    },
    (state) => `state ${state}`,
  );
}
