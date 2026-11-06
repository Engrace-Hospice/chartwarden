// @vitest-environment jsdom
// Step 14, Go-live: two people. The tenant's compliance officer attests readiness in the tenant app; a different platform operator
// approves here (fresh step-up, a reason), and only then does the tenant go active. The panel shows where it stands and offers
// exactly what this operator can do in that state.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { GoLivePanel } from "./go-live-panel";
import {
  ORG_SLUG,
  ok,
  panelCtx,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";
import type { WizardView } from "./wizard-model";

const APPROVE = "/api/v1/platform/tenants/{orgSlug}/go-live/approve";
const REVOKE = "/api/v1/platform/tenants/{orgSlug}/go-live/revoke";
const NOW = Date.now();
const iso = (offsetDays: number): string => new Date(NOW + offsetDays * 86_400_000).toISOString();

type Attestation = NonNullable<WizardView["goLive"]["attestation"]>;
const attestation = (over: Partial<Attestation> = {}): Attestation => ({
  id: "att-1",
  status: "pending",
  attestedByMembershipId: "m-officer",
  attestedAt: iso(-2),
  expiresAt: iso(12),
  attestationNote: "All records reviewed with the administrator",
  approvedByMembershipId: null,
  approvedByLabel: null,
  approvedAt: null,
  approvalReason: null,
  revokedByMembershipId: null,
  revokedByLabel: null,
  revokedAt: null,
  revokeReason: null,
  ...over,
});
const wizard = (
  state: WizardView["goLive"]["state"],
  goLive: Partial<WizardView["goLive"]> = {},
  over: Partial<WizardView> = {},
) =>
  wizardView(
    [
      wizardStep("account_created", 1, { title: "Organisation", status: "done" }),
      wizardStep("baa_executed", 2, {
        title: "BAA",
        status: state === "not_ready" ? "pending" : "done",
        completionMode: "auto",
      }),
      wizardStep("go_live_checklist_complete", 3, {
        title: "Go-live",
        owner: "compliance_officer",
      }),
    ],
    {
      goLive: {
        state,
        attestation: null,
        failedGuards: [],
        complianceOfficerMembershipId: "m-officer",
        ...goLive,
      },
      ...over,
    },
  );
function mount(view: WizardView, extra: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient(extra);
  const ctx = panelCtx(view, "go_live_checklist_complete");
  renderAt("/x", [{ path: "/x", element: <GoLivePanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

describe("GoLivePanel: not ready", () => {
  it("lists what is still open, each a link to its step, and offers no approval", () => {
    mount(wizard("not_ready", { failedGuards: ["baaExecuted"] }));
    expect(screen.getByText(/opens once every earlier step is settled/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "BAA" }).getAttribute("href")).toBe(
      "/tenants/cedar-ridge/onboarding/baa_executed",
    );
    expect(screen.getByText(/latest BAA is executed/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve go-live/ })).toBeNull();
  });
});

describe("GoLivePanel: awaiting the officer", () => {
  it("says who it is waiting for", () => {
    mount(wizard("awaiting_attestation"));
    expect(
      screen.getByText(/Waiting for the compliance officer to attest readiness/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve go-live/ })).toBeNull();
  });

  it("points at the officer step when nobody is assigned", () => {
    mount(wizard("awaiting_attestation", { complianceOfficerMembershipId: null }));
    expect(screen.getByRole("link", { name: /Assign a compliance officer/ })).toBeTruthy();
  });
});

describe("GoLivePanel: awaiting approval", () => {
  const ready = () => wizard("awaiting_approval", { attestation: attestation() });

  it("shows the attestation, its note and how long it stays approvable", () => {
    mount(ready());
    expect(screen.getByText(/All records reviewed with the administrator/)).toBeTruthy();
    expect(screen.getByText(/days left to approve/i)).toBeTruthy();
    expect(screen.getByText(/different operator approves/i)).toBeTruthy();
  });

  it("approves behind a reason and reloads the wizard", async () => {
    const { client, ctx } = mount(ready(), { POST: { [APPROVE]: () => ok(wizard("live")) } });
    fireEvent.click(screen.getByRole("button", { name: "Approve go-live" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Checked the BAA and the officer's attestation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: unknown },
    ];
    expect(path).toBe(APPROVE);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.body).toEqual({ reason: "Checked the BAA and the officer's attestation" });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("revokes the attestation behind a reason, so the officer can attest again", async () => {
    const { client } = mount(ready(), {
      POST: { [REVOKE]: () => ok(wizard("awaiting_attestation")) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke attestation" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "The BAA needs another look first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[0]).toBe(REVOKE);
  });

  it.each([
    ["GO_LIVE_SAME_PERSON", /different operator must approve/i],
    ["GO_LIVE_APPROVER_WROTE_BAA", /You recorded this tenant's BAA/],
    ["ORGANIZATION_ACTIVATION_FAILED", /Approve again to retry/],
  ])("tells the operator what %s means", async (code, words) => {
    mount(ready(), { POST: { [APPROVE]: () => refused(409, code, "x") } });
    fireEvent.click(screen.getByRole("button", { name: "Approve go-live" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Checked everything with the officer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(words)).toBeTruthy();
  });

  it("lists every guard that failed when approval is refused, and what is still open", async () => {
    mount(ready(), {
      POST: {
        [APPROVE]: () =>
          refused(409, "GO_LIVE_GUARDS_FAILED", "approval refused", [
            {
              field: "baaExecuted",
              code: "GUARD_FAILED",
              message: "the latest platform BAA must be executed",
            },
          ]),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve go-live" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "Checked everything with the officer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/approval refused/)).toBeTruthy();
  });

  it("an expired attestation can only be revoked", () => {
    mount(
      wizard("awaiting_approval", {
        attestation: attestation({ attestedAt: iso(-20), expiresAt: iso(-6) }),
      }),
    );
    expect(screen.getByText(/more than 14 days old/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Approve go-live" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Revoke attestation" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a guard that fails now is shown before the operator tries", () => {
    mount(
      wizard("awaiting_approval", {
        attestation: attestation(),
        failedGuards: ["baaExpiryClearsNinetyDays"],
      }),
    );
    expect(screen.getByText(/more than 90 days left/i)).toBeTruthy();
  });
});

describe("GoLivePanel: after", () => {
  it("shows a live tenant as approved, who approved and why", () => {
    mount(
      wizard(
        "live",
        {
          attestation: attestation({
            status: "approved",
            approvedAt: iso(-1),
            approvedByMembershipId: "m-op",
            approvalReason: "Everything checked",
            expiresAt: null,
          }),
        },
        { tenantStatus: "active" },
      ),
    );
    expect(screen.getByText(/This tenant is live/)).toBeTruthy();
    expect(screen.getByText("Everything checked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve go-live" })).toBeNull();
  });

  it("says onboarding is closed for any other state", () => {
    mount(wizard("closed", {}, { tenantStatus: "suspended" }));
    expect(screen.getByText(/Onboarding is closed/)).toBeTruthy();
  });
});
