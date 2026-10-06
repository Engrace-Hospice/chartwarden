import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionCreate } from "../admission-create";
import { localToday } from "../end-of-episode-ui";
import { Readmission, validateIntake } from "../readmission";
import {
  type BenefitPeriodPlan,
  benefitPeriodBody,
  benefitPeriodWarnings,
  requirementChecklist,
  validateBenefitPeriod,
} from "../readmission-model";
import { admissionScreens } from "../screens";

// The directory lookups are exercised in shell/entity-lookups.dom.test.tsx; here they are plain inputs.
vi.mock("../../../shell/entity-lookups", () => {
  const Field = (props: {
    label: string;
    value: string;
    error?: string;
    onChange: (v: string, o?: { id: string; label: string; searchLabel: string } | null) => void;
  }) => (
    <label>
      {props.label}
      <input
        value={props.value}
        onChange={(e) =>
          props.onChange(e.target.value, {
            id: e.target.value,
            label: "Dr. Kim",
            searchLabel: "Dr. Kim",
          })
        }
      />
      {props.error ? <span>{props.error}</span> : null}
    </label>
  );
  return { MdmEntityLookupField: Field, PatientLookupField: Field };
});

const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW_ADM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PHYS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Ana Reyes",
  permissions: ["admission.read", "admission.create"],
};

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: code } },
  response: new Response(null, { status }),
});

function plan(sequence = 2, over: Partial<BenefitPeriodPlan> = {}): BenefitPeriodPlan {
  const f2f = sequence >= 3;
  return {
    patientId: PATIENT,
    previous: {
      admissionId: ADM,
      admissionState: "discharged",
      startedOn: "2026-08-01",
      endedOn: "2026-09-20",
      endKind: "live_discharge",
      dischargeType: "no_longer_terminal",
      transfer: false,
      lastSequence: 1,
      daysSinceDischarge: 16,
    },
    readmission: { eligible: true, blockers: [] },
    priorElectionClosure: {
      admissionId: ADM,
      status: "not_filed",
      notrFiled: false,
      finalClaimFiled: false,
    },
    noeBlocked: true,
    suggestion: {
      suggestedSequence: 2,
      basis: "next_after_live_discharge",
      fromAdmissionId: ADM,
      lastKnownSequence: 1,
    },
    requirements: {
      sequence,
      periodKind: sequence <= 2 ? "ninety_day" : "sixty_day",
      lengthDays: sequence <= 2 ? 90 : 60,
      startDate: "2026-10-06",
      endDate: sequence <= 2 ? "2027-01-03" : "2026-12-04",
      certification: { hospicePhysician: true, attendingIfDesignated: sequence === 1 },
      faceToFace: {
        required: f2f,
        windowStart: f2f ? "2026-09-06" : null,
        windowEnd: f2f ? "2026-10-05" : null,
        exceptionWindowEnd: f2f ? "2026-10-08" : null,
      },
      electionStatementRequired: true,
      noeDueBy: "2026-10-10",
      initialAssessmentDueBy: "2026-10-08",
      comprehensiveAssessmentDueBy: "2026-10-10",
      hopeAdmissionA0220: "2026-10-06",
    },
    rhc: {
      applies: true,
      daysSinceDischarge: 16,
      priorHospiceDays: 50,
      startsAtDay: 51,
      highRateDaysRemaining: 10,
    },
    ...over,
  };
}

function makeClient(
  opts: { planOver?: Partial<BenefitPeriodPlan>; postFail?: string; hets?: object } = {},
) {
  const GET = vi.fn(async (path: string, init?: { params?: { query?: { sequence?: number } } }) => {
    if (path === "/api/v1/billing/eligibility/hospice-periods" && opts.hets) return ok(opts.hets);
    if (path === "/api/v1/admissions/{id}")
      return ok({
        id: ADM,
        state: "discharged",
        version: 7,
        patientId: PATIENT,
        admissionAt: "2026-08-01T12:00:00.000Z",
      });
    if (
      path === "/api/v1/admissions/{id}/readmission-context" ||
      path === "/api/v1/patients/{patientId}/benefit-period-plan"
    )
      return ok(plan(init?.params?.query?.sequence ?? 2, opts.planOver));
    return fail(404, "NOT_FOUND");
  });
  const POST = vi.fn(async () =>
    opts.postFail
      ? fail(409, opts.postFail)
      : ok({ id: NEW_ADM, state: "pending", version: 0 }, 201),
  );
  return { GET, POST };
}

