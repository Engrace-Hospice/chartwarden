// @vitest-environment jsdom
// The frame every step sits in: how the step was settled, and the tenant's own Start / Mark done / Re-open / Skip. Skip is the tenant's
// "this does not apply to us" on steps 8, 9 and 10 only: the administrator, a written reason and a fresh step-up.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StepPanelProps } from "./panel-props";
import { StepFrame } from "./step-frame";
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
import type { WizardStep, WizardView } from "./wizard-model";

const SKIP = "/api/v1/tenant/onboarding/{taskId}/skip";
const START = "/api/v1/tenant/onboarding/{taskId}/start";
const ATTEST = "/api/v1/tenant/onboarding/{taskId}/attest";
const REOPEN = "/api/v1/tenant/onboarding/{taskId}/reopen";

/** A panel that only shows the frame's skip entry point, as the DoseSpot panel does. */
function Probe({ skip }: StepPanelProps) {
  return skip.available ? (
    <button type="button" onClick={skip.request}>
      This does not apply to us
    </button>
  ) : null;
}

function mount(
  step: WizardStep,
  client = stubClient({}),
  session = ORG_ADMIN,
  over: Partial<WizardView> = {},
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const view = wizardView([step], over);
  const { skip: _skip, ...base } = panelProps(view, step.key, session, onChanged);
  const rendered = renderAt(
    at,
    [{ path: "/x", element: <StepFrame base={base} Panel={Probe} /> }],
    client,
    session,
  );
  return { onChanged, ...rendered };
}
const openSkip = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
};
const rationale = (value: string): void => {
  fireEvent.change(screen.getByLabelText("Why it does not apply"), { target: { value } });
};
const confirmSkip = (): void => {
  const buttons = screen.getAllByRole("button", { name: "Skip this step" });
  fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
};

describe("StepFrame: where Skip is offered", () => {
  it.each(["mac_configured", "payer_enrollment", "dosespot_kickoff_initiated"])(
    "offers Skip and the panel entry point on %s to the administrator",
    (key) => {
      mount(wizardStep(key, 1));
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "This does not apply to us" })).toBeTruthy();
    },
  );

  it("never offers Skip on sample data (step 13), the go-live step, or a step an operator added", () => {
    for (const step of [
      wizardStep("sample_data_loaded", 1, { owner: "platform_ops", tenantSkippable: true }),
      wizardStep("go_live_checklist_complete", 1, {
        owner: "compliance_officer",
        tenantSkippable: true,
      }),
      wizardStep("custom_check", 1, { owner: "either", tenantSkippable: true, isCanonical: false }),
    ]) {
      const { unmount } = mount(step);
      expect(screen.queryByRole("button", { name: "Skip this step" })).toBeNull();
      expect(screen.queryByRole("button", { name: "This does not apply to us" })).toBeNull();
      unmount();
    }
  });

  it("does not offer Skip to the compliance officer", () => {
    mount(wizardStep("mac_configured", 1), stubClient({}), COMPLIANCE_OFFICER);
    expect(screen.queryByRole("button", { name: "Skip this step" })).toBeNull();
  });
});

describe("StepFrame: skipping a step", () => {
  it("sends the rationale with one Idempotency-Key and reloads the wizard", async () => {
    const client = stubClient({ POST: { [SKIP]: () => ok({}) } });
    const { onChanged } = mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("We bill Medicare through another vendor");
    confirmSkip();

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: unknown },
    ];
    expect(path).toBe(SKIP);
    expect(init.params.path).toEqual({ taskId: "task-mac_configured" });
    expect(init.body).toEqual({ skipRationale: "We bill Medicare through another vendor" });
    expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("refuses a rationale shorter than 8 characters without sending", async () => {
    const client = stubClient({});
    mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("no");
    confirmSkip();
    expect(await screen.findByText(/at least 8 characters/i)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("refuses a rationale that looks like patient information, in the tenant's words, and keeps the text", async () => {
    const client = stubClient({ POST: { [SKIP]: () => refused(422, "EVIDENCE_LOOKS_LIKE_PHI") } });
    mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("Patient with a long enough note");
    confirmSkip();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /identifier.*without naming a patient/i,
    );
    expect((screen.getByLabelText("Why it does not apply") as HTMLTextAreaElement).value).toBe(
      "Patient with a long enough note",
    );
  });

  it("says Only ChartWarden can skip this step when the server refuses a non-skippable step", async () => {
    const client = stubClient({
      POST: { [SKIP]: () => refused(409, "ONBOARDING_STEP_NOT_TENANT_SKIPPABLE") },
    });
    mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("It does not apply to us");
    confirmSkip();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /only chartwarden can skip this step/i,
    );
  });

  it("offers Re-verify on a stale step-up and reopens the prompt with the reason on return", async () => {
    const client = stubClient({ POST: { [SKIP]: () => refused(403, "STEP_UP_REQUIRED") } });
    const first = mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("We bill through another vendor");
    confirmSkip();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    first.unmount();

    mount(wizardStep("mac_configured", 1), client, ORG_ADMIN, {}, RETURNED_FROM_STEP_UP);
    expect((screen.getByLabelText("Why it does not apply") as HTMLTextAreaElement).value).toBe(
      "We bill through another vendor",
    );
  });

  it("drops a second confirm while the first is in flight", async () => {
    const gate = deferred(ok({}));
    const client = stubClient({ POST: { [SKIP]: gate.handler } });
    mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("We bill through another vendor");
    confirmSkip();
    confirmSkip();
    gate.release();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      POST: {
        [SKIP]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok({});
        },
      },
    });
    mount(wizardStep("mac_configured", 1), client);
    openSkip();
    rationale("We bill through another vendor");
    confirmSkip();
    await screen.findByText(/could not reach the server/i);
    confirmSkip();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client.POST.mock.calls[1] as unknown[])).toBe(
      keyOf(client.POST.mock.calls[0] as unknown[]),
    );
  });
});

