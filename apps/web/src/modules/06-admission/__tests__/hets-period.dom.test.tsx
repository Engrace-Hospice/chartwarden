import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { type JSX, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionCreate } from "../admission-create";
import { BenefitPeriodField } from "../benefit-period-field";
import { type HetsHospicePeriodsView, hetsAdvice, localDateOf } from "../hets-model";
import { useHetsHospicePeriods } from "../hets-period-panel";
import { Readmission } from "../readmission";
import type { BenefitPeriodDraft } from "../readmission-model";

vi.mock("../../../shell/entity-lookups", () => {
  const Field = (props: {
    label: string;
    value: string;
    onChange: (v: string, o: null) => void;
  }) => (
    <label>
      {props.label}
      <input value={props.value} onChange={(e) => props.onChange(e.target.value, null)} />
    </label>
  );
  return {
    MdmEntityLookupField: Field,
    PatientLookupField: Field,
    ProviderEntityLookupField: Field,
  };
});

const PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROVIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TODAY = "2026-10-06";
const HOSPICE_PERIODS = "/api/v1/billing/eligibility/hospice-periods";
const CHECKED_AT = "2026-10-01T15:00:00.000Z";

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "X" } },
  response: new Response(null, { status }),
});

function view(over: Partial<HetsHospicePeriodsView> = {}): HetsHospicePeriodsView {
  return {
    status: "available",
    hetsConfigured: true,
    checkId: "chk-1",
    asOfServiceDate: TODAY,
    outcome: "active_part_a",
    checkedAt: CHECKED_AT,
    staleAt: "2026-10-31T15:00:00.000Z",
    stale: false,
    synthetic: false,
    hospiceHistoryReturned: true,
    hospiceElectionOpen: false,
    hospiceHistoryTruncated: false,
    nextPeriodNumber: 3,
    nextPeriodBasis: "computed",
    lastAttempt: null,
    ...over,
  };
}

const NO_CHECK = view({
  status: "no_check_on_file",
  checkId: null,
  checkedAt: null,
  staleAt: null,
  stale: null,
  outcome: null,
  hospiceHistoryReturned: false,
  hospiceElectionOpen: null,
  hospiceHistoryTruncated: null,
  nextPeriodNumber: null,
  nextPeriodBasis: null,
});

function sessionWith(perms: string[]): Session {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    permissions: ["admission.read", "admission.create", ...perms],
  };
}

function Harness({ initial = "2" }: { initial?: string }): JSX.Element {
  const [draft, setDraft] = useState<BenefitPeriodDraft>({
    sequence: initial,
    hetsConfirmed: false,
    confirmedOn: "",
  });
  const hets = useHetsHospicePeriods(PATIENT, { pollMs: 5 });
  return (
    <>
      <BenefitPeriodField
        idPrefix="t"
        draft={draft}
        onChange={(p) => setDraft((d) => ({ ...d, ...p }))}
        suggested={2}
        today={TODAY}
        errors={{}}
        hets={hets}
        serviceDate={TODAY}
      />
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </>
  );
}

function mountField(get: (path: string) => unknown, perms: string[] = [], post?: () => unknown) {
  const client = {
    GET: vi.fn(async (path: string) => get(path)),
    POST: vi.fn(async () => (post ? post() : ok({ jobId: "j" }, 202))),
  };
  render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={sessionWith(perms)}>
        <Harness />
      </SessionProvider>
    </ApiClientProvider>,
  );
  return client;
}

const draftOf = () => JSON.parse(screen.getByTestId("draft").textContent ?? "{}");

