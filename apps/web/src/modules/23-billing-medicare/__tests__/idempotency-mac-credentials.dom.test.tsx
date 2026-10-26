import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: the MAC credential upsert keeps its Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { MacCredentials } from "../mac-credentials";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const PE = "77777777-7777-4777-8777-777777777777";

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.mac_credential.read", "billing.mac_credential.manage"],
  isAdmin: false,
};

function getBody(path: string): unknown {
  if (path === "/api/v1/provider-entities")
    return {
      items: [{ id: PE, legalName: "Engrace Hospice", ccn: "381588", status: "active", npi: null }],
      nextCursor: null,
    };
  return { items: [], nextCursor: null, hasMore: false };
}

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, getBody);
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <MacCredentials />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function fillForm(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Add credential" }));
  const box = await screen.findByRole("combobox", { name: /Provider entity/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "Eng" } });
  fireEvent.click(await screen.findByRole("option", { name: /Engrace Hospice/ }));
  type("Submitter id", "SUB1");
  type("Trading partner id", "TP1");
  type("Client id", "client-1");
  type("Client secret (write-only)", "s3cret");
}

/** Open the step-up ceremony, sign, and wait for the single write to land and the ceremony to close. */
const sign = async (expected: number, keys: string[]) => {
  fireEvent.click(screen.getByRole("button", { name: "Save with step-up" }));
  const stepUp = await screen.findByLabelText("Re-enter your password to continue");
  fireEvent.change(stepUp, { target: { value: "pw" } });
  const affirm = screen.getByRole("checkbox") as HTMLInputElement;
  if (!affirm.checked) fireEvent.click(affirm);
  fireEvent.click(screen.getByRole("button", { name: "Sign & save" }));
  await waitFor(() => expect(keys.length).toBe(expected));
  await waitFor(() =>
    expect(screen.queryByLabelText("Re-enter your password to continue")).toBeNull(),
  );
};

afterEach(() => cleanup());

describe("MAC credential Idempotency-Key (#821)", () => {
  it("reuses the key when the first save threw", async () => {
    const keys = mount(["throw"]);
    await fillForm();
    await sign(1, keys);
    await sign(2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const keys = mount([422]);
    await fillForm();
    await sign(1, keys);
    await sign(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a new key after a field edit following a thrown save", async () => {
    const keys = mount(["throw"]);
    await fillForm();
    await sign(1, keys);
    type("Submitter id", "SUB2");
    await sign(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
