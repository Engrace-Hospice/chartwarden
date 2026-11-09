import {
  STEP_UP_RETURN_STATE,
  peekStepUpMemoryDraft,
  stashStepUpMemoryDraft,
} from "@chartwarden/ui";
// @vitest-environment jsdom
// The onboarding wizard screen: one ordered list of steps, the current one open, every write behind a reason and (when it is refused)
// an explanation the operator can act on. The server owns the rules; this proves what the operator sees and what is sent.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_OPERATOR,
  ORG_SLUG,
  OVERVIEW,
  type StubClient,
  TASK,
  ok,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";
import { TenantOnboardingWizard } from "./wizard-screen";

const ONBOARDING = "/api/v1/platform/tenants/{orgSlug}/onboarding";
const OVERVIEW_PATH = "/api/v1/platform/tenants/{orgSlug}";
const ATTEST = "/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/attest";
const SKIP = "/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/skip";
const REOPEN = "/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/reopen";
const ROUTES = [
  { path: "/tenants/:orgSlug/onboarding", element: <TenantOnboardingWizard /> },
  { path: "/tenants/:orgSlug/onboarding/:stepKey", element: <TenantOnboardingWizard /> },
];
const URL_BASE = `/tenants/${ORG_SLUG}/onboarding`;

const steps = () => [
  wizardStep("account_created", 1, { title: "Organisation", status: "done" }),
  wizardStep("payer_enrollment", 2, {
    title: "Billing: payer enrollment",
    owner: "either",
    completionMode: "attestation",
  }),
  wizardStep("mac_configured", 3, {
    title: "Billing: MAC credentials",
    owner: "either",
    completionMode: "either",
    locked: true,
    lockedBy: "payer_enrollment",
  }),
  wizardStep("sample_data_loaded", 4, {
    title: "Sample data",
    optional: true,
    locked: true,
    lockedBy: "payer_enrollment",
  }),
];

function setup(over: { view?: ReturnType<typeof wizardView>; extra?: Record<string, never> } = {}) {
  let view = over.view ?? wizardView(steps());
  const client = stubClient({
    GET: {
      [ONBOARDING]: () => ok(view),
      [OVERVIEW_PATH]: () => ok(OVERVIEW),
    },
    POST: {
      [ATTEST]: () => ok(view.steps[1]),
    },
  });
  return {
    client,
    setView: (next: typeof view) => {
      view = next;
    },
  };
}
const where = () => screen.getByTestId("where").textContent;
const writes = (c: StubClient, m: "POST" | "PUT" | "PATCH" = "POST") => c[m].mock.calls;

beforeEach(() => {
  window.sessionStorage.clear();
});

// The screen hands the session's keys to the model (React review L4): a narrower operator sees fewer actions on the same step.
describe("TenantOnboardingWizard: the operator's keys", () => {
  it("offers Mark done only with the manage key, and nothing at all with no session", async () => {
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, setup().client);
    expect(await screen.findByRole("button", { name: "Mark done with evidence" })).toBeTruthy();
    cleanup();
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, setup().client, {
      ...ONBOARDING_OPERATOR,
      permissions:
        ONBOARDING_OPERATOR.permissions?.filter((k) => k !== "onboarding.manage_platform") ?? [],
    });
    await screen.findAllByText("Billing: payer enrollment");
    expect(screen.queryByRole("button", { name: "Mark done with evidence" })).toBeNull();
    cleanup();
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, setup().client, null);
    await screen.findAllByText("Billing: payer enrollment");
    expect(screen.queryByRole("button", { name: "Mark done with evidence" })).toBeNull();
  });
});

