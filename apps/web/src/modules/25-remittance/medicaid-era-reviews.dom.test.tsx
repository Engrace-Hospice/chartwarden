import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { parseMedicaidEraSummary, reasonExplanation } from "./medicaid-era-presentation";
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
// The server's ConflictError sentences: a stale version versus the completed-review state rule.
const STALE_CONFLICT = "reload the review before updating it";
const STATE_RULE_CONFLICT = "reopen the investigation before changing its disposition";
let conflictMessage = STALE_CONFLICT;
let onDispositionSaved: (() => void) | null = null;
let detailGate: Promise<void> | null = null;
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
  if (url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}`) {
    if (detailGate) await detailGate;
    return json(200, detailResponse);
  }
  if (
    url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/notes` &&
    request.method === "POST"
  )
    return noteStatus === 409
      ? json(409, {
          error: { code: "CONFLICT", message: "reload the review before adding a note" },
        })
      : json(200, { id: REVIEW, version: 5, workflowState: "investigating", replay: false });
  if (
    url.pathname === `/api/v1/remittance/medicaid-era-reviews/${REVIEW}/disposition` &&
    request.method === "POST"
  ) {
    if (dispositionStatus === 409)
      return json(409, { error: { code: "CONFLICT", message: conflictMessage } });
    onDispositionSaved?.();
    return json(200, {
      id: REVIEW,
      version: 5,
      workflowState: "reviewed_not_posted",
      replay: false,
    });
  }
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
  conflictMessage = STALE_CONFLICT;
  onDispositionSaved = null;
  detailGate = null;
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
    // The evaluator's idempotency insert is refused for a legacy row, so no write action may be offered.
    expect(screen.getByText(/predates evaluator attestation/)).toBeTruthy();
    expect(screen.queryByLabelText(/Investigation reason/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Record investigation reason" })).toBeNull();
    for (const name of [
      "Start investigation",
      "Request follow-up",
      "Complete review — no posting",
      "Reopen investigation",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Claim.MD ERA review" })).toBeTruthy();
  });

  it("offers the investigation actions for a trusted review", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(await screen.findByLabelText(/Investigation reason/)).toBeTruthy();
    expect(screen.queryByText(/predates evaluator attestation/)).toBeNull();
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

  it("offers only the transitions the server accepts from each state", async () => {
    const offered = async (workflowState: string) => {
      detailResponse = detail({ workflowState });
      mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
      await screen.findByRole("heading", { name: "What needs attention" });
      const group = screen.getByLabelText("Investigation status actions");
      const names = within(group)
        .getAllByRole("button")
        .map((button) => button.textContent);
      cleanup();
      return names;
    };
    expect(await offered("needs_review")).toEqual([
      "Start investigation",
      "Request follow-up",
      "Complete review — no posting",
    ]);
    expect(await offered("investigating")).toEqual([
      "Request follow-up",
      "Complete review — no posting",
    ]);
    expect(await offered("reopened")).toEqual([
      "Start investigation",
      "Request follow-up",
      "Complete review — no posting",
    ]);
    // A completed review is refused every change but a reopen (409 "reopen the investigation first").
    expect(await offered("reviewed_not_posted")).toEqual(["Reopen investigation"]);
  });

  it("states the state rule, and does not read the review again, when the server refuses a transition", async () => {
    dispositionStatus = 409;
    conflictMessage = STATE_RULE_CONFLICT;
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    fireEvent.click(screen.getByRole("button", { name: "Request follow-up" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("must be reopened");
    expect(alert.textContent).not.toContain("changed while you were working");
    expect(calls.filter((call) => call.path.endsWith(`/${REVIEW}`))).toHaveLength(1);
  });

  it("keeps the stale-version wording for a stale version and a neutral one for any other conflict", async () => {
    dispositionStatus = 409;
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    fireEvent.click(screen.getByRole("button", { name: "Request follow-up" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed while you were working",
    );

    conflictMessage = "this idempotency key was used for another review action";
    fireEvent.click(screen.getByRole("button", { name: "Request follow-up" }));
    await waitFor(() => {
      const text = screen.getByRole("alert").textContent ?? "";
      expect(text).toContain("could not be applied to the review's current state");
      expect(text).not.toContain("changed while you were working");
    });
  });

  it("keeps the workspace mounted and announces success through a region that already exists", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    const select = screen.getByLabelText(/Investigation reason/);
    const region = document.querySelector(".mer-live");
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe("");
    fireEvent.change(select, { target: { value: "MATCH_EVIDENCE_REVIEWED" } });
    const record = screen.getByRole("button", { name: "Record investigation reason" });
    record.focus();

    let release: () => void = () => undefined;
    detailGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(record);
    await waitFor(() =>
      expect(calls.filter((call) => call.path.endsWith(`/${REVIEW}`)).length).toBeGreaterThan(1),
    );
    // Mid-refresh: no spinner replaced the workspace, the same controls are mounted, and they are disabled.
    expect(screen.queryByLabelText("Loading review and investigation history…")).toBeNull();
    expect(screen.getByLabelText(/Investigation reason/)).toBe(select);
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Request follow-up" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(region?.textContent).toBe("");

    release();
    await screen.findByText(/Investigation reason recorded/);
    expect(document.querySelector(".mer-live")).toBe(region);
    expect(region?.textContent).toContain("Investigation reason recorded");
    expect((select as HTMLSelectElement).disabled).toBe(false);
  });

  it("keeps keyboard focus in the actions section when a status change removes the pressed button", async () => {
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByRole("heading", { name: "What needs attention" });
    onDispositionSaved = () => {
      detailResponse = detail({ workflowState: "follow_up_required", version: 5 });
    };
    const pressed = screen.getByRole("button", { name: "Request follow-up" });
    pressed.focus();
    fireEvent.click(pressed);
    await screen.findByText(/Request follow-up recorded/);
    expect(screen.queryByRole("button", { name: "Request follow-up" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Record a nonposting action" }),
    );
  });

  it("gives worklist rows with the same decision and state distinct link names", async () => {
    worklistRows = [
      { ...row, id: "30000000-0000-4000-8000-000000000031", createdAt: "2026-11-20T09:00:00.000Z" },
      { ...row, id: "30000000-0000-4000-8000-000000000032", createdAt: "2026-11-22T15:45:00.000Z" },
    ];
    mount();
    const links = await screen.findAllByRole("link", { name: /Open Review required review/ });
    const names = links.map((link) => link.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(JSON.stringify(names)).not.toContain("30000000-0000-4000-8000-000000000031");
  });

  it("labels a source identity conflict hold and humanizes the claim match in the worklist", async () => {
    worklistRows = [
      { ...row, duplicateStatus: "conflict", claimMatchStatus: "SOURCE_ACCOUNT_MISMATCH" },
    ];
    mount();
    const link = await screen.findByRole("link", { name: /Open Review required review/ });
    expect(link.textContent).toContain("Source identity conflict hold");
    expect(link.textContent).toContain("Source account mismatch");
    expect(link.textContent).not.toContain("SOURCE_ACCOUNT_MISMATCH");
    expect(link.textContent).not.toMatch(/Duplicate\s*Unverified/);
  });

  it("labels a source identity conflict hold in the detail view", async () => {
    detailResponse = detail({ duplicateStatus: "conflict" });
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(await screen.findByText("Source identity conflict hold")).toBeTruthy();
  });

  it("labels the evaluator's own history reasons", async () => {
    historyResponse = {
      items: [
        historyItem({ version: 1, action: "assessed", reasonCode: "NONPOSTING_ASSESSMENT" }),
        historyItem({
          version: 2,
          action: "reassessed",
          reasonCode: "CURRENT_SOURCE_FACTS_REASSESSED",
        }),
      ],
    };
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(await screen.findByText(/· Reassessed against current source facts\./)).toBeTruthy();
    expect(screen.getByText(/· Assessed\./)).toBeTruthy();
    expect(screen.queryByText(/Reason details unavailable/)).toBeNull();
  });

  it("labels the history reasons a reassessment records when it reopens or promotes a review", async () => {
    historyResponse = {
      items: [
        historyItem({
          version: 2,
          action: "reassessed",
          reasonCode: "COMPLETED_REVIEW_REOPENED_BY_REASSESSMENT",
        }),
        historyItem({
          version: 3,
          action: "reassessed",
          reasonCode: "LEGACY_REVIEW_REASSESSED_NEEDS_REVIEW",
        }),
      ],
    };
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(await screen.findByText(/the completed review was reopened/)).toBeTruthy();
    expect(screen.getByText(/the review needs a fresh look/)).toBeTruthy();
    expect(screen.queryByText(/Reason details unavailable/)).toBeNull();
  });

  it("words an unavailable evaluation as an unreadable or out-of-scope source", async () => {
    reassessResponse = { status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" };
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    fireEvent.click(await screen.findByRole("button", { name: "Re-evaluate evidence" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be read for evaluation");
    expect(alert.textContent).not.toContain("The evaluator is unavailable");
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

  it("says when the stored adjustment lists were cut short of what the source reported", async () => {
    detailResponse = detail({
      safeSummary: {
        transactionSetCount: 1,
        claims: [observation({ adjustmentCounts: { claim: 120, serviceLine: 0, provider: 0 } })],
      },
    });
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    expect(
      await screen.findByText(/Showing the first 1 claim and 0 service-line adjustments of 120/),
    ).toBeTruthy();
  });

  it("does not claim a cut when the stored adjustment lists are complete", async () => {
    detailResponse = detail({
      safeSummary: {
        transactionSetCount: 1,
        claims: [observation({ adjustmentCounts: { claim: 1, serviceLine: 0, provider: 0 } })],
      },
    });
    mount(`/remittance/medicaid-era-reviews/${REVIEW}`);
    await screen.findByText(/Adjustment observations/);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
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

describe("operator wording for evaluator reason codes", () => {
  it.each([
    "SOURCE_ARTIFACT_UNAVAILABLE",
    "ERA_PARSE_INVALID",
    "ERA_NO_CLAIMS",
    "MULTI_CLAIM_ATTRIBUTION_CONFLICT",
    "ENROLLMENT_NOT_ACTIVE",
    "PAYEE_IDENTITY_CONFLICT",
    "PAYEE_TIN_EVIDENCE_UNAVAILABLE",
    "CLAIM_PROVIDER_MISMATCH",
  ])("explains %s instead of the generic fallback", (code) => {
    const text = reasonExplanation(code);
    expect(text).not.toBe(reasonExplanation("NOT_A_REAL_REASON"));
    expect(text).not.toContain(code);
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
