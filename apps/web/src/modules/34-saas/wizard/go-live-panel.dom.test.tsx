// @vitest-environment jsdom
// Step 14, Go live: the assigned compliance officer attests readiness (a fresh step-up); ChartWarden then approves.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoLivePanel } from "./go-live-panel";
import {
  COMPLIANCE_OFFICER,
  ORG_ADMIN,
  RETURNED_FROM_STEP_UP,
  deferred,
  keyOf,
  ok,
  panelProps,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";
import type { WizardView } from "./wizard-model";

const ATTEST = "/api/v1/tenant/go-live/attest";
const done = (key: string, n: number) => wizardStep(key, n, { owner: "either", status: "done" });
const goLiveStep = wizardStep("go_live_checklist_complete", 3, { owner: "compliance_officer" });
const goLive = (
  state: WizardView["goLive"]["state"],
  over: Partial<WizardView["goLive"]> = {},
): WizardView["goLive"] => ({
  state,
  attestation: null,
  failedGuards: [],
  complianceOfficerMembershipId: "m-officer",
  ...over,
});
const readyView = wizardView([done("ccn_registered", 1), done("locations_seeded", 2), goLiveStep], {
  goLive: goLive("awaiting_attestation"),
});

function mount(
  view: WizardView,
  client = stubClient({}),
  session = COMPLIANCE_OFFICER,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const rendered = renderAt(
    at,
    [
      {
        path: "/x",
        element: (
          <GoLivePanel {...panelProps(view, "go_live_checklist_complete", session, onChanged)} />
        ),
      },
    ],
    client,
    session,
  );
  return { onChanged, ...rendered };
}
const tick = (): void => {
  fireEvent.click(screen.getByRole("checkbox", { name: /ready to go live/i }));
};
const attest = (): void => {
  fireEvent.submit(screen.getByRole("form", { name: "Attest go-live readiness" }));
};

describe("GoLivePanel", () => {
  it("lists each open step as a link while the organization is not ready", () => {
    const view = wizardView(
      [wizardStep("ccn_registered", 1, { owner: "either", title: "Provider entity" }), goLiveStep],
      { goLive: goLive("not_ready") },
    );
    mount(view);
    const link = screen.getByRole("link", { name: "Provider entity" });
    expect(link.getAttribute("href")).toBe("/admin/onboarding/ccn_registered");
    expect(screen.queryByRole("form", { name: "Attest go-live readiness" })).toBeNull();
  });

  it("lets the assigned compliance officer attest with a note and an Idempotency-Key, then reloads", async () => {
    const client = stubClient({ POST: { [ATTEST]: () => ok({}) } });
    const { onChanged } = mount(readyView, client);
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "All checks reviewed" } });
    tick();
    attest();

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe(ATTEST);
    expect(init.body).toEqual({ attestationConfirmed: true, note: "All checks reviewed" });
    expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("lists the checks that still fail when the server refuses", async () => {
    const guards = [{ field: "guard", code: "baaExecuted", message: "baa" }];
    const client = stubClient({
      POST: { [ATTEST]: () => refused(409, "ACTIVATION_GUARDS_FAILED", "guards", guards) },
    });
    mount(readyView, client);
    tick();
    attest();
    expect(await screen.findByText("Your BAA with ChartWarden is executed")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot go live yet/i);
  });

  it("refuses a note that looks like patient information, in the tenant's words", async () => {
    const client = stubClient({
      POST: { [ATTEST]: () => refused(422, "EVIDENCE_LOOKS_LIKE_PHI") },
    });
    mount(readyView, client);
    tick();
    attest();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /identifier.*without naming a patient/i,
    );
  });

  it("keeps the note through Re-verify but never the attestation tick", async () => {
    const client = stubClient({ POST: { [ATTEST]: () => refused(403, "STEP_UP_REQUIRED") } });
    const first = mount(readyView, client);
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "Reviewed with the board" },
    });
    tick();
    attest();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    first.unmount();

    mount(readyView, client, COMPLIANCE_OFFICER, RETURNED_FROM_STEP_UP);
    expect((screen.getByLabelText(/note/i) as HTMLTextAreaElement).value).toBe(
      "Reviewed with the board",
    );
    expect(
      (screen.getByRole("checkbox", { name: /ready to go live/i }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it.each(["GO_LIVE_ALREADY_ATTESTED", "GO_LIVE_ATTESTATION_EXPIRED", "ACTIVATION_GUARDS_FAILED"])(
    "reloads the wizard when the server answers %s (its copy says it was reloaded)",
    async (code) => {
      const client = stubClient({ POST: { [ATTEST]: () => refused(409, code) } });
      const { onChanged } = mount(readyView, client);
      tick();
      attest();
      expect((await screen.findByRole("alert")).textContent).toMatch(/reloaded/i);
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    },
  );

  it("lets a holder of the officer role attest while no officer is assigned (the server's rule)", () => {
    const unassigned = wizardView([done("ccn_registered", 1), goLiveStep], {
      goLive: goLive("awaiting_attestation", { complianceOfficerMembershipId: null }),
    });
    mount(unassigned);
    expect(screen.getByRole("form", { name: "Attest go-live readiness" })).toBeTruthy();
  });

  it("does not let another officer attest once someone else is assigned", () => {
    const other = wizardView([done("ccn_registered", 1), goLiveStep], {
      goLive: goLive("awaiting_attestation", { complianceOfficerMembershipId: "m-someone-else" }),
    });
    mount(other);
    expect(screen.queryByRole("form", { name: "Attest go-live readiness" })).toBeNull();
  });

  it("drops a second submit while the first is in flight", async () => {
    const gate = deferred(ok({}));
    const client = stubClient({ POST: { [ATTEST]: gate.handler } });
    mount(readyView, client);
    tick();
    attest();
    attest();
    gate.release();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      POST: {
        [ATTEST]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok({});
        },
      },
    });
    mount(readyView, client);
    tick();
    attest();
    await screen.findByText(/could not reach the server/i);
    attest();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client.POST.mock.calls[1] as unknown[])).toBe(
      keyOf(client.POST.mock.calls[0] as unknown[]),
    );
  });

  it("offers the administrator no attest form and says who can attest", () => {
    mount(readyView, stubClient({}), ORG_ADMIN);
    expect(screen.queryByRole("form", { name: "Attest go-live readiness" })).toBeNull();
    expect(screen.getByText(/only your assigned compliance officer can/i)).toBeTruthy();
  });

  it("says it is waiting for ChartWarden, with the days left, once attested", () => {
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const attestation = {
      id: "g-1",
      status: "pending" as const,
      attestedByMembershipId: "m-officer",
      attestedAt: new Date().toISOString(),
      expiresAt,
      attestationNote: null,
      approvedByMembershipId: null,
      approvedByLabel: null,
      approvedAt: null,
      approvalReason: null,
      revokedByMembershipId: null,
      revokedByLabel: null,
      revokedAt: null,
      revokeReason: null,
    };
    mount(
      wizardView([done("ccn_registered", 1), goLiveStep], {
        goLive: goLive("awaiting_approval", { attestation }),
      }),
    );
    expect(
      screen.getByText(/waiting for chartwarden's approval: it can be approved for 5 more days/i),
    ).toBeTruthy();
  });

  it("tells the tenant to ask ChartWarden to clear an expired attestation", () => {
    const attestation = {
      id: "g-1",
      status: "pending" as const,
      attestedByMembershipId: "m-officer",
      attestedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-15T00:00:00.000Z",
      attestationNote: null,
      approvedByMembershipId: null,
      approvedByLabel: null,
      approvedAt: null,
      approvalReason: null,
      revokedByMembershipId: null,
      revokedByLabel: null,
      revokedAt: null,
      revokeReason: null,
    };
    mount(
      wizardView([done("ccn_registered", 1), goLiveStep], {
        goLive: goLive("awaiting_approval", { attestation }),
      }),
    );
    expect(
      screen.getByText(
        /ask chartwarden to clear it, then your compliance officer can attest again/i,
      ),
    ).toBeTruthy();
  });

  it("says the organization is live", () => {
    mount(wizardView([done("ccn_registered", 1), goLiveStep], { goLive: goLive("live") }));
    expect(screen.getByText("Your organization is live.")).toBeTruthy();
  });
});
