import {
  type AddendumOverview,
  describeAddendum,
  ensureAddendumAcknowledged,
  ensureAddendumContent,
  ensureAddendumDraft,
  ensureAddendumFurnished,
  ensureAddendumSettled,
  readAddendum,
} from "./addendum";
/**
 * COP27 API seed — the scenario catalog. Each scenario drives one demo patient (or the org's rate table) to a
 * distinct FY2027 state through {@link ScenarioRun} steps; the entry script's header lists them.
 */
import {
  type AdmissionHandle,
  type AdmissionPlan,
  ensureAdmission,
  requireOrgSetup,
} from "./admission";
import { RECERT_CTI_NOTE, ensureRecertF2f } from "./certification";
import {
  COMFORT_MORPHINE,
  UNRELATED_ATORVASTATIN,
  UNRELATED_LISINOPRIL,
  ensureCarePlan,
  ensureMedication,
  ensureNonCoveredSupply,
  ensureVisits,
  expectedAddendumCategories,
} from "./clinical";
import type { SeedContext } from "./context";
import {
  FY2027_EFFECTIVE,
  type SeedCalendar,
  addDays,
  maxDate,
  minDate,
  pastInstantOn,
} from "./dates";
import {
  ensureDeathDischarge,
  ensureForCauseDischarge,
  ensureLiveDischarge,
  ensureRevocation,
} from "./discharge";
import { asAnyone } from "./http";
import {
  type DemoPatientSpec,
  ensureDirectPatient,
  ensureIntakePatient,
  ensureReferralOnly,
} from "./patients";
import { ensureRateTable } from "./rate-table";
import type { RunReport } from "./report";
import { type ScenarioRun, runScenario } from "./run";

export interface ScenarioEnv {
  readonly ctx: SeedContext;
  readonly cal: SeedCalendar;
  readonly report: RunReport;
  readonly apply: boolean;
}

export interface Scenario {
  readonly key: string;
  readonly title: string;
  readonly run: (env: ScenarioEnv) => Promise<void>;
}

const OTHER_HOSPICE = "Blue Ridge Demo Hospice (fictional)";
const OUTBOX_POLL_MS = 2_000;
const OUTBOX_POLL_ATTEMPTS = 90;

const spec = (
  n: string,
  firstName: string,
  dob: string,
  sex: "female" | "male",
): DemoPatientSpec => ({
  marker: `DEMO-COP27-${n}`,
  firstName,
  dob,
  sex,
});

/** An election date `daysAgo` before today, clamped to [2026-10-01, today] so the addendum is mandatory. */
const fy27ElectionDate = (cal: SeedCalendar, daysAgo: number): string =>
  minDate(cal.today, maxDate(FY2027_EFFECTIVE, cal.rel(-daysAgo)));

/** A transfer-in whose inherited election is effective `electionDate`; the transfer is the next day. */
const transferPlan = (cal: SeedCalendar, electionDate: string, priorSequence: number) => ({
  priorSequence,
  priorElectionStartDate: electionDate,
  transferDate: minDate(cal.today, addDays(electionDate, 1)),
  otherHospiceName: OTHER_HOSPICE,
});

/** Transfer-in admission to active: direct patient → transfer-in → NOR → statement → date → recommend → activate. */
async function activeTransferIn(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  who: DemoPatientSpec,
  electionDate: string,
  priorSequence = 1,
): Promise<AdmissionHandle> {
  requireOrgSetup(ctx, run);
  const patient = await ensureDirectPatient(run, ctx, who);
  const transferIn = transferPlan(cal, electionDate, priorSequence);
  const plan: AdmissionPlan = {
    patient,
    transferIn,
    electionEffectiveDate: transferIn.transferDate,
    signCti: false,
    recommendation: true,
    activate: true,
  };
  return ensureAdmission(run, ctx, plan);
}

