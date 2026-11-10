// @vitest-environment jsdom
// Step 8, Billing: MAC credentials, on the tenant's side. The Medicare submitter credential the organization's claims go out under: add it,
// replace it (pinned to the version read), test it against the MAC portal. The client secret is write-only (never shown, never stashed).
// Every write needs a fresh step-up and one Idempotency-Key per intent. A tenant that does not bill Medicare through ChartWarden skips the step
// through the frame's "This does not apply to us".
import { peekStepUpMemoryDraft } from "@chartwarden/ui";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacPanel } from "./mac-panel";
import {
  BILLING_KEYS,
  ORG_ADMIN,
  PROVIDER_ENTITY_ID,
  RETURNED_FROM_STEP_UP,
  type StubClient,
  idempotencyKeyOf,
  ifMatchOf,
  macCredential,
  ok,
  panelProps,
  refused,
  renderPanel,
  stubClient,
  tenantStep,
  tenantView,
} from "./panel-test-support";

const LIST = "/api/v1/billing/mac-credentials";
const ENTITIES = "/api/v1/provider-entities";
const TEST = "/api/v1/billing/mac-credentials/{providerEntityId}/test";
const SECRET = "mac-secret-correct-horse";
const DRAFT_KEY = "wizard:mac_configured:credential";

const STEPS = [
  tenantStep("clearinghouse_selected", 1, { status: "done" }),
  tenantStep("mac_configured", 2),
];
const VIEW = tenantView(STEPS);
const ENTITY_LIST = {
  items: [
    {
      id: PROVIDER_ENTITY_ID,
      legalName: "Cedar Ridge Hospice",
      doingBusinessAs: null,
      ccn: "341234",
      npi: null,
      status: "active",
    },
  ],
  nextCursor: null,
};
const page = (items: ReturnType<typeof macCredential>[]) => ({
  items,
  nextCursor: null,
  hasMore: false,
});

interface Options {
  keys?: readonly string[];
  skipAvailable?: boolean;
  url?: string | { pathname: string; state?: unknown };
}
function mount(client: StubClient, options: Options = {}) {
  const session = { ...ORG_ADMIN, permissions: [...(options.keys ?? BILLING_KEYS)] };
  const props = panelProps(
    VIEW,
    "mac_configured",
    { skip: { available: options.skipAvailable ?? false, request: vi.fn() } },
    session,
  );
  renderPanel(<MacPanel {...props} />, client, options.url, session);
  return props;
}

function client(
  credentials: ReturnType<typeof macCredential>[],
  writes: Record<string, () => unknown> = {},
) {
  return stubClient({
    GET: { [LIST]: () => ok(page(credentials)), [ENTITIES]: () => ok(ENTITY_LIST) },
    POST: writes as never,
  });
}

function fillNew(): void {
  fireEvent.change(screen.getByLabelText("Submitter id"), { target: { value: "SUB-100" } });
  fireEvent.change(screen.getByLabelText("Trading partner id"), { target: { value: "TP-200" } });
  fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "client-300" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("adding and replacing the credential", () => {
  it("sends the first credential with no If-Match and one Idempotency-Key, then reloads the step", async () => {
    const stub = client([], { [LIST]: () => ok(macCredential(), 201) });
    const props = mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    await screen.findByRole("form", { name: "MAC credential form" });
    fireEvent.change(await screen.findByLabelText("Provider entity"), {
      target: { value: PROVIDER_ENTITY_ID },
    });
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(LIST);
    expect((call[1] as { body: unknown }).body).toEqual({
      providerEntityId: PROVIDER_ENTITY_ID,
      macJurisdiction: "noridian_jf",
      submitterId: "SUB-100",
      tradingPartnerId: "TP-200",
      clientId: "client-300",
      clientSecret: SECRET,
    });
    expect(ifMatchOf(call)).toBeUndefined();
    expect(idempotencyKeyOf(call)).toBeTruthy();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(stub.GET.mock.calls.filter((c) => c[0] === LIST).length).toBeGreaterThanOrEqual(2);
  });

  it("pins a replacement to the version it read and never shows the secret on file", async () => {
    const stub = client([macCredential()], { [LIST]: () => ok(macCredential()) });
    mount(stub);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Replace credential for Cedar Ridge Hospice$/ }),
    );
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Provider entity") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect(ifMatchOf(stub.POST.mock.calls[0] as unknown[])).toBe("4");
  });

  it("refuses missing fields before sending anything", async () => {
    const stub = client([]);
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    await screen.findByRole("form", { name: "MAC credential form" });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByText("Enter the submitter id.")).toBeTruthy();
    expect(screen.getByText("Enter the trading partner id.")).toBeTruthy();
    expect(screen.getByText("Enter the client id.")).toBeTruthy();
    expect(screen.getByText("Enter the client secret.")).toBeTruthy();
    expect(stub.POST).not.toHaveBeenCalled();
  });

  it("reloads and says so on a stale version, closing the form whose pin is stale", async () => {
    const stub = client([macCredential()], { [LIST]: () => refused(409, "STALE_VERSION") });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByText(/It has been reloaded\./)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "MAC credential form" })).toBeNull();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  it("shows the server's refusal of an input beside it and keeps the form open", async () => {
    const stub = client([], {
      [LIST]: () =>
        refused(422, "VALIDATION_FAILED", "bad", [
          { field: "submitterId", code: "x", message: "The submitter id is not valid." },
        ]),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    await screen.findByRole("form", { name: "MAC credential form" });
    fireEvent.change(await screen.findByLabelText("Provider entity"), {
      target: { value: PROVIDER_ENTITY_ID },
    });
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    expect(await screen.findByText("The submitter id is not valid.")).toBeTruthy();
    expect(screen.getByRole("form", { name: "MAC credential form" })).toBeTruthy();
  });
});

