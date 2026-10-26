// The override modal must match the server (PR #825): the claimed role is the rule's required role, not a free pick.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MedicaidValidationWorklist } from "../validation-worklist";

afterEach(cleanup);

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const RULE_KEY = "eligibility_active";
const RUN = {
  id: "run-1",
  medicaidClaimId: "claim-1",
  ruleRegistryVersion: "1.0.0",
  triggeredBy: "manual",
  claimStateAtTrigger: "DRAFT",
  at: "2026-10-01T10:00:00.000Z",
  completedAt: "2026-10-01T10:00:01.000Z",
  totalResults: 1,
  failedResults: 1,
  warnedResults: 0,
};
const RESULT = {
  id: "res-1",
  medicaidValidationRunId: "run-1",
  ruleKey: RULE_KEY,
  ruleVersion: 1,
  outcome: "fail",
  remediationSummary: null,
  remediationFixAction: null,
  at: RUN.at,
};
const RATIONALE = "Payer portal confirmed active coverage on the service date.";

function makeApi(opts: { ruleConfig: unknown; post?: () => unknown }) {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/medicaid-claims/{id}/validation-runs")
        return Promise.resolve(ok([RUN]));
      if (path === "/api/v1/medicaid-validation-runs/{id}")
        return Promise.resolve(ok({ ...RUN, results: [RESULT] }));
      if (path === "/api/v1/medicaid-rule-config") return Promise.resolve(opts.ruleConfig);
      return Promise.resolve(ok([]));
    }),
    POST: vi.fn(() => Promise.resolve(opts.post ? opts.post() : ok({}))),
  } as unknown as ApiClient & { POST: ReturnType<typeof vi.fn> };
}

async function openModal(api: ApiClient) {
  render(
    <MemoryRouter initialEntries={["/claims/claim-1/validation"]}>
      <ApiClientProvider client={api}>
        <Routes>
          <Route path="/claims/:claimId/validation" element={<MedicaidValidationWorklist />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: `Override rule ${RULE_KEY}` }));
  return screen.findByRole("dialog");
}

const rules = (role: string | null) =>
  ok([{ ruleKey: RULE_KEY, regulatoryRequired: false, overrideRoleRequired: role }]);

describe("M24 override modal acting role", () => {
  it("fixes the acting role to the rule's required role (no free pick)", async () => {
    await openModal(makeApi({ ruleConfig: rules("compliance_officer") }));
    expect(screen.queryByRole("combobox", { name: "Override role" })).toBeNull();
    expect(screen.getByTestId("override-acting-role").textContent).toBe("Compliance Officer");
  });

  it("posts the required role as overrideRoleClaimed", async () => {
    const api = makeApi({ ruleConfig: rules("medical_director") });
    await openModal(api);
    fireEvent.change(screen.getByLabelText("Override rationale"), { target: { value: RATIONALE } });
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() => expect(api.POST).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/medicaid-validation-results/{id}/override",
      expect.objectContaining({
        body: expect.objectContaining({ overrideRoleClaimed: "medical_director" }),
      }),
    );
  });

  it("still shows the inline 403 message for an actor who lacks the role", async () => {
    const api = makeApi({
      ruleConfig: rules("org_admin"),
      post: () => ({
        data: undefined,
        error: { error: { code: "FORBIDDEN" } },
        response: new Response(null, { status: 403 }),
      }),
    });
    await openModal(api);
    fireEvent.change(screen.getByLabelText("Override rationale"), { target: { value: RATIONALE } });
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Org Admin/);
  });

  it("says the rule cannot be overridden when it has no required role", async () => {
    const api = makeApi({ ruleConfig: rules(null) });
    await openModal(api);
    fireEvent.change(screen.getByLabelText("Override rationale"), { target: { value: RATIONALE } });
    expect(screen.getByText(/cannot be overridden/i)).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Apply override" });
    expect(apply).toHaveProperty("disabled", true);
    fireEvent.click(apply);
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("falls back to a role pick (default billing_manager) when the rule config is unreadable", async () => {
    const api = makeApi({
      ruleConfig: { data: undefined, error: {}, response: new Response(null, { status: 403 }) },
    });
    await openModal(api);
    expect(screen.getByRole("combobox", { name: "Override role" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Override rationale"), { target: { value: RATIONALE } });
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() => expect(api.POST).toHaveBeenCalled());
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/medicaid-validation-results/{id}/override",
      expect.objectContaining({
        body: expect.objectContaining({ overrideRoleClaimed: "billing_manager" }),
      }),
    );
  });
});
