/**
 * COP27 API seed — recertification: the face-to-face encounter for benefit period 3+ (42 CFR 418.22(a)(4))
 * and the recertification CTI of the next period.
 *
 * The F2F is scheduled inside its window (the 30 calendar days before the new period starts), completed by
 * the hospice physician (telehealth carries the 418.22(a)(4)(ii)(A)–(C) eligibility answers) and attested.
 *
 * The recertification CTI (the one a transfer-in drafts for the period after the inherited one) is signed by
 * the hospice physician inside 418.22(a)(3)'s window — no earlier than 15 days before the period starts. M6
 * keeps the signed period `pending` until its own start date (the day after the prior period ends), when the
 * election-period auto-end cron completes the prior period and starts it; a late signature starts it at once.
 */
import {
  type AdmissionHandle,
  type CertView,
  readCert,
  requirePhysician,
  signCti,
} from "./admission";
import type { SeedContext } from "./context";
import { type SeedCalendar, addDays, maxDate, minDate } from "./dates";
import { SkipStep, asAnyone } from "./http";
import type { ScenarioRun } from "./run";

export interface F2fPlan {
  readonly location: "telehealth" | "patient_home";
  readonly attestation: string;
}

/** 42 CFR 418.22(a)(3): a recertification may be signed up to 15 calendar days before its period starts. */
const RECERT_SIGN_LEAD_DAYS = 15;

/**
 * The physician's 418.22(b)(3) narrative for the recertification. A transfer-in drafts the CTI without one, and
 * M6 wants at least 200 characters for a recert; it is sent only when the CTI has none.
 */
export const RECERT_NARRATIVE =
  "DEMO DATA — recertification. Metastatic non-small-cell lung cancer with continued decline since the " +
  "start of the current benefit period: Palliative Performance Scale now 30%, further weight loss with " +
  "intake limited to sips and small bites, dyspnea on minimal exertion despite 3 L oxygen, and most of the " +
  "day spent in bed. No disease-directed treatment is planned. In my clinical judgment the prognosis remains " +
  "six months or less if the illness runs its normal course.";

/**
 * Index of the period being recertified into: the one after the inherited (first dated) period. Read by
 * position so a re-run still finds it once its CTI is signed, or once the cron has started it.
 */
function recertPeriodIndex(cert: CertView): number {
  const inherited = cert.periods.findIndex((p) => p.effectiveAt !== null);
  const idx =
    inherited >= 0 ? inherited + 1 : cert.periods.findIndex((p) => p.status === "pending");
  if (idx < 1 || idx >= cert.periods.length) throw new Error("no next period to recertify into");
  return idx;
}

async function nextPeriodIndex(ctx: SeedContext, adm: AdmissionHandle): Promise<number> {
  const cert = await readCert(ctx, adm.patient.id);
  if (!cert)
    throw new SkipStep(
      "the patient's certification ladder is not readable without the physician account",
    );
  return recertPeriodIndex(cert);
}

/**
 * Sign the recertification CTI (hospice physician) once 418.22(a)(3)'s window is open; before that it stays
 * drafted, as a physician would find it, and a later re-run signs it. Soft: the scenario continues either way.
 */
export async function ensureRecertCtiSigned(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
): Promise<void> {
  const cert = await readCert(ctx, adm.patient.id);
  if (!cert) {
    run.skip(
      "recert CTI signed",
      "the patient's certification ladder is not readable without the physician account",
    );
    return;
  }
  const idx = recertPeriodIndex(cert);
  const prior = cert.periods[idx - 1];
  const next = cert.periods[idx];
  const step = `recert CTI signed (benefit period ${next?.sequenceNumber ?? idx + 1})`;
  if (!prior?.scheduledEndAt || !next) throw new Error("the inherited period has no scheduled end");
  const periodStart = addDays(prior.scheduledEndAt, 1);
  const windowOpens = addDays(periodStart, -RECERT_SIGN_LEAD_DAYS);
  if (!next.cti?.hospiceMdSigned && cal.today < windowOpens) {
    run.note(
      step,
      `left drafted: the period starts ${periodStart} and 418.22(a)(3) allows signing from ${windowOpens}; a re-run on/after that date signs it`,
    );
    return;
  }
  await run.soft(
    step,
    async () => {
      const cti = (await readCert(ctx, adm.patient.id))?.periods[idx]?.cti;
      return cti?.hospiceMdSigned ? cti : null;
    },
    async () => {
      const physician = requirePhysician(ctx);
      const cti = (await readCert(ctx, adm.patient.id))?.periods[idx]?.cti;
      if (!cti) throw new Error(`benefit period ${next.sequenceNumber} has no CTI draft`);
      await signCti(ctx, physician, cti.id, RECERT_NARRATIVE);
      return { ...cti, hospiceMdSigned: true };
    },
    (c) =>
      `cti ${c.id}; period ${next.sequenceNumber} starts ${periodStart}${periodStart > cal.today ? " (pending until then)" : ""}`,
  );
}

