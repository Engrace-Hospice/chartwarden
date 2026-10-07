/**
 * COP27 API seed — recertification: the face-to-face encounter for benefit period 3+ (42 CFR 418.22(a)(4))
 * and the recertification CTI of the next period.
 *
 * The F2F is scheduled inside its window (the 30 calendar days before the new period starts), completed by
 * the hospice physician (telehealth carries the 418.22(a)(4)(ii)(A)–(C) eligibility answers) and attested.
 * The recertification CTI itself is left drafted — see {@link RECERT_CTI_NOTE}.
 */
import { type AdmissionHandle, readCert, requirePhysician } from "./admission";
import type { SeedContext } from "./context";
import { type SeedCalendar, addDays, maxDate, minDate } from "./dates";
import { SkipStep, asAnyone } from "./http";
import type { ScenarioRun } from "./run";

export interface F2fPlan {
  readonly location: "telehealth" | "patient_home";
  readonly attestation: string;
}

/** Index of the first pending (not yet started) period — the one being recertified into. */
async function nextPeriodIndex(ctx: SeedContext, adm: AdmissionHandle): Promise<number> {
  const cert = await readCert(ctx, adm.patient.id);
  if (!cert)
    throw new SkipStep(
      "the patient's certification ladder is not readable without the physician account",
    );
  // The period after the inherited (running) one; it stays `pending` until it starts, but read it by position
  // so a re-run still finds it once its CTI is signed.
  const running = cert.periods.findIndex((p) => p.effectiveAt !== null && p.status === "active");
  const idx = running >= 0 ? running + 1 : cert.periods.findIndex((p) => p.status === "pending");
  if (idx < 0 || idx >= cert.periods.length) throw new Error("no next period to recertify into");
  return idx;
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

  run.note(`recert CTI (benefit period ${seq})`, RECERT_CTI_NOTE);
}

/**
 * Why the seed leaves recertification CTIs unsigned: M6 starts the next benefit period the moment its CTI is
 * signed, dated the signing day (`signCtiHospiceMd` → `setActive` with `effectiveAt: today`), even when the
 * current period still has days to run — signing ahead of time (418.22(a)(3) allows up to 15 days before) would
 * leave two overlapping active periods. The CTI stays drafted, as a physician would find it before the period.
 */
export const RECERT_CTI_NOTE =
  "left drafted, not signed: M6 activates the next period at the signature, dated that day, which would overlap the running period (platform issue)";
