import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: the wage-index write keeps its Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { WageIndexes } from "../wage-indexes";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.wage_index.read", "billing.wage_index.admin"],
  isAdmin: false,
};

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, () => ({ wageIndexes: [] }));
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <WageIndexes />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

async function openAndFill(factor: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: /Enter wage index/ }));
  const drawer = await screen.findByRole("complementary", { name: "Enter wage index" });
  fireEvent.change(within(drawer).getByLabelText(/^CCN/), { target: { value: "381588" } });
  fireEvent.change(within(drawer).getByLabelText(/^Wage index/), { target: { value: factor } });
  fireEvent.change(within(drawer).getByLabelText(/^Source/), { target: { value: "CMS table" } });
  return drawer;
}

const save = async (drawer: HTMLElement, expected: number, keys: string[]) => {
  fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
  await waitFor(() => expect(keys.length).toBe(expected));
  // Settled: the form is re-enabled (a failure) or the drawer has closed (a save).
  await waitFor(() => {
    const button = screen.queryByRole("button", {
      name: "Save wage index",
    }) as HTMLButtonElement | null;
    expect(button === null || !button.disabled).toBe(true);
  });
};

afterEach(() => cleanup());

describe("Wage index Idempotency-Key (#821)", () => {
  it("reuses the key when the first save threw", async () => {
    const keys = mount(["throw"]);
    const drawer = await openAndFill("1.0342");
    await save(drawer, 1, keys);
    await save(drawer, 2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const keys = mount([422]);
    const drawer = await openAndFill("1.0342");
    await save(drawer, 1, keys);
    await save(drawer, 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a new key after a field edit following a thrown save", async () => {
    const keys = mount(["throw"]);
    const drawer = await openAndFill("1.0342");
    await save(drawer, 1, keys);
    fireEvent.change(within(drawer).getByLabelText(/^Wage index/), { target: { value: "1.0400" } });
    await save(drawer, 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
