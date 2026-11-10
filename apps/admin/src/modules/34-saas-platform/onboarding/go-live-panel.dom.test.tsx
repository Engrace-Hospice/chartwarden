// @vitest-environment jsdom
// Step 14, Go-live: two people. The tenant's compliance officer attests readiness in the tenant app; a different platform operator
// approves here (fresh step-up, a reason), and only then does the tenant go active. The panel shows where it stands and offers
// exactly what this operator can do in that state.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type JSX, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { GoLivePanel } from "./go-live-panel";
import {
  ONBOARDING_OPERATOR,
  ORG_SLUG,
  RETURNED_FROM_STEP_UP,
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
function mount(
  view: WizardView,
  extra: Parameters<typeof stubClient>[0] = {},
  session: Parameters<typeof renderAt>[3] = ONBOARDING_OPERATOR,
  at: Parameters<typeof renderAt>[0] = "/x",
) {
  const client = stubClient(extra);
  const ctx = panelCtx(view, "go_live_checklist_complete");
  renderAt(at, [{ path: "/x", element: <GoLivePanel ctx={ctx} /> }], client, session);
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

  it("without the approval key, offers neither approve nor revoke and says so once", () => {
    mount(
      ready(),
      {},
      {
        ...ONBOARDING_OPERATOR,
        permissions:
          ONBOARDING_OPERATOR.permissions?.filter((k) => k !== "go_live.approve_platform") ?? [],
      },
    );
    expect(screen.queryByRole("button", { name: "Approve go-live" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke attestation" })).toBeNull();
    expect(screen.getAllByText(/Your role cannot/)).toHaveLength(1);
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
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.body).toEqual({ reason: "Checked the BAA and the officer's attestation" });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  // Approving or revoking moves the wizard to another state, and the buttons that opened the prompt go with the old one: focus must land
  // on the outcome, not fall to the page.
  it.each([
    {
      what: "approving",
      from: () => ready(),
      to: () => wizard("live"),
      trigger: "Approve go-live",
      confirm: "Approve",
      path: APPROVE,
      outcome: /Approved\. The tenant is live/,
    },
    {
      what: "revoking",
      from: () => ready(),
      to: () => wizard("awaiting_attestation"),
      trigger: "Revoke attestation",
      confirm: "Revoke",
      path: REVOKE,
      outcome: /Attestation revoked/,
    },
  ])(
    "moves focus to the outcome when $what removes the buttons that opened the prompt",
    async ({ from, to, trigger, confirm, path, outcome }) => {
      function Host(): JSX.Element {
        const [view, set] = useState(from());
        const ctx = {
          ...panelCtx(view, "go_live_checklist_complete"),
          refresh: async () => set(to()),
        };
        return <GoLivePanel ctx={ctx} />;
      }
      const client = stubClient({ POST: { [path]: () => ok({}) } });
      renderAt("/x", [{ path: "/x", element: <Host /> }], client);
      fireEvent.click(screen.getByRole("button", { name: trigger }));
      fireEvent.change(screen.getByLabelText(/^Reason/), {
        target: { value: "Checked the BAA and the officer's attestation" },
      });
      fireEvent.click(screen.getByRole("button", { name: confirm }));
      const banner = await screen.findByText(outcome);
      await waitFor(() => expect(screen.queryByRole("button", { name: trigger })).toBeNull());
      await waitFor(() => expect(document.activeElement).not.toBe(document.body));
      expect(document.activeElement?.contains(banner)).toBe(true);
    },
  );

  it("the outcome banner belongs to the state it was written for: a later state does not inherit it", async () => {
    let setView: (v: WizardView) => void = () => undefined;
    function Host({ initial }: { initial: WizardView }): JSX.Element {
      const [view, set] = useState(initial);
      setView = set;
      return <GoLivePanel ctx={panelCtx(view, "go_live_checklist_complete")} />;
    }
    const client = stubClient({ POST: { [REVOKE]: () => ok(wizard("awaiting_attestation")) } });
    renderAt(
      "/x",
      [
        {
          path: "/x",
          element: <Host initial={wizard("awaiting_approval", { attestation: attestation() })} />,
        },
      ],
      client,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke attestation" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), {
      target: { value: "The BAA needs another look first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText(/Attestation revoked/)).toBeTruthy();
    // the wizard reloads into the state the revoke produced: its banner stays
    act(() => setView(wizard("awaiting_attestation")));
    expect(screen.getByText(/Attestation revoked/)).toBeTruthy();
    // the officer attests again: the new waiting-for-approval state does not inherit the old banner
    act(() => setView(wizard("awaiting_approval", { attestation: attestation({ id: "att-2" }) })));
    expect(screen.queryByText(/Attestation revoked/)).toBeNull();
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

  const approveWith = (reason = "Checked everything with the officer") => {
    fireEvent.click(screen.getByRole("button", { name: "Approve go-live" }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  };

  it.each([
    ["GO_LIVE_SAME_PERSON", /different operator must approve/i],
    ["GO_LIVE_APPROVER_WROTE_BAA", /You recorded this tenant's BAA/],
  ])("tells the operator what %s means", async (code, words) => {
    mount(ready(), { POST: { [APPROVE]: () => refused(409, code, "x") } });
    approveWith();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(words)).toBeTruthy();
  });

  // The server answers 503, not 409: the approval IS recorded, only opening the organization failed. The prompt stays so the operator
  // can approve again (it only finishes the activation), and the reference is quoted because it is not their doing.
  it("an organization that could not be opened (503 ORGANIZATION_ACTIVATION_FAILED) says approve again, quotes the reference and keeps the prompt", async () => {
    const { ctx } = mount(ready(), {
      POST: { [APPROVE]: () => refused(503, "ORGANIZATION_ACTIVATION_FAILED", "x") },
    });
    approveWith();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Approve again to retry/)).toBeTruthy();
    expect(within(dialog).getByText(/Reference: corr-test/)).toBeTruthy();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });

  it("ACTIVATION_GUARDS_FAILED lists each failing guard and each step still open in plain words, never a raw key, and reloads the view", async () => {
    const { ctx } = mount(ready(), {
      POST: {
        [APPROVE]: () =>
          refused(
            409,
            "ACTIVATION_GUARDS_FAILED",
            "the tenant cannot go live yet: canonicalTasksComplete, baaExecuted not satisfied",
            [
              { field: "guard", code: "canonicalTasksComplete", message: "Required steps remain" },
              { field: "templateKey", code: "locations_seeded", message: "Locations is pending" },
              { field: "guard", code: "baaExecuted", message: "The BAA is not executed" },
              { field: "guard", code: "aNewGuard", message: "A brand-new check does not pass" },
            ],
          ),
      },
    });
    approveWith();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Every required step is done or skipped")).toBeTruthy();
    expect(within(dialog).getByText("Locations is pending")).toBeTruthy();
    expect(within(dialog).getByText(/signed agreement filed for this tenant/)).toBeTruthy();
    // a guard this screen has no words for is still listed (with the server's sentence), never dropped
    expect(within(dialog).getByText("A brand-new check does not pass")).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/canonicalTasksComplete|baaExecuted/);
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("a state-moved refusal (GO_LIVE_NOT_ATTESTED) closes the prompt, reloads the view and is read on the page", async () => {
    const { ctx } = mount(ready(), {
      POST: { [APPROVE]: () => refused(409, "GO_LIVE_NOT_ATTESTED", "x") },
    });
    approveWith();
    expect(await screen.findByText(/has not attested readiness yet/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("keeps the reason typed in the approve prompt through a Re-verify and reopens it on the return", async () => {
    const typed = "Checked the BAA and the officer's attestation";
    mount(ready(), { POST: { [APPROVE]: () => refused(403, "STEP_UP_REQUIRED", "x") } });
    approveWith(typed);
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(typed);
    cleanup();

    mount(ready(), {}, ONBOARDING_OPERATOR, RETURNED_FROM_STEP_UP);
    expect(((await screen.findByLabelText(/^Reason/)) as HTMLTextAreaElement).value).toBe(typed);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
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