/** Intake admission to active TODAY (referral → … → physician CTI → activate). */
async function activeIntake(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  who: DemoPatientSpec,
): Promise<AdmissionHandle> {
  requireOrgSetup(ctx, run);
  if (!ctx.physician) {
    // Without a physician the CTI cannot be signed, so the admission could never activate; starting it would
    // only leave another half-finished intake behind (scenario 02 already shows that state).
    run.stop(
      "patient",
      "activation needs the hospice physician's CTI signature and no physician account is available",
    );
  }
  const intake = await ensureIntakePatient(run, ctx, who);
  return ensureAdmission(run, ctx, {
    patient: intake.patient,
    intakeAdmissionId: intake.admissionId,
    electionEffectiveDate: cal.today,
    signCti: true,
    recommendation: true,
    activate: true,
  });
}

const addendumContent = (ctx: SeedContext, adm: AdmissionHandle) => ({
  hospiceName: ctx.providerEntity?.name ?? "Demo Hospice",
  patientName: adm.patient.displayName,
  mrn: adm.patient.marker,
  clinicalExplanation:
    "DEMO DATA — the listed items treat conditions unrelated to the terminal illness and related conditions; " +
    "the hospice IDG reviewed each one against the plan of care.",
});

/** Wait for v1 to list every non-covered category this admission's records produce (see ensureAddendumSettled). */
async function settleAddendum(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<void> {
  const expected = await expectedAddendumCategories(ctx, adm);
  const label = expected.size > 0 ? `its non-covered ${[...expected].join(" + ")}` : "its content";
  await ensureAddendumSettled(run, ctx, adm.id, label, (items) =>
    [...expected].every((c) => items.some((i) => i.category === c)),
  );
}

/** Poll the addendum overview until `done` holds (outbox consumers are asynchronous). */
async function waitForAddendum(
  ctx: SeedContext,
  admissionId: string,
  done: (o: AddendumOverview) => boolean,
): Promise<AddendumOverview | null> {
  for (let i = 0; i < OUTBOX_POLL_ATTEMPTS; i++) {
    const o = await readAddendum(ctx, admissionId);
    if (o && done(o)) return o;
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));
  }
  return null;
}

/** Verify (read-only) that an open addendum settled after the patient left care. */
async function verifyAddendumSettled(
  run: ScenarioRun,
  ctx: SeedContext,
  adm: AdmissionHandle,
): Promise<void> {
  const settled = (o: AddendumOverview): boolean =>
    !!o.current &&
    ["signature_not_required", "not_required"].includes(o.current.status) &&
    o.openWindows.length === 0;
  await run.soft(
    "addendum settled automatically (no signature owed)",
    async () => {
      const o = await readAddendum(ctx, adm.id);
      return o && settled(o) ? o : null;
    },
    async () => {
      const o = await waitForAddendum(ctx, adm.id, settled);
      if (!o) {
        const now = await readAddendum(ctx, adm.id);
        throw new Error(`addendum did not settle: ${now ? describeAddendum(now) : "unreadable"}`);
      }
      return o;
    },
    describeAddendum,
  );
}

