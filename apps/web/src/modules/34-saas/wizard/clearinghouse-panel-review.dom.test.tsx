// @vitest-environment jsdom
// Step 7 under review: what the panel does around its writes beyond the happy path. A write that voids a pending go-live attestation says so
// first; a refusal whose copy says "reloaded" really reloads; drafts live in the shell's owner-scoped store (so sign-out wipes them); a
// sibling write never bumps the version under an open editor; the result of a write survives the card that raised it, and so does focus;
// and the write-only credential never rides to another vendor.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "../../../shell/ceremony-drafts";
import { peekStepUpDraft, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { ClearinghousePanel } from "./clearinghouse-panel";
import {
  BILLING_KEYS,
  CLAIMMD_DRAFT,
  ORG_ADMIN,
  type StubClient,
  clearinghouseView,
  draftKey,
  ok,
  panelProps,
  refused,
  renderPanel,
  resetDrafts,
  stubClient,
  tenantStep,
  tenantView,
} from "./panel-test-support";

const PATH = "/api/v1/tenant/clearinghouse";
const SECRET = "sk_live_correct-horse-battery";
const STEPS = [
  tenantStep("provider_setup", 1, { status: "done" }),
  tenantStep("clearinghouse_selected", 2),
];
const PENDING = {
  state: "awaiting_approval" as const,
  attestation: null,
  failedGuards: [],
  complianceOfficerMembershipId: null,
};
const WARNING = /Saving a change here voids that attestation/;

type Reply = ReturnType<typeof ok>;
const baa = (verified: { at: string } | null) => ({
  heldBy: "tenant" as const,
  effectiveDate: "2026-10-01",
  documentRef: "Claim.MD BAA, signed copy",
  recordedAt: "2026-11-02T00:00:00.000Z",
  verified,
});
const VERIFIED_BAA = baa({ at: "2026-11-03T00:00:00.000Z" });
const READY = { ...CLAIMMD_DRAFT, status: "verified" as const, baa: VERIFIED_BAA };

function mount(
  client: StubClient,
  over: { goLive?: typeof PENDING; keys?: readonly string[] } = {},
) {
  const view = tenantView(STEPS, over.goLive ? { goLive: over.goLive } : {});
  const session = { ...ORG_ADMIN, permissions: [...(over.keys ?? BILLING_KEYS)] };
  const props = panelProps(view, "clearinghouse_selected", {}, session);
  renderPanel(<ClearinghousePanel {...props} />, client, "/x", session);
  return props;
}

/** GET answers each view in turn, then keeps answering the last. */
function reads(...views: ReturnType<typeof clearinghouseView>[]): () => Reply {
  let n = 0;
  return () => ok(views[Math.min(n++, views.length - 1)]);
}
const getCalls = (stub: StubClient) => stub.GET.mock.calls.length;
const status = () => screen.getByRole("status", { name: "Step status" });

afterEach(() => {
  cleanup();
  resetDrafts();
});

describe("a write that voids a pending go-live attestation says so first", () => {
  it("above the choice form", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok(clearinghouseView()) } }), { goLive: PENDING });
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it("above the BAA form, the connection test, the attestation form and Activate", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok(CLAIMMD_DRAFT) } }), { goLive: PENDING });
    const bax = await screen.findByRole("form", { name: "Record the vendor BAA" });
    expect(within(bax).getByText(WARNING)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Connection" })).getByText(WARNING),
    ).toBeTruthy();
    cleanup();

    const stedi = {
      ...CLAIMMD_DRAFT,
      vendor: "stedi" as const,
      verifiableBy: "attestation" as const,
    };
    mount(stubClient({ GET: { [PATH]: () => ok(stedi) } }), { goLive: PENDING });
    await screen.findByRole("form", { name: "Verify the connection" });
    expect(
      within(screen.getByRole("region", { name: "Connection" })).getByText(WARNING),
    ).toBeTruthy();
    cleanup();

    mount(stubClient({ GET: { [PATH]: () => ok(READY) } }), { goLive: PENDING });
    const activation = await screen.findByRole("region", { name: "Activation" });
    expect(within(activation).getByText(WARNING)).toBeTruthy();
  });

  it("only while the attestation is waiting for approval", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok(CLAIMMD_DRAFT) } }));
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});

