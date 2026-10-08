// GAP-125 — the Wage Index screen over RECORDED FETCH CALLS: list the tenant-entered values (live + superseded),
// open one in the drawer, enter a new value (decimal STRING, Idempotency-Key), supersede the live one, and render
// the standard error envelope's 409 / 422 / 403 as copy an administrator can act on.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { fiscalYearStartingOf } from "../rate-reference";
import { WageIndexes } from "../wage-indexes";

const FY = fiscalYearStartingOf(new Date());

const LIVE = {
  wageIndexId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  ccn: "381588",
  fiscalYearStarting: FY,
  cbsaCode: "38900",
  factorDecimal: "1.0342",
  sourceReference: "CMS FY wage index table",
  enteredByMembershipId: "m-1",
  entryReason: null,
  supersededAt: null,
  supersededById: null,
  createdAt: `${FY}-09-20T00:00:00.000Z`,
};
const CORRECTED = {
  ...LIVE,
  wageIndexId: "44444444-4444-4444-8444-444444444444",
  factorDecimal: "1.0400",
  entryReason: "Corrected per CMS correction notice",
  createdAt: `${FY}-09-22T00:00:00.000Z`,
};
const OLD = {
  ...LIVE,
  wageIndexId: "22222222-2222-4222-8222-222222222222",
  factorDecimal: "1.0300",
  supersededAt: `${FY}-09-21T00:00:00.000Z`,
  supersededById: LIVE.wageIndexId,
};

type Call = {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown>;
  idem: string | null;
};
let calls: Call[] = [];
let rows: unknown[] = [];
let writeFailure: { status: number; body: unknown } | null = null;
let listForbidden = false;

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
  calls.push({
    method,
    path: url.pathname,
    query: url.search,
    body: raw ? JSON.parse(raw) : {},
    idem: req?.headers.get("Idempotency-Key") ?? null,
  });
  if (method !== "GET" && writeFailure) return json(writeFailure.status, writeFailure.body);
  if (url.pathname === "/api/v1/billing/wage-indexes" && method === "GET" && listForbidden)
    return json(403, { error: { code: "FORBIDDEN", message: "requires billing.wage_index.read" } });
  if (url.pathname === "/api/v1/billing/wage-indexes" && method === "GET")
    return json(200, { wageIndexes: rows });
  if (url.pathname === "/api/v1/billing/wage-indexes" && method === "POST")
    return json(201, { ...LIVE, wageIndexId: "33333333-3333-4333-8333-333333333333" });
  if (url.pathname.endsWith("/supersede") && method === "POST") {
    // The server keeps the old row as history and answers the new live one.
    rows = [
      CORRECTED,
      { ...LIVE, supersededAt: CORRECTED.createdAt, supersededById: CORRECTED.wageIndexId },
      OLD,
    ];
    return json(201, CORRECTED);
  }
  return json(404, { error: { code: "NOT_FOUND", message: "no" } });
}

const ADMIN_SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.wage_index.read", "billing.wage_index.admin"],
  isAdmin: false,
};

function mount(session = ADMIN_SESSION): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/billing/wage-indexes"]}>
            <WageIndexes />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

async function fillEntry(drawer: HTMLElement, factor: string): Promise<void> {
  fireEvent.change(within(drawer).getByLabelText(/^CCN/), { target: { value: "381588" } });
  fireEvent.change(within(drawer).getByLabelText(/^Wage index/), { target: { value: factor } });
  fireEvent.change(within(drawer).getByLabelText(/^Source/), {
    target: { value: "CMS FY wage index table" },
  });
}

beforeEach(() => {
  calls = [];
  rows = [LIVE, OLD];
  writeFailure = null;
  listForbidden = false;
});
afterEach(() => cleanup());

