// @vitest-environment jsdom
// Step 8, Billing: MAC credentials. The submitter credential for Medicare claims, entered on the tenant's behalf. The client secret is
// write-only: it is sealed under the tenant's own key, never shown, never stashed. An update is pinned to the version the operator read
// (If-Match); a first create carries none.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MacPanel } from "./mac-panel";
import {
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

const ENTITIES = "/api/v1/platform/tenants/{orgSlug}/provider-entities";
const MAC = "/api/v1/platform/tenants/{orgSlug}/mac-credentials";
const PE = {
  id: "pe-1",
  ccn: "444444",
  npi: "1679576722",
  legalName: "Beta Hospice",
  status: "active",
};
const CRED = {
  credentialId: "cred-1",
  organizationId: "org-1",
  providerEntityId: "pe-1",
  macJurisdiction: "noridian_jf",
  submitterId: "SUB123",
  tradingPartnerId: "TP123",
  clientId: "client-live",
  hasSecret: true,
  baaRecordRef: null,
  credentialExpiresAt: null,
  lastSandboxTestAt: null,
  version: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const TYPED_VALUE = "mac-write-only-value-for-test";
const view = (over = {}) =>
  wizardView(
    [
      wizardStep("mac_configured", 1, {
        title: "Billing: MAC credentials",
        owner: "either",
        completionMode: "either",
      }),
    ],
    over,
  );
function mount(
  credentials: unknown[],
  extra: Parameters<typeof stubClient>[0] = {},
  v = view(),
  at: Parameters<typeof renderAt>[0] = "/x",
) {
  const client = stubClient({
    GET: { [ENTITIES]: () => ok({ items: [PE] }), [MAC]: () => ok({ items: credentials }) },
    ...extra,
  });
  const ctx = panelCtx(v, "mac_configured");
  renderAt(at, [{ path: "/x", element: <MacPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

const fill = () => {
  fireEvent.change(screen.getByLabelText("Submitter id"), { target: { value: "SUB123" } });
  fireEvent.change(screen.getByLabelText("Trading partner id"), { target: { value: "TP123" } });
  fireEvent.change(screen.getByLabelText("Client id"), { target: { value: "client-live" } });
  fireEvent.change(screen.getByLabelText(/^Client secret/), { target: { value: TYPED_VALUE } });
};
const save = (reason: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
};

describe("MacPanel", () => {
  it("says no credential is on file, and what that means for the step", async () => {
    mount([]);
    expect(await screen.findByText(/No MAC credential yet/)).toBeTruthy();
    expect(screen.getByText(/A MAC credential is on file/).closest("li")?.textContent).toMatch(
      /Not yet/,
    );
  });

  it("shows a credential without its secret: only that one is on file", async () => {
    mount([CRED]);
    expect(await screen.findByText("SUB123")).toBeTruthy();
    expect(screen.getByText(/Secret on file/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(TYPED_VALUE);
  });

  it("creates the first credential with no If-Match, a reason and an Idempotency-Key", async () => {
    const { client, ctx } = mount([], { POST: { [MAC]: () => ok(CRED, 201) } });
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fill();
    save("Customer sent their Noridian enrolment");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      {
        params: { path: unknown; header: Record<string, string> };
        body: Record<string, unknown>;
      },
    ];
    expect(path).toBe(MAC);
    expect(init.params.path).toEqual({ orgSlug: ORG_SLUG });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.params.header["If-Match"]).toBeUndefined();
    expect(init.body).toMatchObject({
      providerEntityId: "pe-1",
      macJurisdiction: "noridian_jf",
      submitterId: "SUB123",
      tradingPartnerId: "TP123",
      clientId: "client-live",
      clientSecret: TYPED_VALUE,
      reason: "Customer sent their Noridian enrolment",
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("Cancel drops the typed secret and returns focus to the control that opened the form", async () => {
    mount([]);
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    expect(document.activeElement?.textContent).toBe("New MAC credential");
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add MAC credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    expect((screen.getByLabelText(/^Client secret/) as HTMLInputElement).value).toBe("");
  });

  it("Enter in a field submits the form: it asks for the reason rather than writing", async () => {
    const { client } = mount([]);
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fill();
    fireEvent.submit(screen.getByRole("form", { name: "MAC credential form" }));
    expect(await screen.findByLabelText(/^Reason/)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("updates a credential pinned to the version that was read", async () => {
    const { client } = mount([CRED], { POST: { [MAC]: () => ok(CRED) } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace credential for Beta Hospice" }),
    );
    fill();
    save("Customer rotated their client key");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const init = client.POST.mock.calls[0]?.[1] as { params: { header: Record<string, string> } };
    expect(init.params.header["If-Match"]).toBe("3");
  });

  it("closes the form on a version conflict (its pin is stale), says why, and reopens on what it says now", async () => {
    mount([CRED], { POST: { [MAC]: () => refused(409, "STALE_VERSION", "stale") } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace credential for Beta Hospice" }),
    );
    fill();
    save("Customer rotated their client key");
    expect(await screen.findByText(/changed since you opened it/i)).toBeTruthy();
    // the prompt AND the form are gone: nothing is left that could be confirmed against the stale version
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Submitter id")).toBeNull();
    expect(screen.queryByLabelText(/^Client secret/)).toBeNull();
  });

  it("treats a missing If-Match (428) like a conflict: closes, reloads, says to enter the change again", async () => {
    const { client } = mount([CRED], {
      POST: { [MAC]: () => refused(428, "IF_MATCH_REQUIRED", "needs the version") },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace credential for Beta Hospice" }),
    );
    fill();
    save("Customer rotated their client key");
    expect(await screen.findByText(/changed while you were looking at it/i)).toBeTruthy();
    expect(screen.queryByLabelText("Submitter id")).toBeNull();
    await waitFor(() =>
      expect(client.GET.mock.calls.filter((c) => c[0] === MAC).length).toBeGreaterThan(1),
    );
  });

  it("explains a version conflict: someone changed it, it is reloaded, the key must be typed again", async () => {
    const { client } = mount([CRED], {
      POST: { [MAC]: () => refused(409, "STALE_VERSION", "stale") },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace credential for Beta Hospice" }),
    );
    fill();
    save("Customer rotated their client key");
    expect(await screen.findByText(/changed since you opened it/i)).toBeTruthy();
    await waitFor(() =>
      expect(client.GET.mock.calls.filter((c) => c[0] === MAC).length).toBeGreaterThan(1),
    );
  });

  it("asks the browser to offer no saved password for the write-only client secret", async () => {
    mount([]);
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    expect(screen.getByLabelText(/^Client secret/).getAttribute("autocomplete")).toBe(
      "new-password",
    );
  });

  it("requires every field before it asks for a reason", async () => {
    mount([]);
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(screen.getByText(/Enter the submitter id/)).toBeTruthy();
    expect(screen.getByText(/Enter the client secret/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never stashes the write-only value through a re-verify", async () => {
    mount([], { POST: { [MAC]: () => refused(403, "STEP_UP_REQUIRED") } });
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fill();
    save("Customer sent their Noridian enrolment");
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    const stashed =
      window.sessionStorage.getItem(
        "wx.admin.step-up-draft:wizard:cedar-ridge:mac_configured:credential",
      ) ?? "";
    expect(stashed).toContain("SUB123");
    expect(stashed).not.toContain(TYPED_VALUE);
  });

  it("is read-only when the step cannot be acted on", async () => {
    mount([CRED], {}, view({ tenantStatus: "active" }));
    await screen.findByText("SUB123");
    expect(screen.queryByRole("button", { name: "Add MAC credential" })).toBeNull();
  });
});

describe("MacPanel: coming back from Re-verify", () => {
  const reverify = async (credentials: unknown[]) => {
    mount(credentials, { POST: { [MAC]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(
      await screen.findByRole(
        "button",
        credentials.length > 0
          ? { name: "Replace credential for Beta Hospice" }
          : { name: "Add MAC credential" },
      ),
    );
    fill();
    save("Customer rotated their client key");
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();
  };

  it("resumes a REPLACE pinned to the version the operator first read (3), so a change made meanwhile is a 409 STALE_VERSION, not a replace they never saw", async () => {
    await reverify([CRED]);

    // someone else replaced it while the operator was re-verifying: the version is now 4
    const { client } = mount(
      [{ ...CRED, version: 4 }],
      {
        POST: {
          [MAC]: (init) =>
            (init as { params?: { header?: Record<string, string> } }).params?.header?.[
              "If-Match"
            ] === "4"
              ? ok(CRED)
              : refused(409, "STALE_VERSION", "stale"),
        },
      },
      view(),
      RETURNED_FROM_STEP_UP,
    );
    expect(await screen.findByText("Replace MAC credential")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Client secret/), { target: { value: TYPED_VALUE } });
    save("Customer rotated their client key");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const init = client.POST.mock.calls[0]?.[1] as { params: { header: Record<string, string> } };
    expect(init.params.header["If-Match"]).toBe("3");
    expect(await screen.findByText(/changed since you opened it/i)).toBeTruthy();
  });

  it("resumes a CREATE as a create (no If-Match) for the same provider entity, never as a replace of whatever is loaded now", async () => {
    await reverify([]);

    const { client } = mount(
      [],
      { POST: { [MAC]: () => ok(CRED, 201) } },
      view(),
      RETURNED_FROM_STEP_UP,
    );
    expect(await screen.findByText("New MAC credential")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Client secret/), { target: { value: TYPED_VALUE } });
    save("Customer sent their Noridian enrolment");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const init = client.POST.mock.calls[0]?.[1] as {
      params: { header: Record<string, string> };
      body: Record<string, unknown>;
    };
    expect(init.params.header["If-Match"]).toBeUndefined();
    expect(init.body).toMatchObject({ providerEntityId: "pe-1", clientSecret: TYPED_VALUE });
  });
});

describe("MacPanel: a server refusal of one field", () => {
  it("closes the prompt so the error is read beside its field, keeps the form and the typed reason, and asks again", async () => {
    let calls = 0;
    const { client } = mount([], {
      POST: {
        [MAC]: () => {
          calls += 1;
          return calls === 1
            ? refused(422, "VALIDATION_FAILED", "invalid", [
                {
                  field: "submitterId",
                  code: "INVALID",
                  message: "That submitter id is not one M23 accepts.",
                },
              ])
            : ok(CRED, 201);
        },
      },
    });
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fill();
    save("Customer sent their Noridian enrolment");

    expect(await screen.findByText("That submitter id is not one M23 accepts.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Reason/)).toBeNull();
    expect((screen.getByLabelText(/^Submitter id/) as HTMLInputElement).value).toBe("SUB123");
    expect((screen.getByLabelText(/^Client secret/) as HTMLInputElement).value).toBe(TYPED_VALUE);

    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect((screen.getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe(
      "Customer sent their Noridian enrolment",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
  });

  it("does not leave the refusal on the page once the form is cancelled", async () => {
    mount([], {
      POST: {
        [MAC]: () =>
          refused(422, "VALIDATION_FAILED", "invalid", [
            { field: "clientId", code: "INVALID", message: "That client id is not valid." },
          ]),
      },
    });
    await screen.findByText(/No MAC credential yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add MAC credential" }));
    fill();
    save("Customer sent their Noridian enrolment");
    await screen.findByText("That client id is not valid.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Some details need attention/)).toBeNull();
  });
});