describe("hetsAdvice", () => {
  it("falls back to the manual flow quietly when forbidden or not configured", () => {
    for (const load of [
      { kind: "unavailable", reason: "forbidden" } as const,
      { kind: "unavailable", reason: "not_configured" } as const,
    ]) {
      const a = hetsAdvice(load, 2, true);
      expect(a.hint).toMatch(/HETS \/ ELGA \/ ELGH/);
      expect(a.warnings).toEqual([]);
      expect(a.offerCheck).toBeNull();
      expect(a.usePeriod).toBeNull();
    }
  });

  it("offers a check only to a caller who may run one", () => {
    expect(hetsAdvice({ kind: "loaded", view: NO_CHECK }, 2, true).offerCheck).toBe("run");
    expect(hetsAdvice({ kind: "loaded", view: NO_CHECK }, 2, false).offerCheck).toBeNull();
  });

  it("uses the check's local calendar date as the confirmation date", () => {
    const a = hetsAdvice({ kind: "loaded", view: view() }, 3, false);
    expect(a.usePeriod).toEqual({ sequence: 3, confirmedOn: localDateOf(CHECKED_AT) });
    expect(a.warnings).toEqual([]);
  });

  it("explains every undetermined basis and never offers a number", () => {
    for (const basis of [
      "election_open",
      "election_status_uncertain",
      "unbilled_election",
      "history_truncated",
    ] as const) {
      const a = hetsAdvice(
        { kind: "loaded", view: view({ nextPeriodNumber: null, nextPeriodBasis: basis }) },
        2,
        false,
      );
      expect(a.usePeriod).toBeNull();
      expect(a.info).toBeNull();
      expect(a.hint).toMatch(/cannot give the next period/);
    }
  });
});

