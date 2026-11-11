// @vitest-environment jsdom
// Step 5, Provider entity and NPI: the administrator creates the CMS identity through the same M2 route as Agency setup. The CCN, NPI,
// EIN and fiscal year end are write-once (a change is a re-enrolment ChartWarden handles); the EIN is never stashed.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderEntityPanel } from "./provider-entity-panel";
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

const LIST = "/api/v1/provider-entities";
const view = wizardView([wizardStep("ccn_registered", 1, { owner: "either" })]);
const ENTITY = {
  id: "pe-1",
  legalName: "Cedar Ridge Hospice LLC",
  doingBusinessAs: null,
  ccn: "051234",
  npi: "1234567893",
  status: "active",
};
const page = (...items: unknown[]) => ok({ items, nextCursor: null });
const BODY = {
  legalName: "Cedar Ridge Hospice LLC",
  ccn: "051234",
  npi: "1234567893",
  taxId: "12-3456789",
  fiscalYearEnd: "1231",
};

function mount(
  client: ReturnType<typeof stubClient>,
  session = ORG_ADMIN,
  at: Parameters<typeof renderAt>[0] = "/x",
  onChanged = vi.fn(async () => undefined),
) {
  const rendered = renderAt(
    at,
    [
      {
        path: "/x",
        element: (
          <ProviderEntityPanel {...panelProps(view, "ccn_registered", session, onChanged)} />
        ),
      },
    ],
    client,
    session,
  );
  return { onChanged, ...rendered };
}
const type = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
async function fill(over: Partial<typeof BODY> = {}): Promise<void> {
  await screen.findByRole("button", { name: /add provider entity/i });
  const v = { ...BODY, ...over };
  type(/legal name/i, v.legalName);
  type(/^CCN/i, v.ccn);
  type(/^NPI/i, v.npi);
  type(/tax id/i, v.taxId);
  type(/fiscal year end/i, v.fiscalYearEnd);
}
const submit = (): void => {
  fireEvent.submit(
    screen
      .getByRole("button", { name: /add provider entity|adding/i })
      .closest("form") as HTMLFormElement,
  );
};

