import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: forward-dating a sequestration policy keeps its Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SequestrationPolicy } from "../sequestration-policy";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const PE = "77777777-7777-4777-8777-777777777777";

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.sequestration.read", "billing.sequestration.admin"],
  isAdmin: false,
};

function getBody(path: string): unknown {
  if (path === "/api/v1/provider-entities")
    return {
      items: [{ id: PE, legalName: "Engrace Hospice", ccn: "381588", status: "active", npi: null }],
      nextCursor: null,
    };
  return { policies: [] };
}

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, getBody);
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <SequestrationPolicy />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

async function readyToSubmit(): Promise<void> {
  const box = await screen.findByRole("combobox", { name: /Provider entity/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "Eng" } });
  fireEvent.click(await screen.findByRole("option", { name: /Engrace Hospice/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load timeline" }));
  await screen.findByRole("button", { name: "Forward-date policy" });
}

const submit = async (expected: number, keys: string[]) => {
  fireEvent.click(await screen.findByRole("button", { name: "Forward-date policy" }));
  await waitFor(() => expect(keys.length).toBe(expected));
  await screen.findByRole("button", { name: "Forward-date policy" });
};

afterEach(() => cleanup());

describe("Sequestration policy Idempotency-Key (#821)", () => {
  it("reuses the key when the first submit threw", async () => {
    const keys = mount(["throw"]);
    await readyToSubmit();
    await submit(1, keys);
    await submit(2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const keys = mount([422]);
    await readyToSubmit();
    await submit(1, keys);
    await submit(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a new key after a field edit following a thrown submit", async () => {
    const keys = mount(["throw"]);
    await readyToSubmit();
    await submit(1, keys);
    fireEvent.change(screen.getByLabelText("Percentage"), { target: { value: "1.5" } });
    await submit(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