function mount(path: string, routePath: string, el: JSX.Element, client: object) {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={el} />
            <Route path="/admissions/:id" element={<p>new admission page</p>} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const cont = () => fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

describe("readmission model", () => {
  const today = "2026-10-06";
  it("validates the number and the HETS confirmation date", () => {
    expect(
      validateBenefitPeriod({ sequence: "0", hetsConfirmed: false, confirmedOn: "" }, today),
    ).toHaveProperty("sequence");
    expect(
      validateBenefitPeriod({ sequence: "2", hetsConfirmed: true, confirmedOn: "" }, today),
    ).toHaveProperty("confirmedOn");
    expect(
      validateBenefitPeriod(
        { sequence: "2", hetsConfirmed: true, confirmedOn: "2026-10-07" },
        today,
      ),
    ).toHaveProperty("confirmedOn");
    expect(
      validateBenefitPeriod({ sequence: "2", hetsConfirmed: true, confirmedOn: today }, today),
    ).toEqual({});
  });

  it("warns (never blocks) when unconfirmed or different from the suggestion", () => {
    expect(
      benefitPeriodWarnings({ sequence: "2", hetsConfirmed: true, confirmedOn: today }, 2),
    ).toEqual([]);
    const w = benefitPeriodWarnings({ sequence: "3", hetsConfirmed: false, confirmedOn: "" }, 2);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/across every hospice/);
    expect(w[1]).toMatch(/suggests \(2\)/);
  });

  it("maps the draft to the request source", () => {
    expect(
      benefitPeriodBody({ sequence: "2", hetsConfirmed: false, confirmedOn: "" }, 2, today),
    ).toEqual({ sequence: 2, source: "internal_history" });
    expect(
      benefitPeriodBody({ sequence: "3", hetsConfirmed: false, confirmedOn: "" }, 2, today),
    ).toEqual({ sequence: 3, source: "staff_entered_unverified" });
    expect(
      benefitPeriodBody({ sequence: "3", hetsConfirmed: true, confirmedOn: today }, 2, today),
    ).toEqual({ sequence: 3, source: "hets_confirmed", confirmedOn: today });
    expect(
      benefitPeriodBody({ sequence: "x", hetsConfirmed: false, confirmedOn: "" }, 2, today),
    ).toBeNull();
  });

  it("builds the period's checklist: signers, F2F from period 3, NOE held, RHC carry-over", () => {
    const fmt = (d: string | null | undefined) => d ?? "—";
    const p2 = requirementChecklist(plan(2), fmt);
    expect(p2.map((c) => c.key)).toEqual([
      "election",
      "certification",
      "noe",
      "assessments",
      "hope",
      "rhc",
    ]);
    expect(p2.find((c) => c.key === "certification")?.title).toMatch(/medical director/);
    expect(p2.find((c) => c.key === "noe")?.detail).toMatch(/Held/);
    const p3 = requirementChecklist(plan(3, { noeBlocked: false }), fmt);
    expect(p3.find((c) => c.key === "f2f")?.detail).toContain("2026-10-08");
    expect(p3.find((c) => c.key === "noe")?.tone).toBe("info");
    const p1 = requirementChecklist(plan(1), fmt);
    expect(p1.find((c) => c.key === "certification")?.title).toMatch(/attending/);
  });

  it("intake: requires the date, director, and an exception reason in period 3+", () => {
    const d = {
      admissionDate: "",
      intakeMethod: "in_person" as const,
      hospiceMedicalDirectorId: "",
      hospiceMedicalDirectorLabel: "",
      attendingPhysicianId: "",
      attendingPhysicianLabel: "",
      f2fException: true,
      f2fExceptionReason: "short",
    };
    expect(Object.keys(validateIntake(d, 3, today)).sort()).toEqual([
      "admissionDate",
      "f2fExceptionReason",
      "hospiceMedicalDirectorId",
    ]);
    expect(validateIntake(d, 2, today)).not.toHaveProperty("f2fExceptionReason");
  });

  it("registers the readmit screen gated on admission.create", () => {
    const s = admissionScreens.screens.find((x) => x.id === "admission.readmit");
    expect(s?.path).toBe("/admissions/:id/readmit");
    expect(s?.requiredPermission).toBe("admission.create");
  });
});