export const SCENARIOS: readonly Scenario[] = [
  {
    key: "01",
    title: "referral only (intake inbox)",
    run: ({ ctx, report, apply }) =>
      runScenario(report, "01 referral", apply, (run) =>
        ensureReferralOnly(run, ctx, spec("01", "Rhea", "1941-04-17", "female")),
      ),
  },
  {
    key: "02",
    title: "admission in intake, not activated (CTI signature + physician recommendation owed)",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "02 intake", apply, async (run) => {
        requireOrgSetup(ctx, run);
        const intake = await ensureIntakePatient(
          run,
          ctx,
          spec("02", "Ivy", "1938-02-11", "female"),
        );
        await ensureAdmission(run, ctx, {
          patient: intake.patient,
          intakeAdmissionId: intake.admissionId,
          electionEffectiveDate: cal.today,
          signCti: false,
          recommendation: false,
          activate: false,
        });
      }),
  },
  {
    key: "03",
    title:
      "active, election effective 2026-07 (addendum not mandatory) — care plan, visits, comfort med",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "03 pre-FY27", apply, async (run) => {
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("03", "Julian", "1940-07-04", "male"),
          minDate(cal.today, "2026-07-15"),
        );
        run.note("recert CTI (benefit period 2)", RECERT_CTI_NOTE);
        await ensureCarePlan(run, ctx, adm);
        await ensureVisits(run, ctx, cal, adm, 0);
        await ensureMedication(run, ctx, adm, COMFORT_MORPHINE);
        await run.soft(
          "addendum not mandatory",
          async () => {
            const o = await readAddendum(ctx, adm.id);
            return o && !o.required ? o : null;
          },
          async () => {
            throw new Error("the addendum reads as mandatory for a July election");
          },
          describeAddendum,
        );
      }),
  },
  {
    key: "04",
    title:
      "active, election ~5 days ago — addendum furnished + signed; non-covered drug and supply",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "04 addendum signed", apply, async (run) => {
        const election = fy27ElectionDate(cal, 5);
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("04", "Nora", "1944-03-22", "female"),
          election,
        );
        await ensureCarePlan(run, ctx, adm);
        await ensureVisits(run, ctx, cal, adm, 2);
        await ensureMedication(run, ctx, adm, COMFORT_MORPHINE);
        await ensureMedication(run, ctx, adm, UNRELATED_LISINOPRIL);
        await ensureNonCoveredSupply(run, ctx, adm);
        await settleAddendum(run, ctx, adm);
        await ensureAddendumContent(run, ctx, adm.id, addendumContent(ctx, adm));
        const furnishedAt = pastInstantOn(minDate(cal.today, addDays(election, 2)), new Date());
        await ensureAddendumFurnished(run, ctx, adm.id, furnishedAt);
        await ensureAddendumAcknowledged(run, ctx, adm.id, {
          kind: "signed",
          signedAt: new Date(
            Math.min(Date.parse(furnishedAt) + 3_600_000, Date.now() - 60_000),
          ).toISOString(),
        });
      }),
  },
  {
    key: "05",
    title: "active, election ~4 days ago — addendum drafted, not furnished (initial window due)",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "05 addendum due", apply, async (run) => {
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("05", "Otis", "1939-12-01", "male"),
          fy27ElectionDate(cal, 4),
        );
        await ensureAddendumDraft(run, ctx, adm.id);
      }),
  },
  {
    key: "06",
    title:
      "active, election ~3 days ago — addendum awaiting signature, then a coverage change opens the 3-day update",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "06 addendum update", apply, async (run) => {
        const election = fy27ElectionDate(cal, 3);
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("06", "Paula", "1946-08-15", "female"),
          election,
        );
        await ensureAddendumDraft(run, ctx, adm.id);
        await ensureAddendumContent(run, ctx, adm.id, addendumContent(ctx, adm));
        await ensureAddendumFurnished(
          run,
          ctx,
          adm.id,
          pastInstantOn(minDate(cal.today, addDays(election, 1)), new Date()),
        );
        await ensureMedication(run, ctx, adm, UNRELATED_ATORVASTATIN);
        await run.soft(
          "addendum v2 + 3-day update window (418.24(d)(2))",
          async () => {
            const o = await readAddendum(ctx, adm.id);
            return o?.history.some((v) => v.versionNumber >= 2) ? o : null;
          },
          async () => {
            const opened = await waitForAddendum(ctx, adm.id, (o) =>
              o.history.some((v) => v.versionNumber >= 2),
            );
            if (opened) return opened;
            // The coverage-change consumer did not open it (no physician to change coverage, or no relay):
            // open the update as a clinician-initiated plan-of-care change instead.
            await asAnyone("open addendum update", ctx.sessions, (s) =>
              s.client.POST("/api/v1/admissions/{id}/election-addendum", {
                params: { path: { id: adm.id } },
                body: {},
              }),
            );
            const o = await readAddendum(ctx, adm.id);
            if (!o?.history.some((v) => v.versionNumber >= 2))
              throw new Error("no addendum v2 after update");
            return o;
          },
          describeAddendum,
        );
      }),
  },
  {
    key: "07",
    title: "active today (ordinary intake) — addendum refused by the representative",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "07 addendum refused", apply, async (run) => {
        const adm = await activeIntake(run, ctx, cal, spec("07", "Quinn", "1937-05-30", "male"));
        await ensureCarePlan(run, ctx, adm);
        await ensureVisits(run, ctx, cal, adm, 4);
        await ensureAddendumDraft(run, ctx, adm.id);
        await settleAddendum(run, ctx, adm);
        await ensureAddendumContent(run, ctx, adm.id, addendumContent(ctx, adm));
        await ensureAddendumFurnished(
          run,
          ctx,
          adm.id,
          new Date(Date.now() - 600_000).toISOString(),
        );
        await ensureAddendumAcknowledged(run, ctx, adm.id, {
          kind: "refused",
          reason:
            "DEMO DATA — the patient's daughter, his health-care representative, received the addendum but " +
            "declined to sign it; she disagrees with the unrelated-condition determinations and will discuss " +
            "them with the attending physician.",
        });
      }),
  },
  {
    key: "08",
    title:
      "recertification into benefit period 3 — telehealth F2F with eligibility answers, narrative attestation",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "08 recert telehealth F2F", apply, async (run) => {
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("08", "Rosa", "1936-10-09", "female"),
          cal.rel(-80),
          2,
        );
        await ensureRecertF2f(run, ctx, cal, adm, {
          location: "telehealth",
          attestation:
            "DEMO DATA — I, the hospice physician, attest that I had a face-to-face encounter with this patient by " +
            "two-way audio-video telehealth on the date shown, and that the clinical findings were provided to the " +
            "certifying physician for use in determining continued eligibility for hospice care.",
        });
      }),
  },
  {
    key: "09",
    title:
      "recertification into benefit period 4 — in-person F2F (signed-note attestation when step-up allows)",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "09 recert in-person F2F", apply, async (run) => {
        const adm = await activeTransferIn(
          run,
          ctx,
          cal,
          spec("09", "Saul", "1934-01-27", "male"),
          cal.rel(-50),
          3,
        );
        run.skip(
          "F2F attested by linking a signed visit note",
          "signing an M8 visit note needs a fresh MFA step-up, which a password-only script cannot perform; attested by narrative instead",
        );
        await ensureRecertF2f(run, ctx, cal, adm, {
          location: "patient_home",
          attestation:
            "DEMO DATA — I, the hospice physician, attest that I personally saw and examined this patient in the " +
            "patient's home on the date shown, and that the clinical findings were provided to the certifying " +
            "physician for use in determining continued eligibility for hospice care.",
        });
      }),
  },
  {
    key: "10",
    title: "live discharge (no longer terminally ill) with the physician discharge order",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "10 live discharge", apply, async (run) => {
        const adm = await activeIntake(run, ctx, cal, spec("10", "Tobias", "1945-06-18", "male"));
        await ensureLiveDischarge(run, ctx, cal, adm);
      }),
  },
  {
    key: "11",
    title: "for-cause discharge completed by the physician cosign",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "11 for-cause discharge", apply, async (run) => {
        const adm = await activeIntake(run, ctx, cal, spec("11", "Uma", "1950-02-02", "female"));
        await ensureForCauseDischarge(run, ctx, cal, adm);
      }),
  },
  {
    key: "12",
    title: "death discharge with place of death — the open addendum settles",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "12 death", apply, async (run) => {
        const adm = await activeIntake(run, ctx, cal, spec("12", "Victor", "1933-11-11", "male"));
        await ensureAddendumDraft(run, ctx, adm.id);
        await ensureDeathDischarge(run, ctx, cal, adm);
        await verifyAddendumSettled(run, ctx, adm);
      }),
  },
  {
    key: "13",
    title: "revocation — the open addendum settles",
    run: ({ ctx, cal, report, apply }) =>
      runScenario(report, "13 revocation", apply, async (run) => {
        const adm = await activeIntake(run, ctx, cal, spec("13", "Wanda", "1948-04-04", "female"));
        await ensureAddendumDraft(run, ctx, adm.id);
        await ensureRevocation(run, ctx, cal, adm);
        await verifyAddendumSettled(run, ctx, adm);
      }),
  },
  {
    key: "org",
    title: "FY2027 rate table for the provider entity",
    run: ({ ctx, report, apply }) =>
      runScenario(report, "org rate table", apply, (run) => ensureRateTable(run, ctx)),
  },
];