describe("StepFrame: how a step was settled", () => {
  it("says a tenant skip was by the organization, with its reason", () => {
    mount(
      wizardStep("mac_configured", 1, {
        status: "skipped",
        skippedBy: "tenant",
        skipRationale: "We bill through another vendor",
      }),
    );
    expect(screen.getByText("Skipped by your organization.")).toBeTruthy();
    expect(screen.getByText("We bill through another vendor")).toBeTruthy();
  });

  it("names an operator's skip and attestation 'ChartWarden operations', never a person", () => {
    mount(
      wizardStep("payer_enrollment", 1, {
        status: "skipped",
        skippedBy: "platform_ops",
        skipRationale: "Enrolled by ChartWarden",
      }),
    );
    expect(screen.getByText("Skipped by ChartWarden operations.")).toBeTruthy();
    const attested = wizardStep("ccn_registered", 2, {
      owner: "either",
      status: "done",
      evidence: { note: "Checked the CMS letter", ref: null },
      attestedBy: {
        membershipId: null,
        actorKind: "platform_ops",
        label: "ChartWarden operations",
        at: "2026-11-02T10:00:00.000Z",
      },
    });
    mount(attested);
    expect(screen.getAllByText("ChartWarden operations").length).toBeGreaterThan(0);
  });

  it("says the system skipped a billing step for an organization that bills outside ChartWarden", () => {
    mount(
      wizardStep("mac_configured", 1, {
        status: "skipped",
        skippedBy: "system",
        systemSkipped: true,
        skipRationale: "bills outside ChartWarden",
      }),
    );
    expect(
      screen.getByText(
        /skipped automatically because your organization bills outside chartwarden/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("bills outside ChartWarden")).toBeNull();
  });
});

describe("StepFrame: the other three actions", () => {
  it("starts a step", async () => {
    const client = stubClient({ POST: { [START]: () => ok({}) } });
    const { onChanged } = mount(wizardStep("ccn_registered", 1, { owner: "either" }), client);
    fireEvent.click(screen.getByRole("button", { name: "Start this step" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[0]).toBe(START);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("marks a step done with evidence", async () => {
    const client = stubClient({ POST: { [ATTEST]: () => ok({}) } });
    const { onChanged } = mount(wizardStep("ccn_registered", 1, { owner: "either" }), client);
    fireEvent.click(screen.getByRole("button", { name: "Mark done with evidence" }));
    fireEvent.change(screen.getByLabelText("What was checked, and by whom"), {
      target: { value: "Checked the CMS letter" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Mark this step done" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe(ATTEST);
    expect(init.body).toEqual({ evidenceNote: "Checked the CMS letter" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("re-opens a settled step with a reason", async () => {
    const client = stubClient({ POST: { [REOPEN]: () => ok({}) } });
    mount(wizardStep("ccn_registered", 1, { owner: "either", status: "done" }), client);
    fireEvent.click(screen.getByRole("button", { name: "Re-open to edit" }));
    fireEvent.change(screen.getByLabelText("Why you are re-opening it"), {
      target: { value: "The CCN was wrong" },
    });
    const buttons = screen.getAllByRole("button", { name: "Re-open step" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect((client.POST.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({
      reason: "The CCN was wrong",
    });
  });

  it("explains why Re-open is not offered while a go-live attestation waits", () => {
    const attestation = {
      id: "g",
      status: "pending" as const,
      attestedByMembershipId: "m",
      attestedAt: "2026-11-02T00:00:00.000Z",
      expiresAt: null,
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
      wizardStep("ccn_registered", 1, { owner: "either", status: "done" }),
      stubClient({}),
      ORG_ADMIN,
      {
        goLive: {
          state: "awaiting_approval",
          attestation,
          failedGuards: [],
          complianceOfficerMembershipId: "m",
        },
      },
    );
    expect(screen.queryByRole("button", { name: "Re-open to edit" })).toBeNull();
    expect(screen.getByText(/waiting for chartwarden's approval/i)).toBeTruthy();
  });

  it("says why a locked step cannot be worked, and offers no action", () => {
    const locked = wizardStep("payer_enrollment", 2, { locked: true, lockedBy: "mac_configured" });
    mount(locked);
    expect(screen.getByText("Finish mac_configured first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /skip|start|mark done/i })).toBeNull();
  });
});
