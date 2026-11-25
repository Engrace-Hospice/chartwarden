import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — F-066 (#161): the assembly wizard's admission.
//
// The wizard asked a billing clerk to TYPE a uuid (`useState("")` rendered as a raw text input), then
// later offered a lookup that spanned the whole organization. Both shapes let the wrong admission onto
// a Medicaid claim, and `step1Valid` only ever checked that the value was uuid-SHAPED — so a stale id
// left over from a previously selected patient passed every client-side check. The server re-derives
// and would refuse, but a wizard that lets a clerk get to "Assemble draft" has already made the error.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
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
async function reachBillingContext(): Promise<void> {
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
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Coverage and coordination");
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
    expect(pricing).toHaveTextContent("Estimated reimbursement: $12.00");
    expect(pricing).toHaveTextContent("locality SYNTHETIC-LOCALITY");
    expect(fieldValue("Clinical quantity")).toContain(
      "Verified quantity evidence is present for the reimbursement estimate",
    );
    expect(pricing).toHaveTextContent(
      "not the provider's billed charge, payer-allowed amount, or payment",
    );
    expect(pricing).toHaveTextContent("actual billed amount remains unavailable");
    expect(fieldValue("Electronic submission")).toContain("Unavailable");
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
