import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ClaimMdEraReview } from "./claimmd-era-review";

const STAGE = "20000000-0000-4000-8000-000000000002";
const CLAIM = "30000000-0000-4000-8000-000000000003";
const row = {
  id: STAGE,
  providerEntityId: "40000000-0000-4000-8000-000000000004",
  locationId: null,
  eraId: "synthetic-era-ref",
  fileIndex: 0,
  transactionSetControlNumber: "0001",
  sourceDigest: "b".repeat(64),
  state: "staged",
  holdReason: null,
  possibleDuplicate: false,
  duplicateClassification: "none" as const,
  existingAdviceId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  detailsAvailable: true,
  payer: { name: "Synthetic Payer", identifier: "payer-1" },
  payee: { name: "Synthetic Hospice", npi: "1999999999" },
  payment: { trace: "SYNTHETIC-TRACE", method: "eft", amount: 130, date: "2026-10-01" },
  claims: [
    {
      patientControlNumber: "SYNTHETIC-PCN",
      payerIcn: "SYNTHETIC-ICN",
      statusCode: 1,
      totalCharge: 500,
      totalPayment: 130,
      patientResponsibility: 10,
      serviceFrom: "2026-09-01",
      serviceTo: "2026-09-30",
      adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 5, quantity: null }],
      serviceLines: [
        {
          procedureCode: "SYNTH-HCPCS",
          revenueCode: "0651",
          chargeAmount: 500,
          paidAmount: 130,
          paidUnits: 1,
          submittedUnits: 1,
          adjustments: [],
          remarks: [],
        },
      ],
      remarks: [],
    },
  ],
  providerAdjustments: [
    {
      reason: "WO",
      reference: "SYNTHETIC-PLB",
      amount: -5,
      providerIdentifierMasked: "••••9999",
      fiscalPeriod: "2026-12-31",
      segmentPosition: 12,
      occurrence: 1,
      classification: "overpayment_recovery_reported" as const,
      historicalReference: "not_verified" as const,
      policyStatus: "not_configured" as const,
      postingEligible: false as const,
    },
  ],
  claimOutcomes: [
    {
      claimId: CLAIM,
      patientControlNumber: "SYNTHETIC-PCN",
      outcome: "verified",
      module: "M23",
      fileIndex: 0,
      transactionSetControlNumber: "0001",
    },
  ],
  reconciliationEligible: true,
  history: {
    availability: "available",
    events: [
      {
        eventType: "era_captured",
        description: "The original ERA content was captured and protected.",
        occurredAt: "2026-10-01T01:00:00.000Z",
        stageId: STAGE,
        fromState: "discovered",
        toState: "captured",
        reasonCode: null,
        origin: "ingestion",
        actorClassification: "system",
        attemptCount: null,
      },
    ],
  },
};
type ReviewRow = Omit<
  typeof row,
  | "state"
  | "holdReason"
  | "possibleDuplicate"
  | "reconciliationEligible"
  | "duplicateClassification"
> & {
  state: string;
  holdReason: string | null;
  possibleDuplicate: boolean;
  duplicateClassification: "none" | "possible" | "exact";
  reconciliationEligible: boolean;
};
const summary = {
  id: row.id,
  providerEntityId: row.providerEntityId,
  locationId: row.locationId,
  state: row.state,
  holdReason: row.holdReason,
  possibleDuplicate: row.possibleDuplicate,
  duplicateClassification: row.duplicateClassification,
  existingAdviceId: row.existingAdviceId,
  createdAt: row.createdAt,
  detailsAvailable: row.detailsAvailable,
  payer: row.payer,
  payee: { name: row.payee.name },
  payment: { method: row.payment.method, amount: row.payment.amount, date: row.payment.date },
  claimCount: 1,
  identityExceptionCount: 0,
  reconciliationEligible: true,
};

