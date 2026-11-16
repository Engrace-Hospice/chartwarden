import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CarePlanSummary } from "../summary";

afterEach(cleanup);

const signedSummary = {
  planId: "plan-1",
  versionId: "version-initial",
  activeProblems: [{ description: "Terminal cancer", kind: "terminal" }],
  patientStatedGoals: [{ text: "Stay at home", measurableOutcome: null }],
  activeInterventions: [
    { layText: "Nurse visits", discipline: "rn", frequencyText: "Twice weekly" },
    { layText: "Physician review", discipline: "md_np", frequencyText: "Weekly" },
    { layText: "Bathing help", discipline: "chha", frequencyText: "Daily" },
  ],
  redacted: false,
};

function clientReturning(result: () => Promise<unknown>): ApiClient {
  return { GET: vi.fn(result) } as unknown as ApiClient;
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function failed(status: number) {
  return { data: undefined, error: { status }, response: new Response(null, { status }) };
}

function renderSummary(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/care-plans/plan-1/summary"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/care-plans/:planId/summary" element={<CarePlanSummary />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Care Plan summary with no signed version", () => {
  it("says there is no signed care plan instead of claiming nothing is active", async () => {
    renderSummary(
      clientReturning(async () =>
        ok({
          planId: "plan-1",
          versionId: null,
          activeProblems: [],
          patientStatedGoals: [],
          activeInterventions: [],
          redacted: false,
        }),
      ),
    );

    expect(await screen.findByText("No signed care plan yet")).toBeTruthy();
    expect(screen.queryByText("No active problems.")).toBeNull();
    expect(screen.queryByText("No active interventions.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Print summary/ })).toBeNull();
  });

  it("does not present unsigned draft rows as the care plan", async () => {
    renderSummary(clientReturning(async () => ok({ ...signedSummary, versionId: null })));

    expect(await screen.findByText("No signed care plan yet")).toBeTruthy();
    expect(screen.queryByText("Terminal cancer")).toBeNull();
  });
});

describe("Care Plan summary with a signed version", () => {
  it("names disciplines readably instead of showing raw ids", async () => {
    renderSummary(clientReturning(async () => ok(signedSummary)));

    expect(await screen.findByText(/Nursing · Twice weekly/)).toBeTruthy();
    expect(screen.getByText(/Medical · Weekly/)).toBeTruthy();
    expect(screen.getByText(/HHA · Daily/)).toBeTruthy();
    expect(screen.queryByText(/md_np/)).toBeNull();
    expect(screen.queryByText(/chha/)).toBeNull();
  });

  it("offers a print control that prints this page", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    renderSummary(clientReturning(async () => ok(signedSummary)));

    const printButton = await screen.findByRole("button", { name: /Print summary/ });
    // The handout must not print its own button: the shared print stylesheet hides this wrapper class.
    expect(printButton.closest(".wx-print-hide")).not.toBeNull();
    fireEvent.click(printButton);

    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});

describe("Care Plan summary load failures", () => {
  it("says the viewer has no access on a 403", async () => {
    renderSummary(clientReturning(async () => failed(403)));

    expect(await screen.findByText("No access")).toBeTruthy();
    expect(screen.getByText("You do not have access to this care plan summary.")).toBeTruthy();
    expect(screen.queryByText("Could not load the summary.")).toBeNull();
  });

  it("keeps the generic message for any other failure", async () => {
    renderSummary(clientReturning(async () => failed(500)));

    expect(await screen.findByText("Could not load the summary.")).toBeTruthy();
    expect(screen.queryByText("No access")).toBeNull();
  });

  it("shows the generic message, not an endless spinner, when the request throws", async () => {
    renderSummary(
      clientReturning(async () => {
        throw new Error("network down");
      }),
    );

    expect(await screen.findByText("Could not load the summary.")).toBeTruthy();
  });
});