describe("Benefit-period field — HETS states", () => {
  it("403: quiet hint, manual checkbox, no banner or check action", async () => {
    mountField(
      (p) => (p === HOSPICE_PERIODS ? fail(403) : fail(404)),
      ["billing.eligibility.check"],
    );
    expect(await screen.findByText(/Look the period up in HETS/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /HETS check/ })).toBeNull();
    expect(screen.getByLabelText(/Confirmed against HETS/)).toBeTruthy();
  });

  it("hets_not_configured: the same manual fallback", async () => {
    mountField(() =>
      ok(view({ ...NO_CHECK, status: "hets_not_configured", hetsConfigured: false })),
    );
    expect(await screen.findByText(/Look the period up in HETS/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /HETS check/ })).toBeNull();
  });

  it("no_check_on_file without billing.eligibility.check: manual flow, no action", async () => {
    mountField(() => ok(NO_CHECK));
    expect(await screen.findByText(/No HETS check is on file/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run HETS check/ })).toBeNull();
  });

  it("no_check_on_file with billing.eligibility.check: runs a check (Idempotency-Key, 202) and polls until it lands", async () => {
    let calls = 0;
    const client = mountField(
      (p) => {
        if (p !== HOSPICE_PERIODS) return fail(404);
        calls += 1;
        return ok(calls < 3 ? NO_CHECK : view({ nextPeriodNumber: 4 }));
      },
      ["billing.eligibility.check"],
    );
    const run = await screen.findByRole("button", { name: "Run HETS check" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Provider entity for the HETS check/), {
      target: { value: PROVIDER },
    });
    fireEvent.click(run);
    expect(
      await screen.findByText(/Medicare \(HETS, checked .*\) indicates period 4/),
    ).toBeTruthy();
    expect(client.POST).toHaveBeenCalledWith("/api/v1/billing/eligibility/check", {
      headers: { "Idempotency-Key": expect.any(String) },
      body: { patientId: PATIENT, providerEntityId: PROVIDER, asOfServiceDate: TODAY },
    });
  });

  it("available + computed + fresh: 'Use period N' sets the number and hets_confirmed; a different number warns", async () => {
    mountField(() => ok(view()));
    fireEvent.click(await screen.findByRole("button", { name: "Use period 3" }));
    expect(draftOf()).toEqual({
      sequence: "3",
      hetsConfirmed: true,
      confirmedOn: localDateOf(CHECKED_AT),
    });
    expect(screen.queryByText(/differs from Medicare's HETS answer/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Benefit period number/), { target: { value: "4" } });
    expect(await screen.findByText(/differs from Medicare's HETS answer \(3\)/)).toBeTruthy();
  });

  it("stale: warns the check is over 30 days old, no 'Use', offers a re-check", async () => {
    mountField(() => ok(view({ stale: true })), ["billing.eligibility.check"]);
    expect(await screen.findByText(/over 30 days old/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use period/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Re-check HETS" })).toBeTruthy();
  });

  it("election open elsewhere: explains why, and warns Medicare will reject our NOE", async () => {
    mountField(() =>
      ok(
        view({
          nextPeriodNumber: null,
          nextPeriodBasis: "election_open",
          hospiceElectionOpen: true,
        }),
      ),
    );
    expect(await screen.findByText(/most recent hospice election is still open/)).toBeTruthy();
    expect(
      screen.getByText(/Medicare rejects our NOE until that election is terminated/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use period/ })).toBeNull();
  });

  it("truncated history: explains, keeps the manual flow", async () => {
    mountField(() =>
      ok(
        view({
          nextPeriodNumber: null,
          nextPeriodBasis: "history_truncated",
          hospiceHistoryTruncated: true,
        }),
      ),
    );
    expect(await screen.findByText(/returned only part of the hospice history/)).toBeTruthy();
    expect(screen.getByLabelText(/Confirmed against HETS/)).toBeTruthy();
  });

  it("uncertain election status: explains", async () => {
    mountField(() =>
      ok(view({ nextPeriodNumber: null, nextPeriodBasis: "election_status_uncertain" })),
    );
    expect(
      await screen.findByText(/unclear whether the most recent election was closed/),
    ).toBeTruthy();
  });

  it("synthetic: labels sandbox data visibly", async () => {
    mountField(() => ok(view({ synthetic: true })));
    expect(await screen.findByText(/Sandbox data — not real CMS/)).toBeTruthy();
  });
});

describe("HETS on the screens", () => {
  function screenClient() {
    return {
      GET: vi.fn(async (path: string) => {
        if (path === HOSPICE_PERIODS) return ok(view({ synthetic: true }));
        if (path === "/api/v1/admissions/{id}")
          return ok({ id: ADM, state: "discharged", version: 1, patientId: PATIENT });
        if (
          path === "/api/v1/admissions/{id}/readmission-context" ||
          path === "/api/v1/patients/{patientId}/benefit-period-plan"
        )
          return ok({
            patientId: PATIENT,
            previous: null,
            readmission: { eligible: true, blockers: [] },
            priorElectionClosure: null,
            noeBlocked: false,
            suggestion: {
              suggestedSequence: 1,
              basis: "no_history",
              fromAdmissionId: null,
              lastKnownSequence: null,
            },
            requirements: {
              sequence: 1,
              periodKind: "ninety_day",
              lengthDays: 90,
              startDate: TODAY,
              endDate: "2027-01-03",
              certification: { hospicePhysician: true, attendingIfDesignated: true },
              faceToFace: {
                required: false,
                windowStart: null,
                windowEnd: null,
                exceptionWindowEnd: null,
              },
              electionStatementRequired: true,
              noeDueBy: "2026-10-11",
              initialAssessmentDueBy: "2026-10-08",
              comprehensiveAssessmentDueBy: "2026-10-10",
              hopeAdmissionA0220: TODAY,
            },
            rhc: {
              applies: false,
              daysSinceDischarge: null,
              priorHospiceDays: 0,
              startsAtDay: 1,
              highRateDaysRemaining: 60,
            },
          });
        return fail(404);
      }),
      POST: vi.fn(),
    };
  }

  it("New admission shows the HETS answer and 'Use period N'", async () => {
    const client = screenClient();
    render(
      <ApiClientProvider client={client as unknown as ApiClient}>
        <SessionProvider session={sessionWith([])}>
          <MemoryRouter initialEntries={[`/admissions/new?patientId=${PATIENT}`]}>
            <Routes>
              <Route path="/admissions/new" element={<AdmissionCreate />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Use period 3" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/Benefit period number/) as HTMLInputElement).value).toBe("3"),
    );
    expect(screen.getByText(/Sandbox data/)).toBeTruthy();
    expect(client.GET).toHaveBeenCalledWith(HOSPICE_PERIODS, {
      params: { query: { patientId: PATIENT } },
    });
  });

  it("the readmission screen reads HETS for the patient", async () => {
    const client = screenClient();
    render(
      <ApiClientProvider client={client as unknown as ApiClient}>
        <SessionProvider session={sessionWith([])}>
          <MemoryRouter initialEntries={[`/admissions/${ADM}/readmit`]}>
            <Routes>
              <Route path="/admissions/:id/readmit" element={<Readmission />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("button", { name: "Use period 3" })).toBeTruthy();
    // The readmission screen also asks for the RHC carry-over of a new election on the admission date.
    expect(client.GET).toHaveBeenCalledWith(HOSPICE_PERIODS, {
      params: {
        query: { patientId: PATIENT, electionDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      },
    });
  });
});
