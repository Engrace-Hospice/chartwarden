// @vitest-environment jsdom
// Step 10, e-Prescribing kickoff, on the tenant's side. In this tree step 10 is an ordinary wizard step: the panel is DoseSpot copy, the
// "This does not apply to us" entry point (the frame owns the skip), and an empty seam for the clinic registration. It reads only the
// step view the shell hands it: it calls no API, so a branch that auto-settles the step, or fills the seam, changes nothing here.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoseSpotPanel } from "./dosespot-panel";
import { DoseSpotRegistrationSlot } from "./dosespot-registration-slot";
import type { StepPanelProps, TenantWizardStep } from "./panel-props";
import {
  ORG_ADMIN,
  type StubClient,
  panelProps,
  renderPanel,
  stubClient,
  tenantStep,
  tenantView,
} from "./panel-test-support";

const KEY = "dosespot_kickoff_initiated";

function mount(
  stepOver: Partial<TenantWizardStep> = {},
  options: { roles?: string[]; skipAvailable?: boolean } = {},
): { props: StepPanelProps; client: StubClient } {
  const view = tenantView([
    tenantStep("mac_configured", 1, { status: "done" }),
    tenantStep(KEY, 2, { tenantSkippable: true, ...stepOver }),
  ]);
  const session = { ...ORG_ADMIN, roles: options.roles ?? ORG_ADMIN.roles };
  const props = panelProps(
    view,
    KEY,
    { skip: { available: options.skipAvailable ?? false, request: vi.fn() } },
    session as typeof ORG_ADMIN,
  );
  const client = stubClient({});
  renderPanel(<DoseSpotPanel {...props} />, client, "/x", session as typeof ORG_ADMIN);
  return { props, client };
}

afterEach(cleanup);

describe("DoseSpotPanel", () => {
  it("explains what the kickoff is and how to record it, and calls no API", () => {
    const { client } = mount();
    expect(screen.getByRole("heading", { name: "e-Prescribing with DoseSpot" })).toBeTruthy();
    expect(screen.getByText(/ChartWarden sends prescriptions through DoseSpot/)).toBeTruthy();
    expect(screen.getByText(/Mark done with evidence/)).toBeTruthy();
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(client[method]).not.toHaveBeenCalled();
    }
  });

  it("only HINTS at skipping when the frame says the member may skip: the frame owns the one Skip button", () => {
    const { props } = mount({}, { skipAvailable: true });
    expect(screen.getByText(/use Skip this step below/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(props.skip.request).not.toHaveBeenCalled();
  });

  it("shows no skip hint when the frame does not offer a skip", () => {
    mount();
    expect(screen.queryByText(/use Skip this step below/)).toBeNull();
  });

  it("says a recorded kickoff is recorded", () => {
    mount({ status: "done" });
    expect(screen.getByText("The DoseSpot kickoff is recorded.")).toBeTruthy();
    expect(screen.queryByText(/Mark done with evidence/)).toBeNull();
  });

  it.each([
    ["tenant", /Your organization skipped this step/],
    ["platform_ops", /ChartWarden operations skipped this step/],
    ["system", /skipped automatically/],
  ] as const)("says who skipped it: %s", (skippedBy, text) => {
    mount({ status: "skipped", skippedBy, systemSkipped: skippedBy === "system" });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("is read-only for a member who is not an organization administrator", () => {
    mount({}, { roles: ["compliance_officer"] });
    expect(screen.getByText(/Your administrator records this step/)).toBeTruthy();
  });

  it("does not show the read-only note to an organization administrator", () => {
    mount();
    expect(screen.queryByText(/Your administrator records this step/)).toBeNull();
  });
});

describe("DoseSpotRegistrationSlot", () => {
  it("renders nothing: the DoseSpot branch fills the seam", () => {
    const { container } = render(<DoseSpotRegistrationSlot />);
    expect(container.innerHTML).toBe("");
  });
});
