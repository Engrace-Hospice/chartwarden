// FY2027 workstream E — the Hospice Rates screen over RECORDED FETCH CALLS: load a provider entity, read the live
// version and its CMS reference warnings in the drawer, then key a new version with the HQRP toggle + prefill and
// see the live warning when a rate is changed.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { fiscalYearStartingOf } from "../rate-reference";
import { RateTables } from "../rate-tables";

const PE = "77777777-7777-4777-8777-777777777777";
const FY = fiscalYearStartingOf(new Date());

const REF = {
  fiscalYearStarting: FY,
  fiscalYearLabel: `FY${FY + 1}`,
  paymentUpdatePct: 2.3,
  hqrpReductionPctPoints: 4,
  hqrpCompliant: {
    rhcDays1to60PerDiemCents: 23_633,
    rhcDays61PlusPerDiemCents: 18_633,
    chcPerDiemCents: 172_616,
    chcHourlyRateCents: 7_192,
    ircPerDiemCents: 54_593,
    gipPerDiemCents: 123_151,
  },
  hqrpNonCompliant: {
    rhcDays1to60PerDiemCents: 22_709,
    rhcDays61PlusPerDiemCents: 17_904,
    chcPerDiemCents: 165_866,
    chcHourlyRateCents: 6_911,
    ircPerDiemCents: 52_458,
    gipPerDiemCents: 118_335,
  },
  sources: [{ cite: "CMS-1851-CN, 91 FR 61791", url: "https://www.federalregister.gov" }],
  note: "",
};

const VERSION = {
  rateTableId: "12121212-1212-4212-8212-121212121212",
  organizationId: "org-1",
  providerEntityId: PE,
  fiscalYearStarting: FY,
  effectiveFrom: `${FY}-10-01`,
  effectiveTo: `${FY + 1}-09-30`,
  ...REF.hqrpNonCompliant,
  laborShareRhc: "0.6600",
  laborShareChc: "0.6600",
  laborShareIrc: "0.5400",
  laborShareGip: "0.6400",
  hqrpCompliant: true,
  nationalReferenceWarnings: [
    "Declared HQRP-compliant, but the rates are the NON-compliant national rates (-1.7% update).",
  ],
  enteredByMembershipId: "m-1",
  entryReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: `${FY}-09-20T00:00:00.000Z`,
};

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let versions: unknown[] = [];

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const raw = method !== "GET" && req ? await req.clone().text() : "";
  calls.push({ method, path: url.pathname, body: raw ? JSON.parse(raw) : {} });
  if (url.pathname === "/api/v1/provider-entities")
    return json(200, {
      items: [{ id: PE, legalName: "Engrace Hospice", ccn: "381588", status: "active", npi: null }],
      nextCursor: null,
    });
  if (url.pathname === "/api/v1/billing/rate-tables/national-reference")
    return json(200, { reference: REF });
  if (url.pathname === "/api/v1/billing/rate-tables" && method === "GET")
    return json(200, { rateTables: versions });
  if (url.pathname === "/api/v1/billing/rate-tables" && method === "POST")
    return json(201, { ...VERSION, nationalReferenceWarnings: [] });
  return json(404, { error: { code: "NOT_FOUND", message: "no" } });
}

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.rate_table.read", "billing.rate_table.admin"],
  isAdmin: false,
};

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/billing/rate-tables"]}>
            <RateTables />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function loadProvider(): Promise<void> {
  const box = screen.getByRole("combobox", { name: /Provider entity/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "Eng" } });
  fireEvent.click(await screen.findByRole("option", { name: /Engrace Hospice/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load rates" }));
}

beforeEach(() => {
  calls = [];
  versions = [VERSION];
});
afterEach(() => cleanup());

describe("Hospice Rates (M23, FY2027 HQRP + CMS reference)", () => {
  it("loads the provider's versions and the national reference, and flags the HQRP mismatch", async () => {
    mount();
    await loadProvider();
    const table = await screen.findByRole("table", { name: "Rate-table versions" });
    // interactiveRowProps gives the row a button role, so it is read off the DOM.
    const row = table.querySelector("tbody tr") as HTMLElement;
    expect(within(row).getByText("HQRP compliant")).toBeTruthy();
    expect(within(row).getByText("Differs from CMS")).toBeTruthy();
    expect(within(row).getByText("$227.09")).toBeTruthy();
    expect(
      calls.some(
        (c) => c.path === "/api/v1/billing/rate-tables/national-reference" && c.method === "GET",
      ),
    ).toBe(true);

    fireEvent.click(row);
    const drawer = await screen.findByRole("complementary", { name: `FY${FY + 1} rates` });
    expect(within(drawer).getByText(/NON-compliant national rates/)).toBeTruthy();
    expect(within(drawer).getByText(/CMS-1851-CN, 91 FR 61791/)).toBeTruthy();
  });

  it("keys a version: the toggle picks the column to prefill, a changed rate warns live, save posts cents + hqrpCompliant", async () => {
    versions = [];
    mount();
    await loadProvider();
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`Enter FY${FY + 1} rates`) }),
    );
    const drawer = await screen.findByRole("complementary", { name: "Enter rates" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Not compliant" }));
    fireEvent.click(within(drawer).getByRole("button", { name: /Prefill from CMS national/ }));
    const rhc = within(drawer).getByLabelText(/RHC days 1–60/) as HTMLInputElement;
    expect(rhc.value).toBe("227.09");
    expect(within(drawer).getByText(/Matches the FY\d+ non-compliant national rates/)).toBeTruthy();

    fireEvent.change(within(drawer).getByLabelText(/General inpatient/), {
      target: { value: "1200.00" },
    });
    expect(
      within(drawer).getByText(/1 rate differs from the FY\d+ non-compliant national rates/),
    ).toBeTruthy();

    for (const [label, v] of [
      ["Labor share RHC", "0.6600"],
      ["Labor share CHC", "0.6600"],
      ["Labor share IRC", "0.5400"],
      ["Labor share GIP", "0.6400"],
    ] as const)
      fireEvent.change(within(drawer).getByLabelText(label), { target: { value: v } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save rates" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/billing/rate-tables");
    expect(post?.body).toMatchObject({
      providerEntityId: PE,
      fiscalYearStarting: FY,
      hqrpCompliant: false,
      rhcDays1to60PerDiemCents: 22_709,
      gipPerDiemCents: 120_000,
      laborShareRhc: "0.6600",
    });
    expect(await within(drawer).findByText(/Saved\./)).toBeTruthy();
  });
});
