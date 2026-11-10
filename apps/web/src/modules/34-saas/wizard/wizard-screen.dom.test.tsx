// @vitest-environment jsdom
// The tenant's onboarding wizard: resume on the first unsettled step, deep links, the audited read made once and again on focus no more
// often than every 30 seconds, a stale notice, locked steps read-only, and a tenant that is not onboarding read-only.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
  ok,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";
import type { WizardView } from "./wizard-model";
import { FOCUS_RELOAD_MIN_MS, OnboardingWizard } from "./wizard-screen";

const PATH = "/api/v1/tenant/onboarding";
const steps = () => [
  wizardStep("account_created", 1, { title: "Organisation", status: "done" }),
  wizardStep("plan_contract", 2, { title: "Plan and contract" }),
  wizardStep("ccn_registered", 3, {
    title: "Provider entity",
    owner: "either",
    locked: true,
    lockedBy: "plan_contract",
  }),
];
const routes = [
  { path: "/admin/onboarding", element: <OnboardingWizard /> },
  { path: "/admin/onboarding/:stepKey", element: <OnboardingWizard /> },
];
const client = (view: WizardView = wizardView(steps())) =>
  stubClient({ GET: { [PATH]: () => ok(view) } });

afterEach(() => vi.restoreAllMocks());

describe("OnboardingWizard", () => {
  it("resumes on the first step that is not settled, and counts the steps done", async () => {
    renderAt("/admin/onboarding", routes, client());
    expect(
      await screen.findByRole("heading", { level: 2, name: "Plan and contract" }),
    ).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/admin/onboarding/plan_contract");
    expect(screen.getByText("1 of 3 steps done")).toBeTruthy();
  });

  it("opens the step in the address (a deep link)", async () => {
    renderAt("/admin/onboarding/account_created", routes, client());
    expect(await screen.findByRole("heading", { level: 2, name: "Organisation" })).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/admin/onboarding/account_created");
  });

  it("says there is no such step and links to the current one", async () => {
    renderAt("/admin/onboarding/nope", routes, client());
    expect(await screen.findByText('There is no step called "nope"')).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the current step" }).getAttribute("href")).toBe(
      "/admin/onboarding/plan_contract",
    );
  });

  it("reads a locked step but offers no action on it, and names the step to finish", async () => {
    renderAt("/admin/onboarding/ccn_registered", routes, client());
    expect(await screen.findByRole("heading", { level: 2, name: "Provider entity" })).toBeTruthy();
    expect(screen.getByText("Finish Plan and contract first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start this step|mark done|skip/i })).toBeNull();
  });

  it("words the rail in the tenant's terms, never an operator's", async () => {
    renderAt("/admin/onboarding", routes, client());
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    const rail = screen.getByRole("navigation", { name: "Onboarding steps" });
    expect(rail.textContent).toMatch(/Your administrator or ChartWarden/);
    expect(rail.textContent).not.toMatch(/operator/i);
  });

  it("moves focus to the step heading when the person changes step", async () => {
    renderAt("/admin/onboarding", routes, client());
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    fireEvent.click(screen.getByRole("button", { name: /Organisation/ }));
    await waitFor(() =>
      expect(document.activeElement?.hasAttribute("data-step-heading")).toBe(true),
    );
    expect(document.activeElement?.textContent).toBe("Organisation");
  });

  it("reports a failed read with a retry", async () => {
    let calls = 0;
    const c = stubClient({
      GET: { [PATH]: () => (++calls === 1 ? refused(500, "BOOM") : ok(wizardView(steps()))) },
    });
    renderAt("/admin/onboarding", routes, c);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not load your onboarding/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Plan and contract" }),
    ).toBeTruthy();
  });

  it("is read-only once the organization is live, and says so", async () => {
    const live = wizardView(steps(), {
      tenantStatus: "active",
      goLive: {
        state: "live",
        attestation: null,
        failedGuards: [],
        complianceOfficerMembershipId: null,
      },
    });
    renderAt("/admin/onboarding/plan_contract", routes, client(live));
    expect(
      await screen.findByText("Your organization is live. Onboarding is complete."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start this step|mark done|skip/i })).toBeNull();
  });

  it("tells a tab opened before go-live to reload once the organization is live", async () => {
    const live = wizardView(steps(), {
      tenantStatus: "active",
      goLive: {
        state: "live",
        attestation: null,
        failedGuards: [],
        complianceOfficerMembershipId: null,
      },
    });
    renderAt("/admin/onboarding/plan_contract", routes, client(live), ORG_ADMIN);
    expect(
      await screen.findByText(/your organization is live\. reload to open all of chartwarden/i),
    ).toBeTruthy();
  });

  it("shows the compliance officer the steps read-only", async () => {
    renderAt(
      "/admin/onboarding/ccn_registered",
      routes,
      client(wizardView([wizardStep("ccn_registered", 1, { owner: "either" })])),
      COMPLIANCE_OFFICER,
    );
    expect(
      await screen.findByText(/only your organization's administrator can complete this step/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start this step|mark done|skip/i })).toBeNull();
  });

  it("leaves the header's help slot empty until Get help is built", async () => {
    renderAt("/admin/onboarding", routes, client());
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    expect(screen.queryByRole("button", { name: /help/i })).toBeNull();
  });
});

/** How many times the audited onboarding view was read (the plan panel makes its own, different read). */
const reads = (c: ReturnType<typeof stubClient>): number =>
  c.GET.mock.calls.filter((call) => call[0] === PATH).length;

describe("OnboardingWizard: the audited read", () => {
  it("reads again on window focus only when 30 seconds have passed since the last read", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const c = client();
    renderAt("/admin/onboarding/plan_contract", routes, c);
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    expect(reads(c)).toBe(1);

    window.dispatchEvent(new Event("focus")); // straight away: too soon
    expect(reads(c)).toBe(1);

    now += FOCUS_RELOAD_MIN_MS + 1;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(reads(c)).toBe(2));

    window.dispatchEvent(new Event("focus")); // the read above counts as the last read
    expect(reads(c)).toBe(2);
  });

  it("keeps what is on screen and says it may be out of date when a quiet reload fails", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const c = stubClient({
      GET: {
        [PATH]: () => (++calls === 1 ? ok(wizardView(steps())) : refused(503, "UNAVAILABLE")),
      },
    });
    renderAt("/admin/onboarding/plan_contract", routes, c);
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    now += FOCUS_RELOAD_MIN_MS + 1;
    window.dispatchEvent(new Event("focus"));
    expect(
      await screen.findByText(/could not refresh this page after the last change/i),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Plan and contract" })).toBeTruthy();
  });
});