describe("step-up and the write-only secret", () => {
  const stepUp = () => refused(403, "STEP_UP_REQUIRED");

  it("offers Re-verify, stashes the form without the secret, and restores it blank and still pinned", async () => {
    const stub = client([macCredential()], { [LIST]: stepUp });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
    fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "client-999" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));

    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    const stashed = peekStepUpMemoryDraft<{ form: { clientId: string }; pinnedVersion: number }>(
      DRAFT_KEY,
    );
    expect(stashed?.form.clientId).toBe("client-999");
    expect(stashed?.pinnedVersion).toBe(4);
    expect(JSON.stringify(stashed)).not.toContain(SECRET);

    cleanup();
    const again = client([macCredential()], { [LIST]: () => ok(macCredential()) });
    mount(again, { url: RETURNED_FROM_STEP_UP });
    expect(await screen.findByRole("form", { name: "MAC credential form" })).toBeTruthy();
    expect((screen.getByLabelText("Client id") as HTMLInputElement).value).toBe("client-999");
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(again.POST).toHaveBeenCalledTimes(1));
    expect(ifMatchOf(again.POST.mock.calls[0] as unknown[])).toBe("4");
  });

  it("drops a second Save while the first is in flight", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const stub = client([], {
      [LIST]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    await screen.findByRole("form", { name: "MAC credential form" });
    fireEvent.change(await screen.findByLabelText("Provider entity"), {
      target: { value: PROVIDER_ENTITY_ID },
    });
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    fireEvent.submit(screen.getByRole("form", { name: "MAC credential form" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    release(ok(macCredential(), 201));
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
  });

  it("keeps the same Idempotency-Key when the first try got no answer", async () => {
    let attempts = 0;
    const stub = client([], {
      [LIST]: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("network down");
        return ok(macCredential(), 201);
      },
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    await screen.findByRole("form", { name: "MAC credential form" });
    fireEvent.change(await screen.findByLabelText("Provider entity"), {
      target: { value: PROVIDER_ENTITY_ID },
    });
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(2));
    const [first, second] = stub.POST.mock.calls as unknown[][];
    expect(idempotencyKeyOf(second as unknown[])).toBe(idempotencyKeyOf(first as unknown[]));
  });
});

describe("testing the credential", () => {
  const TEST_REPLY = {
    providerEntityId: PROVIDER_ENTITY_ID,
    macJurisdiction: "noridian_jf",
    method: "portal_health_probe",
    checkedAt: "2026-11-05T00:00:00.000Z",
    lastSandboxTestAt: "2026-11-05T00:00:00.000Z",
  };

  it("probes the MAC portal for that provider entity under an Idempotency-Key and says it answered", async () => {
    const stub = client([macCredential()], {
      [TEST]: () => ok({ ...TEST_REPLY, ok: true, detail: "portal reachable" }),
    });
    mount(stub);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Test the connection for Cedar Ridge Hospice$/ }),
    );

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(TEST);
    expect((call[1] as { params: { path: unknown } }).params.path).toEqual({
      providerEntityId: PROVIDER_ENTITY_ID,
    });
    expect(idempotencyKeyOf(call)).toBeTruthy();
    expect(await screen.findByText(/The MAC portal answered/)).toBeTruthy();
  });

  it("says plainly when the portal test did not pass", async () => {
    const stub = client([macCredential()], {
      [TEST]: () => ok({ ...TEST_REPLY, ok: false, detail: "credential rejected" }),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Test the connection for/ }));
    expect(await screen.findByText(/The MAC portal test did not pass/)).toBeTruthy();
  });

  it("offers Re-verify when the test needs a fresh step-up", async () => {
    const stub = client([macCredential()], { [TEST]: () => refused(403, "STEP_UP_REQUIRED") });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Test the connection for/ }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });
});

describe("skipping and what the member may see", () => {
  it("offers 'This does not apply to us' only when the frame says the member may skip, and asks the frame to open it", async () => {
    const props = mount(client([]), { skipAvailable: true });
    fireEvent.click(await screen.findByRole("button", { name: "This does not apply to us" }));
    expect(props.skip.request).toHaveBeenCalledTimes(1);
  });

  it("shows no skip entry point when the frame does not offer one", async () => {
    mount(client([]));
    await screen.findByRole("button", { name: "Add MAC credential" });
    expect(screen.queryByRole("button", { name: "This does not apply to us" })).toBeNull();
  });

  it("lists the credential and offers nothing to a member without the admin key", async () => {
    mount(client([macCredential()]), { keys: ["billing.mac_credential.read", "org.manage"] });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("SUB-100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Replace credential/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Test the connection/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });

  it("says so, and calls nothing, when the member cannot read the credentials", async () => {
    const stub = client([macCredential()]);
    mount(stub, { keys: ["onboarding.read_own"] });
    expect(await screen.findByText(/cannot view the MAC credentials/)).toBeTruthy();
    expect(stub.GET).not.toHaveBeenCalled();
  });

  it("asks for a provider entity first when there is none", async () => {
    const stub = stubClient({
      GET: { [LIST]: () => ok(page([])), [ENTITIES]: () => ok({ items: [], nextCursor: null }) },
    });
    mount(stub);
    expect(await screen.findByText(/Add a provider entity first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });

  it("reads a failed credential load as a failure, not as no credential", async () => {
    const stub = stubClient({
      GET: { [LIST]: () => refused(500, "INTERNAL", "boom"), [ENTITIES]: () => ok(ENTITY_LIST) },
    });
    mount(stub);
    expect(await screen.findByText(/Could not load the MAC credentials/)).toBeTruthy();
    expect(screen.queryByText("No MAC credential yet.")).toBeNull();
  });
});
