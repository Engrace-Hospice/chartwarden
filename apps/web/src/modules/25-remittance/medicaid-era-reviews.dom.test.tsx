import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { parseMedicaidEraSummary } from "./medicaid-era-presentation";
import { MedicaidEraReviews } from "./medicaid-era-reviews";

const REVIEW = "30000000-0000-4000-8000-000000000003";
const PROVIDER = "40000000-0000-4000-8000-000000000004";
const CLAIM = "50000000-0000-4000-8000-000000000005";
const PAYER = "60000000-0000-4000-8000-000000000006";
const ORG = "10000000-0000-4000-8000-000000000001";

const observation = (overrides: Record<string, unknown> = {}) => ({
  decision: "partial_payment",
  reasonCode: "PARTIAL_PAYMENT_REVIEW",
  matchStatus: "MATCHED",
  matchedClaim: {
    claimId: CLAIM,
    submissionId: "70000000-0000-4000-8000-000000000007",
    claimVersion: 3,
  },
  attribution: { status: "verified" },
  evidenceReferences: ["synthetic-evidence-reference"],
  amounts: {
    claimChargeCents: 50000,
    claimPaidCents: 25000,
    patientResponsibilityCents: null,
    providerAdjustmentCents: null,
    reportedPaymentCents: 25000,
  },
  providerAdjustments: [],
  claimAdjustments: [{ groupCode: "CO", reasonCode: "45", amountCents: 25000, quantity: null }],
  serviceLineAdjustments: [],
  remarks: [],
  unresolvedRequirements: ["PAYER_SPECIFIC_ADJUDICATION_POLICY_UNQUALIFIED"],
  postingAuthorized: false,
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  id: REVIEW,
  organizationId: ORG,
  providerEntityId: PROVIDER,
  assessmentTrustStatus: "isolated_evaluator",
  assessmentSemantics: "point_in_time_nonposting",
  assessmentObservedAt: "2026-11-23T12:30:00.000Z",
  vendor: "claimmd",
  accountReference: "synthetic-account-reference",
  sourceEnvironment: "test",
  sourceDigest: "a".repeat(64),
  canonicalPayerId: PAYER,
  programId: "OR_FFS_SYNTHETIC",
  assessmentVersion: "l6d-v2",
  decisionStatus: "review_required",
  reasonCodes: ["PARTIAL_PAYMENT_REVIEW"],
  claimMatchStatus: "MATCHED",
  duplicateStatus: "none",
  safeSummary: { transactionSetCount: 1, claims: [observation()] },
  workflowState: "investigating",
  version: 4,
  createdAt: "2026-11-23T12:30:00.000Z",
  updatedAt: "2026-11-23T12:30:00.000Z",
  ...overrides,
});

const historyItem = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  action: "assessed",
  reasonCode: "PAYMENT_REPORTED_REQUIRES_REVIEW",
  actorMembershipId: "80000000-0000-4000-8000-000000000008",
  trustStatus: "isolated_evaluator",
  createdAt: "2026-11-23T12:30:00.000Z",
  ...overrides,
});

const row = {
  id: REVIEW,
  providerEntityId: PROVIDER,
  assessmentTrustStatus: "isolated_evaluator",
  assessmentSemantics: "point_in_time_nonposting",
  assessmentObservedAt: "2026-11-23T12:30:00.000Z",
  vendor: "claimmd",
  sourceEnvironment: "test",
  canonicalPayerId: PAYER,
  programId: "OR_FFS_SYNTHETIC",
  decisionStatus: "review_required",
  reasonCodes: ["PARTIAL_PAYMENT_REVIEW"],
  claimMatchStatus: "MATCHED",
  duplicateStatus: "none",
  workflowState: "investigating",
  version: 4,
  createdAt: "2026-11-23T12:30:00.000Z",
};
let worklistRows: Record<string, unknown>[] = [row];

