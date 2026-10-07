import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimEditor } from "../claim-editor";
import { ClaimWorkbench } from "../claim-workbench";
import { missingDischargeDetailOf, normalizeRemediation } from "../validation-remediation";
import { ValidationWorklist } from "../validation-worklist";

// The workbench's lookup fields hit their own APIs; they are exercised in shell/entity-lookups tests.
vi.mock("../../../shell/entity-lookups", () => ({
  ProviderEntityLookupField: () => null,
  PatientLookupField: () => null,
}));

const CLAIM = "c1c1c1c1-0000-4000-8000-000000000001";
const ADM = "a1a1a1a1-0000-4000-8000-000000000001";
const RUN = "r1r1r1r1-0000-4000-8000-000000000001";

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number) => ({
  data: undefined,
  error: { error: { code: "X" } },
  response: new Response(null, { status }),
});

function mount(path: string, el: JSX.Element, routePath: string, client: object) {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={el} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const missingResult = (remediation: unknown) => ({
  resultId: "res-1",
  validationRunId: RUN,
  ruleKey: "bereavement_discharge_legitimacy",
  ruleVersion: 3,
  severity: "error",
  outcome: "fail",
  remediation,
  overridden: false,
  override: null,
  recordedAt: "2026-10-01T00:00:00Z",
});
const FLAT = {
  summary: "CMS requires the patient status on the final claim. …",
  blameTarget: "admission",
  blameTargetId: ADM,
  fixAction: "fix_discharge_details",
  fixDeepLink: `/admissions/${ADM}/discharge-details?claimId=${CLAIM}`,
  defects: [
    {
      code: "PLACE_OF_DEATH_MISSING",
      message: "death discharge has no place of death recorded",
      refs: { admissionId: ADM, claimId: CLAIM, dischargeEventId: "de-1" },
    },
  ],
};

describe("validation remediation reading", () => {
  it("reads the flat and the legacy nested shape alike", () => {
    expect(normalizeRemediation(FLAT)?.fixAction).toBe("fix_discharge_details");
    expect(
      normalizeRemediation({
        remediation: { summary: "Fix it", fixAction: "edit_claim" },
        observed: {},
      }),
    ).toMatchObject({ summary: "Fix it", fixAction: "edit_claim" });
    expect(normalizeRemediation({})).toBeNull();
  });
  it("finds the missing discharge detail on an un-overridden failure only", () => {
    expect(missingDischargeDetailOf([missingResult(FLAT)])).toEqual({
      detail: "place_of_death",
      admissionId: ADM,
      fixDeepLink: FLAT.fixDeepLink,
    });
    expect(missingDischargeDetailOf([{ ...missingResult(FLAT), overridden: true }])).toBeNull();
  });
});

describe("ValidationWorklist — missing discharge details", () => {
  it("shows the guided panel with the values, codes and the Fix discharge details action", async () => {
    const GET = vi.fn(async (path: string) => {
      if (path === "/api/v1/claims/{id}/validation-runs")
        return ok({
          claimId: CLAIM,
          runs: [
            {
              validationRunId: RUN,
              claimId: CLAIM,
              trigger: "manual_re_run",
              outcome: "overrides_required",
              rulesExecuted: 19,
              rulesPassed: 18,
              rulesFailed: 1,
              rulesWarn: 0,
              rulesInfo: 0,
              startedAt: "2026-10-01T00:00:00Z",
              completedAt: "2026-10-01T00:00:01Z",
              durationMs: 1,
            },
          ],
        });
      if (path === "/api/v1/claims/{id}/validation-runs/{runId}")
        return ok({ validationRunId: RUN, results: [missingResult(FLAT)] });
      return fail(403);
    });
    mount(
      `/billing/claims/${CLAIM}/validation`,
      <ValidationWorklist />,
      "/billing/claims/:claimId/validation",
      {
        GET,
        POST: vi.fn(),
      },
    );
    expect(await screen.findByText("Claim held: missing discharge details")).toBeTruthy();
    expect(screen.getByText(/recorded before WardenX captured the place of death/)).toBeTruthy();
    const choices = screen.getByRole("list", { name: "place of death choices" });
    expect(choices.textContent).toMatch(/40.*At home.*41.*In a facility.*42.*Place not known/);
    // The panel's action and the result row's own remediation CTA both lead to the guided M6 screen.
    const links = screen.getAllByRole("link", { name: "Fix discharge details" });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute("href")).toBe(FLAT.fixDeepLink);
  });
});