export async function ensureRecertF2f(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
  plan: F2fPlan,
): Promise<void> {
  const physician = ctx.physician;
  if (!physician) {
    run.stop(
      "face-to-face",
      "the F2F performer and attester must be a signed-in hospice physician account",
    );
  }
  const idx = await nextPeriodIndex(ctx, adm);
  const readF2f = async () =>
    (await readCert(ctx, adm.patient.id))?.periods[idx]?.faceToFace ?? null;
  const seq = (await readCert(ctx, adm.patient.id))?.periods[idx]?.sequenceNumber ?? idx + 1;

  const f2f = await run.ensure(
    `F2F scheduled (benefit period ${seq})`,
    readF2f,
    async () => {
      const cert = await readCert(ctx, adm.patient.id);
      const current = cert?.periods[idx - 1];
      const next = cert?.periods[idx];
      if (!current?.scheduledEndAt || !next) throw new Error("current period has no scheduled end");
      const periodStart = addDays(current.scheduledEndAt, 1);
      const windowStart = addDays(periodStart, -30);
      const windowEnd = addDays(periodStart, -1);
      await asAnyone("schedule F2F", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/face-to-face", {
          params: { path: { id: adm.id } },
          body: {
            electionPeriodId: next.id,
            scheduledDate: minDate(windowEnd, maxDate(windowStart, cal.today)),
            windowStart,
            windowEnd,
            clinicianRole: "hospice_md",
            scheduledClinicianId: physician.userId,
          },
        }),
      );
      const after = await readF2f();
      if (!after) throw new Error("F2F not visible after scheduling");
      return after;
    },
    (f) => `f2f ${f.id} (${f.status})`,
  );

  const version = async (): Promise<number> =>
    (
      await asAnyone<{ version: number }>("read F2F", ctx.sessions, (s) =>
        s.client.GET("/api/v1/face-to-face/{id}", { params: { path: { id: f2f.id } } }),
      )
    ).version;

  await run.ensure(
    `F2F completed (${plan.location})`,
    async () => {
      const f = await readF2f();
      return f?.encounterDate ? f : null;
    },
    async () => {
      await asAnyone("complete F2F", [physician], async (s) =>
        s.client.POST("/api/v1/face-to-face/{id}/complete", {
          params: { path: { id: f2f.id } },
          body: {
            encounterDate: cal.today,
            encounterLocation: plan.location,
            ...(plan.location === "telehealth"
              ? {
                  telehealthEligibility: {
                    patientInMoratoriumArea: false,
                    hospiceUnderEnhancedOversight: false,
                    performerMedicareEnrolledOrOptedOut: true,
                  },
                }
              : {}),
            ifVersion: await version(),
          },
        }),
      );
      const f = await readF2f();
      if (!f) throw new Error("F2F vanished");
      return f;
    },
    (f) => `encounter ${f.encounterDate}`,
  );

  await run.ensure(
    "F2F attested (narrative)",
    async () => ((await readF2f())?.attested ? true : null),
    async () => {
      await asAnyone("attest F2F", [requirePhysician(ctx)], async (s) =>
        s.client.POST("/api/v1/face-to-face/{id}/attest", {
          params: { path: { id: f2f.id } },
          body: { attestationNarrative: plan.attestation, ifVersion: await version() },
        }),
      );
      return true;
    },
  );

  // The F2F is part of the recertification (418.22(a)(4)): M6's adequacy gate wants it attested before the
  // CTI signature for benefit period 3 onward.
  await ensureRecertCtiSigned(run, ctx, cal, adm);
}
