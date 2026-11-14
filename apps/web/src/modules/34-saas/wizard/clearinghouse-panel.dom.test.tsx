// @vitest-environment jsdom
// Step 7, Billing: clearinghouse, on the tenant's side. Choose Stedi, Claim.MD or billing outside ChartWarden, record the vendor BAA, verify
// the connection, then activate once ChartWarden has verified the BAA. The credential is write-only (never shown, never stashed), every write
// needs a fresh step-up and carries one Idempotency-Key per intent, and a change sends the version the member read.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { peekStepUpDraft, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { ClearinghousePanel } from "./clearinghouse-panel";
import {
  BILLING_KEYS,
  CLAIMMD_DRAFT,
  ORG_ADMIN,
  type StubClient,
  clearinghouseView,
  draftKey,
  idempotencyKeyOf,
  ifMatchOf,
  ok,
  panelProps,
  refused,
  renderPanel,
  resetDrafts,
  returnFromStepUp,
  stubClient,
  tenantStep,
  tenantView,
} from "./panel-test-support";

const PATH = "/api/v1/tenant/clearinghouse";
const SECRET = "sk_live_correct-horse-battery";
const DRAFT_KEY = draftKey("tenant-clearinghouse-choice", "clearinghouse_selected");
const BAA_DRAFT_KEY = draftKey("tenant-clearinghouse-baa", "clearinghouse_selected");
const VERIFY_DRAFT_KEY = draftKey("tenant-clearinghouse-verify", "clearinghouse_selected");

const STEPS = [
  tenantStep("provider_setup", 1, { status: "done" }),
  tenantStep("clearinghouse_selected", 2),
];
const VIEW = tenantView(STEPS);

const verifiedBaa = (verified: { at: string } | null) => ({
  heldBy: "tenant" as const,
  effectiveDate: "2026-10-01",
  documentRef: "Claim.MD BAA, signed copy",
  recordedAt: "2026-11-02T00:00:00.000Z",
  verified,
  revoked: false,
  revokedAt: null,
  revokedReasonCode: null,
});

function mount(
  client: StubClient,
  options: {
    view?: typeof VIEW;
    keys?: readonly string[];
  } = {},
) {
  const session = { ...ORG_ADMIN, permissions: [...(options.keys ?? BILLING_KEYS)] };
  const props = panelProps(options.view ?? VIEW, "clearinghouse_selected", {}, session);
  renderPanel(<ClearinghousePanel {...props} />, client, "/x", session);
  return props;
}

/** A client whose GET answers `view` and whose writes answer as given. */
function client(
  view: ReturnType<typeof clearinghouseView>,
  writes: Partial<Record<"PUT" | "POST", Record<string, () => ReturnType<typeof ok>>>> = {},
) {
  return stubClient({
    GET: { [PATH]: () => ok(view) },
    ...(writes.PUT ? { PUT: writes.PUT } : {}),
    ...(writes.POST ? { POST: writes.POST } : {}),
  });
}