const detail = (over: Record<string, unknown> = {}) => ({
  claimId: CLAIM,
  providerEntityId: "pe-1",
  patientId: "p-1",
  admissionId: ADM,
  tob: "812",
  state: "ready",
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  claimControlNumber: "CCN-1",
  payerClaimControlNumber: null,
  macJurisdiction: "ngs_j6",
  totalChargeCents: 100,
  totalExpectedPaymentCents: 90,
  version: 3,
  sequestrationAppliedPct: "2.0",
  sequestrationPolicyId: "sp-1",
  replacesClaimId: null,
  replacedByClaimId: null,
  replacementReason: null,
  latestValidation: null,
  pricing: { hipps: null, sia: null },
  attention: {
    stayEnd: { kind: "revocation", effectiveDate: "2026-03-20" },
    typeOfBill: { stored: "812", derived: "811", changed: true, remedy: "revalidate" },
    missingDischargeDetail: null,
    flags: ["tob_changed"],
  },
  ...over,
});

describe("ClaimEditor — type of bill", () => {
  afterEach(() => window.history.pushState({}, "", "/"));

  function editor(claim: unknown, POST = vi.fn(async () => ok({ validationRunId: RUN }, 202))) {
    window.history.pushState({}, "", `/billing/claims/${CLAIM}`);
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/billing/claims/{id}" ? ok(claim) : ok([]),
    );
    mount(`/billing/claims/${CLAIM}`, <ClaimEditor />, "/billing/claims/:claimId", { GET, POST });
    return { GET, POST };
  }

  it("explains an unsubmitted TOB change and re-runs validation", async () => {
    const { GET, POST } = editor(detail());
    const notice = await screen.findByLabelText("Type of bill changed");
    expect(notice.textContent).toMatch(/Type of bill changed: 812 → 811/);
    expect(notice.textContent).toMatch(/stay ended by revocation on 03\/20\/2026/);
    expect(notice.textContent).toMatch(/Re-run validation and the type of bill is updated to 811/);
    fireEvent.click(screen.getByRole("button", { name: "Re-run validation" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/claims/{id}/validate", {
        params: { path: { id: CLAIM } },
      }),
    );
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(2)); // reloaded
  });

  it("asks for a replacement on a paid claim and opens the TOB-817 ceremony", async () => {
    editor(
      detail({
        state: "paid",
        attention: {
          stayEnd: { kind: "transfer", effectiveDate: "2026-03-31" },
          typeOfBill: { stored: "813", derived: "814", changed: true, remedy: "replace" },
          missingDischargeDetail: null,
          flags: ["tob_changed"],
        },
        tob: "813",
      }),
    );
    expect((await screen.findByLabelText("Type of bill changed")).textContent).toMatch(
      /Build a replacement claim \(TOB 817\)/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Build replacement claim (TOB 817)" }));
    expect(await screen.findByText("Replace claim (TOB 817)")).toBeTruthy();
  });

  it("states the wait-then-replace step for a submitted claim, and explains an unchanged final TOB", async () => {
    editor(
      detail({
        state: "submitted",
        attention: {
          stayEnd: { kind: "revocation", effectiveDate: "2026-03-20" },
          typeOfBill: {
            stored: "812",
            derived: "811",
            changed: true,
            remedy: "await_acknowledgment",
          },
          missingDischargeDetail: null,
          flags: ["tob_changed"],
        },
      }),
    );
    expect((await screen.findByLabelText("Type of bill changed")).textContent).toMatch(
      /wait for the acknowledgment, then use Replace/,
    );
    expect(screen.queryByRole("button", { name: "Re-run validation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build replacement claim (TOB 817)" })).toBeNull();
  });

  it("shows how a current TOB was derived, and the missing-details panel", async () => {
    editor(
      detail({
        tob: "811",
        state: "validating",
        attention: {
          stayEnd: { kind: "death", effectiveDate: "2026-03-12" },
          typeOfBill: { stored: "811", derived: "811", changed: false, remedy: null },
          missingDischargeDetail: {
            detail: "place_of_death",
            admissionId: ADM,
            dischargeEventId: "de-1",
            transferEventId: null,
            fixPath: `/admissions/${ADM}/discharge-details?claimId=${CLAIM}`,
          },
          flags: ["missing_discharge_details"],
        },
      }),
    );
    expect(
      await screen.findByText("Final claim — the stay ended by the patient's death on 03/12/2026."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Type of bill changed")).toBeNull();
    expect(screen.getByRole("link", { name: "Fix discharge details" }).getAttribute("href")).toBe(
      `/admissions/${ADM}/discharge-details?claimId=${CLAIM}`,
    );
  });
});

describe("ClaimWorkbench — needs-attention filter", () => {
  it("sends the attention filter and shows the row chips", async () => {
    const GET = vi.fn(async () =>
      ok({
        items: [
          {
            ...detail(),
            attention: {
              ...detail().attention,
              flags: ["missing_discharge_details", "tob_changed"],
            },
          },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    );
    mount("/billing/claims", <ClaimWorkbench />, "/billing/claims", { GET, POST: vi.fn() });
    expect(await screen.findByText("Missing discharge details")).toBeTruthy();
    expect(screen.getByText("TOB now 811")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Needs attention"), {
      target: { value: "tob_changed" },
    });
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith("/api/v1/billing/claims", {
        params: { query: { limit: 50, attention: "tob_changed" } },
      }),
    );
  });
});