describe("ProviderEntityPanel", () => {
  it("lists the entities, warns the identity cannot be changed and points at ChartWarden", async () => {
    mount(stubClient({ GET: { [LIST]: () => page(ENTITY) } }));
    expect(await screen.findByText("Cedar Ridge Hospice LLC")).toBeTruthy();
    expect(
      screen.getByText(/cannot be changed here\. to change one, ask chartwarden/i),
    ).toBeTruthy();
    expect(screen.getByText(/cannot be changed after saving/i)).toBeTruthy();
  });

  it("creates the entity with an Idempotency-Key and reloads the list and the wizard", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: { [LIST]: () => ok({ id: "pe-2" }) },
    });
    const { onChanged } = mount(client);
    await fill();
    submit();

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe(LIST);
    expect(init.body).toEqual(BODY);
    expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(client.GET.mock.calls.length).toBeGreaterThan(1));
  });

  it("says in the tenant's words when the tax ID cannot be stored, and refuses a malformed CCN without sending", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: {
        [LIST]: () =>
          refused(503, "TAX_ID_CIPHER_UNBOUND", "the tax-id envelope cipher is not bound"),
      },
    });
    mount(client);
    await fill({ ccn: "12" });
    submit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/CCN is 6/);
    expect(client.POST).not.toHaveBeenCalled();

    type(/^CCN/i, "051234");
    submit();
    const alert = (await screen.findByRole("alert")).textContent ?? "";
    expect(alert).toMatch(/your tax id cannot be stored right now/i);
    expect(alert).not.toMatch(/envelope cipher/i);
  });

  it("never shows a server error's own sentence: a plain line and the reference to quote", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: { [LIST]: () => refused(500, "INTERNAL", "relation provider_entity does not exist") },
    });
    mount(client);
    await fill();
    submit();
    const alert = (await screen.findByRole("alert")).textContent ?? "";
    expect(alert).toMatch(/could not do that right now/i);
    expect(alert).toMatch(/Reference: corr-test/);
    expect(alert).not.toMatch(/relation provider_entity/);
  });

  it("lists a field error that has no input beside the form", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: {
        [LIST]: () =>
          refused(422, "VALIDATION_FAILED", "invalid", [
            {
              field: "iqiesFacilityId",
              code: "invalid",
              message: "That facility id is not valid.",
            },
          ]),
      },
    });
    mount(client);
    await fill();
    submit();
    expect(await screen.findByText("That facility id is not valid.")).toBeTruthy();
  });

  it("reloads the wizard when the refusal says the step moved", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: { [LIST]: () => refused(409, "TENANT_NOT_ONBOARDING") },
    });
    const { onChanged } = mount(client);
    await fill();
    submit();
    await screen.findByRole("alert");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("labels the status in words, not as the stored value", async () => {
    mount(stubClient({ GET: { [LIST]: () => page({ ...ENTITY, status: "pending_review" }) } }));
    expect(await screen.findByText("Pending Review")).toBeTruthy();
    expect(screen.queryByText("pending_review")).toBeNull();
  });

  it("keeps the typed fields through Re-verify and never the EIN", async () => {
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: { [LIST]: () => refused(403, "STEP_UP_REQUIRED") },
    });
    const first = mount(client);
    await fill();
    submit();
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    expect(await screen.findByText("step-up page")).toBeTruthy();
    first.unmount();

    mount(client, ORG_ADMIN, RETURNED_FROM_STEP_UP);
    await screen.findByRole("button", { name: /add provider entity/i });
    expect((screen.getByLabelText(/legal name/i) as HTMLInputElement).value).toBe(
      "Cedar Ridge Hospice LLC",
    );
    expect((screen.getByLabelText(/^CCN/i) as HTMLInputElement).value).toBe("051234");
    expect((screen.getByLabelText(/tax id/i) as HTMLInputElement).value).toBe("");
  });

  it("drops a second submit while the first is in flight", async () => {
    const gate = deferred(ok({ id: "pe-2" }));
    const client = stubClient({ GET: { [LIST]: () => page() }, POST: { [LIST]: gate.handler } });
    mount(client);
    await fill();
    submit();
    submit();
    gate.release();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
  });

  it("reuses the same Idempotency-Key when the first attempt got no answer", async () => {
    let calls = 0;
    const client = stubClient({
      GET: { [LIST]: () => page() },
      POST: {
        [LIST]: () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
          return ok({ id: "pe-2" });
        },
      },
    });
    mount(client);
    await fill();
    submit();
    await screen.findByText(/could not reach the server/i);
    submit();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(client.POST.mock.calls[1] as unknown[])).toBe(
      keyOf(client.POST.mock.calls[0] as unknown[]),
    );
  });

  it("offers no form to a role without org.manage, and does not read the list", () => {
    const client = stubClient({});
    mount(client, COMPLIANCE_OFFICER);
    expect(screen.getByText(/your role cannot see or add provider entities/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add provider entity/i })).toBeNull();
    expect(client.GET).not.toHaveBeenCalled();
  });
});

describe("ProviderEntityPanel: the idempotency fingerprint", () => {
  it("still submits, with a key, on an origin without SubtleCrypto (plain-HTTP staging)", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    try {
      const client = stubClient({
        GET: { [LIST]: () => page() },
        POST: { [LIST]: () => ok({ id: "pe-2" }) },
      });
      mount(client);
      await fill();
      submit();
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
      expect(keyOf(client.POST.mock.calls[0] as unknown[])).toMatch(/\S+/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds the in-flight guard from the first instant, while the digest is still being computed", async () => {
    // The digest is asynchronous: two Enters before it settles must make one attempt, not two.
    const real = crypto.subtle.digest.bind(crypto.subtle);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (...args: Parameters<typeof real>) => {
        await gate;
        return real(...args);
      },
    );
    try {
      const client = stubClient({
        GET: { [LIST]: () => page() },
        POST: { [LIST]: () => ok({ id: "pe-2" }) },
      });
      mount(client);
      await fill();
      submit();
      submit();
      release();
      await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.POST).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
