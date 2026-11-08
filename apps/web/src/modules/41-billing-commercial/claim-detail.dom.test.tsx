// The commercial claim detail (issue #726): payer and plan, authorization posture, coordination of benefits, the validation panel
// with audited overrides, and the lifecycle actions (a blocked "ready" is shown inline). Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommercialClaimDetail } from "./claim-detail";
import {
  CLAIM_ID,
  type Call,
  PATIENT_ID,
  PAYER_ID,
  PLAN_ID,
  type Responder,
  mountScreen,
  patientRoute,
  payerNameRoute,
} from "./commercial-test-harness";

const CLAIM = `GET /api/v1/billing/commercial/claims/${CLAIM_ID}`;
const BASE = `/api/v1/billing/commercial/claims/${CLAIM_ID}`;

const result = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "r-1",
  ruleKey: "authorization_on_file",
  severity: "warn",
  outcome: "fail",
  overridable: true,
  overridden: false,
  blocking: true,
  message:
    "No approved authorization covers 2026-03-01 to 2026-03-10. Record one or confirm with the payer.",
  ...over,
});

const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan: {
    id: PLAN_ID,
    payerId: PAYER_ID,
    planName: "Synthetic PPO",
    authorizationRequirement: "required_at_admission",
    payerStatus: "active",
  },
  authorizations: [],
  claim: {
    id: CLAIM_ID,
    claimControlNumber: "CCN-0001",
    state: "draft",
    patientId: PATIENT_ID,
    providerEntityId: "22222222-2222-4222-8222-222222222222",
    planId: PLAN_ID,
    tob: "812",
    serviceFrom: "2026-03-01",
    serviceTo: "2026-03-31",
    claimFilingIndicator: "CI",
    secondaryPayerKind: null,
    totalChargeCents: 620_000,
    expectedPaymentCents: 620_000,
    readyAt: null,
  },
  lines: [
    {
      lineNumber: 1,
      levelOfCare: "routine_home_care",
      revenueCode: "0651",
      hcpcsCode: null,
      serviceFrom: "2026-03-01",
      serviceTo: "2026-03-31",
      units: 31,
      unitRateCents: 20_000,
      lineChargeCents: 620_000,
    },
  ],
  validation: {
    runId: "run-1",
    outcome: "soft_block",
    results: [
      result({}),
      result({
        id: "r-2",
        ruleKey: "plan_in_effect",
        outcome: "pass",
        blocking: false,
        message: "ok",
      }),
    ],
  },
  correction: {
    correctionOfClaimId: null,
    correctionKind: null,
    correctionReasonCode: null,
    relatedClaims: [],
    rejectedCorrection: { eligible: false, reasonCode: "CLAIM_NOT_REJECTED" },
  },
  ...over,
});

function mount(
  claim: Responder,
  extra: Record<string, Responder> = {},
  permissions = [
    "commercial_billing.read",
    "commercial_billing.write",
    "commercial_billing.override_validation",
  ],
  calls: Call[] = [],
): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      [CLAIM]: claim,
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
      [`GET /api/v1/mdm/payer/${PAYER_ID}`]: payerNameRoute,
      ...extra,
    },
    calls,
    element: <CommercialClaimDetail />,
    routePath: "/commercial/billing/claims/:claimId",
    entry: `/commercial/billing/claims/${CLAIM_ID}`,
    permissions,
  });
}

afterEach(cleanup);

