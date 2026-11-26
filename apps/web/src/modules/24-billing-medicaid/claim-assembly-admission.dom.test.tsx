import {
  ApiClientProvider,
  ToastProvider,
  __resetClaimsBillingForTest,
  createApiClient,
  noteClaimsBillingRefusal,
} from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — F-066 (#161): the assembly wizard's admission.
//
// The wizard asked a billing clerk to TYPE a uuid (`useState("")` rendered as a raw text input), then
// later offered a lookup that spanned the whole organization. Both shapes let the wrong admission onto
// a Medicaid claim, and `step1Valid` only ever checked that the value was uuid-SHAPED — so a stale id
// left over from a previously selected patient passed every client-side check. The server re-derives
// and would refuse, but a wizard that lets a clerk get to "Assemble draft" has already made the error.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicaidAssemblyWizard } from "./claim-assembly-wizard";

const PATIENT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ADMISSION_A = "11111111-8888-4888-8888-111111111111";

let paths: string[] = [];
let previewRequestStatus = 200;
let holdPreviewResponse = false;
let releasePreviewResponse: (() => void) | null = null;
let previewBody: unknown;
const CHC_PATH = "/api/v1/medicaid-chc-pricing-preparations";
let chcStatus = 200;
let chcBody: unknown;
let holdChcResponse = false;
/** One releaser per held CHC request, in arrival order (the nth request is released by `chcReleasers[n]`). */
let chcReleasers: Array<() => void> = [];
/** Bumped once the stub has built (or thrown) the answer, so a test can tell when the client has been handed it. */
let chcResponded = 0;
let rejectChcFetch = false;

const BLOCKED_ARRANGEMENT_PREVIEW = {
  primaryCoverage: { status: "uniform", coverageKind: "medicaid", rank: 1 },
  medicaidCoverage: { status: "uniform", coverageKind: "medicaid", rank: 1 },
  payerResponsibility: "medicaid_primary",
  recordedEligibility: {
    status: "not_recorded",
    outcome: null,
    serviceState: "OR",
    asOfServiceDate: null,
    checkedAt: null,
    staleAt: null,
  },
  claimKinds: [
    { kind: "hospice_only", payerPolicy: "permitted", reasonCode: null },
    { kind: "rb_only", payerPolicy: "permitted", reasonCode: null },
    {
      kind: "combined_hospice_rb",
      payerPolicy: "blocked",
      reasonCode: "MEDICAID_TPL_POLICY_UNVERIFIED",
    },
  ],
  rbArrangements: [
    {
      id: "22222222-8888-4888-8888-222222222222",
      facilityName: "Synthetic NF",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      billableDayCount: 0,
      status: "unresolved",
      reasonCode: "MEDICAID_LOC_PERIOD_READER_UNBOUND",
    },
  ],
  arrangementListStatus: "unavailable",
  medicareEvidence: {
    match: "not_applicable",
    evidenceStatus: null,
    rangeRelation: null,
    remittanceAdviceRecorded: null,
  },
  stateBillingPolicy: "not_applicable_to_primary_medicaid",
  programResponsibility: {
    status: "missing",
    programKind: "unresolved",
    canonicalPayerId: null,
    canonicalPayerName: null,
    reasonCode: "PROGRAM_ASSIGNMENT_MISSING",
  },
  payerAuthorizationEvidence: {
    clinicalDocuments: "missing",
    notification: "missing",
    authorization: "missing",
    policyQualification: "unqualified",
    reasonCodes: ["PAYER_AUTHORIZATION_POLICY_UNQUALIFIED"],
  },
  enrollmentReadiness: [],
  selectedClearinghouse: { status: "unavailable", vendor: null, configurationStatus: null },
  tradingPartnerCredential: { status: "missing", reasonCode: "TRADING_PARTNER_CREDENTIAL_MISSING" },
  pricing: {
    status: "unresolved",
    assessedAt: "2026-11-25T00:00:00.000Z",
    coversRequestedPeriod: true,
    requiredInputs: ["Clinical quantity evidence"],
    segments: [
      {
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
        serviceCategory: "RHC",
        serviceLocationKind: null,
        status: "unresolved",
        rateStatus: "missing",
        unitBasis: null,
        rateCents: null,
        rateLocalityCode: null,
        rateEffectiveFrom: null,
        rateEffectiveTo: null,
        rateSourceKind: null,
        rateEvidenceVersion: null,
        methodologyVersion: null,
        pricingMethod: null,
        quantityConversionMethod: null,
        minimumDurationMethod: null,
        minimumClinicalMinutes: null,
        roundingBoundary: null,
        chargeCeilingMethod: null,
        chargeCeilings: [],
        quantityStatus: "missing",
        baseReimbursementCents: null,
        reimbursementEstimateCents: null,
        actualBilledChargeCents: null,
        reasonCodes: ["RATE_LOCALITY_UNRESOLVED"],
      },
    ],
    reimbursementEstimateTotalCents: null,
    actualBilledChargeTotalCents: null,
    submissionAvailable: false,
  },
  electronicSubmissionAvailable: false,
  isAdvisorySnapshot: true,
};

// A single service day with a home CHC segment: the shape that mounts the local CHC preparation panel.
const CHC_PREVIEW = {
  ...BLOCKED_ARRANGEMENT_PREVIEW,
  pricing: {
    ...BLOCKED_ARRANGEMENT_PREVIEW.pricing,
    segments: [
      {
        ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-01",
        serviceCategory: "CHC",
        serviceLocationKind: "home",
      },
    ],
  },
};

const CURRENT_PREPARATION = {
  id: "44444444-8888-4888-8888-444444444444",
  preparationId: "55555555-8888-4888-8888-555555555555",
  version: 3,
  serviceDate: "2026-03-01",
  observedMinutes: 135,
  qualifiedMinutes: 120,
  reimbursementHours: 2,
  rateCentsPerHour: 4500,
  estimatedReimbursementCents: 9000,
  billedChargeCents: 12000,
  institutionalUnits: "unqualified",
  institutionalFormatQualified: false,
  verification: {
    status: "current",
    preparationId: "55555555-8888-4888-8888-555555555555",
    version: 3,
    fingerprint: "synthetic-fingerprint",
  },
};

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://localhost").pathname;
  paths.push(path);
  if (path === "/api/v1/medicaid-claims/assembly-preview" && previewRequestStatus >= 400) {
    return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), {
      status: previewRequestStatus,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/api/v1/medicaid-claims/assembly-preview") {
    if (holdPreviewResponse) {
      await new Promise<void>((resolve) => {
        releasePreviewResponse = resolve;
      });
    }
    return new Response(JSON.stringify(previewBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === CHC_PATH) {
    if (holdChcResponse) {
      await new Promise<void>((resolve) => {
        chcReleasers.push(resolve);
      });
    }
    // The answer is decided when the request is released, so a test can give each held request its own outcome.
    if (rejectChcFetch) {
      chcResponded += 1;
      throw new TypeError("synthetic network failure");
    }
    const response = new Response(JSON.stringify(chcBody), {
      status: chcStatus,
      headers: { "content-type": "application/json" },
    });
    chcResponded += 1;
    return response;
  }
  const body = path.endsWith("/admissions")
    ? {
        items: [
          {
            id: ADMISSION_A,
            state: "active",
            admissionAt: "2025-11-02T00:00:00.000Z",
            dischargedAt: null,
          },
        ],
        nextCursor: null,
      }
    : {
        items: [
          {
            id: PATIENT_A,
            lastName: "Vance",
            firstName: "Ada",
            mrn: "MRN-1",
            dob: "1948-03-02",
            status: "active",
          },
          {
            id: PATIENT_B,
            lastName: "Okonkwo",
            firstName: "Ben",
            mrn: "MRN-2",
            dob: "1950-07-11",
            status: "active",
          },
        ],
        nextCursor: null,
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["biller"],
  permissions: [],
  isAdmin: false,
};

function mount(): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <MedicaidAssemblyWizard />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const comboboxes = (): HTMLInputElement[] => screen.getAllByRole("combobox") as HTMLInputElement[];

async function pickFirstOption(input: HTMLInputElement): Promise<void> {
  fireEvent.focus(input);
  const options = await screen.findAllByRole("option");
  fireEvent.click(options[0] as HTMLElement);
}

beforeEach(() => {
  paths = [];
  previewRequestStatus = 200;
  holdPreviewResponse = false;
  releasePreviewResponse = null;
  previewBody = BLOCKED_ARRANGEMENT_PREVIEW;
  chcStatus = 200;
  chcBody = CURRENT_PREPARATION;
  holdChcResponse = false;
  chcReleasers = [];
  chcResponded = 0;
  rejectChcFetch = false;
});

afterEach(() => {
  // Unmount before resetting the shared claims-billing store so the reset does not update a mounted tree.
  cleanup();
  __resetClaimsBillingForTest();
});

describe("F-066 — the assembly wizard's admission belongs to the chosen patient", () => {
  it("does not offer an admission before a patient is chosen", () => {
    mount();
    const [, admission] = comboboxes();
    expect(admission?.disabled).toBe(true);
    expect(screen.getByText("Choose a patient first.")).toBeTruthy();
  });

  it("reads the chosen patient's admissions, not the org-wide census", async () => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission] = comboboxes();
    await waitFor(() => expect(admission?.disabled).toBe(false));
    fireEvent.focus(admission as HTMLInputElement);
    await waitFor(() => expect(paths).toContain(`/api/v1/patients/${PATIENT_A}/admissions`));
    expect(paths).not.toContain("/api/v1/admissions");
  });

  it("clears a selected admission when the patient changes — a stale uuid is still uuid-shaped", async () => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission] = comboboxes();
    await waitFor(() => expect(admission?.disabled).toBe(false));
    await pickFirstOption(admission as HTMLInputElement);
    await waitFor(() => expect((comboboxes()[1] as HTMLInputElement).value).not.toBe(""));

    // Switch to a different patient: the admission below it must not survive the change.
    fireEvent.focus(comboboxes()[0] as HTMLInputElement);
    const patientOptions = await screen.findAllByRole("option");
    fireEvent.click(patientOptions[1] as HTMLElement);
    await waitFor(() => expect((comboboxes()[1] as HTMLInputElement).value).toBe(""));
  });

  it("shows an assembly preview failure without making an eligibility determination", async () => {
    previewRequestStatus = 503;
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission, provider] = comboboxes();
    await pickFirstOption(provider as HTMLInputElement);
    await pickFirstOption(admission as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-31" } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(paths).toContain("/api/v1/medicaid-claims/assembly-preview"));

    expect(
      await screen.findByText(
        /The billing preview could not be loaded\. No eligibility or payer conclusion was made/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/No check recorded for this Medicaid coverage/)).toBeNull();
    expect(paths).toContain("/api/v1/medicaid-claims/assembly-preview");
  });

  it("does not issue duplicate preview reads while the first request is pending", async () => {
    holdPreviewResponse = true;
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission, provider] = comboboxes();
    await pickFirstOption(provider as HTMLInputElement);
    await pickFirstOption(admission as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-31" } });

    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(
        paths.filter((path) => path === "/api/v1/medicaid-claims/assembly-preview"),
      ).toHaveLength(1),
    );
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(
      paths.filter((path) => path === "/api/v1/medicaid-claims/assembly-preview"),
    ).toHaveLength(1);

    holdPreviewResponse = false;
    releasePreviewResponse?.();
    expect(await screen.findByText("Server preview loaded for this service window.")).toBeTruthy();
  });

  it("explains unresolved Room & Board candidates and non-applicable Medicare evidence", async () => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission, provider] = comboboxes();
    await pickFirstOption(provider as HTMLInputElement);
    await pickFirstOption(admission as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Server preview loaded for this service window.");
    fireEvent.change(screen.getByLabelText("Claim kind"), { target: { value: "rb_only" } });

    expect(await screen.findByText(/Room & Board candidates could not be determined/)).toBeTruthy();
    expect(screen.getAllByText(/level-of-care records are unavailable/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Claim kind"), {
      target: { value: "hospice_only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Not applicable for the recorded primary payer")).toBeTruthy();
  });
});

