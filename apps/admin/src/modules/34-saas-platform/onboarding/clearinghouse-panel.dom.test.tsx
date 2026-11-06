// @vitest-environment jsdom
// Step 7, Billing: clearinghouse. Choose Stedi, Claim.MD or billing outside ChartWarden for the tenant, then walk a vendor to active. The
// credential is write-only (never shown, never stashed). Verifying the vendor BAA is pinned to the record the operator read (If-Match =
// its recordedAt): a BAA the tenant swapped meanwhile is shown anew and needs a second, deliberate confirm.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClearinghouseView } from "./clearinghouse-model";
import { ClearinghousePanel } from "./clearinghouse-panel";
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

const CH = "/api/v1/platform/tenants/{orgSlug}/clearinghouse";
const VERIFY = `${CH}/verify`;
const ACTIVATE = `${CH}/activate`;
const BAA_VERIFY = `${CH}/baa/verify`;
const SUBSCRIPTION = "/api/v1/platform/tenants/{orgSlug}/subscription";
const TYPED_VALUE = "vendor-credential-for-test-only";
const RECORDED_AT = "2026-11-02T10:00:00.123Z";
const RECORDED_AGAIN = "2026-11-04T08:30:00.456Z";

const NOTHING: ClearinghouseView = {
  vendor: null,
  mode: null,
  status: null,
  source: "none",
  hasSecret: false,
  verifiableBy: null,
  verification: null,
  lastTest: null,
  baaRequired: false,
  baa: null,
  activatedAt: null,
  version: null,
  updatedAt: null,
};
const CLAIMMD: ClearinghouseView = {
  ...NOTHING,
  vendor: "claimmd",
  mode: "production",
  status: "draft",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  baaRequired: true,
  version: 3,
};
const BAA = {
  heldBy: "tenant" as const,
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, contract folder 7",
  recordedAt: RECORDED_AT,
  verified: null,
};
const VERIFIED_BAA = { ...BAA, verified: { at: "2026-11-03T09:00:00.000Z" } };

const step = (over = {}) =>
  wizardStep("clearinghouse_selected", 1, {
    title: "Billing: clearinghouse",
    owner: "either",
    completionMode: "either",
    ...over,
  });
const view = (over = {}) => wizardView([step()], over);