describe("CommercialClaimDetail", () => {
  it("shows payer, plan, authorization and coordination of benefits", async () => {
    mount(() => ({
      body: view({
        authorizations: [
          {
            id: "a-1",
            status: "approved",
            levelOfCare: null,
            effectiveFrom: "2026-03-01",
            effectiveTo: "2026-03-31",
          },
        ],
        claim: { ...(view().claim as object), secondaryPayerKind: "medicaid" },
      }),
    }));
    await screen.findByRole("heading", { name: "Claim CCN-0001" });
    const rail = screen.getByRole("complementary", { name: /Payer, authorization/ });
    await within(rail).findByText("Synthetic Health Plan");
    expect(within(rail).getByText("Synthetic PPO")).toBeTruthy();
    expect(within(rail).getByText("Covers every billed day")).toBeTruthy();
    expect(within(rail).getByText("Commercial + Medicaid secondary")).toBeTruthy();
    expect(within(rail).getByText(/Medicaid other-payer loop is on the 837I/)).toBeTruthy();
    await screen.findByText("Vance, Ada", { exact: false });
  });

  it("warns that a required authorization is missing and never shows an authorization number", async () => {
    mount(() => ({ body: view() }));
    const rail = await screen.findByRole("complementary", { name: /Payer, authorization/ });
    expect(within(rail).getByText("Required, none approved on file")).toBeTruthy();
    expect(within(rail).getByText(/No authorization on file for this claim's dates/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/AUTH-/);
  });

  it("separates a soft block (overridable) from a hard block (not)", async () => {
    mount(() => ({
      body: view({
        validation: {
          runId: "run-1",
          outcome: "hard_block",
          results: [
            result({}),
            result({
              id: "r-3",
              ruleKey: "payer_route_in_effect",
              severity: "error",
              overridable: false,
              message: "No clearinghouse route is in effect.",
            }),
          ],
        },
      }),
    }));
    await screen.findByText("Soft block");
    expect(screen.getByText("Hard block")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Override / })).toHaveLength(1);
  });

  it("records an override only with a reason of at least 40 characters", async () => {
    const calls: Call[] = [];
    mount(
      () => ({ body: view() }),
      {
        [`POST ${BASE}/validation-results/r-1/override`]: () => ({
          status: 201,
          body: { overrideId: "o", auditEventId: "e", ruleKey: "authorization_on_file" },
        }),
      },
      undefined,
      calls,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Override Authorization On File" }));
    const reason = screen.getByLabelText(/Reason to override Authorization On File/);
    const submit = screen.getByRole("button", { name: "Record override" }) as HTMLButtonElement;
    fireEvent.change(reason, { target: { value: "too short" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(reason, {
      target: { value: "The payer confirmed by telephone that no authorization is required." },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/override"))).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { reason: string }).reason).toContain("payer confirmed");
  });

  it("hides the lifecycle and override controls without the write grants", async () => {
    mount(() => ({ body: view() }), {}, ["commercial_billing.read"]);
    await screen.findByRole("heading", { name: "Claim CCN-0001" });
    expect(screen.queryByRole("button", { name: "Mark ready" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Override / })).toBeNull();
  });

  it("shows the server's actionable message inline when ready is blocked", async () => {
    mount(() => ({ body: view() }), {
      [`POST ${BASE}/ready`]: () => ({
        status: 409,
        body: {
          error: {
            code: "COMMERCIAL_CLAIM_BLOCKED",
            message: "Blocked: record an authorization first.",
          },
        },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Mark ready" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Blocked: record an authorization first.");
  });

  it("reviews the server send gate and queues only after explicit confirmation", async () => {
    const calls: Call[] = [];
    const permissions = ["commercial_billing.read", "commercial_billing.submit"];
    mount(
      () => ({ body: view({ claim: { ...(view().claim as object), state: "ready" } }) }),
      {
        [`GET ${BASE}/send-gate`]: () => ({
          body: { claimId: CLAIM_ID, state: "ready", patientId: PATIENT_ID, canSubmit: true, clearinghouseKey: "synthetic-ch", reasons: [] },
        }),
        [`POST ${BASE}/submit`]: () => ({
          status: 202,
          body: { submissionId: "submission-1", claimId: CLAIM_ID, status: "queued", controlNumber: "CCN-0001", clearinghouseKey: "synthetic-ch", attemptCount: 0, requestedAt: "2026-11-08T00:00:00.000Z", replayed: false },
        }),
      },
      permissions,
      calls,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review submission checks" }));
    expect(await screen.findByText("Ready to queue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and queue submission" }));
    await screen.findByText(/Submission queued\. This confirms queueing only/);

    const submit = calls.find((call) => call.method === "POST" && call.path.endsWith("/submit"));
    expect(submit?.body).toBeUndefined();
    expect(submit?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(screen.getByText(/clearinghouse receipt is still pending/)).toBeTruthy();
  });

  it("does not offer confirmation when the server submission gate blocks the claim", async () => {
    mount(
      () => ({ body: view({ claim: { ...(view().claim as object), state: "ready" } }) }),
      {
        [`GET ${BASE}/send-gate`]: () => ({
          body: { claimId: CLAIM_ID, state: "ready", patientId: PATIENT_ID, canSubmit: false, clearinghouseKey: null, reasons: [{ code: "CH_NOT_WIRED", message: "No clearinghouse is connected." }] },
        }),
      },
      ["commercial_billing.read", "commercial_billing.submit"],
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review submission checks" }));
    expect(await screen.findByText(/No clearinghouse is connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and queue submission" })).toBeNull();
  });

  it("announces a successful action politely and moves focus into the void confirmation", async () => {
    mount(() => ({ body: view() }), {
      [`POST ${BASE}/validate`]: () => ({
        body: { runId: "run-2", outcome: "all_pass", results: [] },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Re-validate" }));
    await screen.findByText("Validation re-run. The results below are current.");

    fireEvent.click(screen.getByRole("button", { name: "Void claim" }));
    const confirm = await screen.findByRole("button", { name: "Confirm void" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(screen.getByRole("button", { name: "Keep claim" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Void claim" })),
    );
  });

  it("asks for confirmation before voiding", async () => {
    const calls: Call[] = [];
    mount(
      () => ({ body: view() }),
      { [`POST ${BASE}/void`]: () => ({ body: { claimId: CLAIM_ID, state: "void" } }) },
      undefined,
      calls,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Void claim" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm void" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/void"))).toBe(true));
  });

  it("creates a separate corrected draft only for a verified clearinghouse rejection", async () => {
    const calls: Call[] = [];
    mount(
      () => ({
        body: view({
          claim: { ...(view().claim as object), state: "rejected" },
          correction: {
            correctionOfClaimId: null,
            correctionKind: null,
            correctionReasonCode: null,
            relatedClaims: [],
            rejectedCorrection: { eligible: true, reasonCode: "VERIFIED_CLEARINGHOUSE_REJECTION" },
          },
        }),
      }),
      {
        [`POST ${BASE}/corrections/clearinghouse-rejection`]: () => ({
          status: 201,
          body: { claimId: "corrected-id", parentClaimId: CLAIM_ID, replayed: false },
        }),
      },
      undefined,
      calls,
    );
    fireEvent.change(await screen.findByRole("combobox", { name: "Correction reason" }), {
      target: { value: "clearinghouse_edit_corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create corrected draft" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" && call.path.endsWith("/corrections/clearinghouse-rejection"),
        ),
      ).toBe(true),
    );
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      reasonCode: "clearinghouse_edit_corrected",
    });
  });

  it("keeps payer-side replacements blocked when the plan rules are not verified", async () => {
    mount(() => ({
      body: view({
        claim: { ...(view().claim as object), state: "accepted" },
        correction: {
          correctionOfClaimId: null,
          correctionKind: null,
          correctionReasonCode: null,
          relatedClaims: [],
          rejectedCorrection: { eligible: false, reasonCode: "PAYER_REPLACEMENT_UNVERIFIED" },
        },
      }),
    }));
    expect(
      await screen.findByText(
        /replacement frequency and original payer control reference with the payer/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create corrected draft" })).toBeNull();
  });

  it("says the claim was not found on a 404, and offers the way back", async () => {
    mount(() => ({ status: 404, body: { error: { code: "NOT_FOUND" } } }));
    expect((await screen.findByRole("alert")).textContent).toContain("Claim not found");
    expect(screen.getByRole("link", { name: "Back to the claim queue" })).toBeTruthy();
  });
});
