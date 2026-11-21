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
  remediationSummary: null as string | null,
  remediationFixAction: null as string | null,
  at: RUN.at,
};
const RATIONALE = "Payer portal confirmed active coverage on the service date.";

function makeApi(opts: {
  ruleConfig: unknown;
  post?: () => unknown;
  result?: typeof RESULT;
}) {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/medicaid-claims/{id}/validation-runs")
        return Promise.resolve(ok([RUN]));
      if (path === "/api/v1/medicaid-validation-runs/{id}")
        return Promise.resolve(ok({ ...RUN, results: [opts.result ?? RESULT] }));
      if (path === "/api/v1/medicaid-rule-config") return Promise.resolve(opts.ruleConfig);
      return Promise.resolve(ok([]));
    }),
    POST: vi.fn(() => Promise.resolve(opts.post ? opts.post() : ok({}))),
  } as unknown as ApiClient & { POST: ReturnType<typeof vi.fn> };
}

function renderWorklist(api: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/claims/claim-1/validation"]}>
      <ApiClientProvider client={api}>
        <Routes>
          <Route path="/claims/:claimId/validation" element={<MedicaidValidationWorklist />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

async function openModal(api: ApiClient) {
  renderWorklist(api);
  fireEvent.click(await screen.findByRole("button", { name: `Override rule ${RULE_KEY}` }));
  return screen.findByRole("dialog");
}

function renderWorklist(api: ApiClient) {
  render(
    <MemoryRouter initialEntries={["/claims/claim-1/validation"]}>
      <ApiClientProvider client={api}>
        <Routes>
          <Route path="/claims/:claimId/validation" element={<MedicaidValidationWorklist />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const rules = (role: string | null) =>
  ok([{ ruleKey: RULE_KEY, regulatoryRequired: false, overrideRoleRequired: role }]);

describe("M24 override modal acting role", () => {
  it("links an EVV remediation to the registered missing-resolution workspace", async () => {
    renderWorklist(
      makeApi({
        ruleConfig: rules("compliance_officer"),
        result: {
          ...RESULT,
          remediationFixAction: "resolve_in_m18",
          remediationSummary: "Resolve the open EVV exception before retrying validation.",
        },
      }),
    );
    expect(await screen.findByRole("link", { name: /Resolve EVV visit/ })).toHaveAttribute(
      "href",
      "/evv/missing-resolutions?status=open",
    );
  });

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

  it("does not offer override when the server has no required role", async () => {
    const api = makeApi({ ruleConfig: rules(null) });
    renderWorklist(api);
    await screen.findByText(RULE_KEY);
    expect(screen.queryByRole("button", { name: `Override rule ${RULE_KEY}` })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("does not offer override when the server rule configuration is unreadable", async () => {
    const api = makeApi({
      ruleConfig: { data: undefined, error: {}, response: new Response(null, { status: 403 }) },
    });
    renderWorklist(api);
    await screen.findByText(RULE_KEY);
    expect(screen.queryByRole("button", { name: `Override rule ${RULE_KEY}` })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
  });
});