function mount(
  config: ClearinghouseView,
  extra: Parameters<typeof stubClient>[0] = {},
  v = view(),
  contractMode: string | null = null,
) {
  const client = stubClient({
    GET: {
      [CH]: () => ok(config),
      [SUBSCRIPTION]: () =>
        ok({
          contract: contractMode
            ? { billingServiceMode: contractMode, pendingBillingServiceMode: null }
            : null,
        }),
    },
    ...extra,
  });
  const ctx = panelCtx(v, "clearinghouse_selected");
  renderAt("/x", [{ path: "/x", element: <ClearinghousePanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

const confirm = (reason: string, button: string) => {
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: button }));
};
const secretBox = () => screen.getByLabelText(/^Vendor credential/);
const lastCall = (calls: unknown[][]) =>
  calls.at(-1) as [
    string,
    {
      params: { path: unknown; header: Record<string, string> };
      body: Record<string, unknown>;
    },
  ];

describe("ClearinghousePanel: what is on file", () => {
  it("says nothing is chosen, and offers the choice", async () => {
    mount(NOTHING);
    expect(await screen.findByRole("button", { name: "Choose clearinghouse" })).toBeTruthy();
    expect(screen.getByText(/A clearinghouse is chosen/).closest("li")?.textContent).toMatch(
      /Not yet/,
    );
  });

  it("shows a vendor without its credential, and the BAA the tenant recorded", async () => {
    mount({ ...CLAIMMD, baa: BAA });
    expect(await screen.findByText(/Secret on file/)).toBeTruthy();
    expect(screen.getAllByText(/Claim\.MD BAA, contract folder 7/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(TYPED_VALUE);
  });

  it("shows a tenant billing outside ChartWarden as settled, with nothing to verify or activate", async () => {
    mount({ ...NOTHING, vendor: "outside", status: "active", source: "tenant", version: 1 });
    expect((await screen.findAllByText(/Billing outside ChartWarden/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Activate|Verify|connection test/ })).toBeNull();
  });

  it("is read-only when the step cannot be acted on", async () => {
    mount(CLAIMMD, {}, view({ tenantStatus: "active" }));
    await screen.findByText(/Secret on file/);
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run the connection test" })).toBeNull();
  });
});

describe("ClearinghousePanel: choosing", () => {
  it("makes a first choice with no If-Match, the credential, a reason and an Idempotency-Key", async () => {
    const { client, ctx } = mount(NOTHING, {
      PUT: { [CH]: () => ok({ ...CLAIMMD, version: 1 }, 201) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer sent us their Claim.MD account key", "Save");

    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [path, init] = lastCall(client.PUT.mock.calls);
    expect(path).toBe(CH);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.params.header["If-Match"]).toBeUndefined();
    expect(init.body).toEqual({
      vendor: "claimmd",
      mode: "production",
      secret: TYPED_VALUE,
      reason: "Customer sent us their Claim.MD account key",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain(TYPED_VALUE);
  });

  it("requires a credential for a first choice and does not ask for a reason until it has one", async () => {
    mount(NOTHING);
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Enter the vendor credential/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(secretBox(), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/at least 8 characters/)).toBeTruthy();
  });

  it("pins a change to the version that was read, and needs a credential only when the vendor or mode changes", async () => {
    const { client } = mount(CLAIMMD, { PUT: { [CH]: () => ok(CLAIMMD) } });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    // the same vendor and mode: nothing new to seal, the credential on file stays
    expect(screen.getByText(/Leave blank to keep the credential on file/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Enter the vendor credential/)).toBeTruthy();
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/starts the new configuration at draft/)).toBeTruthy();
    confirm("Customer moved to their sandbox account", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].params.header["If-Match"]).toBe("3");
    expect(lastCall(client.PUT.mock.calls)[1].body).toMatchObject({
      mode: "test",
      secret: TYPED_VALUE,
    });
  });

  it("chooses billing outside ChartWarden with no mode and no credential, and says what that does first", async () => {
    const { client } = mount(NOTHING, {
      PUT: { [CH]: () => ok({ ...NOTHING, vendor: "outside", status: "active" }, 201) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Clearinghouse" }), {
      target: { value: "outside" },
    });
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(secretBoxOrNull()).toBeNull();
    expect(screen.getByText(/ChartWarden will transmit nothing for this tenant/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer files its own claims with its biller", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].body).toEqual({
      vendor: "outside",
      reason: "Customer files its own claims with its biller",
    });
  });

  it("explains a version conflict: it is reloaded and the credential must be typed again", async () => {
    const { client } = mount(CLAIMMD, {
      PUT: { [CH]: () => refused(412, "VERSION_CONFLICT", "stale") },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer moved to their sandbox account", "Save");
    expect(await screen.findByText(/changed since you opened it/i)).toBeTruthy();
    await waitFor(() =>
      expect(client.GET.mock.calls.filter((c) => c[0] === CH).length).toBeGreaterThan(1),
    );
    // the form closed (its pin is stale): reopening it starts on what the record says now, with no credential typed
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect((secretBox() as HTMLInputElement).value).toBe("");
  });

  it("treats a missing If-Match (428) like a conflict: closes the form, reloads, says to enter the change again", async () => {
    const { client } = mount(CLAIMMD, {
      PUT: { [CH]: () => refused(428, "IF_MATCH_REQUIRED", "needs the version") },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer moved to their sandbox account", "Save");
    expect(await screen.findByText(/changed while you were looking at it/i)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText(/^Vendor credential/)).toBeNull();
    await waitFor(() =>
      expect(client.GET.mock.calls.filter((c) => c[0] === CH).length).toBeGreaterThan(1),
    );
  });

  it("never stashes the credential through a re-verify, and comes back to the form without the reason prompt", async () => {
    mount(NOTHING, { PUT: { [CH]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer sent us their Claim.MD account key", "Save");
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    const stashed =
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:clearinghouse_selected:choice",
      ) ?? "";
    expect(stashed).toContain("claimmd");
    expect(stashed).not.toContain(TYPED_VALUE);
    cleanup();

    mount(NOTHING, { PUT: { [CH]: () => ok(CLAIMMD, 201) } });
    expect(await screen.findByRole("heading", { name: "Choose the clearinghouse" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((secretBox() as HTMLInputElement).value).toBe("");
  });
});

describe("ClearinghousePanel: leaving outside for a vendor (a contracted tenant's billing mode)", () => {
  const OUTSIDE_TENANT: ClearinghouseView = {
    ...NOTHING,
    vendor: "outside",
    status: "active",
    source: "tenant",
    version: 4,
  };
  const withContract = () =>
    wizardView([wizardStep("plan_contract", 1, { status: "done" }), step({ sequence: 2 })]);
  const open = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    // the form opens on what is chosen now (outside): the operator picks the vendor to move to
    fireEvent.change(screen.getByRole("combobox", { name: "Clearinghouse" }), {
      target: { value: "claimmd" },
    });
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
  };

  it("asks for the billing service mode (no default), refuses to continue without it, and sends it with the pin", async () => {
    const { client } = mount(OUTSIDE_TENANT, { PUT: { [CH]: () => ok(CLAIMMD) } }, withContract());
    await open();
    const modeBox = screen.getByLabelText(/^Billing service mode/) as HTMLSelectElement;
    expect(modeBox.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose the billing service mode.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.change(modeBox, { target: { value: "managed_billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(within(screen.getByRole("dialog")).getByText(/Managed billing/)).toBeTruthy();
    confirm("The customer moves to Claim.MD, ticket CHG-9101", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    const [, init] = lastCall(client.PUT.mock.calls);
    expect(init.params.header["If-Match"]).toBe("4");
    expect(init.body).toMatchObject({
      vendor: "claimmd",
      billingServiceMode: "managed_billing",
      reason: "The customer moves to Claim.MD, ticket CHG-9101",
    });
  });

  it("accepts an explicit None as the answer", async () => {
    const { client } = mount(OUTSIDE_TENANT, { PUT: { [CH]: () => ok(CLAIMMD) } }, withContract());
    await open();
    fireEvent.change(screen.getByLabelText(/^Billing service mode/), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("The customer moves to Claim.MD, ticket CHG-9101", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].body).toMatchObject({ billingServiceMode: "none" });
  });

  it("does not ask, and sends no billing mode, for a tenant with no contract, a vendor-to-vendor change or a first choice", async () => {
    const { client } = mount(OUTSIDE_TENANT, { PUT: { [CH]: () => ok(CLAIMMD) } }); // no plan_contract step: no contract
    await open();
    expect(screen.queryByLabelText(/^Billing service mode/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("The customer moves to Claim.MD, ticket CHG-9101", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].body).not.toHaveProperty("billingServiceMode");
    cleanup();

    mount(CLAIMMD, {}, withContract());
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(screen.queryByLabelText(/^Billing service mode/)).toBeNull();
  });

  it("shows the server's own refusal under the mode box when it judged the contract differently (422, field billingServiceMode)", async () => {
    mount(
      OUTSIDE_TENANT,
      {
        PUT: {
          [CH]: () =>
            refused(422, "VALIDATION_FAILED", "invalid", [
              {
                field: "billingServiceMode",
                code: "BILLING_SERVICE_MODE_REQUIRED",
                message: "choose the billing service mode it takes with the vendor",
              },
            ]),
        },
      },
      view(), // the console saw no contract; the server did
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("The customer moves to Claim.MD, ticket CHG-9101", "Save");
    // the prompt steps aside; the form is still open, and the mode box is not there to attach to, so the notice carries it
    expect(await screen.findByText(/Some details need attention/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ClearinghousePanel: the write-only credential box and the no-patient confirmation", () => {
  it("asks the browser to offer no saved password for the vendor credential", async () => {
    mount(NOTHING);
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    expect(secretBox().getAttribute("autocomplete")).toBe("new-password");
  });

  const STEDI: ClearinghouseView = { ...CLAIMMD, vendor: "stedi", verifiableBy: "attestation" };
  const NOTE = "Sent a 270 test transaction with the sandbox key and read the 271 reply";
  const tick = () =>
    screen.getByLabelText("This note names no patient information") as HTMLInputElement;

  it("clears the tick when the note is edited, so the operator confirms the words that will be recorded", async () => {
    mount(STEDI);
    fireEvent.click(await screen.findByRole("button", { name: "Verify the connection" }));
    fireEvent.change(screen.getByLabelText(/^What was checked, and by whom/), {
      target: { value: NOTE },
    });
    fireEvent.click(tick());
    expect(tick().checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/^What was checked, and by whom/), {
      target: { value: `${NOTE}; also read the claim for the member` },
    });
    expect(tick().checked).toBe(false);
  });

  it("clears the tick when the reason prompt is cancelled, so going back to the note asks again", async () => {
    mount(STEDI);
    fireEvent.click(await screen.findByRole("button", { name: "Verify the connection" }));
    fireEvent.change(screen.getByLabelText(/^What was checked, and by whom/), {
      target: { value: NOTE },
    });
    fireEvent.click(tick());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tick().checked).toBe(false);
  });
});

describe("ClearinghousePanel: the server's field errors land on their inputs", () => {
  it("shows a refused vendor credential under the credential box, with the form still open and what was typed kept", async () => {
    mount(NOTHING, {
      PUT: {
        [CH]: () =>
          refused(422, "CLEARINGHOUSE_SECRET_INVALID", "invalid", [
            {
              field: "secret",
              code: "X",
              message: "That does not look like a Claim.MD account key.",
            },
          ]),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer sent us their Claim.MD account key", "Save");

    expect(await screen.findByText(/does not look like a Claim\.MD account key/)).toBeTruthy();
    // the prompt is out of the way, so the error is read beside the box it is about
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Choose the clearinghouse" })).toBeTruthy();
  });

  it("shows a PHI refusal of the Stedi evidence note under the note field", async () => {
    const stedi: ClearinghouseView = { ...CLAIMMD, vendor: "stedi", verifiableBy: "attestation" };
    mount(stedi, {
      POST: {
        [VERIFY]: () =>
          refused(422, "EVIDENCE_LOOKS_LIKE_PHI", "looks like phi", [
            {
              field: "evidenceNote",
              code: "EVIDENCE_LOOKS_LIKE_PHI",
              message: "That text looks like it contains a patient identifier.",
            },
          ]),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Verify the connection" }));
    fireEvent.change(screen.getByLabelText(/^What was checked, and by whom/), {
      target: {
        value: "Sent a 270 test transaction for the sandbox member and read the 271 reply",
      },
    });
    fireEvent.click(screen.getByLabelText("This note names no patient information"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Tenant asked us to complete setup, ticket CHG-8002", "Attest");

    const field = screen.getByLabelText(/^What was checked, and by whom/);
    expect(await screen.findByText(/looks like it contains a patient identifier/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // what the operator typed is still there to fix
    expect((field as HTMLTextAreaElement).value).toMatch(/270 test transaction/);
  });
});

describe("ClearinghousePanel: coming back from Re-verify keeps the pin", () => {
  it("resumes a CHANGE pinned to the version the operator first read (3), so a change made meanwhile is a 412, not one they never saw", async () => {
    mount(CLAIMMD, { PUT: { [CH]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer moved to their sandbox account", "Save");
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    // someone else changed the config while the operator was re-verifying: it is version 4 now
    const { client } = mount(
      { ...CLAIMMD, version: 4 },
      { PUT: { [CH]: () => refused(412, "VERSION_CONFLICT", "stale") } },
    );
    expect(await screen.findByRole("heading", { name: "Change the clearinghouse" })).toBeTruthy();
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer moved to their sandbox account", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].params.header["If-Match"]).toBe("3");
    expect(await screen.findByText(/changed since you opened it/i)).toBeTruthy();
  });

  it("resumes a FIRST choice as a first choice (no If-Match), never as a change of whatever is on file now", async () => {
    mount(NOTHING, { PUT: { [CH]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(await screen.findByRole("button", { name: "Choose clearinghouse" }));
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer sent us their Claim.MD account key", "Save");
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    const { client } = mount(NOTHING, { PUT: { [CH]: () => ok(CLAIMMD, 201) } });
    await screen.findByRole("heading", { name: "Choose the clearinghouse" });
    fireEvent.change(secretBox(), { target: { value: TYPED_VALUE } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Customer sent us their Claim.MD account key", "Save");
    await waitFor(() => expect(client.PUT).toHaveBeenCalledTimes(1));
    expect(lastCall(client.PUT.mock.calls)[1].params.header["If-Match"]).toBeUndefined();
  });
});

const secretBoxOrNull = () => screen.queryByLabelText(/^Vendor credential/);

describe("ClearinghousePanel: verifying the vendor BAA (pinned to the record read)", () => {
  const openBaa = async () =>
    fireEvent.click(await screen.findByRole("button", { name: "Verify the vendor BAA" }));

  it("shows the record being verified and pins the call to its recordedAt", async () => {
    const { client } = mount(
      { ...CLAIMMD, baa: BAA },
      { POST: { [BAA_VERIFY]: () => ok(CLAIMMD) } },
    );
    await openBaa();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Claim.MD BAA, contract folder 7")).toBeTruthy();
    expect(dialog.getByText("2026-01-15")).toBeTruthy();
    confirm("Read the signed agreement, ticket CHG-8001", "Verify BAA");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = lastCall(client.POST.mock.calls);
    expect(path).toBe(BAA_VERIFY);
    expect(init.params.header["If-Match"]).toBe(RECORDED_AT);
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({ reason: "Read the signed agreement, ticket CHG-8001" });
  });

  it("when the tenant re-recorded its BAA meanwhile: says so, shows the new record, and the second confirm pins the NEW one", async () => {
    let reads = 0;
    const { client } = mount(
      { ...CLAIMMD, baa: BAA },
      {
        GET: {
          [CH]: () => {
            reads += 1;
            return ok({
              ...CLAIMMD,
              baa:
                reads === 1
                  ? BAA
                  : { ...BAA, documentRef: "Claim.MD BAA v2", recordedAt: RECORDED_AGAIN },
            });
          },
          [SUBSCRIPTION]: () => ok({ contract: null }),
        },
        POST: {
          [BAA_VERIFY]: (init) =>
            (init as { params?: { header?: Record<string, string> } }).params?.header?.[
              "If-Match"
            ] === RECORDED_AT
              ? refused(409, "CLEARINGHOUSE_BAA_CHANGED", "changed", [
                  { field: "currentRecordedAt", code: "X", message: RECORDED_AGAIN },
                ])
              : ok(CLAIMMD),
        },
      },
    );
    await openBaa();
    confirm("Read the signed agreement, ticket CHG-8001", "Verify BAA");

    // the dialog stays open on the NEW record, with the stale notice and a re-worded confirm button
    expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
    const dialog = within(screen.getByRole("dialog"));
    await waitFor(() => expect(dialog.getByText("Claim.MD BAA v2")).toBeTruthy());
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(dialog.getByRole("button", { name: /Confirm the updated record/ })).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: /Confirm the updated record/ }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(lastCall(client.POST.mock.calls)[1].params.header["If-Match"]).toBe(RECORDED_AGAIN);
  });

  it("closes the prompt when the BAA was verified by someone else meanwhile, instead of leaving it to reappear", async () => {
    let reads = 0;
    mount(
      { ...CLAIMMD, baa: BAA },
      {
        GET: {
          [CH]: () => {
            reads += 1;
            return ok({ ...CLAIMMD, baa: reads === 1 ? BAA : VERIFIED_BAA });
          },
          [SUBSCRIPTION]: () => ok({ contract: null }),
        },
        POST: { [BAA_VERIFY]: () => refused(409, "CLEARINGHOUSE_BAA_CHANGED", "changed") },
      },
    );
    await openBaa();
    confirm("Read the signed agreement, ticket CHG-8001", "Verify BAA");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByText(/An operator verified the vendor BAA/).closest("li")?.textContent,
    ).toMatch(/Met/);
  });

  it("offers nothing to verify while the tenant has not recorded a BAA, and says it is the tenant's to record", async () => {
    mount(CLAIMMD);
    await screen.findByText(/Secret on file/);
    expect(screen.queryByRole("button", { name: "Verify the vendor BAA" })).toBeNull();
    expect(screen.getByText(/The tenant records this itself/)).toBeTruthy();
  });
});

describe("ClearinghousePanel: verifying the connection and activating", () => {
  it("runs the Claim.MD connection test with a reason only, and says so when the vendor rejects the credential", async () => {
    const { client } = mount(
      { ...CLAIMMD, baa: VERIFIED_BAA },
      {
        POST: {
          [VERIFY]: () => ok({ config: CLAIMMD, test: { outcome: "credential_rejected" } }),
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Run the connection test" }));
    confirm("Checking the credential the tenant sent", "Run test");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(lastCall(client.POST.mock.calls)[1].body).toEqual({
      reason: "Checking the credential the tenant sent",
    });
    expect(await screen.findByText(/The vendor rejected the credential/)).toBeTruthy();
  });

  it("attests a Stedi connection with the evidence note and the no-patient-information confirmation", async () => {
    const stedi: ClearinghouseView = { ...CLAIMMD, vendor: "stedi", verifiableBy: "attestation" };
    const { client } = mount(stedi, {
      POST: { [VERIFY]: () => ok({ config: stedi, test: null }) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Verify the connection" }));
    // no note, no reason prompt
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Say what was checked and by whom/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.change(screen.getByLabelText(/^What was checked, and by whom/), {
      target: {
        value:
          "Sent a 270 test transaction with the sandbox key; Dana in support confirmed 271 reply",
      },
    });
    // the note alone is not enough: the operator must confirm it names no patient (nothing confirms it for them)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/Confirm the note names no patient information/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByLabelText("This note names no patient information"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    confirm("Tenant asked us to complete setup, ticket CHG-8002", "Attest");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(lastCall(client.POST.mock.calls)[1].body).toEqual({
      evidenceNote:
        "Sent a 270 test transaction with the sandbox key; Dana in support confirmed 271 reply",
      confirmNoPatientInformation: true,
      reason: "Tenant asked us to complete setup, ticket CHG-8002",
    });
  });

  it("holds activation back until the BAA is verified, and says why", async () => {
    mount({ ...CLAIMMD, status: "verified", baa: BAA });
    await screen.findByText(/Secret on file/);
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.getByText(/Verify the vendor BAA first/)).toBeTruthy();
  });

  it("activates a verified clearinghouse whose BAA is verified, and re-reads the wizard (the step settles)", async () => {
    const { client, ctx } = mount(
      { ...CLAIMMD, status: "verified", baa: VERIFIED_BAA },
      { POST: { [ACTIVATE]: () => ok({ ...CLAIMMD, status: "active" }) } },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Activate" }));
    confirm("Everything verified, ticket CHG-8003", "Activate");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(lastCall(client.POST.mock.calls)[0]).toBe(ACTIVATE);
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });
});

describe("ClearinghousePanel: the billing mode banner", () => {
  it("warns when a vendor is chosen but the contract's billing mode is still None, and links to the plan step", async () => {
    mount(CLAIMMD, {}, view(), "none");
    expect(await screen.findByText(/billing service mode is still None/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Plan and contract step/ }).getAttribute("href")).toBe(
      `/tenants/${ORG_SLUG}/onboarding/plan_contract`,
    );
  });

  it("is silent when the mode is something else, and for a tenant billing outside (no vendor)", async () => {
    mount(CLAIMMD, {}, view(), "billing_software");
    await screen.findByText(/Secret on file/);
    await waitFor(() => expect(screen.queryByText(/still None/)).toBeNull());
    cleanup();
    const { client } = mount(
      { ...NOTHING, vendor: "outside", status: "active", source: "tenant", version: 1 },
      {},
      view(),
      "none",
    );
    await screen.findAllByText(/Billing outside ChartWarden/);
    // the contract is not even read (an audited read) when there is no vendor to compare it to
    expect(client.GET.mock.calls.some((c) => c[0] === SUBSCRIPTION)).toBe(false);
  });
});
