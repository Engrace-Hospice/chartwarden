// @vitest-environment jsdom
// Step 8, Billing: MAC credentials, on the tenant's side. The Medicare submitter credential the organization's claims go out under: add it
// (one per provider entity), replace it (pinned to the version read), and check that the MAC portal for its jurisdiction ANSWERS (which
// does not check the credential). The client secret is write-only (never shown, never stashed). Every write needs a fresh step-up and one
// Idempotency-Key per intent, and the save voids a pending go-live attestation. Skipping is the frame's button; the panel only hints.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "../../../shell/ceremony-drafts";
import { peekStepUpDraft, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { MacPanel } from "./mac-panel";
import {
  BILLING_KEYS,
  ORG_ADMIN,
  PROVIDER_ENTITY_ID,
  type StubClient,
  draftKey,
  idempotencyKeyOf,
  ifMatchOf,
  macCredential,
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

const LIST = "/api/v1/billing/mac-credentials";
const ENTITIES = "/api/v1/provider-entities";
const TEST = "/api/v1/billing/mac-credentials/{providerEntityId}/test";
const SECRET = "mac-secret-correct-horse";
const DRAFT_KEY = draftKey("tenant-mac-credential", "mac_configured");
const SECOND_ENTITY_ID = "22222222-2222-4222-8222-222222222222";

const STEPS = [
  tenantStep("clearinghouse_selected", 1, { status: "done" }),
  tenantStep("mac_configured", 2),
];
const ENTITY = (id: string, legalName: string) => ({
  id,
  legalName,
  doingBusinessAs: null,
  ccn: "341234",
  npi: null,
  status: "active",
});
const ONE_ENTITY = { items: [ENTITY(PROVIDER_ENTITY_ID, "Cedar Ridge Hospice")], nextCursor: null };
const TWO_ENTITIES = {
  items: [
    ENTITY(PROVIDER_ENTITY_ID, "Cedar Ridge Hospice"),
    ENTITY(SECOND_ENTITY_ID, "Birch Valley Hospice"),
  ],
  nextCursor: null,
};
const page = (items: ReturnType<typeof macCredential>[], hasMore = false) => ({
  items,
  nextCursor: null,
  hasMore,
});
const PENDING = {
  state: "awaiting_approval" as const,
  attestation: null,
  failedGuards: [],
  complianceOfficerMembershipId: null,
};
const REPLACED = /Saving a change here voids that attestation/;

interface Options {
  keys?: readonly string[];
  skipAvailable?: boolean;
  goLive?: typeof PENDING;
  onChanged?: StepPropsOnChanged;
}
type StepPropsOnChanged = () => Promise<void>;
function mount(client: StubClient, options: Options = {}) {
  const view = tenantView(STEPS, options.goLive ? { goLive: options.goLive } : {});
  const session = { ...ORG_ADMIN, permissions: [...(options.keys ?? BILLING_KEYS)] };
  const props = panelProps(
    view,
    "mac_configured",
    {
      skip: { available: options.skipAvailable ?? false, request: vi.fn() },
      ...(options.onChanged ? { onChanged: options.onChanged } : {}),
    },
    session,
  );
  renderPanel(<MacPanel {...props} />, client, "/x", session);
  return props;
}

function client(
  credentials: ReturnType<typeof macCredential>[],
  writes: Record<string, () => unknown> = {},
  entities: unknown = ONE_ENTITY,
  hasMore = false,
) {
  return stubClient({
    GET: { [LIST]: () => ok(page(credentials, hasMore)), [ENTITIES]: () => ok(entities) },
    POST: writes as never,
  });
}

function fillNew(): void {
  fireEvent.change(screen.getByLabelText("Submitter id"), { target: { value: "SUB-100" } });
  fireEvent.change(screen.getByLabelText("Trading partner id"), { target: { value: "TP-200" } });
  fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "client-300" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
}
async function openAdd(entityId = PROVIDER_ENTITY_ID): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
  await screen.findByRole("form", { name: "MAC credential form" });
  const select = screen.getByLabelText("Provider entity") as HTMLSelectElement;
  if (select.value !== entityId) fireEvent.change(select, { target: { value: entityId } });
}
const status = () => screen.getByRole("status", { name: "Step status" });
const save = () => screen.getByRole("button", { name: "Save credential" }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  resetDrafts();
});

