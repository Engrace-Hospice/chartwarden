import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: the rate-table write keeps its Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { fiscalYearStartingOf } from "../rate-reference";
import { RateTables } from "../rate-tables";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const PE = "77777777-7777-4777-8777-777777777777";
const FY = fiscalYearStartingOf(new Date());
const RATES = {
  rhcDays1to60PerDiemCents: 22_709,
  rhcDays61PlusPerDiemCents: 17_904,
  chcPerDiemCents: 165_866,
  chcHourlyRateCents: 6_911,
  ircPerDiemCents: 52_458,
  gipPerDiemCents: 118_335,
};
const REF = {
  fiscalYearStarting: FY,
  fiscalYearLabel: `FY${FY + 1}`,
  paymentUpdatePct: 2.3,
  hqrpReductionPctPoints: 4,
  hqrpCompliant: RATES,
  hqrpNonCompliant: RATES,
  sources: [],
  note: "",
};

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.rate_table.read", "billing.rate_table.admin"],
  isAdmin: false,
};

function getBody(path: string): unknown {
  if (path === "/api/v1/provider-entities")
    return {
      items: [{ id: PE, legalName: "Engrace Hospice", ccn: "381588", status: "active", npi: null }],
      nextCursor: null,
    };
  if (path.endsWith("/national-reference")) return { reference: REF };
  return { rateTables: [] };
}

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, getBody);
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/billing/rate-tables"]}>
            <RateTables />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

async function openDrawer(): Promise<HTMLElement> {
  const box = screen.getByRole("combobox", { name: /Provider entity/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "Eng" } });
  fireEvent.click(await screen.findByRole("option", { name: /Engrace Hospice/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load rates" }));
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`Enter FY${FY + 1} rates`) }),
  );
  const drawer = await screen.findByRole("complementary", { name: "Enter rates" });
  fireEvent.click(within(drawer).getByRole("button", { name: /Prefill from CMS national/ }));
  for (const [label, v] of [
    ["Labor share RHC", "0.6600"],
    ["Labor share CHC", "0.6600"],
    ["Labor share IRC", "0.5400"],
    ["Labor share GIP", "0.6400"],
  ] as const)
    fireEvent.change(within(drawer).getByLabelText(label), { target: { value: v } });
  return drawer;
}

const save = async (drawer: HTMLElement, expected: number, keys: string[]) => {
  fireEvent.click(within(drawer).getByRole("button", { name: "Save rates" }));
  await waitFor(() => expect(keys.length).toBe(expected));
  await waitFor(() => {
    const button = screen.queryByRole("button", { name: "Save rates" }) as HTMLButtonElement | null;
    expect(button === null || !button.disabled).toBe(true);
  });
};

afterEach(() => cleanup());

describe("Rate tables Idempotency-Key (#821)", () => {
  it("reuses the key when the first save threw", async () => {
    const keys = mount(["throw"]);
    const drawer = await openDrawer();
    await save(drawer, 1, keys);
    await save(drawer, 2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const keys = mount([409]);
    const drawer = await openDrawer();
    await save(drawer, 1, keys);
    await save(drawer, 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("mints a new key after a field edit following a thrown save", async () => {
    const keys = mount(["throw"]);
    const drawer = await openDrawer();
    await save(drawer, 1, keys);
    fireEvent.change(within(drawer).getByLabelText(/General inpatient/), {
      target: { value: "1200.00" },
    });
    await save(drawer, 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