// The billing-context step renders the program, clearinghouse and enrollment sections the preview now carries.
async function continueToBillingContext(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Server preview loaded for this service window.");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Coverage and coordination");
}

async function reachBillingContext(serviceTo = "2026-03-31"): Promise<void> {
  mount();
  const [patient] = comboboxes();
  await pickFirstOption(patient as HTMLInputElement);
  const [, admission, provider] = comboboxes();
  await pickFirstOption(provider as HTMLInputElement);
  await pickFirstOption(admission as HTMLInputElement);
  fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-03-01" } });
  fireEvent.change(screen.getByLabelText("Service to"), { target: { value: serviceTo } });
  await continueToBillingContext();
}

const fieldValue = (label: string): string | null | undefined =>
  screen.getByText(label).nextElementSibling?.textContent;

describe("the billing context step shows what the server resolved", () => {
  it("states an unresolved program, clearinghouse and trading-partner credential as unresolved", async () => {
    await reachBillingContext();
    expect(fieldValue("Medicaid program and payer")).toBe("Missing · Program assignment missing");
    expect(fieldValue("Selected clearinghouse")).toBe("Unavailable");
    expect(fieldValue("Trading-partner credential configuration")).toBe(
      "Missing · Trading partner credential missing; configuration is not payer enrollment",
    );
    expect(screen.queryByText("Era enrollment")).toBeNull();
  });

  it("shows a verified program assignment, the selected clearinghouse and each enrollment row", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      programResponsibility: {
        status: "verified",
        programKind: "managed_care",
        canonicalPayerId: "33333333-8888-4888-8888-333333333333",
        canonicalPayerName: "Synthetic Oregon Medicaid",
        reasonCode: "PROGRAM_ASSIGNMENT_VERIFIED",
      },
      selectedClearinghouse: {
        status: "selected",
        vendor: "claimmd",
        configurationStatus: "ready",
      },
      enrollmentReadiness: [
        {
          kind: "era_enrollment",
          status: "pending",
          reasonCode: "ENROLLMENT_EVIDENCE_PENDING",
          vendorPayerId: "VP-SYN-1",
        },
        { kind: "claim_enrollment", status: "missing", reasonCode: "ENROLLMENT_EVIDENCE_MISSING" },
      ],
    };
    await reachBillingContext();
    expect(fieldValue("Medicaid program and payer")).toBe(
      "Managed care · Synthetic Oregon Medicaid; verified assignment covers this service range",
    );
    expect(fieldValue("Selected clearinghouse")).toBe("claimmd · Ready");
    expect(fieldValue("Era enrollment")).toBe(
      "Pending · Enrollment evidence pending · vendor payer ID VP-SYN-1",
    );
    expect(fieldValue("Claim enrollment")).toBe("Missing · Enrollment evidence missing");
  });

  it("shows missing pricing inputs next to the unqualified payer policy they depend on", async () => {
    await reachBillingContext();
    expect(fieldValue("Payer authorization evidence")).toContain("Unqualified payer policy");
    expect(fieldValue("Clinical quantity")).toContain("Clinical quantity missing or unqualified");
    expect(screen.getByRole("region", { name: "Pricing assessment" })).toHaveTextContent(
      "No complete reimbursement estimate is available. Missing facts are not shown as a zero amount.",
    );
    expect(fieldValue("Electronic submission")).toContain("Unavailable");
  });

  it("shows a synthetic reimbursement estimate separately from the billed charge and submission state", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      pricing: {
        ...BLOCKED_ARRANGEMENT_PREVIEW.pricing,
        status: "fully_resolved",
        requiredInputs: [],
        segments: [
          {
            ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
            serviceLocationKind: "facility",
            status: "resolved",
            rateStatus: "qualified",
            unitBasis: "per_day",
            rateCents: 1200,
            rateLocalityCode: "SYNTHETIC-LOCALITY",
            rateEffectiveFrom: "2026-01-01",
            rateSourceKind: "cco_contract",
            rateEvidenceVersion: 1,
            methodologyVersion: 1,
            pricingMethod: "per_day",
            quantityConversionMethod: "daily_units",
            minimumDurationMethod: "not_applicable",
            minimumClinicalMinutes: null,
            roundingBoundary: "not_applicable",
            chargeCeilingMethod: "none",
            quantityStatus: "verified",
            baseReimbursementCents: 1200,
            reimbursementEstimateCents: 1200,
            reasonCodes: [],
          },
        ],
        reimbursementEstimateTotalCents: 1200,
      },
    };
    await reachBillingContext();
    const pricing = screen.getByRole("region", { name: "Pricing assessment" });
    expect(pricing).toHaveTextContent("Facility-based RHC");
    expect(pricing).toHaveTextContent("Estimated reimbursement: $12.00");
    expect(pricing).toHaveTextContent("locality SYNTHETIC-LOCALITY");
    // Acronyms render as written, not as humanized wire enums ("Rhc", "Cco contract").
    expect(pricing).toHaveTextContent("RHC · 2026-01-01");
    expect(pricing).toHaveTextContent("CCO contract");
    expect(pricing).not.toHaveTextContent("Rhc");
    expect(pricing).not.toHaveTextContent("Cco contract");
    expect(fieldValue("Clinical quantity")).toContain(
      "Verified quantity evidence is present for the reimbursement estimate",
    );
    expect(pricing).toHaveTextContent(
      "not the provider's billed charge, payer-allowed amount, or payment",
    );
    // The static line must not contradict a separately sourced billed charge the panel can show.
    expect(pricing).toHaveTextContent(
      "Any billed charge shown here comes from separately sourced evidence, not from a claim",
    );
    expect(pricing).not.toHaveTextContent("remains unavailable");
    expect(fieldValue("Electronic submission")).toContain("Unavailable");
  });

  it("explains election-bucket segmentation and the IRC episode day range", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      pricing: {
        ...BLOCKED_ARRANGEMENT_PREVIEW.pricing,
        status: "fully_resolved",
        requiredInputs: [],
        segments: [
          {
            ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
            serviceFrom: "2026-02-27",
            serviceTo: "2026-03-01",
            serviceCategory: "RHC",
            status: "resolved",
            rateStatus: "qualified",
            unitBasis: "per_day",
            rateCents: 1200,
            rateSourceKind: "cco_contract",
            rateEffectiveFrom: "2026-01-01",
            rateEvidenceVersion: 1,
            methodologyVersion: 1,
            quantityStatus: "verified",
            baseReimbursementCents: 3600,
            reimbursementEstimateCents: 3600,
            electionDayRange: {
              basis: "current_signed_election_calendar_days_v1",
              dayFrom: 58,
              dayTo: 60,
              rateBucketFrom: 1,
              rateBucketTo: 60,
            },
          },
          {
            ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
            serviceFrom: "2026-12-01",
            serviceTo: "2026-12-03",
            serviceCategory: "IRC",
            serviceLocationKind: "facility",
            status: "resolved",
            rateStatus: "qualified",
            unitBasis: "per_day",
            rateCents: 22000,
            rateSourceKind: "cco_contract",
            rateEffectiveFrom: "2026-11-01",
            rateEvidenceVersion: 1,
            methodologyVersion: 1,
            quantityStatus: "verified",
            baseReimbursementCents: 66000,
            reimbursementEstimateCents: 66000,
            ircEpisodeDayRange: {
              episodeStartDate: "2026-11-29",
              dayFrom: 3,
              dayTo: 5,
            },
          },
        ],
      },
    };
    await reachBillingContext("2026-12-03");
    const pricing = screen.getByRole("region", { name: "Pricing assessment" });
    expect(pricing).toHaveTextContent(
      "Election days 58–60; rate bucket 1–60. The line is split where the verified election-day bucket changes.",
    );
    expect(pricing).toHaveTextContent(
      "Respite episode began 2026-11-29; this claim segment covers episode days 3–5. Local pricing only; institutional format is unqualified.",
    );
    expect(fieldValue("Electronic submission")).toContain("Unavailable");
  });

  it("does not label a facility span 'Facility-based RHC' when it cannot be priced, and says why", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      pricing: {
        ...BLOCKED_ARRANGEMENT_PREVIEW.pricing,
        status: "unsupported",
        requiredInputs: [
          "Only an assisted-living facility is priced locally; this M5 residence is another facility kind and needs a reviewed pricing profile",
        ],
        segments: [
          {
            ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
            serviceCategory: "RHC",
            serviceLocationKind: "facility",
            status: "unsupported",
            rateStatus: "unsupported",
            reasonCodes: ["RHC_Q5002_REQUIRES_ASSISTED_LIVING"],
          },
        ],
      },
    };
    await reachBillingContext();
    const pricing = screen.getByRole("region", { name: "Pricing assessment" });
    expect(pricing).not.toHaveTextContent("Facility-based RHC");
    expect(pricing).toHaveTextContent("This service span cannot be priced locally.");
    expect(pricing).toHaveTextContent(
      "The recorded facility is not an assisted-living facility, the only facility kind priced locally.",
    );
    expect(pricing).not.toHaveTextContent("Rhc q5002");
    expect(pricing).not.toHaveTextContent("No exact qualified rate");
  });
});