describe("adding and replacing the credential", () => {
  it("sends the first credential with no If-Match and one Idempotency-Key, then reloads the step and the wizard", async () => {
    const stub = client([], { [LIST]: () => ok(macCredential(), 201) });
    const props = mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());

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

  it("pins a replacement to the version it read, never shows the secret on file, and locks the jurisdiction", async () => {
    const stub = client([macCredential()], { [LIST]: () => ok(macCredential()) });
    mount(stub);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Replace credential for Cedar Ridge Hospice$/ }),
    );
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Provider entity") as HTMLSelectElement).disabled).toBe(true);
    const jurisdiction = screen.getByLabelText("MAC jurisdiction") as HTMLSelectElement;
    expect(jurisdiction.disabled).toBe(true);
    expect(screen.getByText(/jurisdiction of a credential cannot be changed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(save());

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect(ifMatchOf(stub.POST.mock.calls[0] as unknown[])).toBe("4");
  });

  it("refuses missing fields before sending anything", async () => {
    const stub = client([]);
    mount(stub);
    await openAdd();
    fireEvent.click(save());

    expect(await screen.findByText("Enter the submitter id.")).toBeTruthy();
    expect(screen.getByText("Enter the trading partner id.")).toBeTruthy();
    expect(screen.getByText("Enter the client id.")).toBeTruthy();
    expect(screen.getByText("Enter the client secret.")).toBeTruthy();
    expect(stub.POST).not.toHaveBeenCalled();
  });

  it.each([
    [409, "STALE_VERSION"],
    [428, "IF_MATCH_REQUIRED"],
  ])(
    "reloads the list and the wizard and says so on a %i %s, closing the form whose pin is stale",
    async (httpStatus, code) => {
      const stub = client([macCredential()], { [LIST]: () => refused(httpStatus, code) });
      const props = mount(stub);
      fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
      fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
      fireEvent.click(save());

      expect(await screen.findByText(/It has been reloaded\./)).toBeTruthy();
      expect(screen.queryByRole("form", { name: "MAC credential form" })).toBeNull();
      expect(screen.queryByDisplayValue(SECRET)).toBeNull();
      await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
      expect(stub.GET.mock.calls.filter((c) => c[0] === LIST).length).toBeGreaterThanOrEqual(2);
    },
  );

  it("shows the server's refusal of an input beside it, keeps the form open, and drops it when the field is edited", async () => {
    const stub = client([], {
      [LIST]: () =>
        refused(422, "VALIDATION_FAILED", "bad", [
          { field: "submitterId", code: "x", message: "The submitter id is not valid." },
        ]),
    });
    mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());

    expect(await screen.findByText("The submitter id is not valid.")).toBeTruthy();
    expect(screen.getByRole("form", { name: "MAC credential form" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Submitter id"), { target: { value: "SUB-101" } });
    expect(screen.queryByText("The submitter id is not valid.")).toBeNull();
  });

  it("shows a refusal that names only a field the form does not render, with its own sentence", async () => {
    const stub = client([], {
      [LIST]: () =>
        refused(422, "VALIDATION_FAILED", "The request has the wrong shape.", [
          { field: "(root)", code: "x", message: "wrong shape" },
        ]),
    });
    mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());
    expect(await screen.findByText("The request has the wrong shape.")).toBeTruthy();
  });

  it("clears the secret before the reloads finish, so it does not sit in the page while they run", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const stub = stubClient({
      GET: {
        [LIST]: (() => {
          let n = 0;
          return () =>
            ++n === 1
              ? ok(page([]))
              : (new Promise((resolve) => {
                  release = resolve;
                }) as never);
        })(),
        [ENTITIES]: () => ok(ONE_ENTITY),
      },
      POST: { [LIST]: () => ok(macCredential(), 201) } as never,
    });
    mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());

    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "MAC credential form" })).toBeNull(),
    );
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    release(ok(page([macCredential()])));
  });

  it("empties the secret on Cancel and after a successful save", async () => {
    mount(client([], { [LIST]: () => ok(macCredential(), 201) }));
    await openAdd();
    fillNew();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openAdd();
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    fillNew();
    fireEvent.click(save());
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "MAC credential form" })).toBeNull(),
    );
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });
});

