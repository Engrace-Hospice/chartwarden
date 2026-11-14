// @vitest-environment jsdom
// Who skipped a step, in the step's evidence card: the operator approving go-live reads it as plain text, from what the server recorded
// (`skippedBy`), never from the rationale's wording. A step that is not skipped says nothing about it.
import { cleanup, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StepFrame } from "./step-frame";
import { panelCtx, renderAt, stubClient, wizardStep, wizardView } from "./test-support";

const skipped = (over = {}) =>
  wizardStep("mac_configured", 3, {
    title: "Billing: MAC credentials",
    status: "skipped",
    skipRationale: "We bill our payers through our own clearinghouse",
    skippable: true,
    ...over,
  });

function mount(step: ReturnType<typeof wizardStep>) {
  const ctx = panelCtx(wizardView([step]), step.key);
  renderAt("/x", [{ path: "/x", element: <StepFrame ctx={ctx} /> }], stubClient({}));
}
beforeEach(() => cleanup());

describe("the evidence card of a skipped step says who skipped it", () => {
  it("names the organization for the tenant's own skip, with the reason it gave", async () => {
    mount(skipped({ skippedBy: "tenant" }));
    expect(await screen.findByText("Skipped by the organization")).toBeTruthy();
    expect(screen.getByText("We bill our payers through our own clearinghouse")).toBeTruthy();
    expect(screen.queryByText(/Skipped by ChartWarden operations/)).toBeNull();
    expect(screen.queryByText(/Skipped by the system/)).toBeNull();
  });

  it("names ChartWarden operations for an operator's skip", async () => {
    mount(skipped({ skippedBy: "platform_ops" }));
    expect(await screen.findByText("Skipped by ChartWarden operations")).toBeTruthy();
    expect(screen.queryByText(/Skipped by the organization/)).toBeNull();
  });

  it("names the system for the clearinghouse sync's skip, next to why it happened", async () => {
    mount(
      skipped({
        skippedBy: "system",
        systemSkipped: true,
        skipRationale: "bills outside ChartWarden",
      }),
    );
    expect(await screen.findByText("Skipped by the system")).toBeTruthy();
    expect(
      screen.getByText(/Skipped automatically because this tenant bills outside/),
    ).toBeTruthy();
  });

  it("shows the line even for a skip that carries no reason, so the card is never silent about who skipped", async () => {
    mount(skipped({ skippedBy: "tenant", skipRationale: null }));
    expect(await screen.findByText("Skipped by the organization")).toBeTruthy();
  });

  it("says nothing about a skip for a step that is done, or one that is not settled", () => {
    mount(
      wizardStep("mac_configured", 3, {
        status: "done",
        evidence: { note: "credential on file", ref: null },
        skippedBy: null,
      }),
    );
    expect(screen.queryByText(/Skipped by/)).toBeNull();
    cleanup();
    mount(wizardStep("mac_configured", 3, { status: "pending", skippedBy: null }));
    expect(screen.queryByText(/Skipped by/)).toBeNull();
  });
});