const calls: { method: string; path: string; key: string | null }[] = [];
/** What the next approval / execution write gets: nothing at all, a gateway page, or the API's refusal (then it succeeds). */
type WriteReply = "no answer" | "gateway" | "refused";
let writeScript: WriteReply[] = [];
let activeRow: ReviewRow = row;
let failRequests = false;
let decisionSaved = false;
let financialDecisionSaved = false;
let manualScenario = false;
let postingScenario = false;
let medicareScenario = false;
let contractualAdjustmentScenario = false;
let postingApproved = false;
let postingExecuted = false;
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (failRequests) throw new Error("synthetic network failure");
  const request = new Request(input as RequestInfo, init);
  const url = new URL(request.url);
  const path = url.pathname;
  calls.push({
    method: request.method,
    path: `${path}${url.search}`,
    key: request.headers.get("Idempotency-Key"),
  });
  if (path.endsWith("/matching/claims/0/decision") && request.method === "POST") {
    decisionSaved = true;
    return new Response(
      JSON.stringify({
        id: STAGE,
        claimIndex: 0,
        decisionVersion: 1,
        decision: manualScenario ? "human_confirmed_candidate" : "confirmed_identity",
        postingAuthorized: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (path.endsWith("/financial-review/decision") && request.method === "POST") {
    financialDecisionSaved = true;
    return new Response(
      JSON.stringify({
        id: STAGE,
        itemType: "era",
        itemIndex: -1,
        decisionVersion: 1,
        disposition: "reviewed",
        financialPostingAuthorized: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (postingScenario && path.endsWith("/posting-plan") && request.method === "POST") {
    return new Response(
      JSON.stringify({
        planId: "80000000-0000-4000-8000-000000000008",
        planDigest: "a".repeat(64),
        stageId: STAGE,
        providerEntityId: row.providerEntityId,
        payer: medicareScenario ? "Synthetic Medicare MAC" : "Synthetic Payer",
        paymentCents: contractualAdjustmentScenario ? 7_000 : 13_000,
        billedCents: contractualAdjustmentScenario ? 10_000 : 13_000,
        unresolvedCents: contractualAdjustmentScenario ? 3_000 : 0,
        claims: (medicareScenario || contractualAdjustmentScenario ? [1] : [1, 2]).map(
          (claimIndex) => ({
            claimIndex: claimIndex - 1,
            billingModule: medicareScenario ? "M23" : "M41",
            patientControlNumber: `SYNTHETIC-POST-PCN-${claimIndex}`,
            payerIcn: `SYNTHETIC-POST-ICN-${claimIndex}`,
            claimId: CLAIM,
            payerId: "payer-1",
            submissionId: `70000000-0000-4000-8000-00000000000${claimIndex}`,
            evidenceId: `60000000-0000-4000-8000-00000000000${claimIndex}`,
            evidenceVersion: 1,
            matching: "verified",
            billedCents: contractualAdjustmentScenario ? 10000 : 6500,
            paidCents: contractualAdjustmentScenario ? 7000 : 6500,
            patientResponsibilityCents: 0,
            adjustments: contractualAdjustmentScenario
              ? [
                  {
                    scope: "claim",
                    groupCode: "CO",
                    reasonCode: "45",
                    amountCents: 3000,
                    responsibility: "provider_reported",
                    classification: "contractual_obligation_reported",
                    accountingDisposition: "policy_required",
                    policyVersion: null,
                    m25Action: "not_authorized",
                  },
                ]
              : [],
            unresolvedCents: contractualAdjustmentScenario ? 3000 : 0,
            financialStatus: contractualAdjustmentScenario ? "unsupported" : "fully_paid",
            duplicate: "none",
            eligible: !contractualAdjustmentScenario && !medicareScenario,
            blockers: medicareScenario
              ? ["MEDICARE_POSTING_NOT_CERTIFIED"]
              : contractualAdjustmentScenario
                ? ["CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE"]
                : [],
          }),
        ),
        claimId: CLAIM,
        eligible: !contractualAdjustmentScenario && !medicareScenario && !postingExecuted,
        status:
          contractualAdjustmentScenario || medicareScenario
            ? "blocked"
            : postingExecuted
              ? "already_posted"
              : "eligible",
        blockers: medicareScenario
          ? ["CLAIM_NOT_ELIGIBLE"]
          : contractualAdjustmentScenario
            ? ["CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE"]
            : [],
        featureEnabled: true,
        approval: postingExecuted ? "posted" : postingApproved ? "approved" : "not_approved",
        createdAt: "2026-10-01T01:00:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (postingScenario && path.endsWith("/posting-history") && request.method === "GET") {
    return new Response(
      JSON.stringify(
        postingApproved
          ? [
              {
                eventType: "approved",
                planId: "80000000-0000-4000-8000-000000000008",
                occurredAt: "2026-10-01T01:00:00.000Z",
                reason: "Approved synthetic posting plan",
                adviceId: null,
                remittanceLineId: null,
                remittanceLineIds: [],
              },
              ...(postingExecuted
                ? [
                    {
                      eventType: "posted",
                      planId: "80000000-0000-4000-8000-000000000008",
                      occurredAt: "2026-10-01T01:01:00.000Z",
                      reason: "Executed synthetic posting plan",
                      adviceId: STAGE,
                      remittanceLineId: "90000000-0000-4000-8000-000000000009",
                      remittanceLineIds: [
                        "90000000-0000-4000-8000-000000000009",
                        "90000000-0000-4000-8000-000000000010",
                      ],
                    },
                  ]
                : []),
            ]
          : [],
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const scripted = (isWrite: boolean): Response | null => {
    const next = isWrite ? writeScript.shift() : undefined;
    if (next === "no answer") throw new TypeError("Failed to fetch");
    if (next === "gateway") return new Response("{}", { status: 502 });
    if (next === "refused")
      return new Response(JSON.stringify({ error: { code: "PLAN_STALE", message: "stale" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    return null;
  };
  if (postingScenario && path.endsWith("/approval") && request.method === "POST") {
    const reply = scripted(true);
    if (reply) return reply;
    postingApproved = true;
    return new Response(
      JSON.stringify({ planId: "80000000-0000-4000-8000-000000000008", outcome: "approved" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (postingScenario && path.endsWith("/execution") && request.method === "POST") {
    const reply = scripted(true);
    if (reply) return reply;
    postingExecuted = true;
    return new Response(
      JSON.stringify({
        planId: "80000000-0000-4000-8000-000000000008",
        outcome: "posted",
        adviceId: STAGE,
        remittanceLineId: "90000000-0000-4000-8000-000000000009",
        remittanceLineIds: [
          "90000000-0000-4000-8000-000000000009",
          "90000000-0000-4000-8000-000000000010",
        ],
        paymentCents: 13_000,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (manualScenario && path.endsWith("/matching/claims/0/candidates")) {
    return new Response(
      JSON.stringify({
        complete: true,
        postingAuthorized: false,
        candidates: [
          {
            module: "M23",
            evidenceId: "60000000-0000-4000-8000-000000000006",
            claimId: CLAIM,
            submissionId: "70000000-0000-4000-8000-000000000007",
            attemptKey: "70000000-0000-4000-8000-000000000007:1",
            claimType: "0811",
            payerId: "payer-1",
            usage: "test",
            serviceFrom: "2026-09-01",
            serviceTo: "2026-09-30",
            chargeCents: 50000,
            lineage: "original",
            attemptState: "submitted",
            submittedAt: "2026-10-01T00:00:00.000Z",
            supportingEvidence: [
              "patient control number matches the immutable submitted attempt",
              "organization, provider, Claim.MD account and environment match",
              "payer identifier matches",
              "service period matches",
              "submitted charge matches",
            ],
            selectable: true,
            submittedLines: "unavailable",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const duplicateRow = {
    ...row,
    state: "possible_duplicate",
    possibleDuplicate: true,
    duplicateClassification: "possible" as const,
    holdReason: "POSSIBLE_CROSS_SOURCE_DUPLICATE",
    reconciliationEligible: false,
  };
  const exactDuplicateRow = {
    ...row,
    state: "held",
    possibleDuplicate: false,
    duplicateClassification: "exact" as const,
    holdReason: "EXACT_DUPLICATE_FROM_M25",
    reconciliationEligible: false,
  };
  const isDuplicate = url.searchParams.get("state") === "possible_duplicate";
  const isExactDuplicate = url.searchParams.get("state") === "held";
  const item = isDuplicate ? duplicateRow : isExactDuplicate ? exactDuplicateRow : row;
  if (path === "/api/v1/remittance/claimmd-era") activeRow = item;
  const listItem = isDuplicate
    ? {
        ...summary,
        state: "possible_duplicate",
        possibleDuplicate: true,
        duplicateClassification: "possible",
        holdReason: "POSSIBLE_CROSS_SOURCE_DUPLICATE",
        reconciliationEligible: false,
      }
    : isExactDuplicate
      ? {
          ...summary,
          state: "held",
          holdReason: "EXACT_DUPLICATE_FROM_M25",
          duplicateClassification: "exact",
          reconciliationEligible: false,
        }
      : summary;
  const body = path.endsWith(`/${STAGE}/matching`)
    ? {
        stageId: STAGE,
        totalClaims: 1,
        verifiedSourceIdentities: 1,
        unresolvedSourceIdentities: 0,
        claims: [
          {
            claimIndex: 0,
            patientControlNumber: "SYNTHETIC-PCN",
            payerIcn: "SYNTHETIC-ICN",
            serviceLines: [
              {
                lineIndex: 0,
                payerLineReference: "SYNTH-6R",
                outcome: "original_line_evidence_unavailable",
              },
            ],
            outcome: manualScenario ? "ambiguous" : "verified",
            linkedClaimId: manualScenario && decisionSaved ? CLAIM : manualScenario ? null : CLAIM,
            linkedModule: "M23",
            decision: decisionSaved
              ? manualScenario
                ? "human_confirmed_candidate"
                : "confirmed_identity"
              : "unreviewed",
            decisionVersion: decisionSaved ? 1 : 0,
            reason: decisionSaved ? "Reviewed synthetic source" : null,
            decisionAt: decisionSaved ? "2026-10-01T02:00:00.000Z" : null,
          },
        ],
        decisionHistory: decisionSaved
          ? [
              {
                claimIndex: 0,
                decisionVersion: 1,
                decision: "confirmed_identity",
                reason: "Reviewed synthetic source",
                occurredAt: "2026-10-01T02:00:00.000Z",
                actorClassification: "billing_reviewer",
              },
            ]
          : [],
        serviceLineMatching: "not_available_without_original_line_reference",
        readOnlyBalance: {
          status: "discrepancy",
          claimPaymentsCents: 13000,
          providerAdjustmentsCents: -500,
          reportedPaymentCents: 13000,
          expectedPaymentCents: 13500,
          differenceCents: 500,
        },
        financialReview: {
          reportedPaymentCents: 13000,
          claimCount: 1,
          chargeCents: 50000,
          claimPaymentCents: 13000,
          patientResponsibilityCents: 1000,
          claimAdjustmentCents: 500,
          serviceLineAdjustmentCents: 0,
          providerAdjustmentCents: -500,
          balance: {
            status: "discrepancy",
            claimPaymentsCents: 13000,
            providerAdjustmentsCents: -500,
            reportedPaymentCents: 13000,
            expectedPaymentCents: 13500,
            differenceCents: 500,
          },
          claims: [
            {
              claimIndex: 0,
              status: "partial_payment",
              chargeCents: 50000,
              paymentCents: 13000,
              patientResponsibilityCents: 1000,
              adjustments: [],
              lineEvidence: "original_line_evidence_unavailable",
            },
          ],
          adjustments: [
            {
              scope: "claim",
              groupCode: "CO",
              category: "contractual_obligation",
              reasonCode: "45",
              amountCents: 500,
              description: "Description unavailable",
            },
          ],
          providerAdjustments: [{ reason: "WO", reference: "SYNTHETIC-PLB", amountCents: -500 }],
          exceptions: [
            {
              code: "ERA_PAYMENT_BALANCE_DISCREPANCY",
              severity: "blocking",
              blocksReviewCompletion: true,
              blocksFuturePosting: true,
            },
          ],
          canCompleteNonpostingReview: false,
          financialPostingAuthorized: false,
        },
        financialReviewHistory: financialDecisionSaved
          ? [
              {
                itemType: "era",
                itemIndex: -1,
                decisionVersion: 1,
                disposition: "reviewed",
                reason: "Checked reported balances",
                occurredAt: "2026-10-01T02:00:00.000Z",
                reviewerMembershipId: "50000000-0000-4000-8000-000000000005",
                currentSource: true,
              },
            ]
          : [],
        postingAuthorized: false,
      }
    : path.endsWith(`/${STAGE}`)
      ? activeRow
      : {
          items:
            (url.searchParams.get("payer") &&
              url.searchParams.get("payer") !== "Synthetic Payer") ||
            (url.searchParams.get("fromDate") &&
              (url.searchParams.get("fromDate") ?? "") > "2026-10-01")
              ? []
              : [listItem],
          nextCursor: null,
          searchWindowLimited: false,
        };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "synthetic-user",
          organizationId: "synthetic-org",
          membershipId: "synthetic-membership",
          roles: ["billing_specialist"],
          permissions: ["remittance.read"],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <ClaimMdEraReview />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  activeRow = row;
  failRequests = false;
  decisionSaved = false;
  financialDecisionSaved = false;
  manualScenario = false;
  postingScenario = false;
  medicareScenario = false;
  contractualAdjustmentScenario = false;
  postingApproved = false;
  postingExecuted = false;
  writeScript = [];
});

const POSTING_REVIEWER = {
  userId: "synthetic-user",
  organizationId: "synthetic-org",
  membershipId: "synthetic-membership",
  roles: ["finance_reviewer"],
  permissions: [
    "remittance.read",
    "remittance.financial_review",
    "remittance.posting.approve",
    "remittance.posting.execute",
  ],
  isAdmin: false,
};

/** Open the posting plan of the staged ERA and type the reason the approval and execution carry. */
async function openPostingPlan(): Promise<void> {
  postingScenario = true;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={POSTING_REVIEWER}>
        <ToastProvider>
          <MemoryRouter>
            <ClaimMdEraReview />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Review posting readiness" }));
  await screen.findByText("Eligible");
  fireEvent.change(screen.getByRole("textbox", { name: "Posting action reason" }), {
    target: { value: "Approved synthetic posting plan" },
  });
}

const writesTo = (suffix: string) =>
  calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

/** Press the button until `suffix` has been written `count` times, waiting for each attempt to finish. */
async function pressUntilWritten(name: string, suffix: string, count: number): Promise<void> {
  for (let sent = writesTo(suffix).length + 1; sent <= count; sent += 1) {
    fireEvent.click(await screen.findByRole("button", { name }));
    await waitFor(() => expect(writesTo(suffix)).toHaveLength(sent));
    await waitFor(() => expect(screen.queryByRole("button", { name, busy: true })).toBeNull());
  }
}

describe("M25 Claim.MD ERA posting writes: one Idempotency-Key per intent", () => {
  it.each([
    ["approval", "Approve plan", "/approval"],
    ["execution", "Execute approved posting", "/execution"],
  ])(
    "the %s write is replayed under the same key after no answer or a gateway page, and renewed by an answer",
    async (_name, button, suffix) => {
      await openPostingPlan();
      if (suffix === "/execution") await pressUntilWritten("Approve plan", "/approval", 1);
      const replies: WriteReply[] = ["no answer", "gateway", "refused"];
      writeScript = [...replies];

      await pressUntilWritten(button, suffix, replies.length + 1);

      const keys = writesTo(suffix).map((call) => call.key);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]); // retried after no answer
      expect(keys[2]).toBe(keys[0]); // retried after a gateway page
      expect(keys[3]).toBeTruthy();
      expect(keys[3]).not.toBe(keys[2]); // the API's refusal was an answer: the next attempt is a new intent
    },
  );
});

describe("M25 Claim.MD ERA nonposting review", () => {
  it("shows scoped staged summary and a clear read-only posting boundary", async () => {
    mount();
    expect(await screen.findByText("Synthetic Payer")).toBeTruthy();
    expect(screen.getByText(/Review only — no payment/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review remittance from Synthetic Payer" }));
    expect(await screen.findByText("Claims and service lines")).toBeTruthy();
    expect(await screen.findByText("Processing history")).toBeTruthy();
    expect(screen.getByText("The original ERA content was captured and protected.")).toBeTruthy();
    expect(screen.getByText("SYNTH-HCPCS")).toBeTruthy();
    expect(await screen.findByText(/Service-line matching is unavailable/)).toBeTruthy();
    expect(screen.getByText(/ERA payment balance/)).toBeTruthy();
    expect(screen.getByText("CO 45: $5.00")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open claim" })[0]?.getAttribute("href")).toBe(
      `/billing/claims/${CLAIM}`,
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("shows identity confirmation only with match-review permission and keeps it nonposting", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-user",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["billing_specialist"],
            permissions: ["remittance.read", "remittance.match_review"],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    expect(await screen.findByRole("button", { name: "Confirm identity" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Matching review reason" }), {
      target: { value: "Verified against source evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm identity" }));
    expect(await screen.findByText(/Reviewed synthetic source/)).toBeTruthy();
    expect(
      calls.some(
        (call) => call.method === "POST" && call.path.includes("matching/claims/0/decision"),
      ),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /post payment/i })).toBeNull();
  });

  it("shows financial review and plan readiness only with their permissions; execution remains unavailable by default", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-user",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["billing_specialist"],
            permissions: ["remittance.read", "remittance.financial_review"],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    expect(await screen.findByText("Financial review")).toBeTruthy();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Complete nonposting review" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /post payment|approve posting|allocate payment/i }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Review posting readiness" })).toBeTruthy();
    expect(screen.getByText(/No posting approval or execution history/)).toBeTruthy();
  });

  it("completes the plan, separate approval and execution UI sequence and shows committed history", async () => {
    postingScenario = true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-user",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["finance_reviewer"],
            permissions: [
              "remittance.read",
              "remittance.financial_review",
              "remittance.posting.approve",
              "remittance.posting.execute",
            ],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review posting readiness" }));
    expect(await screen.findAllByText("Eligible")).toHaveLength(3);
    fireEvent.change(screen.getByRole("textbox", { name: "Posting action reason" }), {
      target: { value: "Approved synthetic posting plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(await screen.findByText("Approved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Execute approved posting" }));
    expect(await screen.findByText(/M25 committed 2 claim records/)).toBeTruthy();
    expect(
      screen
        .getAllByRole("table")
        .some((table) => table.textContent?.includes("SYNTHETIC-POST-PCN-2")),
    ).toBe(true);
    expect(
      calls.some((call) => call.method === "POST" && call.path.endsWith("/posting-plan")),
    ).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/approval"))).toBe(
      true,
    );
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/execution"))).toBe(
      true,
    );
    confirm.mockRestore();
  });

  it("shows CO as payer-reported responsibility and keeps an unconfigured write-off blocked", async () => {
    postingScenario = true;
    contractualAdjustmentScenario = true;
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-user",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["finance_reviewer"],
            permissions: ["remittance.read", "remittance.financial_review"],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review posting readiness" }));
    expect(await screen.findByText(/payer-reported provider responsibility/)).toBeTruthy();
    expect(screen.getByText(/policy required; no write-off is authorized/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Posting blockers" }).textContent).toContain(
      "policy authorizes a contractual write-off",
    );
    expect(screen.queryByRole("button", { name: "Execute approved posting" })).toBeNull();
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/execution"))).toBe(
      false,
    );
  });

  it("shows the verified Medicare claim link and the explicit nonposting certification blocker", async () => {
    medicareScenario = true;
    postingScenario = true;
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-medicare-reviewer",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["billing_specialist"],
            permissions: ["remittance.read", "remittance.financial_review"],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review posting readiness" }));
    expect(
      await screen.findByText(/Medicare Claim.MD financial posting is not certified/),
    ).toBeTruthy();
    expect(
      screen
        .getAllByRole("link")
        .some((link) => link.getAttribute("href") === `/billing/claims/${CLAIM}`),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Execute approved posting" })).toBeNull();
  });

  it("supports evidence-based manual claim selection and reports historical lines as unavailable", async () => {
    manualScenario = true;
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider
          session={{
            userId: "synthetic-user",
            organizationId: "synthetic-org",
            membershipId: "synthetic-membership",
            roles: ["billing_specialist"],
            permissions: ["remittance.read", "remittance.match_review"],
            isAdmin: false,
          }}
        >
          <ToastProvider>
            <MemoryRouter>
              <ClaimMdEraReview />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Find historical claim" }));
    expect(await screen.findByText(/payer identifier matches/)).toBeTruthy();
    expect(screen.getByText(/original submitted line snapshot unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.change(screen.getByRole("textbox", { name: "Manual matching reason" }), {
      target: { value: "Confirmed against original payer evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm reviewed claim" }));
    expect(await screen.findByText(/human confirmed candidate/i)).toBeTruthy();
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/decision"))).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: /post payment/i })).toBeNull();
  });

  it("sends payer and date filters to the server and shows the filtered empty state", async () => {
    mount();
    await screen.findByText("Synthetic Payer");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter by payer" }), {
      target: { value: "No such payer" },
    });
    fireEvent.change(screen.getByLabelText("Received from"), {
      target: { value: "2026-10-02" },
    });
    expect(await screen.findByText(/No Claim\.MD ERA stages match this view/)).toBeTruthy();
    const queries = calls.map((call) => new URLSearchParams(call.path.split("?")[1] ?? ""));
    expect(queries.some((query) => query.get("payer") === "No such payer")).toBe(true);
    expect(queries.some((query) => query.get("fromDate") === "2026-10-02")).toBe(true);
  });

  it("keeps possible duplicates visibly held and does not offer a posting action", async () => {
    mount();
    await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by review status" }), {
      target: { value: "possible_duplicate" },
    });
    expect(await screen.findByText("Synthetic Payer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review remittance from Synthetic Payer" }));
    expect(await screen.findByText("Possible duplicate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /post payment/i })).toBeNull();
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("distinguishes an exact duplicate from an ordinary hold", async () => {
    mount();
    await screen.findByText("Synthetic Payer");
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by review status" }), {
      target: { value: "held" },
    });
    expect(await screen.findByText("Exact duplicate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review remittance from Synthetic Payer" }));
    expect(await screen.findByText(/source matches an existing remittance identity/i)).toBeTruthy();
  });

  it("shows a recoverable error when the review service is unreachable", async () => {
    failRequests = true;
    mount();
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach the service/i);
    failRequests = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Review remittance from Synthetic Payer" }),
    ).toBeTruthy();
  });
});