describe("a refusal whose copy says 'reloaded' reloads", () => {
  const ACTIVATE = `${PATH}/activate`;

  it.each([
    ["CLEARINGHOUSE_BAA_NOT_VERIFIED", /has not verified your vendor BAA yet/],
    ["CLEARINGHOUSE_NOT_VERIFIED", /Verify the connection before you activate/],
  ])(
    "%s on Activate re-reads the settings and the wizard, and the button goes",
    async (code, sentence) => {
      const voided = { ...READY, baa: baa(null) };
      const stub = stubClient({
        GET: { [PATH]: reads(READY, voided) },
        POST: { [ACTIVATE]: () => refused(409, code) as never },
      });
      const props = mount(stub);
      fireEvent.click(await screen.findByRole("button", { name: "Activate the clearinghouse" }));

      expect(await screen.findByText(sentence)).toBeTruthy();
      await waitFor(() => expect(getCalls(stub)).toBe(2));
      await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText(/Waiting for ChartWarden to verify your vendor BAA/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Activate the clearinghouse" })).toBeNull();
    },
  );

  it("CLEARINGHOUSE_CHANGED_DURING_VERIFY on the connection test re-reads the settings and the wizard", async () => {
    const stub = stubClient({
      GET: { [PATH]: reads(CLAIMMD_DRAFT, { ...CLAIMMD_DRAFT, version: 4 }) },
      POST: {
        [`${PATH}/verify`]: () => refused(409, "CLEARINGHOUSE_CHANGED_DURING_VERIFY") as never,
      },
    });
    const props = mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Test the connection" }));

    expect(await screen.findByText(/changed while they were being verified/)).toBeTruthy();
    await waitFor(() => expect(getCalls(stub)).toBe(2));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it("a refusal of the BAA record whose copy says 'reloaded' reloads too", async () => {
    const stub = stubClient({
      GET: { [PATH]: reads(CLAIMMD_DRAFT, CLAIMMD_DRAFT) },
      POST: { [`${PATH}/baa`]: () => refused(409, "CLEARINGHOUSE_NOT_CONFIGURED") as never },
    });
    const props = mount(stub);
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "Claim.MD BAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));

    expect(await screen.findByText(/Choose a clearinghouse first/)).toBeTruthy();
    await waitFor(() => expect(getCalls(stub)).toBe(2));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it("a stale pin on the choice also re-reads the wizard (another tab may have chosen outside)", async () => {
    const stub = stubClient({
      GET: { [PATH]: () => ok(CLAIMMD_DRAFT) },
      PUT: { [PATH]: () => refused(412, "VERSION_CONFLICT") as never },
    });
    const props = mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Change the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });
});

describe("drafts live in the shell's owner-scoped store", () => {
  async function stashByReverify(stub: StubClient) {
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Change the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
  }
  const stepUp = () =>
    stubClient({
      GET: { [PATH]: () => ok(CLAIMMD_DRAFT) },
      PUT: { [PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });

  it("keys the draft by organization and user, and never holds the credential", async () => {
    await stashByReverify(stepUp());
    const keys = stepUpDraftKeys();
    expect(keys).toEqual([draftKey("tenant-clearinghouse-choice", "clearinghouse_selected")]);
    expect(keys[0]?.startsWith(`${ORG_ADMIN.organizationId}|${ORG_ADMIN.userId}|`)).toBe(true);
    expect(JSON.stringify(peekStepUpDraft(keys[0] ?? ""))).not.toContain(SECRET);
  });

  it("is gone after sign-out / idle lock / expiry (clearAllDrafts)", async () => {
    await stashByReverify(stepUp());
    expect(stepUpDraftKeys()).toHaveLength(1);
    clearAllDrafts();
    expect(stepUpDraftKeys()).toEqual([]);
    expect(
      peekStepUpDraft(draftKey("tenant-clearinghouse-choice", "clearinghouse_selected")),
    ).toBeNull();
  });

  it("is dropped by a later visit that is not the return from Re-verify", async () => {
    await stashByReverify(stepUp());
    cleanup();
    mount(stubClient({ GET: { [PATH]: () => ok(CLAIMMD_DRAFT) } }));
    await screen.findByRole("button", { name: "Change the clearinghouse" });
    expect(screen.queryByRole("form", { name: "Clearinghouse choice" })).toBeNull();
    expect(stepUpDraftKeys()).toEqual([]);
  });
});

describe("a sibling write waits for an open editor, and an editor for a running write", () => {
  it("disables the BAA, connection and activation controls while the choice form is open", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok(CLAIMMD_DRAFT) } }));
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    expect((screen.getByRole("button", { name: "Record BAA" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change the clearinghouse" }));
    expect((screen.getByRole("button", { name: "Record BAA" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Test the connection" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByText("Finish or cancel the change above first.").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Record BAA" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("will not open the choice form while another write is running", async () => {
    let release: (reply: Reply) => void = () => undefined;
    const stub = stubClient({
      GET: { [PATH]: () => ok(CLAIMMD_DRAFT) },
      POST: {
        [`${PATH}/verify`]: () =>
          new Promise((resolve) => {
            release = resolve;
          }) as never,
      },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Test the connection" }));
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "Change the clearinghouse" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    release(ok({ config: CLAIMMD_DRAFT, test: { outcome: "ok" } }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Change the clearinghouse" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});

describe("an organization that bills outside ChartWarden", () => {
  it("is told to ask ChartWarden instead of being offered a vendor form it would be refused", async () => {
    const stub = stubClient({
      GET: {
        [PATH]: () =>
          ok(
            clearinghouseView({
              vendor: "outside",
              source: "tenant",
              status: "active",
              version: 1,
            }),
          ),
      },
    });
    mount(stub);
    expect(await screen.findByText(/changes your billing service mode/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clearinghouse$/ })).toBeNull();
    expect(screen.queryByRole("form", { name: "Clearinghouse choice" })).toBeNull();
    expect(screen.getByText("Billing outside ChartWarden")).toBeTruthy();
  });
});

describe("results and focus survive the card that raised them", () => {
  it("keeps a passed connection test on screen and moves focus to the status line when the card goes away", async () => {
    const stub = stubClient({
      GET: {
        [PATH]: reads(CLAIMMD_DRAFT, { ...CLAIMMD_DRAFT, status: "verified", baa: baa(null) }),
      },
      POST: { [`${PATH}/verify`]: () => ok({ config: CLAIMMD_DRAFT, test: { outcome: "ok" } }) },
    });
    mount(stub);
    expect(status().textContent).toBe(""); // mounted empty, before any message
    fireEvent.click(await screen.findByRole("button", { name: "Test the connection" }));

    await waitFor(() => expect(status().textContent).toContain("The connection test passed."));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Connection" })).toBeNull());
    expect(document.activeElement).toBe(status());
  });

  it("moves focus to the status line after the first BAA is recorded (its form is gone)", async () => {
    const recorded = { ...CLAIMMD_DRAFT, baa: baa(null) };
    const stub = stubClient({
      GET: { [PATH]: reads(CLAIMMD_DRAFT, recorded) },
      POST: { [`${PATH}/baa`]: () => ok(recorded) },
    });
    mount(stub);
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "Claim.MD BAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));

    await waitFor(() =>
      expect(status().textContent).toContain("Waiting for ChartWarden to verify it."),
    );
    expect(screen.queryByRole("form", { name: "Record the vendor BAA" })).toBeNull();
    expect(document.activeElement).toBe(status());
  });

  it("announces activation and moves focus when the Activate button is replaced by text", async () => {
    const stub = stubClient({
      GET: { [PATH]: reads(READY, { ...READY, status: "active" }) },
      POST: { [`${PATH}/activate`]: () => ok({ ...READY, status: "active" }) },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Activate the clearinghouse" }));

    await waitFor(() => expect(status().textContent).toContain("The clearinghouse is active."));
    expect(screen.queryByRole("button", { name: "Activate the clearinghouse" })).toBeNull();
    expect(document.activeElement).toBe(status());
  });

  it("puts focus on the form heading when the choice opens and back on its button when it closes", async () => {
    mount(stubClient({ GET: { [PATH]: () => ok(clearinghouseView()) } }));
    const open = await screen.findByRole("button", { name: "Choose the clearinghouse" });
    open.focus();
    fireEvent.click(open);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Choose the clearinghouse" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Choose the clearinghouse" }),
    );
  });

  it("keeps the pressed Save focusable (aria-disabled, not disabled) while its write runs", async () => {
    let release: (reply: Reply) => void = () => undefined;
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: {
        [PATH]: () =>
          new Promise((resolve) => {
            release = resolve;
          }) as never,
      },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    const save = screen.getByRole("button", { name: "Save choice" });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(save);
    release(ok(CLAIMMD_DRAFT, 201));
  });
});

describe("the write-only credential", () => {
  it("is cleared when the vendor or the mode it was typed for changes, so it never rides to another vendor", async () => {
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: { [PATH]: () => ok(CLAIMMD_DRAFT, 201) },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    expect((screen.getByLabelText("Vendor credential") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Clearinghouse"), { target: { value: "stedi" } });
    expect((screen.getByLabelText("Vendor credential") as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    expect(await screen.findByText("Enter the vendor credential.")).toBeTruthy();
    expect(stub.PUT).not.toHaveBeenCalled();
  });

  it("is cleared when billing outside ChartWarden is picked, and nothing is sent with it", async () => {
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: { [PATH]: () => ok(clearinghouseView({ vendor: "outside", source: "tenant" }), 201) },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Clearinghouse"), { target: { value: "outside" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(stub.PUT.mock.calls[0])).not.toContain(SECRET);
  });

  it("is empty after Cancel and after a successful save", async () => {
    mount(
      stubClient({
        GET: { [PATH]: () => ok(clearinghouseView()) },
        PUT: { [PATH]: () => ok(CLAIMMD_DRAFT, 201) },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose the clearinghouse" }));
    expect((screen.getByLabelText("Vendor credential") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Clearinghouse choice" })).toBeNull(),
    );
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });
});

describe("refusals", () => {
  const openAndSave = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Choose the clearinghouse" }));
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
  };
  const withPut = (reply: () => unknown) =>
    stubClient({ GET: { [PATH]: () => ok(clearinghouseView()) }, PUT: { [PATH]: reply as never } });

  it("shows a refusal that names only a field the form does not render (the server's (root)), with its own sentence", async () => {
    mount(
      withPut(() =>
        refused(422, "VALIDATION_FAILED", "The request has the wrong shape.", [
          { field: "(root)", code: "x", message: "wrong shape" },
        ]),
      ),
    );
    await openAndSave();
    expect(await screen.findByText("The request has the wrong shape.")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Clearinghouse choice" })).toBeTruthy();
  });

  it("drops the server's message under a field once the member edits that field", async () => {
    mount(
      withPut(() =>
        refused(422, "VALIDATION_FAILED", "bad", [
          { field: "secret", code: "x", message: "The credential must have no spaces." },
        ]),
      ),
    );
    await openAndSave();
    expect(await screen.findByText("The credential must have no spaces.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Vendor credential"), {
      target: { value: `${SECRET}!` },
    });
    expect(screen.queryByText("The credential must have no spaces.")).toBeNull();
  });

  it("tells the member how long to wait on a 429 that says", async () => {
    const reply = {
      ...refused(429, "RATE_LIMITED"),
      response: { status: 429, headers: { get: () => "30" } },
    };
    mount(withPut(() => reply));
    await openAndSave();
    expect(await screen.findByText(/Try again in about 30 seconds\./)).toBeTruthy();
    expect(screen.getByText(/tried too many times in a row/)).toBeTruthy();
  });

  it.each([
    [503, "DEGRADED", /unavailable for a moment/],
    [503, "CLEARINGHOUSE_CONTRACT_UNAVAILABLE", /contract could not be read/],
    [409, "CLEARINGHOUSE_SECRET_UNREADABLE", /could not open the vendor credential/],
    [403, "FORBIDDEN", /do not have access/],
  ])("words a %i %s in the tenant's voice", async (status, code, sentence) => {
    mount(withPut(() => refused(status, code)));
    await openAndSave();
    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it("stays usable when the wizard reload after a write rejects, and says nothing alarming", async () => {
    const view = tenantView(STEPS);
    const session = { ...ORG_ADMIN };
    const props = panelProps(
      view,
      "clearinghouse_selected",
      { onChanged: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("rail")) },
      session,
    );
    renderPanel(
      <ClearinghousePanel {...props} />,
      stubClient({
        GET: { [PATH]: () => ok(clearinghouseView()) },
        PUT: { [PATH]: () => ok(CLAIMMD_DRAFT, 201) },
      }),
      "/x",
      session,
    );
    await openAndSave();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Choose the clearinghouse" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Clearinghouse choice" })).toBeNull();
  });
});