describe("Readmission screen", () => {
  it("walks previous episode → period → requirements → intake → review and posts the readmission", async () => {
    const client = makeClient();
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, client);

    // Previous episode
    expect(await screen.findByRole("heading", { name: "Previous episode" })).toBeTruthy();
    expect(screen.getByText("No NOTR or final claim filed yet")).toBeTruthy();
    expect(screen.getByText(/Medicare rejects the new NOE/)).toBeTruthy();
    cont();

    // Benefit period: prefilled with the suggestion; unconfirmed → a warning, not a block
    const seq = (await screen.findByLabelText(/Benefit period number/)) as HTMLInputElement;
    await waitFor(() => expect(seq.value).toBe("2"));
    expect(screen.getByText(/Not confirmed against HETS/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Confirmed against HETS \/ ELGA \/ ELGH/));
    expect(screen.queryByText(/Not confirmed against HETS/)).toBeNull();
    cont();

    // Requirements
    expect(await screen.findByText("Requirements for period 2")).toBeTruthy();
    expect(screen.getByText(/hospice medical director \/ IDG physician/)).toBeTruthy();
    expect(screen.queryByText("Face-to-face encounter required")).toBeNull();
    cont();

    // Intake: the director is required
    cont();
    expect(await screen.findByText("Select the hospice medical director.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Hospice medical director/), {
      target: { value: PHYS },
    });
    cont();

    // Review + submit
    expect(await screen.findByRole("heading", { name: "Review" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create readmission" }));
    expect(await screen.findByText("new admission page")).toBeTruthy();
    expect(client.POST).toHaveBeenCalledWith("/api/v1/admissions", {
      body: {
        patientId: PATIENT,
        intakeMethod: "in_person",
        hospiceMedicalDirectorId: PHYS,
        readmittedFromAdmissionId: ADM,
        benefitPeriod: { sequence: 2, source: "hets_confirmed", confirmedOn: localToday() },
        admissionDate: localToday(),
      },
    });
  });

  it("an edited number differing from the suggestion warns and drives period-3 F2F with the exception path", async () => {
    const client = makeClient();
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, client);
    await screen.findByRole("heading", { name: "Previous episode" });
    cont();
    const seq = (await screen.findByLabelText(/Benefit period number/)) as HTMLInputElement;
    await waitFor(() => expect(seq.value).toBe("2"));
    fireEvent.change(seq, { target: { value: "3" } });
    expect(await screen.findByText(/differs from the period our history suggests/)).toBeTruthy();
    cont();
    expect(await screen.findByText("Face-to-face encounter required")).toBeTruthy();
    cont();
    fireEvent.change(screen.getByLabelText(/Hospice medical director/), {
      target: { value: PHYS },
    });
    fireEvent.click(screen.getByLabelText(/Exceptional circumstances/));
    cont();
    expect(await screen.findByText(/at least 20 characters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Describe the circumstance/), {
      target: { value: "Weekend emergency admission; no hospice physician available" },
    });
    cont();
    fireEvent.click(await screen.findByRole("button", { name: "Create readmission" }));
    await screen.findByText("new admission page");
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions",
      expect.objectContaining({
        body: expect.objectContaining({
          benefitPeriod: { sequence: 3, source: "staff_entered_unverified" },
          f2fException: { reason: "Weekend emergency admission; no hospice physician available" },
        }),
      }),
    );
  });

  it("blocks a stay that ended in death and says why", async () => {
    const client = makeClient({
      planOver: { readmission: { eligible: false, blockers: ["ENDED_BY_DEATH"] } },
    });
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, client);
    expect(await screen.findByText("This stay ended in death.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Continue/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows the server's refusal on submit", async () => {
    const client = makeClient({ postFail: "PATIENT_ALREADY_ELECTED" });
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, client);
    await screen.findByRole("heading", { name: "Previous episode" });
    cont();
    await waitFor(() =>
      expect((screen.getByLabelText(/Benefit period number/) as HTMLInputElement).value).toBe("2"),
    );
    cont();
    cont();
    fireEvent.change(screen.getByLabelText(/Hospice medical director/), {
      target: { value: PHYS },
    });
    cont();
    fireEvent.click(await screen.findByRole("button", { name: "Create readmission" }));
    expect(await screen.findByText("The patient already has an open admission.")).toBeTruthy();
  });
});

describe("New admission — benefit period field", () => {
  it("prefills the suggestion, warns when unconfirmed, and posts the benefit period", async () => {
    const client = makeClient();
    mount(`/admissions/new?patientId=${PATIENT}`, "/admissions/new", <AdmissionCreate />, client);
    const seq = (await screen.findByLabelText(/Benefit period number/)) as HTMLInputElement;
    await waitFor(() => expect(seq.value).toBe("2"));
    expect(screen.getByText(/Not confirmed against HETS/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Use the readmission workflow" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText(/Hospice medical director/), {
      target: { value: PHYS },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const review = await screen.findByText("Review admission");
    expect(
      within(review.closest("section") ?? document.body).getByText(/not confirmed in HETS/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create admission" }));
    await screen.findByText("new admission page");
    expect(client.POST).toHaveBeenCalledWith("/api/v1/admissions", {
      body: {
        patientId: PATIENT,
        intakeMethod: "in_person",
        hospiceMedicalDirectorId: PHYS,
        benefitPeriod: { sequence: 2, source: "internal_history" },
      },
    });
  });
});

describe("Readmission screen — RHC carry-over across hospices (HETS)", () => {
  const hetsView = {
    status: "available",
    hetsConfigured: true,
    patientId: PATIENT,
    checkId: "33333333-3333-4333-8333-333333333333",
    asOfServiceDate: "2026-10-01",
    outcome: "active_part_a",
    checkedAt: "2026-10-01T12:00:00.000Z",
    staleAt: "2026-10-31T12:00:00.000Z",
    stale: false,
    synthetic: false,
    hospiceHistoryReturned: true,
    hospiceElectionOpen: false,
    hospiceHistoryTruncated: false,
    hospicePeriods: [],
    nextPeriodNumber: 2,
    nextPeriodBasis: "computed",
    lastAttempt: null,
    rhcCarryOver: {
      electionDate: "2026-10-06",
      priorDays: 57,
      chainDays: 57,
      basis: "hets_merged",
      startsAtDay: 58,
      highRateDaysRemaining: 3,
      daysSinceLastCare: 16,
      chain: [
        {
          source: "hets",
          kind: "benefit_period",
          start: "2026-07-01",
          end: "2026-07-07",
          endAssumed: false,
          countedDays: 7,
          hospiceNpi: "1649726464",
          ref: null,
        },
        {
          source: "internal",
          kind: "stay",
          start: "2026-08-01",
          end: "2026-09-19",
          endAssumed: false,
          countedDays: 50,
          hospiceNpi: null,
          ref: ADM,
        },
      ],
      warnings: [],
      hetsCheck: {
        checkId: "33333333-3333-4333-8333-333333333333",
        checkedAt: "2026-10-01T12:00:00.000Z",
        ageDays: 5,
        stale: false,
      },
    },
  };

  it("shows the merged carry-over with each source, and asks the read for the election date", async () => {
    const client = makeClient({ hets: hetsView });
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, client);

    expect(
      await screen.findByText(/57 carry over \(our stays \+ other hospices via HETS\)/),
    ).toBeTruthy();
    const summary = screen.getByTestId("rhc-carry-over");
    expect(within(summary).getByText("Our records + HETS")).toBeTruthy();
    expect(within(summary).getByText("Other hospice (HETS, NPI 1649726464)")).toBeTruthy();
    expect(within(summary).getByText("Our stay")).toBeTruthy();
    expect(
      within(summary).getByText(/starts at RHC day 58, with 3 high-rate days left/),
    ).toBeTruthy();
    expect(screen.queryByText(/no recent HETS check is on file/)).toBeNull();
    const hetsCall = client.GET.mock.calls.find(
      (c) => c[0] === "/api/v1/billing/eligibility/hospice-periods",
    ) as unknown as [string, { params: { query: Record<string, string> } }];
    expect(hetsCall[1].params.query.electionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("warns that the split may be wrong when HETS has not been checked", async () => {
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, makeClient());
    expect(await screen.findByText(/50 carry over \(readmitted within 60 days\)/)).toBeTruthy();
    expect(screen.getByText(/no recent HETS check is on file/)).toBeTruthy();
  });

  const rhcLineOnRequirements = async (): Promise<HTMLElement> => {
    await screen.findByRole("heading", { name: "Previous episode" });
    cont();
    const seq = (await screen.findByLabelText(/Benefit period number/)) as HTMLInputElement;
    await waitFor(() => expect(seq.value).toBe("2"));
    cont();
    const title = await screen.findByText("Routine home care day count continues");
    return title.closest("li") as HTMLElement;
  };

  it("the Requirements RHC line uses the merged HETS carry-over, not M6's own count", async () => {
    mount(
      `/admissions/${ADM}/readmit`,
      "/admissions/:id/readmit",
      <Readmission />,
      makeClient({ hets: hetsView }),
    );
    const line = await rhcLineOnRequirements();
    expect(line.textContent).toMatch(
      /57 earlier hospice days carry over \(our stays \+ other hospices via HETS\), so this stay starts at day 58 \(3 days left/,
    );
    expect(line.textContent).not.toMatch(/\b50 earlier/);
  });

  it("the Requirements RHC line falls back to M6's count when no HETS carry-over is loaded", async () => {
    mount(`/admissions/${ADM}/readmit`, "/admissions/:id/readmit", <Readmission />, makeClient());
    const line = await rhcLineOnRequirements();
    expect(line.textContent).toMatch(
      /Readmitted within 60 days: 50 earlier hospice days carry over, so this stay starts at day 51/,
    );
  });
});