describe("an ambiguous or unsupported pricing outcome is shown as such", () => {
  it("shows conflicting rate evidence for an ambiguous segment and no verified quantity", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      pricing: {
        ...BLOCKED_ARRANGEMENT_PREVIEW.pricing,
        status: "ambiguous",
        coversRequestedPeriod: false,
        segments: [
          {
            ...BLOCKED_ARRANGEMENT_PREVIEW.pricing.segments[0],
            status: "ambiguous",
            rateStatus: "ambiguous",
            quantityStatus: "unverified",
          },
        ],
      },
    };
    await reachBillingContext();
    const pricing = screen.getByRole("region", { name: "Pricing assessment" });
    expect(pricing).toHaveTextContent("Pricing assessment · Ambiguous");
    expect(pricing).toHaveTextContent("Conflicting rate evidence requires resolution.");
    expect(fieldValue("Clinical quantity")).toContain("Clinical quantity evidence is unverified");
    expect(fieldValue("Clinical quantity")).not.toContain("Verified quantity evidence is present");
  });
});

describe("a preview this bundle cannot trust fails closed instead of throwing", () => {
  const withoutSection = (section: string) => {
    const { [section]: _omitted, ...rest } = BLOCKED_ARRANGEMENT_PREVIEW as Record<string, unknown>;
    return rest;
  };
  const continueToPreview = async (): Promise<void> => {
    mount();
    const [patient] = comboboxes();
    await pickFirstOption(patient as HTMLInputElement);
    const [, admission, provider] = comboboxes();
    await pickFirstOption(provider as HTMLInputElement);
    await pickFirstOption(admission as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Service from"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  };

  it.each([
    ["programResponsibility"],
    ["selectedClearinghouse"],
    ["payerAuthorizationEvidence"],
    ["enrollmentReadiness"],
  ])("rejects an older backend preview that has no %s", async (section) => {
    previewBody = withoutSection(section);
    await continueToPreview();
    expect(
      await screen.findByText(
        /The billing preview could not be loaded\. No eligibility or payer conclusion was made/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Server preview loaded for this service window.")).toBeNull();
  });

  it("rejects a preview that does not state electronic submission is unavailable", async () => {
    previewBody = { ...BLOCKED_ARRANGEMENT_PREVIEW, electronicSubmissionAvailable: true };
    await continueToPreview();
    expect(await screen.findByText(/The billing preview could not be loaded\./)).toBeTruthy();
  });

  it("rejects a preview whose payer policy is no longer unqualified", async () => {
    previewBody = {
      ...BLOCKED_ARRANGEMENT_PREVIEW,
      payerAuthorizationEvidence: {
        ...BLOCKED_ARRANGEMENT_PREVIEW.payerAuthorizationEvidence,
        policyQualification: "qualified",
      },
    };
    await continueToPreview();
    expect(await screen.findByText(/The billing preview could not be loaded\./)).toBeTruthy();
  });
});

describe("the local CHC pricing preparation panel", () => {
  const AMOUNT = /\$\d/;
  const GENERIC_FAILURE =
    "Local CHC pricing could not be prepared. Confirm the day's clinical and pricing evidence. If it persists, contact support. No claim was created.";
  const chcPanel = (): HTMLElement =>
    screen.getByRole("region", { name: "Local CHC pricing preparation" });
  // The panel's own status line: the loading button carries a second spinner <output>, so it is not the only one.
  const chcLive = (): HTMLElement => {
    const live = Array.from(chcPanel().children).find((child) => child.tagName === "OUTPUT");
    if (!live) throw new Error("the CHC panel has no always-mounted status region");
    return live as HTMLElement;
  };
  const chcField = (label: string): string | null | undefined =>
    within(chcPanel()).getByText(label).nextElementSibling?.textContent;
  const prepareButton = (): HTMLButtonElement =>
    within(chcPanel()).getByRole("button", {
      name: /Prepare local CHC pricing|Checking evidence/,
    }) as HTMLButtonElement;
  const click = (name: "Back" | "Continue"): void => {
    fireEvent.click(screen.getByRole("button", { name }));
  };
  const reachChcPanel = async (): Promise<void> => {
    previewBody = CHC_PREVIEW;
    await reachBillingContext("2026-03-01");
  };
  const requests = (): number => paths.filter((path) => path === CHC_PATH).length;
  /** Several macrotask turns inside act: the client's own handling of an answer needs more than one microtask. */
  const flushClient = async (): Promise<void> => {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const waitForHeldRequests = async (count: number): Promise<void> => {
    await waitFor(() => expect(chcReleasers).toHaveLength(count));
  };
  /** Release the nth held request, wait until the stub has answered it, then let the client finish handling it. */
  const releaseChc = async (index: number): Promise<void> => {
    const release = chcReleasers[index];
    if (!release) throw new Error(`CHC request ${index} was never held`);
    const answeredBefore = chcResponded;
    release();
    await waitFor(() => expect(chcResponded).toBe(answeredBefore + 1));
    await flushClient();
  };

  it("shows a current preparation's whole-hour minutes, rate, estimate and separately sourced charge, not as a claim", async () => {
    await reachChcPanel();
    fireEvent.click(prepareButton());
    await within(chcPanel()).findByText("Qualified clinical minutes");

    expect(requests()).toBe(1);
    expect(chcField("Local preparation")).toBe("Current when prepared · version 3 · 2026-03-01");
    expect(chcField("Prepared at")).toMatch(/ · this browser's clock when the response arrived$/);
    expect(chcField("Observed clinical minutes")).toBe("135");
    expect(chcField("Qualified clinical minutes")).toBe("120");
    expect(chcField("Reimbursement quantity")).toBe(
      "2 local hourly units; not institutional units",
    );
    expect(chcField("Hourly reimbursement rate")).toBe("$45.00 per hour");
    expect(chcField("Estimated reimbursement")).toBe("$90.00 · estimate only");
    expect(chcField("Independently sourced billed charges")).toBe(
      "$120.00 · separate from reimbursement; not a claim amount",
    );
    expect(chcField("Institutional qualification")).toContain("Unqualified");
    expect(chcPanel()).toHaveTextContent("This stores a local preparation, not a claim");
    expect(chcLive()).toHaveTextContent(
      "Local CHC pricing prepared. The figures below were current when prepared and are not re-verified on this screen.",
    );
    expect(within(chcPanel()).queryByRole("alert")).toBeNull();
    expect(chcPanel()).toHaveTextContent("Continuous home care · local pricing preparation");
  });

  it("shows a figure the server left null as unavailable rather than as zero", async () => {
    chcBody = { ...CURRENT_PREPARATION, estimatedReimbursementCents: null };
    await reachChcPanel();
    fireEvent.click(prepareButton());
    await within(chcPanel()).findByText("Qualified clinical minutes");

    expect(chcField("Estimated reimbursement")).toBe("Unavailable");
    expect(chcField("Hourly reimbursement rate")).toBe("$45.00 per hour");
  });

  it("states the whole-hour limit in the static help text before anything is prepared", async () => {
    await reachChcPanel();
    expect(chcPanel()).toHaveTextContent(
      "Only a day whose qualified clinical minutes are a whole number of hours is priced locally.",
    );
    expect(requests()).toBe(0);
    expect(chcLive().textContent).toBe("");
  });

  it("explains a partial-hour refusal as a whole-hour limit and shows no amounts", async () => {
    chcStatus = 409;
    chcBody = {
      error: { code: "CHC_LOCAL_HOURLY_CHARGE_QUANTITY_UNSUPPORTED", message: "synthetic" },
    };
    await reachChcPanel();
    fireEvent.click(prepareButton());

    const alert = await within(chcPanel()).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Local CHC pricing could not be prepared. The day's qualified clinical minutes are not a whole number of hours, and only whole hours are priced locally. No claim was created.",
    );
    expect(alert).not.toHaveTextContent("financial record");
    expect(chcPanel()).not.toHaveTextContent(AMOUNT);
    expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
    expect(prepareButton().disabled).toBe(false);
  });

  it.each([
    [
      "CHC_LOC_MISSING",
      409,
      "No continuous home care level of care is recorded for this service day.",
    ],
    ["CHC_PROVIDER_SCOPE_DENIED", 409, "The selected provider entity is outside your access."],
    [
      "MEDICAID_RATE_POLICY_UNRESOLVED",
      409,
      "No verified hourly rate evidence covers this service day.",
    ],
    [
      "CHC_CLINICAL_INDICATION_UNQUALIFIED",
      409,
      "The day's level of care is not continuous home care for a symptom crisis, or has no assigning clinician.",
    ],
    [
      "CHC_BILLED_CHARGE_OUT_OF_RANGE",
      409,
      "The billed charge computed for this day is zero or larger than can be stored.",
    ],
    [
      "CHC_SERVICE_TIMEZONE_UNRESOLVED",
      409,
      "The service location's time zone is missing or inconsistent, so the local service day cannot be determined.",
    ],
    [
      "CHC_SERVICE_TIMEZONE_INVALID",
      409,
      "The service location's time zone is not valid, so the local service day cannot be determined.",
    ],
    [
      "CHC_ADMISSION_IDENTITY_MISMATCH",
      409,
      "The admission does not belong to the selected patient and provider entity.",
    ],
    [
      "CHC_ADMISSION_NOT_ACTIVE",
      409,
      "The admission is not active, so this day is not priced locally.",
    ],
    [
      "CHC_ACTOR_MEMBERSHIP_REQUIRED",
      403,
      "Your session has no organization membership, and a preparation is recorded against one.",
    ],
  ])("maps the refusal code %s (HTTP %i) to its own guidance", async (code, status, guidance) => {
    chcStatus = status;
    chcBody = { error: { code } };
    await reachChcPanel();
    fireEvent.click(prepareButton());

    const alert = await within(chcPanel()).findByRole("alert");
    expect(alert).toHaveTextContent(
      `Local CHC pricing could not be prepared. ${guidance} No claim was created.`,
    );
    expect(alert).not.toHaveTextContent("whole number of hours");
    expect(alert).not.toHaveTextContent(code);
  });

  // `constructor` is an inherited property: an `in` lookup would find it and print a function's source.
  it.each([["SOME_FUTURE_CODE"], ["constructor"]])(
    "falls back to generic guidance for the unknown refusal code %s",
    async (code) => {
      chcStatus = 409;
      chcBody = { error: { code } };
      await reachChcPanel();
      fireEvent.click(prepareButton());

      const alert = await within(chcPanel()).findByRole("alert");
      expect(alert).toHaveTextContent(GENERIC_FAILURE);
      expect(alert).not.toHaveTextContent("whole number of hours");
      expect(alert).not.toHaveTextContent(code);
      expect(alert).not.toHaveTextContent("function");
    },
  );

  it("shows the generic message and frees the button when the request itself fails", async () => {
    rejectChcFetch = true;
    await reachChcPanel();
    fireEvent.click(prepareButton());

    const alert = await within(chcPanel()).findByRole("alert");
    expect(alert).toHaveTextContent(GENERIC_FAILURE);
    expect(alert).not.toHaveTextContent("synthetic network failure");
    expect(chcPanel()).not.toHaveTextContent(AMOUNT);
    await waitFor(() => expect(prepareButton().disabled).toBe(false));
    expect(prepareButton()).toHaveTextContent("Prepare local CHC pricing");
  });

  it("withholds every amount from a non-current verification, even when the server sent them", async () => {
    chcBody = {
      ...CURRENT_PREPARATION,
      verification: { status: "stale", reasonCode: "CHC_PRICING_SNAPSHOT_STALE" },
    };
    await reachChcPanel();
    fireEvent.click(prepareButton());

    await waitFor(() => expect(chcLive()).toHaveTextContent("Pricing evidence requires review."));
    expect(chcLive()).toHaveTextContent(
      "The prepared pricing no longer matches the current evidence.",
    );
    expect(chcLive()).toHaveTextContent(
      "Stored amounts are withheld until current evidence is verified.",
    );
    expect(chcPanel()).not.toHaveTextContent(AMOUNT);
    expect(chcPanel()).not.toHaveTextContent("Chc");
    expect(within(chcPanel()).queryByText("Estimated reimbursement")).toBeNull();
    expect(within(chcPanel()).queryByText("Prepared at")).toBeNull();
  });

  it.each([["stale"], ["unresolved"], ["ambiguous"], ["unsupported"]])(
    "renders no amount and no raw code for a %s verification with an unknown reason",
    async (status) => {
      chcBody = {
        ...CURRENT_PREPARATION,
        verification: { status, reasonCode: "CHC_REASON_FROM_A_NEWER_SERVER" },
      };
      await reachChcPanel();
      fireEvent.click(prepareButton());

      await waitFor(() => expect(chcLive()).toHaveTextContent("Pricing evidence requires review."));
      expect(chcLive()).toHaveTextContent(
        "Confirm the day's clinical and pricing evidence. If it persists, contact support.",
      );
      expect(chcPanel()).not.toHaveTextContent(AMOUNT);
      expect(chcPanel()).not.toHaveTextContent("Chc");
      expect(chcPanel()).not.toHaveTextContent("CHC_REASON_FROM_A_NEWER_SERVER");
    },
  );

  describe("a response this bundle cannot trust is reported as unreadable, never rendered", () => {
    const NUMERIC_KEYS = [
      "observedMinutes",
      "qualifiedMinutes",
      "reimbursementHours",
      "rateCentsPerHour",
      "estimatedReimbursementCents",
      "billedChargeCents",
    ] as const;
    const UNREADABLE: ReadonlyArray<readonly [string, unknown]> = [
      ...NUMERIC_KEYS.flatMap((key) => [
        [`${key} that is not a number`, { ...CURRENT_PREPARATION, [key]: "oops" }] as const,
        [`a negative ${key}`, { ...CURRENT_PREPARATION, [key]: -1 }] as const,
      ]),
      [
        "institutional units no longer unqualified",
        { ...CURRENT_PREPARATION, institutionalUnits: "qualified" },
      ],
      [
        "an institutional format that is qualified",
        { ...CURRENT_PREPARATION, institutionalFormatQualified: true },
      ],
      ["no verification block", { ...CURRENT_PREPARATION, verification: undefined }],
      ["no id", { ...CURRENT_PREPARATION, id: undefined }],
      ["a non-string preparationId", { ...CURRENT_PREPARATION, preparationId: 7 }],
      [
        "a verification that names another preparation",
        {
          ...CURRENT_PREPARATION,
          verification: { ...CURRENT_PREPARATION.verification, preparationId: "another" },
        },
      ],
      [
        "a verification that names another version",
        {
          ...CURRENT_PREPARATION,
          verification: { ...CURRENT_PREPARATION.verification, version: 2 },
        },
      ],
      [
        "a verification with no fingerprint",
        {
          ...CURRENT_PREPARATION,
          verification: { ...CURRENT_PREPARATION.verification, fingerprint: undefined },
        },
      ],
      ["a service date that is not ISO", { ...CURRENT_PREPARATION, serviceDate: "03/01/2026" }],
      ["a service date that is not a string", { ...CURRENT_PREPARATION, serviceDate: 20260301 }],
      [
        "a version that is not a number",
        {
          ...CURRENT_PREPARATION,
          version: "3",
          verification: { ...CURRENT_PREPARATION.verification, version: "3" },
        },
      ],
      [
        "a non-current verification with no reason",
        { ...CURRENT_PREPARATION, verification: { status: "stale" } },
      ],
      [
        "a non-current verification whose reason is not a string",
        { ...CURRENT_PREPARATION, verification: { status: "stale", reasonCode: 5 } },
      ],
      [
        "an unknown verification status",
        { ...CURRENT_PREPARATION, verification: { status: "pending", reasonCode: "CHC_X" } },
      ],
    ];

    it.each(UNREADABLE)("for %s", async (_name, body) => {
      chcBody = body;
      await reachChcPanel();
      fireEvent.click(prepareButton());

      const alert = await within(chcPanel()).findByRole("alert");
      expect(alert).toHaveTextContent(
        "The local CHC pricing response could not be read. Reload the preview and try again. No claim was created.",
      );
      expect(chcPanel()).not.toHaveTextContent("NaN");
      expect(chcPanel()).not.toHaveTextContent("-1");
      expect(chcPanel()).not.toHaveTextContent(AMOUNT);
      expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
      expect(within(chcPanel()).queryByText("Prepared at")).toBeNull();
    });
  });

  // Each outcome is decided when the held request is released, so the same fixtures drive the abandoned request A.
  const ABANDONED_OUTCOMES = [
    ["a preparation", { status: 200, body: CURRENT_PREPARATION, reject: false }],
    ["a refusal", { status: 409, body: { error: { code: "CHC_LOC_MISSING" } }, reject: false }],
    ["a network failure", { status: 200, body: CURRENT_PREPARATION, reject: true }],
  ] as const;

  it.each(ABANDONED_OUTCOMES)(
    "ignores %s that lands after the preview was changed and reloaded",
    async (_name, outcome) => {
      chcStatus = outcome.status;
      chcBody = outcome.body;
      rejectChcFetch = outcome.reject;
      holdChcResponse = true;
      await reachChcPanel();
      fireEvent.click(prepareButton());
      await waitForHeldRequests(1);
      expect(prepareButton().disabled).toBe(true);

      // Back to the first step, edit the range and restore it: the same inputs, a different preview.
      click("Back");
      click("Back");
      fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-02" } });
      fireEvent.change(screen.getByLabelText("Service to"), { target: { value: "2026-03-01" } });
      await continueToBillingContext();
      await releaseChc(0);

      expect(requests()).toBe(1);
      expect(chcPanel()).not.toHaveTextContent("Current when prepared");
      expect(chcPanel()).not.toHaveTextContent(AMOUNT);
      expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
      expect(within(chcPanel()).queryByRole("alert")).toBeNull();
      expect(chcLive().textContent).toBe("");
      // The busy state belonged to the abandoned request: a fresh one can start.
      expect(prepareButton().disabled).toBe(false);
      expect(prepareButton()).toHaveTextContent("Prepare local CHC pricing");
    },
  );

  it.each(ABANDONED_OUTCOMES)(
    "keeps the button busy until the current request lands when an abandoned one returns %s first",
    async (_name, outcome) => {
      holdChcResponse = true;
      await reachChcPanel();
      fireEvent.click(prepareButton()); // request A
      await waitForHeldRequests(1);

      // Back and forward on the same preview: the panel is empty and idle again, so request B can start.
      click("Back");
      click("Continue");
      await screen.findByText("Coverage and coordination");
      expect(prepareButton().disabled).toBe(false);
      fireEvent.click(prepareButton()); // request B
      await waitForHeldRequests(2);

      // A lands while B is still in flight: nothing from A may show, and the button must stay busy.
      chcStatus = outcome.status;
      chcBody = outcome.body;
      rejectChcFetch = outcome.reject;
      await releaseChc(0);
      rejectChcFetch = false;
      expect(prepareButton().disabled).toBe(true);
      expect(prepareButton()).toHaveTextContent("Checking evidence");
      expect(chcLive()).toHaveTextContent("Checking evidence…");
      expect(within(chcPanel()).queryByRole("alert")).toBeNull();
      expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
      fireEvent.click(prepareButton());
      await flushClient();
      expect(requests()).toBe(2);

      chcStatus = 200;
      chcBody = CURRENT_PREPARATION;
      await releaseChc(1);
      expect(chcField("Qualified clinical minutes")).toBe("120");
      expect(within(chcPanel()).queryByRole("alert")).toBeNull();
      expect(prepareButton().disabled).toBe(false);
      expect(requests()).toBe(2);
    },
  );

  it("clears a prepared result when the preview is reloaded", async () => {
    await reachChcPanel();
    fireEvent.click(prepareButton());
    await within(chcPanel()).findByText("Qualified clinical minutes");

    click("Back");
    click("Back");
    await continueToBillingContext();

    expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
    expect(chcPanel()).not.toHaveTextContent(AMOUNT);
    expect(chcLive().textContent).toBe("");
    expect(requests()).toBe(1);
  });

  it("clears a prepared result on Back, so it is not read as live when the step is revisited", async () => {
    await reachChcPanel();
    fireEvent.click(prepareButton());
    await within(chcPanel()).findByText("Qualified clinical minutes");

    click("Back");
    click("Continue");
    await screen.findByText("Coverage and coordination");

    expect(within(chcPanel()).queryByText("Qualified clinical minutes")).toBeNull();
    expect(chcPanel()).not.toHaveTextContent("Current when prepared");
    expect(chcLive().textContent).toBe("");
  });

  it("clears a refusal on Back as well", async () => {
    chcStatus = 409;
    chcBody = { error: { code: "CHC_LOC_MISSING" } };
    await reachChcPanel();
    fireEvent.click(prepareButton());
    await within(chcPanel()).findByRole("alert");

    click("Back");
    click("Continue");
    await screen.findByText("Coverage and coordination");

    expect(within(chcPanel()).queryByRole("alert")).toBeNull();
  });

  it("disables the prepare button and sends no request while claims billing is paused", async () => {
    noteClaimsBillingRefusal({
      error: { code: "CLAIMS_BILLING_ADDON_REQUIRED", details: [{ code: "lapsed" }] },
    });
    await reachChcPanel();

    expect(screen.getByText(/claims-billing add-on has ended/)).toBeTruthy();
    const button = prepareButton();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await flushClient();
    expect(requests()).toBe(0);
    expect(chcPanel()).not.toHaveTextContent(AMOUNT);
  });
});
