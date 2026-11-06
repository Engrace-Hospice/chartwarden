// @vitest-environment jsdom
// Steps 8 (MAC credentials) and 9 (payer enrollment) when the SYSTEM skipped them because the tenant bills outside ChartWarden. The step
// shows why it does not apply and offers none of its own forms. Whether the system made the skip is the server's flag (`systemSkipped`):
// a person who typed the same words on a skip of their own does not get this treatment.
import { cleanup, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MacPanel } from "./mac-panel";
import { panelFor } from "./panels";
import { SystemSkippedPanel } from "./system-skipped-panel";
import { ok, panelCtx, renderAt, stubClient, wizardStep, wizardView } from "./test-support";

const CH = "/api/v1/platform/tenants/{orgSlug}/clearinghouse";
const OUTSIDE = { vendor: "outside", mode: null, status: "active", source: "tenant" };
const VENDOR = { vendor: "claimmd", mode: "production", status: "active", source: "tenant" };

const skipped = (key: string, over = {}) =>
  wizardStep(key, 1, {
    title: key === "mac_configured" ? "Billing: MAC credentials" : "Billing: payer enrollment",
    status: "skipped",
    systemSkipped: true,
    skipRationale: "bills outside ChartWarden",
    attestedBy: {
      actorKind: "platform_ops",
      membershipId: null,
      label: "System",
      at: "2026-11-05T10:00:00.000Z",
    },
    ...over,
  });

function mount(step: ReturnType<typeof wizardStep>, choice: unknown = OUTSIDE, view = {}) {
  const client = stubClient({ GET: { [CH]: () => ok(choice) } });
  const ctx = panelCtx(wizardView([step], view), step.key);
  renderAt("/x", [{ path: "/x", element: <SystemSkippedPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => cleanup());

describe("panelFor: which panel draws a skipped step", () => {
  it("gives the system's skip its own panel, and a person's skip of the same step (even with the same words) the step's own", () => {
    expect(panelFor(skipped("mac_configured")).Panel).toBe(SystemSkippedPanel);
    expect(panelFor(skipped("payer_enrollment")).Panel).toBe(SystemSkippedPanel);
    expect(panelFor(skipped("mac_configured", { systemSkipped: false })).Panel).toBe(MacPanel);
  });

  it("gives a step that is not skipped its own panel even when the flag is set (a reopened step is no longer skipped)", () => {
    expect(panelFor(skipped("mac_configured", { status: "pending" })).Panel).toBe(MacPanel);
  });
});

describe("SystemSkippedPanel", () => {
  it("says why MAC credentials do not apply, says it was automatic, and offers no form, skip or attestation", async () => {
    mount(skipped("mac_configured"));
    expect(await screen.findByText(/no MAC submitter credential to enter/i)).toBeTruthy();
    expect(screen.getAllByText(/Skipped automatically/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Add MAC credential/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Skip this step|Mark done with evidence/ }),
    ).toBeNull();
  });

  it("says why payer enrollment does not apply", async () => {
    mount(skipped("payer_enrollment"));
    expect(await screen.findByText(/payer enrollment is not tracked here/i)).toBeTruthy();
  });

  it("still lets an operator re-open the step (the step frame's own action), because nothing is hidden behind the skip", async () => {
    mount(skipped("mac_configured"));
    await screen.findByText(/no MAC submitter credential to enter/i);
    expect(screen.getByRole("button", { name: "Re-open to edit" })).toBeTruthy();
  });

  it("warns when the tenant has since chosen a vendor, so the step applies again, and says how to get it back", async () => {
    mount(skipped("mac_configured"), VENDOR);
    expect(await screen.findByText(/now bills through Claim\.MD/)).toBeTruthy();
    expect(screen.getByText(/re-opens by itself/)).toBeTruthy();
  });

  it("does not warn while the tenant still bills outside, or when the choice cannot be read", async () => {
    mount(skipped("mac_configured"), OUTSIDE);
    await screen.findByText(/no MAC submitter credential to enter/i);
    expect(screen.queryByText(/now bills through/)).toBeNull();
    cleanup();
    const client = stubClient({
      GET: { [CH]: () => ({ error: { error: { code: "X" } }, response: { status: 500 } }) },
    });
    const ctx = panelCtx(wizardView([skipped("mac_configured")]), "mac_configured");
    renderAt("/x", [{ path: "/x", element: <SystemSkippedPanel ctx={ctx} /> }], client);
    await screen.findByText(/no MAC submitter credential to enter/i);
    expect(screen.queryByText(/now bills through/)).toBeNull();
  });
});