describe("Wage Index (M23 F-211, GAP-125)", () => {
  it("lists live and superseded values with history and opens one in the drawer", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Wage-index values" });
    const body = table.querySelectorAll("tbody tr");
    expect(body.length).toBe(2);
    expect(within(body[0] as HTMLElement).getByText("1.0342")).toBeTruthy();
    expect(within(body[0] as HTMLElement).getByText("Live")).toBeTruthy();
    expect(within(body[1] as HTMLElement).getByText("Superseded")).toBeTruthy();
    const list = calls.find((c) => c.path === "/api/v1/billing/wage-indexes");
    expect(list?.query).toContain("includeSuperseded=true");

    fireEvent.click(body[0] as HTMLElement);
    const drawer = await screen.findByRole("complementary", { name: /381588/ });
    expect(within(drawer).getByText("CMS FY wage index table")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: /Supersede/ })).toBeTruthy();
  });

  it("filters by CCN through the server query", async () => {
    mount();
    await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.change(screen.getByLabelText(/Filter by CCN/), { target: { value: "381588" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path === "/api/v1/billing/wage-indexes" && c.query.includes("ccn=381588"),
        ),
      ).toBe(true),
    );
  });

  it("enters a new value as a decimal STRING with an Idempotency-Key", async () => {
    mount();
    await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(screen.getByRole("button", { name: /Enter wage index/ }));
    const drawer = await screen.findByRole("complementary", { name: "Enter wage index" });
    await fillEntry(drawer, "1.0450");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
    await waitFor(() => expect(writes().length).toBe(1));
    const post = writes()[0] as Call;
    expect(post.path).toBe("/api/v1/billing/wage-indexes");
    expect(post.body.factorDecimal).toBe("1.0450");
    expect(typeof post.body.factorDecimal).toBe("string");
    expect(post.body.ccn).toBe("381588");
    expect(post.body.fiscalYearStarting).toBe(FY);
    expect(post.idem).toBeTruthy();
    // The form is done: the drawer shows the new value with the confirmation, and cannot be resubmitted.
    const view = await screen.findByRole("complementary", { name: /381588/ });
    expect(within(view).getByText(/Saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save wage index" })).toBeNull();
  });

  it("refuses a malformed factor client-side instead of sending it", async () => {
    mount();
    await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(screen.getByRole("button", { name: /Enter wage index/ }));
    const drawer = await screen.findByRole("complementary", { name: "Enter wage index" });
    await fillEntry(drawer, "1.03421");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
    expect(await within(drawer).findByText(/at most four decimal places/)).toBeTruthy();
    expect(writes().length).toBe(0);
  });

  it("supersedes the live value via the supersede route", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(table.querySelector("tbody tr") as HTMLElement);
    const view = await screen.findByRole("complementary", { name: /381588/ });
    fireEvent.click(within(view).getByRole("button", { name: /Supersede/ }));
    const drawer = await screen.findByRole("complementary", { name: "Supersede wage index" });
    const factor = within(drawer).getByLabelText(/^Wage index/) as HTMLInputElement;
    expect(factor.value).toBe("1.0342");
    fireEvent.change(factor, { target: { value: "1.0400" } });
    fireEvent.change(within(drawer).getByLabelText(/Reason/), {
      target: { value: "Corrected per CMS correction notice" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Supersede value" }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]?.path).toBe(`/api/v1/billing/wage-indexes/${LIVE.wageIndexId}/supersede`);
    expect(writes()[0]?.body.factorDecimal).toBe("1.0400");
  });

  it("after a supersede the drawer moves to the NEW live value and the form cannot be resubmitted", async () => {
    mount();
    const table = await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(table.querySelector("tbody tr") as HTMLElement);
    const view = await screen.findByRole("complementary", { name: /381588/ });
    fireEvent.click(within(view).getByRole("button", { name: /Supersede/ }));
    const form = await screen.findByRole("complementary", { name: "Supersede wage index" });
    fireEvent.change(within(form).getByLabelText(/^Wage index/), { target: { value: "1.0400" } });
    fireEvent.change(within(form).getByLabelText(/Reason/), {
      target: { value: "Corrected per CMS correction notice" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Supersede value" }));

    const after = await screen.findByRole("complementary", { name: /381588/ });
    expect(within(after).getByText(/corrected value is now live/)).toBeTruthy();
    expect(within(after).getByText("Wage index 1.0400 · CBSA 38900")).toBeTruthy();
    expect(within(after).getByText("Live")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Supersede value" })).toBeNull();
    // The reload lands; the drawer still shows the new value and the confirmation.
    await waitFor(() => expect(table.querySelectorAll("tbody tr").length).toBe(3));
    expect(within(after).getByText(/corrected value is now live/)).toBeTruthy();
    expect(table.querySelector("tbody tr.is-selected")?.textContent).toContain("1.0400");

    // A further correction targets the new live row, never the superseded one.
    fireEvent.click(
      within(after).getByRole("button", { name: /Supersede with a corrected value/ }),
    );
    const again = await screen.findByRole("complementary", { name: "Supersede wage index" });
    fireEvent.change(within(again).getByLabelText(/^Wage index/), { target: { value: "1.0410" } });
    fireEvent.click(within(again).getByRole("button", { name: "Supersede value" }));
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]?.path).toBe(
      `/api/v1/billing/wage-indexes/${CORRECTED.wageIndexId}/supersede`,
    );
  });

  it("renders a 409 from the envelope as a supersede hint", async () => {
    writeFailure = {
      status: 409,
      body: { error: { code: "CONFLICT", message: "a live wage index already exists" } },
    };
    mount();
    await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(screen.getByRole("button", { name: /Enter wage index/ }));
    const drawer = await screen.findByRole("complementary", { name: "Enter wage index" });
    await fillEntry(drawer, "1.0450");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
    expect((await within(drawer).findByRole("alert")).textContent).toMatch(
      /supersede the live value instead/i,
    );
  });

  it("renders a 422 with the server's message and a 403 as a permission refusal", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "VALIDATION_ERROR", message: "request validation failed" } },
    };
    mount();
    await screen.findByRole("table", { name: "Wage-index values" });
    fireEvent.click(screen.getByRole("button", { name: /Enter wage index/ }));
    const drawer = await screen.findByRole("complementary", { name: "Enter wage index" });
    await fillEntry(drawer, "1.0450");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
    expect((await within(drawer).findByRole("alert")).textContent).toMatch(
      /request validation failed/,
    );

    writeFailure = { status: 403, body: { error: { code: "FORBIDDEN", message: "nope" } } };
    fireEvent.click(within(drawer).getByRole("button", { name: "Save wage index" }));
    await waitFor(() =>
      expect(within(drawer).getByRole("alert").textContent).toMatch(/billing\.wage_index\.admin/),
    );
  });

  it("hides the write controls from a reader without billing.wage_index.admin", async () => {
    mount({ ...ADMIN_SESSION, permissions: ["billing.wage_index.read"] });
    const table = await screen.findByRole("table", { name: "Wage-index values" });
    expect(screen.queryByRole("button", { name: /Enter wage index/ })).toBeNull();
    fireEvent.click(table.querySelector("tbody tr") as HTMLElement);
    const view = await screen.findByRole("complementary", { name: /381588/ });
    expect(within(view).queryByRole("button", { name: /Supersede/ })).toBeNull();
  });

  it("shows a friendly refusal when the list read is forbidden, and an empty state with no rows", async () => {
    listForbidden = true;
    mount({ ...ADMIN_SESSION, permissions: [] });
    expect((await screen.findByRole("alert")).textContent).toMatch(/billing\.wage_index\.read/);
    cleanup();

    listForbidden = false;
    rows = [];
    mount();
    expect(await screen.findByText(/No wage indexes/)).toBeTruthy();
  });
});
