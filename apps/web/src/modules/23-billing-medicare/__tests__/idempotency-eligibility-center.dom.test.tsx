import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: the eligibility check keeps its Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EligibilityCenter } from "../eligibility-center";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const PE = "77777777-7777-4777-8777-777777777777";
const PATIENT = "99999999-9999-4999-8999-999999999999";

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.eligibility.read", "billing.eligibility.check"],
  isAdmin: false,
};

function getBody(path: string): unknown {
  if (path === "/api/v1/patients")
    return {
      items: [
        {
          id: PATIENT,
          lastName: "Doe",
          firstName: "Jane",
          mrn: "MRN1",
          status: "active",
          dob: "1940-01-01",
        },
      ],
      nextCursor: null,
    };
  if (path === "/api/v1/provider-entities")
    return {
      items: [{ id: PE, legalName: "Engrace Hospice", ccn: "381588", status: "active", npi: null }],
      nextCursor: null,
    };
  return { items: [] };
}

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, getBody);
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <EligibilityCenter />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

async function pick(name: RegExp, typed: string, option: RegExp): Promise<void> {
  const box = await screen.findByRole("combobox", { name });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: typed } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function readyToRun(): Promise<void> {
  await pick(/Patient/, "Doe", /Doe, Jane/);
  fireEvent.click(screen.getByRole("button", { name: "Load history" }));
  await pick(/Provider entity/, "Eng", /Engrace Hospice/);
}

const run = async (expected: number, keys: string[]) => {
  fireEvent.click(screen.getByRole("button", { name: "Run check" }));
  await waitFor(() => expect(keys.length).toBe(expected));
  await screen.findByRole("button", { name: "Run check" });
};

afterEach(() => cleanup());

describe("Eligibility check Idempotency-Key (#821)", () => {
  it("reuses the key when the first check threw", async () => {
    const keys = mount(["throw"]);
    await readyToRun();
    await run(1, keys);
    await run(2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const keys = mount([422]);
    await readyToRun();
    await run(1, keys);
    await run(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a new key after a field edit following a thrown check", async () => {
    const keys = mount(["throw"]);
    await readyToRun();
    await run(1, keys);
    fireEvent.change(screen.getByLabelText("As-of service date"), {
      target: { value: "2026-01-02" },
    });
    await run(2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