async function openChoice(name: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

afterEach(() => {
  cleanup();
  resetDrafts();
});

describe("choosing a clearinghouse", () => {
  it("sends the first choice with no If-Match and one Idempotency-Key, then reloads the step", async () => {
    const stub = client(clearinghouseView(), { PUT: { [PATH]: () => ok(CLAIMMD_DRAFT, 201) } });
    const props = mount(stub);
    await openChoice(/^Choose the clearinghouse$/);

    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    const call = stub.PUT.mock.calls[0] as unknown[];
    expect(call[0]).toBe(PATH);
    expect((call[1] as { body: unknown }).body).toEqual({
      vendor: "claimmd",
      mode: "production",
      secret: SECRET,
    });
    expect(ifMatchOf(call)).toBeUndefined();
    expect(idempotencyKeyOf(call)).toBeTruthy();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(stub.GET.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("sends the version it read when the choice changes", async () => {
    const stub = client(CLAIMMD_DRAFT, { PUT: { [PATH]: () => ok(CLAIMMD_DRAFT) } });
    mount(stub);
    await openChoice(/^Change the clearinghouse$/);

    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    expect(ifMatchOf(stub.PUT.mock.calls[0] as unknown[])).toBe("3");
  });

  it("asks for a credential when the vendor changes and keeps the one on file when nothing does", async () => {
    const stub = client(CLAIMMD_DRAFT, { PUT: { [PATH]: () => ok(CLAIMMD_DRAFT) } });
    mount(stub);
    await openChoice(/^Change the clearinghouse$/);

    fireEvent.change(screen.getByLabelText("Clearinghouse"), { target: { value: "stedi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    expect(await screen.findByText("Enter the vendor credential.")).toBeTruthy();
    expect(stub.PUT).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Clearinghouse"), { target: { value: "claimmd" } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    expect((stub.PUT.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      vendor: "claimmd",
      mode: "production",
    });
  });

  it("says what billing outside ChartWarden does and sends no mode and no credential", async () => {
    const stub = client(clearinghouseView(), {
      PUT: { [PATH]: () => ok(clearinghouseView({ vendor: "outside", source: "tenant" }), 201) },
    });
    mount(stub);
    await openChoice(/^Choose the clearinghouse$/);

    fireEvent.change(screen.getByLabelText("Clearinghouse"), { target: { value: "outside" } });
    expect(
      screen.getByText(/ChartWarden will not send claims; steps 8 and 9 are skipped\./),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Vendor credential")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    expect((stub.PUT.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ vendor: "outside" });
  });

  it("shows the server's refusal of an input beside it and keeps the form open", async () => {
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: {
        [PATH]: () =>
          refused(422, "CLEARINGHOUSE_SECRET_INVALID", "bad", [
            { field: "secret", code: "x", message: "The credential must have no spaces." },
          ]) as never,
      },
    });
    mount(stub);
    await openChoice(/^Choose the clearinghouse$/);
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    expect(await screen.findByText("The credential must have no spaces.")).toBeTruthy();
    expect(screen.getByRole("form", { name: "Clearinghouse choice" })).toBeTruthy();
  });

  it.each([
    [412, "VERSION_CONFLICT"],
    [428, "IF_MATCH_REQUIRED"],
  ])(
    "reloads and says so on a %i (%s), closing the form whose pin is stale",
    async (status, code) => {
      const stub = stubClient({
        GET: { [PATH]: () => ok(CLAIMMD_DRAFT) },
        PUT: { [PATH]: () => refused(status, code) as never },
      });
      mount(stub);
      await openChoice(/^Change the clearinghouse$/);
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
      fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
      fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

      expect(await screen.findByText(/It has been reloaded\./)).toBeTruthy();
      expect(screen.queryByRole("form", { name: "Clearinghouse choice" })).toBeNull();
      await waitFor(() => expect(stub.GET.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    },
  );
});

describe("step-up and the write-only credential", () => {
  const stepUpRefused = () => refused(403, "STEP_UP_REQUIRED") as never;

  it("offers Re-verify, stashes the choice without the credential, and restores it blank on return", async () => {
    const stub = stubClient({
      GET: { [PATH]: () => ok(CLAIMMD_DRAFT) },
      PUT: { [PATH]: stepUpRefused },
    });
    mount(stub);
    await openChoice(/^Change the clearinghouse$/);
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));

    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    const stashed = peekStepUpDraft<{
      form: { vendor: string; mode: string };
      pinnedVersion: number;
    }>(DRAFT_KEY);
    expect(stashed?.form).toMatchObject({ vendor: "claimmd", mode: "test" });
    expect(stashed?.pinnedVersion).toBe(3);
    expect(JSON.stringify(stashed)).not.toContain(SECRET);

    cleanup();
    returnFromStepUp();
    mount(stubClient({ GET: { [PATH]: () => ok(CLAIMMD_DRAFT) }, PUT: { [PATH]: stepUpRefused } }));
    expect(await screen.findByRole("form", { name: "Clearinghouse choice" })).toBeTruthy();
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("test");
    expect((screen.getByLabelText("Vendor credential") as HTMLInputElement).value).toBe("");
  });

  it("drops a second Save while the first is in flight", async () => {
    let release: (reply: ReturnType<typeof ok>) => void = () => undefined;
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: {
        [PATH]: () =>
          new Promise((resolve) => {
            release = resolve;
          }) as never,
      },
    });
    const props = mount(stub);
    await openChoice(/^Choose the clearinghouse$/);
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    fireEvent.submit(screen.getByRole("form", { name: "Clearinghouse choice" }));

    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(1));
    release(ok(CLAIMMD_DRAFT, 201));
    // the one write ran to completion (its follow-up reloaded the wizard once) and no second write was ever sent
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(stub.PUT).toHaveBeenCalledTimes(1);
  });

  it("keeps the same Idempotency-Key when the first try got no answer", async () => {
    let attempts = 0;
    const stub = stubClient({
      GET: { [PATH]: () => ok(clearinghouseView()) },
      PUT: {
        [PATH]: () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("network down");
          return ok(CLAIMMD_DRAFT, 201);
        },
      },
    });
    mount(stub);
    await openChoice(/^Choose the clearinghouse$/);
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    await waitFor(() => expect(stub.PUT).toHaveBeenCalledTimes(2));
    const [first, second] = stub.PUT.mock.calls as unknown[][];
    expect(idempotencyKeyOf(second as unknown[])).toBe(idempotencyKeyOf(first as unknown[]));
  });
});