type RequestCall = { method: string; path: string; body: unknown; idempotencyKey: string | null };
const calls: RequestCall[] = [];
let detailResponse: ReturnType<typeof detail> | Record<string, unknown> = detail();
let historyResponse: { items: ReturnType<typeof historyItem>[] } = { items: [historyItem()] };
let noteStatus = 200;
let dispositionStatus = 200;
let reassessResponse: unknown = {
  status: "review_saved",
  reviewId: REVIEW,
  version: 5,
  replay: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fetchStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body =
    request.method === "POST"
      ? await request
          .clone()
          .json()
          .catch(() => null)
      : null;
  calls.push({
    method: request.method,
    path: url.pathname,
    body,
    idempotencyKey: request.headers.get("Idempotency-Key"),
  });
  if (url.pathname === "/api/v1/remittance/medicaid-era-reviews" && request.method === "GET")
    return json(200, { items: worklistRows, nextCursor: null });
  if (url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/history`)
    return json(200, historyResponse);
  if (url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}`)
    return json(200, detailResponse);
  if (
    url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/notes` &&
    request.method === "POST"
  )
    return noteStatus === 409
      ? json(409, { error: { code: "CONFLICT", message: "reload" } })
      : json(200, { id: REVIEW, version: 5, workflowState: "investigating", replay: false });
  if (
    url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/disposition` &&
    request.method === "POST"
  )
    return dispositionStatus === 409
      ? json(409, { error: { code: "CONFLICT", message: "reload" } })
      : json(200, { id: REVIEW, version: 5, workflowState: "reviewed_not_posted", replay: false });
  if (
    url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/reassess` &&
    request.method === "POST"
  )
    return json(200, reassessResponse);
  return json(404, { error: { code: "NOT_FOUND", message: "not found" } });
}

const FULL_SESSION = {
  userId: "synthetic-user",
  organizationId: ORG,
  membershipId: "90000000-0000-4000-8000-000000000009",
  roles: ["billing_specialist"],
  permissions: [
    "remittance.read",
    "remittance.financial_review",
    "remittance.match_review",
    "medicaid.claim.read",
  ],
  providerEntityIds: [PROVIDER],
  isAdmin: false,
};

function mount(path = "/remittance/medicaid-era-reviews", session = FULL_SESSION) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/remittance/medicaid-era-reviews" element={<MedicaidEraReviews />} />
              <Route path="/remittance/medicaid-era-reviews/:id" element={<MedicaidEraReviews />} />
              <Route path="/remittance/claimmd-era-review" element={<p>Claim.MD source</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  worklistRows = [row];
  detailResponse = detail();
  historyResponse = { items: [historyItem()] };
  noteStatus = 200;
  dispositionStatus = 200;
  reassessResponse = { status: "review_saved", reviewId: REVIEW, version: 5, replay: true };
  vi.restoreAllMocks();
});

describe("Medicaid ERA operator worklist and investigation", () => {
  it("loads a scoped worklist, opens detail, and presents reported values as observations", async () => {
    mount();
    expect(await screen.findByText("Review required")).toBeTruthy();
    expect(screen.getByText("Identity recorded")).toBeTruthy();
    expect(screen.queryByText(REVIEW)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Open Review required review/ }));
    expect(await screen.findByRole("heading", { name: "Medicaid ERA investigation" })).toBeTruthy();
    expect(
      screen.getByText(
        /Assessment observed on .* This is not current eligibility verification or payment authorization\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Reported charge").parentElement?.textContent).toContain("$500.00");
    expect(screen.getByText("Reported claim payment").parentElement?.textContent).toContain(
      "$250.00",
    );
    expect(screen.queryByText("Reported 835 payment")).toBeNull();
    expect(screen.getByText(/not ledger balances/)).toBeTruthy();
    expect(screen.queryByText("Paid")).toBeNull();
    expect(screen.queryByText("synthetic-account-reference")).toBeNull();
    expect(screen.getByRole("link", { name: /Open verified Medicaid claim/ })).toBeTruthy();
    expect(screen.getByText(/Recorded by an authorized reviewer/)).toBeTruthy();
    expect(screen.queryByText("80000000-0000-4000-8000-000000000008")).toBeNull();
  });

  it("preserves worklist context on the detail link and return navigation", async () => {
    mount();
    fireEvent.click(await screen.findByRole("link", { name: /Open Review required review/ }));
    fireEvent.click(await screen.findByRole("link", { name: "Back to reviews" }));
    expect(await screen.findByText("Review required")).toBeTruthy();
  });

  it("does not expose legacy payer, environment, or duplicate facts in the worklist", async () => {
    worklistRows = [
      {
        ...row,
        assessmentTrustStatus: "legacy_unverified",
        decisionStatus: "unverified",
        canonicalPayerId: PAYER,
        programId: "OR_FFS_SYNTHETIC",
        sourceEnvironment: "production",
        duplicateStatus: "exact",
      },
    ];
    mount();
    const legacyRow = await screen.findByRole("link", {
      name: /Open Historical assessment unverified review/,
    });
    expect(legacyRow.textContent).toContain("Not verified");
    expect(legacyRow.textContent).toContain("Environment unavailable");
    expect(legacyRow.textContent).toContain("Unavailable");
    expect(legacyRow.textContent).not.toContain("Exact duplicate");
    expect(legacyRow.textContent).not.toContain("Production source environment");
    expect(legacyRow.textContent).not.toContain("Identity recorded");
  });

  it("does not show financial values from a malformed or unsupported summary", async () => {
    detailResponse = detail({
      safeSummary: {
        transactionSetCount: 1,
        claims: [{ decision: "future_decision", postingAuthorized: true }],
      },
    });
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(await screen.findByText(/cannot safely display/)).toBeTruthy();
    expect(screen.queryByText("$500.00")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("keeps historical assessments and events visibly unverified", async () => {
    detailResponse = detail({
      assessmentTrustStatus: "legacy_unverified",
      assessmentSemantics: "legacy_unverified",
      assessmentObservedAt: null,
      accountReference: null,
      sourceEnvironment: null,
      sourceDigest: null,
      canonicalPayerId: null,
      programId: null,
      safeSummary: null,
      decisionStatus: "unverified",
      reasonCodes: ["LEGACY_ASSESSMENT_UNVERIFIED"],
      claimMatchStatus: "UNVERIFIED",
      duplicateStatus: "unverified",
    });
    historyResponse = {
      items: [
        historyItem({
          trustStatus: "legacy_unverified",
          action: "legacy_unverified",
          reasonCode: null,
          actorMembershipId: null,
        }),
      ],
    };
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect((await screen.findAllByText(/predates the trusted evaluator/)).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Observation time not recorded")).toBeTruthy();
    expect(screen.getByText(/original details have not been independently verified/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-evaluate evidence" })).toBeNull();
    expect(screen.queryByText("$500.00")).toBeNull();
  });

  it("allows read-only staff to see history without requesting restricted assessment detail", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`, {
      ...FULL_SESSION,
      permissions: ["remittance.read"],
    });
    expect(await screen.findByText(/Financial review permission is required/)).toBeTruthy();
    expect(screen.getByText(/Recorded by an authorized reviewer/)).toBeTruthy();
    expect(
      calls.some((call) => call.path === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}`),
    ).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/history"))).toBe(true);
  });

  it("records controlled reasons using the authoritative version and idempotency key", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    fireEvent.change(screen.getByLabelText(/Investigation reason/), {
      target: { value: "MATCH_EVIDENCE_REVIEWED" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record investigation reason" }));
    await screen.findByText(/Investigation reason recorded/);
    const noteCall = calls.find((call) => call.path.endsWith("/notes"));
    expect(noteCall?.body).toEqual({ expectedVersion: 4, reasonCode: "MATCH_EVIDENCE_REVIEWED" });
    expect(noteCall?.idempotencyKey).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /note|comment/i })).toBeNull();
  });

  it("refreshes after a stale version conflict and requires confirmation to complete without posting", async () => {
    dispositionStatus = 409;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    fireEvent.click(screen.getByRole("button", { name: "Complete review — no posting" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("without posting any payment"),
    );
    expect(calls.some((call) => call.path.endsWith("/disposition"))).toBe(false);

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Complete review — no posting" }));
    await screen.findByRole("alert");
    const disposition = calls.find((call) => call.path.endsWith("/disposition"));
    expect(disposition?.body).toEqual({
      expectedVersion: 4,
      state: "reviewed_not_posted",
      reasonCode: "INTERNAL_REVIEW_COMPLETE",
    });
    expect(disposition?.idempotencyKey).toBeTruthy();
    expect(calls.filter((call) => call.path.endsWith(`/${REVIEW}`))).toHaveLength(2);
  });

  it("reassesses through the review id without exposing a staged artifact reference", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    fireEvent.click(await screen.findByRole("button", { name: "Re-evaluate evidence" }));
    await screen.findByText("The existing nonposting assessment is current.");
    const call = calls.find((item) => item.path.endsWith("/reassess"));
    expect(call?.path).toBe(`/api/v1/remittance/medicaid-era-reviews/${REVIEW}/reassess`);
    expect(call?.idempotencyKey).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain("synthetic-account-reference");
  });

  it("does not repeat transaction-level provider adjustments per claim in multi-claim evidence", async () => {
    detailResponse = detail({
      safeSummary: {
        transactionSetCount: 1,
        claims: [
          observation({
            amounts: {
              claimChargeCents: 50000,
              claimPaidCents: 25000,
              patientResponsibilityCents: null,
              providerAdjustmentCents: -450,
              reportedPaymentCents: 25000,
            },
            providerAdjustments: [{ reason: "WO", reference: "SYNTHETIC", amountCents: -450 }],
          }),
          observation({
            amounts: {
              claimChargeCents: 10000,
              claimPaidCents: 5000,
              patientResponsibilityCents: null,
              providerAdjustmentCents: -450,
              reportedPaymentCents: 5000,
            },
            providerAdjustments: [{ reason: "WO", reference: "SYNTHETIC", amountCents: -450 }],
          }),
        ],
      },
    });
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(
      (await screen.findAllByText(/not allocated to individual claims/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Reported provider-level adjustment")).toBeNull();
    expect(screen.queryByText("Reported 835 payment")).toBeNull();
  });
});

describe("safe Medicaid ERA summary presentation", () => {
  it("rejects unsupported versions and posting-enabled summaries", () => {
    expect(parseMedicaidEraSummary({ claims: [] })).toBeNull();
    expect(
      parseMedicaidEraSummary({
        transactionSetCount: 1,
        claims: [observation({ postingAuthorized: true })],
      }),
    ).toBeNull();
    expect(
      parseMedicaidEraSummary({
        transactionSetCount: 1,
        claims: [observation({ amounts: { reportedPaymentCents: 1.5 } })],
      }),
    ).toBeNull();
  });

  it("preserves absent amounts as unavailable rather than zero", () => {
    const parsed = parseMedicaidEraSummary({
      transactionSetCount: 1,
      claims: [observation({ amounts: { claimChargeCents: null } })],
    });
    expect(parsed?.claims[0]?.amounts.claimChargeCents).toBeNull();
    expect(parsed?.claims[0]?.amounts.claimPaidCents).toBeNull();
  });

  it("does not link a claim unless submitted-match identity is complete", () => {
    const parsed = parseMedicaidEraSummary({
      transactionSetCount: 1,
      claims: [observation({ matchedClaim: { claimId: CLAIM, claimVersion: 3 } })],
    });
    expect(parsed?.claims[0]?.matchedClaimId).toBeNull();
  });
});