describe("TenantOnboardingWizard: reading", () => {
  it("opens at the current step and shows the rail, the tenant and the progress", async () => {
    const { client } = setup();
    renderAt(URL_BASE, ROUTES, client);
    expect(
      await screen.findByRole("heading", { level: 1, name: /Cedar Ridge Hospice/ }),
    ).toBeTruthy();
    await waitFor(() => expect(where()).toBe(`${URL_BASE}/payer_enrollment`));
    // one name, on the landmark: the list inside it must not announce the same words again
    expect(screen.getAllByLabelText("Onboarding steps")).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Onboarding steps" });
    expect(within(nav).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/1 of 3 steps done/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Billing: payer enrollment" }),
    ).toBeTruthy();
  });

  it("opens the step the link names, and a click in the rail moves to that step", async () => {
    const { client } = setup();
    renderAt(`${URL_BASE}/account_created`, ROUTES, client);
    expect(await screen.findByRole("heading", { level: 2, name: "Organisation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Billing: MAC credentials/ }));
    await waitFor(() => expect(where()).toBe(`${URL_BASE}/mac_configured`));
    // a change of step moves focus to the new step's heading
    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "Billing: MAC credentials",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("says a locked step is locked and offers no write on it", async () => {
    const { client } = setup();
    renderAt(`${URL_BASE}/mac_configured`, ROUTES, client);
    expect(
      await screen.findByText(/Finish Billing: payer enrollment first/, { selector: "output, p" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark done/ })).toBeNull();
  });

  it("an unknown step key is an honest empty state with a way back to the current step", async () => {
    const { client } = setup();
    renderAt(`${URL_BASE}/no_such_step`, ROUTES, client);
    expect(await screen.findByText(/no step called/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /Go to the current step/i }));
    await waitFor(() => expect(where()).toBe(`${URL_BASE}/payer_enrollment`));
  });

  it("shows a load failure with Try again, and not-found as final", async () => {
    const client = stubClient({
      GET: {
        [ONBOARDING]: () => refused(500, "INTERNAL_ERROR"),
        [OVERVIEW_PATH]: () => ok(OVERVIEW),
      },
    });
    renderAt(URL_BASE, ROUTES, client);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();

    const missing = stubClient({
      GET: {
        [ONBOARDING]: () => refused(404, "NOT_FOUND"),
        [OVERVIEW_PATH]: () => refused(404, "NOT_FOUND"),
      },
    });
    renderAt(URL_BASE, ROUTES, missing);
    expect(await screen.findByText("Tenant not found.")).toBeTruthy();
  });

  it("a provisioning tenant is read-only and shows the provisioning state above the rail", async () => {
    const view = wizardView(steps(), {
      tenantStatus: "provisioning",
      currentStepKey: "account_created",
    });
    const client = stubClient({
      GET: {
        [ONBOARDING]: () => ok(view),
        [OVERVIEW_PATH]: () => ok({ ...OVERVIEW, status: "provisioning" }),
        "/api/v1/platform/tenants/{orgSlug}/provision-status": () =>
          ok({
            tenantAccountId: "ta-1",
            orgSlug: ORG_SLUG,
            tenantStatus: "provisioning",
            job: { state: "active", attemptsMade: 1, failedReason: null },
          }),
      },
    });
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, client);
    expect(await screen.findByText(/still provisioning/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark done/ })).toBeNull();
  });
});

describe("TenantOnboardingWizard: marking a step done with evidence", () => {
  async function openAttest(client: StubClient) {
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, client);
    fireEvent.click(await screen.findByRole("button", { name: /Mark done with evidence/ }));
  }
  const fill = (note: string, ref: string, reason: string) => {
    fireEvent.change(screen.getByLabelText(/What was checked/), { target: { value: note } });
    fireEvent.change(screen.getByLabelText(/Reference/), { target: { value: ref } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: reason } });
  };

  it("asks for the evidence and the reason, sends them for this step, and reloads the wizard", async () => {
    const { client } = setup();
    await openAttest(client);
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    // evidence note and reason are required: nothing is sent
    expect(writes(client)).toHaveLength(0);
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);

    fill(
      "Confirmed enrolment letter with the customer",
      "ticket CHG-4521",
      "Customer asked us to settle this for them",
    );
    const before = client.GET.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const [path, init] = writes(client)[0] as [
      string,
      { params: { path: Record<string, string> }; body: unknown },
    ];
    expect(path).toBe(ATTEST);
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG, taskId: TASK("payer_enrollment") });
    expect(init.body).toEqual({
      evidenceNote: "Confirmed enrolment letter with the customer",
      evidenceRef: "ticket CHG-4521",
      reason: "Customer asked us to settle this for them",
    });
    await waitFor(() => expect(client.GET.mock.calls.length).toBeGreaterThan(before));
  });

  it("says so when the page could not be refreshed after a saved change, instead of showing old state as current", async () => {
    let reads = 0;
    const view = wizardView(steps());
    const client = stubClient({
      GET: {
        [ONBOARDING]: () => (++reads === 1 ? ok(view) : refused(500, "INTERNAL_ERROR")),
        [OVERVIEW_PATH]: () => ok(OVERVIEW),
      },
      POST: { [ATTEST]: () => ok(view.steps[1]) },
    });
    await openAttest(client);
    fill("Confirmed enrolment letter", "", "Customer asked us to settle this");
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    expect(await screen.findByText(/may be out of date/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("a second submit while the write is in flight sends nothing more", async () => {
    const { client } = setup();
    client.POST.mockImplementationOnce(() => new Promise(() => {}));
    await openAttest(client);
    fill("Confirmed enrolment letter", "", "Customer asked us to settle this");
    const form = screen.getByRole("form", { name: "Mark this step done" });
    fireEvent.submit(form);
    await screen.findByRole("button", { name: "Saving…" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(writes(client)).toHaveLength(1);
  });

  it("a submit during the reload that follows a saved attestation sends nothing more", async () => {
    const { client } = setup();
    await openAttest(client);
    fill("Confirmed enrolment letter", "", "Customer asked us to settle this");
    // the write answers; the wizard's reload after it never does
    const reads = client.GET.getMockImplementation();
    client.GET.mockImplementation((path: string, init) =>
      path === ONBOARDING
        ? new Promise(() => {})
        : (reads as NonNullable<typeof reads>)(path, init),
    );
    const form = screen.getByRole("form", { name: "Mark this step done" });
    fireEvent.submit(form);
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    await waitFor(() =>
      expect(client.GET.mock.calls.some(([path]) => path === ONBOARDING)).toBe(true),
    );
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(writes(client)).toHaveLength(1);
  });

  it("leaves the reference out when it is blank", async () => {
    const { client } = setup();
    await openAttest(client);
    fill("Confirmed enrolment letter", "   ", "Customer asked us to settle this");
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const init = writes(client)[0]?.[1] as { body: Record<string, unknown> };
    expect(init.body).not.toHaveProperty("evidenceRef");
  });

  it("a stale step-up offers Re-verify and keeps what was typed through the round trip", async () => {
    const { client } = setup();
    client.POST.mockResolvedValueOnce(refused(403, "STEP_UP_REQUIRED"));
    await openAttest(client);
    fill("Confirmed enrolment letter", "ref-1", "Customer asked us to settle this");
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    const reverify = await screen.findByRole("link", { name: /Re-verify/ });
    fireEvent.click(reverify);
    expect(await screen.findByText("step-up page")).toBeTruthy();
    // free text (the note, the reference, the reason) is kept in memory only, never in sessionStorage
    expect(
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:payer_enrollment:attest",
      ),
    ).toBeNull();
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(
      "Confirmed enrolment letter",
    );
    expect(
      peekStepUpMemoryDraft<{ evidenceNote: string }>("wizard:cedar-ridge:payer_enrollment:attest")
        ?.evidenceNote,
    ).toBe("Confirmed enrolment letter");
  });

  it("restores the stashed form once the operator comes back", async () => {
    stashStepUpMemoryDraft("wizard:cedar-ridge:payer_enrollment:attest", {
      evidenceNote: "Typed before re-verifying",
      evidenceRef: "",
      reason: "Typed reason for audit",
    });
    const { client } = setup();
    renderAt(
      { pathname: `${URL_BASE}/payer_enrollment`, state: STEP_UP_RETURN_STATE },
      ROUTES,
      client,
    );
    expect(await screen.findByDisplayValue("Typed before re-verifying")).toBeTruthy();
  });

  it("does not reopen the evidence form from a draft an abandoned Re-verify left behind, now or on a later return", async () => {
    const key = "wizard:cedar-ridge:payer_enrollment:attest";
    stashStepUpMemoryDraft(key, {
      evidenceNote: "Typed before re-verifying",
      evidenceRef: "",
      reason: "Typed reason for audit",
    });
    const { client } = setup();
    // Back from /step-up: the page mounts with no step-up return marker
    renderAt(`${URL_BASE}/payer_enrollment`, ROUTES, client);
    expect(await screen.findByRole("button", { name: "Mark done with evidence" })).toBeTruthy();
    expect(screen.queryByDisplayValue("Typed before re-verifying")).toBeNull();
    // that visit dropped the draft: it is gone for a later, genuine return as well
    await waitFor(() => expect(peekStepUpMemoryDraft(key)).toBeUndefined());
  });

  it("shows the server's reason when an earlier step is unfinished, with a link to that step", async () => {
    const { client } = setup();
    client.POST.mockResolvedValueOnce(
      refused(409, "ONBOARDING_STEP_OUT_OF_ORDER", "x", [
        {
          field: "templateKey",
          code: "account_created",
          message: "Organisation must be done or skipped first",
        },
      ]),
    );
    await openAttest(client);
    fill("Confirmed enrolment letter", "", "Customer asked us to settle this");
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    expect(await screen.findByText(/earlier step is not finished/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /Go to Organisation/ }));
    await waitFor(() => expect(where()).toBe(`${URL_BASE}/account_created`));
  });

  it("shows a patient-identifier refusal on the evidence field", async () => {
    const { client } = setup();
    client.POST.mockResolvedValueOnce(
      refused(422, "EVIDENCE_LOOKS_LIKE_PHI", "x", [
        {
          field: "evidenceNote",
          code: "EVIDENCE_LOOKS_LIKE_PHI",
          message: "no patient identifiers here",
        },
      ]),
    );
    await openAttest(client);
    fill("Confirmed enrolment letter", "", "Customer asked us to settle this");
    fireEvent.click(screen.getByRole("button", { name: "Save and mark done" }));
    expect(await screen.findByText(/no patient identifiers here/)).toBeTruthy();
  });
});

describe("TenantOnboarding wizard: skip and re-open", () => {
  it("offers Skip only where the step does not apply, behind a reason", async () => {
    const view = wizardView([
      wizardStep("account_created", 1, { status: "done" }),
      wizardStep("mac_configured", 2, {
        title: "Billing: MAC credentials",
        completionMode: "either",
        owner: "either",
      }),
    ]);
    const { client } = setup({ view });
    client.POST.mockResolvedValueOnce(ok({ ...view.steps[1] }));
    renderAt(`${URL_BASE}/mac_configured`, ROUTES, client);
    fireEvent.click(await screen.findByRole("button", { name: /Skip this step/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Tenant bills outside ChartWarden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const [path, init] = writes(client)[0] as [string, { body: unknown }];
    expect(path).toBe(SKIP);
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.body).toEqual({ skipRationale: "Tenant bills outside ChartWarden" });
  });

  it("does not offer Skip on a step that is never skipped by hand", async () => {
    const { client } = setup({ view: wizardView([wizardStep("account_created", 1)]) });
    renderAt(`${URL_BASE}/account_created`, ROUTES, client);
    await screen.findByRole("heading", { level: 2, name: "account_created" });
    expect(screen.queryByRole("button", { name: /Skip this step/ })).toBeNull();
  });

  it("re-opens a settled step with a reason", async () => {
    const { client } = setup();
    client.POST.mockResolvedValueOnce(ok({}));
    renderAt(`${URL_BASE}/account_created`, ROUTES, client);
    fireEvent.click(await screen.findByRole("button", { name: /Re-open to edit/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Display name was misspelled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Re-open step" }));
    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const [path, init] = writes(client)[0] as [string, { body: unknown }];
    expect(path).toBe(REOPEN);
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.body).toEqual({ reason: "Display name was misspelled" });
  });

  // A stale step-up sends the operator to /step-up and back. What they typed in the prompt (free text: memory only) goes with them.
  it.each([
    { what: "skip", url: "mac_configured", open: /Skip this step/, confirm: "Skip step" },
    { what: "re-open", url: "account_created", open: /Re-open to edit/, confirm: "Re-open step" },
  ])(
    "keeps the reason typed in the $what prompt through a Re-verify, and reopens the prompt with it on the return",
    async ({ url, open, confirm }) => {
      const view = wizardView([
        wizardStep("account_created", 1, { status: "done" }),
        wizardStep("mac_configured", 2, {
          title: "Billing: MAC credentials",
          completionMode: "either",
          owner: "either",
        }),
      ]);
      const typed = "Customer asked us to settle this, CHG-4411";
      const { client } = setup({ view });
      client.POST.mockResolvedValueOnce(refused(403, "STEP_UP_REQUIRED", "x"));
      renderAt(`${URL_BASE}/${url}`, ROUTES, client);
      fireEvent.click(await screen.findByRole("button", { name: open }));
      fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: typed } });
      fireEvent.click(screen.getByRole("button", { name: confirm }));
      fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
      expect(await screen.findByText("step-up page")).toBeTruthy();
      // free text: memory only, never sessionStorage
      expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(typed);
      cleanup();

      renderAt(
        { pathname: `${URL_BASE}/${url}`, state: STEP_UP_RETURN_STATE },
        ROUTES,
        setup({ view }).client,
      );
      expect(((await screen.findByLabelText(/Reason/)) as HTMLTextAreaElement).value).toBe(typed);
      expect(screen.getByRole("button", { name: confirm })).toBeTruthy();
    },
  );

  it("does not reopen the skip prompt from a reason an abandoned Re-verify left behind", async () => {
    const view = wizardView([
      wizardStep("account_created", 1, { status: "done" }),
      wizardStep("mac_configured", 2, {
        title: "Billing: MAC credentials",
        completionMode: "either",
        owner: "either",
      }),
    ]);
    const { client } = setup({ view });
    client.POST.mockResolvedValueOnce(refused(403, "STEP_UP_REQUIRED", "x"));
    renderAt(`${URL_BASE}/mac_configured`, ROUTES, client);
    fireEvent.click(await screen.findByRole("button", { name: /Skip this step/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Customer asked us to settle this, CHG-4411" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip step" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    // Back from /step-up, no return marker: the page opens on the step, with no prompt
    renderAt(`${URL_BASE}/mac_configured`, ROUTES, setup({ view }).client);
    expect(await screen.findByRole("button", { name: /Skip this step/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
  });

  it("will not re-open while a go-live attestation is pending, and says what to do", async () => {
    const view = wizardView(steps(), {
      goLive: {
        state: "awaiting_approval",
        attestation: null,
        failedGuards: [],
        complianceOfficerMembershipId: null,
      },
    });
    const { client } = setup({ view });
    renderAt(`${URL_BASE}/account_created`, ROUTES, client);
    expect(await screen.findByText(/Revoke the go-live attestation first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Re-open to edit/ })).toBeNull();
  });
});