describe("recording the vendor BAA", () => {
  const BAA_PATH = `${PATH}/baa`;

  it("sends the BAA the tenant holds under one Idempotency-Key and reloads", async () => {
    const stub = client(CLAIMMD_DRAFT, { POST: { [BAA_PATH]: () => ok(CLAIMMD_DRAFT) } });
    const props = mount(stub);
    const form = await screen.findByRole("form", { name: "Record the vendor BAA" });
    expect(form).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "Claim.MD BAA, signed copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(BAA_PATH);
    expect((call[1] as { body: unknown }).body).toEqual({
      heldBy: "tenant",
      effectiveDate: "2026-10-01",
      documentRef: "Claim.MD BAA, signed copy",
    });
    expect(idempotencyKeyOf(call)).toBeTruthy();
    expect(ifMatchOf(call)).toBe(String(CLAIMMD_DRAFT.version));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it("refuses a missing date, a future date and a too short reference before sending", async () => {
    const stub = client(CLAIMMD_DRAFT, { POST: { [BAA_PATH]: () => ok(CLAIMMD_DRAFT) } });
    mount(stub);
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    expect(await screen.findByText("Enter the date the BAA took effect.")).toBeTruthy();
    expect(
      screen.getByText("Say where the signed BAA is kept (3 to 200 characters)."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2999-01-01" } });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "ab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    expect(await screen.findByText("The effective date cannot be in the future.")).toBeTruthy();
    expect(stub.POST).not.toHaveBeenCalled();
  });

  it("says it is waiting for ChartWarden to verify, and offers no Activate yet", async () => {
    const view = { ...CLAIMMD_DRAFT, status: "verified" as const, baa: verifiedBaa(null) };
    mount(client(view));
    expect(
      await screen.findByText(/Waiting for ChartWarden to verify your vendor BAA/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate the clearinghouse" })).toBeNull();
  });

  it("offers Re-verify when the write needs a fresh step-up", async () => {
    const stub = client(CLAIMMD_DRAFT, {
      POST: { [BAA_PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });
    mount(stub);
    await screen.findByRole("form", { name: "Record the vendor BAA" });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "Claim.MD BAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("does not restore a BAA draft onto a different clearinghouse configuration", async () => {
    const refusedWrite = client(CLAIMMD_DRAFT, {
      POST: { [BAA_PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });
    mount(refusedWrite);
    fireEvent.change(await screen.findByLabelText("Effective date"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("Where the signed BAA is kept"), {
      target: { value: "Claim.MD BAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(peekStepUpDraft(BAA_DRAFT_KEY)).toBeTruthy();

    cleanup();
    returnFromStepUp();
    const changed = {
      ...CLAIMMD_DRAFT,
      vendor: "stedi" as const,
      mode: "test" as const,
      version: (CLAIMMD_DRAFT.version ?? 0) + 1,
      verifiableBy: "attestation" as const,
    };
    mount(client(changed));
    expect(((await screen.findByLabelText("Effective date")) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Where the signed BAA is kept") as HTMLInputElement).value).toBe(
      "",
    );
  });
});

describe("verifying the connection and activating", () => {
  const VERIFY_PATH = `${PATH}/verify`;
  const ACTIVATE_PATH = `${PATH}/activate`;

  it("runs the connection test for Claim.MD with an empty body and says when the vendor rejects it", async () => {
    const stub = client(CLAIMMD_DRAFT, {
      POST: {
        [VERIFY_PATH]: () =>
          ok({ config: CLAIMMD_DRAFT, test: { outcome: "credential_rejected" } }),
      },
    });
    const props = mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Test the connection" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(VERIFY_PATH);
    expect((call[1] as { body: unknown }).body).toEqual({});
    expect(idempotencyKeyOf(call)).toBeTruthy();
    expect(ifMatchOf(call)).toBe(String(CLAIMMD_DRAFT.version));
    expect(await screen.findByText(/The vendor rejected the credential/)).toBeTruthy();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("asks Stedi for what was checked and a no-patient-information confirmation, then sends both", async () => {
    const stedi = {
      ...CLAIMMD_DRAFT,
      vendor: "stedi" as const,
      verifiableBy: "attestation" as const,
    };
    const stub = client(stedi, {
      POST: { [VERIFY_PATH]: () => ok({ config: stedi, test: null }) },
    });
    mount(stub);
    await screen.findByRole("form", { name: "Verify the connection" });

    fireEvent.change(screen.getByLabelText("What was checked, and by whom"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify the connection" }));
    expect(await screen.findByText(/Say what was checked and by whom/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("What was checked, and by whom"), {
      target: { value: "Signed in to Stedi and saw the key active, J. Rivera" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify the connection" }));
    expect(
      await screen.findByText("Confirm that your note names no patient information."),
    ).toBeTruthy();
    expect(stub.POST).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("This note names no patient information"));
    fireEvent.click(screen.getByRole("button", { name: "Verify the connection" }));
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect((stub.POST.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      evidenceNote: "Signed in to Stedi and saw the key active, J. Rivera",
      confirmNoPatientInformation: true,
    });
  });

  it("offers Re-verify when the connection test needs a fresh step-up", async () => {
    const stub = client(CLAIMMD_DRAFT, {
      POST: { [VERIFY_PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Test the connection" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("does not restore connection-attestation evidence onto a changed configuration", async () => {
    const stedi = {
      ...CLAIMMD_DRAFT,
      vendor: "stedi" as const,
      verifiableBy: "attestation" as const,
    };
    const refusedWrite = client(stedi, {
      POST: { [VERIFY_PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });
    mount(refusedWrite);
    fireEvent.change(await screen.findByLabelText("What was checked, and by whom"), {
      target: { value: "Signed in to Stedi and saw the key active, J. Rivera" },
    });
    fireEvent.click(screen.getByLabelText("This note names no patient information"));
    fireEvent.click(screen.getByRole("button", { name: "Verify the connection" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(peekStepUpDraft(VERIFY_DRAFT_KEY)).toBeTruthy();

    cleanup();
    returnFromStepUp();
    const changed = { ...stedi, mode: "test" as const, version: (stedi.version ?? 0) + 1 };
    mount(client(changed));
    expect(
      ((await screen.findByLabelText("What was checked, and by whom")) as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  it("offers Re-verify when activation needs a fresh step-up, and explains a refusal in the tenant's words", async () => {
    const view = {
      ...CLAIMMD_DRAFT,
      status: "verified" as const,
      baa: verifiedBaa({ at: "2026-11-03T00:00:00.000Z" }),
    };
    const stub = client(view, {
      POST: { [ACTIVATE_PATH]: () => refused(403, "STEP_UP_REQUIRED") as never },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Activate the clearinghouse" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("activates once the connection and the BAA are both verified", async () => {
    const view = {
      ...CLAIMMD_DRAFT,
      status: "verified" as const,
      baa: verifiedBaa({ at: "2026-11-03T00:00:00.000Z" }),
    };
    const stub = client(view, {
      POST: { [ACTIVATE_PATH]: () => ok({ ...view, status: "active" }) },
    });
    const props = mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Activate the clearinghouse" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(ACTIVATE_PATH);
    expect(idempotencyKeyOf(call)).toBeTruthy();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });
});

describe("what the member may see and do", () => {
  it("shows facts and no controls to a member without the admin key", async () => {
    mount(client(CLAIMMD_DRAFT), { keys: ["billing.clearinghouse.read"] });
    expect(await screen.findByText("The vendor credential is on file")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clearinghouse$/i })).toBeNull();
    expect(screen.queryByRole("form", { name: "Record the vendor BAA" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test the connection" })).toBeNull();
  });

  it("offers no form once the tenant is not onboarding", async () => {
    mount(client(CLAIMMD_DRAFT), { view: tenantView(STEPS, { tenantStatus: "active" }) });
    expect(await screen.findByText("The vendor credential is on file")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change the clearinghouse" })).toBeNull();
  });

  it("says so, and calls nothing, when the member cannot read the settings", async () => {
    const stub = client(CLAIMMD_DRAFT);
    mount(stub, { keys: ["onboarding.read_own"] });
    expect(await screen.findByText(/cannot view the clearinghouse settings/)).toBeTruthy();
    expect(stub.GET).not.toHaveBeenCalled();
  });

  it("says the page may be out of date when the reload after a write fails", async () => {
    let reads = 0;
    const stub = stubClient({
      GET: {
        [PATH]: () => {
          reads += 1;
          return reads === 1
            ? ok(clearinghouseView())
            : (refused(500, "INTERNAL", "boom") as never);
        },
      },
      PUT: { [PATH]: () => ok(CLAIMMD_DRAFT, 201) },
    });
    mount(stub);
    await openChoice(/^Choose the clearinghouse$/);
    fireEvent.change(screen.getByLabelText("Vendor credential"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save choice" }));
    expect(await screen.findByText(/may be out of date/)).toBeTruthy();
  });

  it("reads a failed load as a failure, not as no choice", async () => {
    let reads = 0;
    const stub = stubClient({
      GET: {
        [PATH]: () =>
          reads++ === 0 ? (refused(500, "INTERNAL", "boom") as never) : ok(clearinghouseView()),
      },
    });
    mount(stub);
    expect(await screen.findByText(/Could not load the clearinghouse settings/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose the clearinghouse" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Choose the clearinghouse" })).toBeTruthy();
  });
});