describe("one credential per provider entity", () => {
  it("keeps Add for an entity that has none, offering only those", async () => {
    mount(client([macCredential()], {}, TWO_ENTITIES));
    fireEvent.click(await screen.findByRole("button", { name: "Add MAC credential" }));
    const select = (await screen.findByLabelText("Provider entity")) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toContain("Birch Valley Hospice (341234)");
    expect(options.join()).not.toContain("Cedar Ridge Hospice");
  });

  it("offers no Add once every entity has a credential", async () => {
    mount(client([macCredential()]));
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });
});

describe("the secret is write-only", () => {
  const stepUp = () => refused(403, "STEP_UP_REQUIRED");

  it("offers Re-verify, stashes the form without the secret in the owner-scoped store, and restores it blank and still pinned", async () => {
    const stub = client([macCredential()], { [LIST]: stepUp });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
    fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "client-999" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(save());

    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    const stashed = peekStepUpDraft<{ form: { clientId: string }; pinnedVersion: number }>(
      DRAFT_KEY,
    );
    expect(stashed?.form.clientId).toBe("client-999");
    expect(stashed?.pinnedVersion).toBe(4);
    expect(JSON.stringify(stashed)).not.toContain(SECRET);
    expect(stepUpDraftKeys()).toEqual([DRAFT_KEY]);
    expect(DRAFT_KEY.startsWith(`${ORG_ADMIN.organizationId}|${ORG_ADMIN.userId}|`)).toBe(true);

    cleanup();
    returnFromStepUp();
    const again = client([macCredential()], { [LIST]: () => ok(macCredential()) });
    mount(again);
    expect(await screen.findByRole("form", { name: "MAC credential form" })).toBeTruthy();
    expect((screen.getByLabelText("Client id") as HTMLInputElement).value).toBe("client-999");
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(save());
    await waitFor(() => expect(again.POST).toHaveBeenCalledTimes(1));
    expect(ifMatchOf(again.POST.mock.calls[0] as unknown[])).toBe("4");
  });

  it("loses the stashed form when the session is cleared (sign-out, idle lock, expiry)", async () => {
    mount(client([macCredential()], { [LIST]: stepUp }));
    fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(save());
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    await screen.findByText("step-up page");
    expect(stepUpDraftKeys()).toHaveLength(1);
    clearAllDrafts();
    expect(stepUpDraftKeys()).toEqual([]);
  });

  it("drops a second Save while the first is in flight, and sends exactly one write", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const stub = client([], {
      [LIST]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const props = mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());
    fireEvent.submit(screen.getByRole("form", { name: "MAC credential form" }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    release(ok(macCredential(), 201));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(stub.POST).toHaveBeenCalledTimes(1);
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
    await openAdd();
    fillNew();
    fireEvent.click(save());
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();

    fireEvent.click(save());
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(2));
    const [first, second] = stub.POST.mock.calls as unknown[][];
    expect(idempotencyKeyOf(second as unknown[])).toBe(idempotencyKeyOf(first as unknown[]));
  });

  it("keeps the pressed Save focusable (aria-disabled) while its write runs", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const stub = client([], {
      [LIST]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    mount(stub);
    await openAdd();
    fillNew();
    save().focus();
    fireEvent.click(save());
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect(save().disabled).toBe(false);
    expect(document.activeElement).toBe(save());
    release(ok(macCredential(), 201));
  });

  it("asks password managers to leave the secret alone", async () => {
    mount(client([]));
    await openAdd();
    const secret = screen.getByLabelText("Client secret");
    expect(secret.getAttribute("type")).toBe("password");
    expect(secret.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(secret.getAttribute("data-lpignore")).toBe("true");
    expect(screen.getByLabelText("Submitter id").getAttribute("autocomplete")).toBe("off");
  });
});

describe("a pending go-live attestation", () => {
  it("is named above the form, because the save voids it", async () => {
    mount(client([]), { goLive: PENDING });
    await openAdd();
    expect(
      within(screen.getByRole("form", { name: "MAC credential form" })).getByText(REPLACED),
    ).toBeTruthy();
  });

  it("is not mentioned while go-live is not waiting for approval", async () => {
    mount(client([]));
    await openAdd();
    expect(screen.queryByText(REPLACED)).toBeNull();
  });
});

describe("checking the MAC portal", () => {
  const PROBE = {
    providerEntityId: PROVIDER_ENTITY_ID,
    macJurisdiction: "noridian_jf",
    method: "portal_health_probe",
    checkedAt: "2026-11-05T00:00:00.000Z",
    lastSandboxTestAt: "2026-11-05T00:00:00.000Z",
  };
  const CHECK = /^Check the MAC portal for Cedar Ridge Hospice$/;

  it("probes the portal for that provider entity under an Idempotency-Key, names the entity, and says it does not check the credential", async () => {
    const stub = client([macCredential()], {
      [TEST]: () => ok({ ...PROBE, ok: true, detail: "portal reachable" }),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));

    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    const call = stub.POST.mock.calls[0] as unknown[];
    expect(call[0]).toBe(TEST);
    expect((call[1] as { params: { path: unknown } }).params.path).toEqual({
      providerEntityId: PROVIDER_ENTITY_ID,
    });
    expect(idempotencyKeyOf(call)).toBeTruthy();
    await waitFor(() =>
      expect(status().textContent).toBe(
        "Cedar Ridge Hospice: The MAC portal for your jurisdiction answered. This does not check your credential.",
      ),
    );
  });

  it("says plainly when the portal did not answer", async () => {
    mount(
      client([macCredential()], {
        [TEST]: () => ok({ ...PROBE, ok: false, detail: "no answer from the portal" }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await waitFor(() =>
      expect(status().textContent).toContain(
        "The MAC portal for your jurisdiction did not answer. no answer from the portal",
      ),
    );
  });

  it("claims nothing about the credential having passed, anywhere on the panel", async () => {
    mount(client([macCredential({ lastSandboxTestAt: "2026-11-05T00:00:00.000Z" })]));
    await screen.findByRole("table");
    expect(document.body.textContent).not.toMatch(/passed a test|has passed|credential.*passed/i);
    expect(
      screen.getByText(/The MAC portal for Cedar Ridge Hospice's jurisdiction answered a check/),
    ).toBeTruthy();
    expect(screen.getByText(/This does not check your credential\./)).toBeTruthy();
  });

  it("offers Re-verify when the check needs a fresh step-up", async () => {
    mount(client([macCredential()], { [TEST]: () => refused(403, "STEP_UP_REQUIRED") }));
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });

  it("clears a shown result when the credential is edited or saved, so it never describes a credential that has changed", async () => {
    const stub = client([macCredential()], {
      [TEST]: () => ok({ ...PROBE, ok: true, detail: "x" }),
      [LIST]: () => ok(macCredential()),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: CHECK }));
    await waitFor(() => expect(status().textContent).toContain("answered"));

    fireEvent.click(screen.getByRole("button", { name: /^Replace credential/ }));
    expect(status().textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: SECRET } });
    fireEvent.click(save());
    await waitFor(() => expect(status().textContent).toBe("The MAC credential is saved."));
  });
});

describe("a sibling write waits for an open editor, and an editor for a running check", () => {
  it("disables Replace and Check while the editor is open (a check would bump the version the editor is pinned to)", async () => {
    mount(client([macCredential()]));
    fireEvent.click(await screen.findByRole("button", { name: /^Replace credential/ }));
    // the table's buttons are disabled while the form is open
    const table = screen.getByRole("table");
    expect(
      (within(table).getByRole("button", { name: /^Check the MAC portal/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(table).getByRole("button", { name: /^Replace credential/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      (within(table).getByRole("button", { name: /^Check the MAC portal/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("does not let Save race a running check: the editor cannot open and Save keeps the typed secret", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const stub = client([macCredential()], {
      [TEST]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      [LIST]: () => ok(macCredential()),
    });
    mount(stub);
    fireEvent.click(await screen.findByRole("button", { name: /^Check the MAC portal/ }));
    await waitFor(() => expect(stub.POST).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: /^Replace credential/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release(
      ok({
        providerEntityId: PROVIDER_ENTITY_ID,
        macJurisdiction: "noridian_jf",
        method: "portal_health_probe",
        checkedAt: "x",
        lastSandboxTestAt: "x",
        ok: true,
        detail: "x",
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^Replace credential/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("what the member may see and do", () => {
  it("only HINTS at skipping when the frame says the member may skip: the frame owns the one Skip button", async () => {
    const props = mount(client([]), { skipAvailable: true });
    expect(await screen.findByText(/use Skip this step below/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /does not apply to us|^Skip/ })).toBeNull();
    expect(props.skip.request).not.toHaveBeenCalled();
  });

  it("shows no skip hint when the frame does not offer a skip", async () => {
    mount(client([]));
    await screen.findByRole("button", { name: "Add MAC credential" });
    expect(screen.queryByText(/use Skip this step below/)).toBeNull();
  });

  it("lists the credential and offers nothing to a member without the admin key", async () => {
    mount(client([macCredential()]), { keys: ["billing.mac_credential.read"] });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("SUB-100")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Replace credential/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Check the MAC portal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });

  it("says so, still hints at skipping, and calls nothing, when the member cannot read the credentials", async () => {
    const stub = client([macCredential()]);
    mount(stub, { keys: ["onboarding.read_own"], skipAvailable: true });
    expect(await screen.findByText(/cannot view the MAC credentials/)).toBeTruthy();
    expect(screen.getByText(/use Skip this step below/)).toBeTruthy();
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
      GET: { [LIST]: () => refused(500, "INTERNAL", "boom"), [ENTITIES]: () => ok(ONE_ENTITY) },
    });
    mount(stub);
    expect(await screen.findByText(/Could not load the MAC credentials/)).toBeTruthy();
    expect(screen.queryByText("No MAC credential yet.")).toBeNull();
  });

  it("does not offer Add while the credential list is unresolved, even when provider entities load first", async () => {
    let releaseCredentials: (reply: ReturnType<typeof ok>) => void = () => undefined;
    const stub = stubClient({
      GET: {
        [LIST]: () =>
          new Promise((resolve) => {
            releaseCredentials = resolve;
          }) as never,
        [ENTITIES]: () => ok(ONE_ENTITY),
      },
    });
    mount(stub);

    await waitFor(() => expect(stub.GET).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();

    releaseCredentials(ok(page([macCredential()])));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });

  it("never shows a provider entity's raw id while the names are not known", async () => {
    const stub = stubClient({
      GET: {
        [LIST]: () => ok(page([macCredential()])),
        [ENTITIES]: () => refused(403, "FORBIDDEN"),
      },
    });
    mount(stub, { keys: ["billing.mac_credential.read"] });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("A provider entity")).toBeTruthy();
    expect(document.body.textContent).not.toContain(PROVIDER_ENTITY_ID);
    expect(document.body.innerHTML).not.toContain(PROVIDER_ENTITY_ID);
  });

  it("says when only the first page is shown", async () => {
    mount(client([macCredential()], {}, ONE_ENTITY, true));
    expect(await screen.findByText(/Showing the first 100/)).toBeTruthy();
  });

  it("says plainly that the role does not cover a provider entity when the save is refused 403, and keeps nothing typed", async () => {
    const stub = client([], { [LIST]: () => refused(403, "FORBIDDEN") });
    mount(stub);
    await openAdd();
    fillNew();
    fireEvent.click(save());
    expect(
      await screen.findByText(/Your role cannot change this provider entity's MAC credential/),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  it("says the same for a 403 on the portal check", async () => {
    mount(client([macCredential()], { [TEST]: () => refused(403, "FORBIDDEN") }));
    fireEvent.click(await screen.findByRole("button", { name: /^Check the MAC portal/ }));
    expect(
      await screen.findByText(/Your role cannot change this provider entity's MAC credential/),
    ).toBeTruthy();
  });

  it("stays usable when the wizard reload after a save rejects", async () => {
    const stub = client([], { [LIST]: () => ok(macCredential(), 201) });
    const props = mount(stub, {
      onChanged: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("rail")),
    });
    await openAdd();
    fillNew();
    fireEvent.click(save());
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("form", { name: "MAC credential form" })).toBeNull();
    expect(status().textContent).toBe("The MAC credential is saved.");
  });
});
