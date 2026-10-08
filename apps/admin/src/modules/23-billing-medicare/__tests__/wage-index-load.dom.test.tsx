// apps/admin/src/modules/23-billing-medicare — the platform wage-index load screen (M23 §4.1 #42) over RECORDED FETCH
// CALLS. Before this screen the annual CMS load was API-only. The net asserts what is SENT (the parsed rows, the fiscal
// year, the source reference and an Idempotency-Key), that nothing is sent while the preview shows a problem, and that
// every refusal the route can give (STEP_UP_REQUIRED, 403, 409, 422 with row details) reaches the operator.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WageIndexLoad } from "../wage-index-load";
import {
  WAGE_INDEX_DRAFT_TTL_MS,
  clearWageIndexDraft,
  readWageIndexDraft,
  saveWageIndexDraft,
} from "../wage-index-load-draft";
import { fiscalYearStartingOf } from "../wage-index-load-model";

type Call = { method: string; path: string; body: Record<string, unknown>; key: string | null };
let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  const raw = req.method === "GET" ? "" : await req.clone().text();
  calls.push({
    method: req.method,
    path: url.pathname,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    key: req.headers.get("Idempotency-Key"),
  });
  return json(reply.status, reply.body);
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/admin/billing/wage-index"]}>
          <Routes>
            <Route path="/admin/billing/wage-index" element={<WageIndexLoad />} />
            <Route path="/step-up" element={<div data-testid="step-up-page" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

/** A fiscal year the screen offers (the current federal FY). */
const FY = fiscalYearStartingOf(new Date());

const TABLE = ["CCN,CBSA,Wage Index", "381588,38900,1.0342", "381589,,0.9876"].join("\n");

function fill(table = TABLE, source = "CMS FY2027 hospice wage index table"): void {
  fireEvent.change(screen.getByLabelText(/Source reference/), { target: { value: source } });
  fireEvent.change(screen.getByLabelText(/Paste the table/), { target: { value: table } });
}

async function confirmLoad(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Review and load" }));
  const dialog = await screen.findByRole("dialog", { name: "Load wage index" });
  fireEvent.click(within(dialog).getByRole("button", { name: /^Load \d+ rows?$/ }));
  return dialog;
}

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: {} };
  clearWageIndexDraft();
});
afterEach(() => cleanup());

describe("Platform wage-index load (M23 §4.1 #42)", () => {
  it("previews the parsed rows and loads them with an Idempotency-Key after confirmation", async () => {
    reply = {
      status: 200,
      body: {
        fiscalYearStarting: 2026,
        sourceReference: "CMS FY2027 hospice wage index table",
        inserted: 1,
        updated: 1,
      },
    };
    mount();
    fireEvent.change(screen.getByLabelText(/Fiscal year/), { target: { value: "2026" } });
    fill();
    const preview = await screen.findByRole("table", { name: "Wage-index rows to load" });
    expect(within(preview).getByText("381588")).toBeTruthy();
    expect(within(preview).getByText("0.9876")).toBeTruthy();

    await confirmLoad();
    await waitFor(() => expect(calls.length).toBe(1));
    const sent = calls[0] as Call;
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/api/v1/admin/billing/wage-indexes/load");
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.body).toEqual({
      fiscalYearStarting: 2026,
      sourceReference: "CMS FY2027 hospice wage index table",
      rows: [
        { ccn: "381588", cbsaCode: "38900", factorDecimal: "1.0342" },
        { ccn: "381589", factorDecimal: "0.9876" },
      ],
    });
    expect(await screen.findByText(/1 new value, 1 updated/)).toBeTruthy();
  });

  it("reads an uploaded CSV file into the table", async () => {
    mount();
    const file = new File(["381588,1.1\n"], "fy2027.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/Upload a CSV/), { target: { files: [file] } });
    const preview = await screen.findByRole("table", { name: "Wage-index rows to load" });
    expect(within(preview).getByText("1.1")).toBeTruthy();
  });

  it("sends nothing while the preview shows a problem, and names the line", async () => {
    mount();
    fill("381588,1.0\n38158,1.1");
    expect(await screen.findByText(/Line 2:/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review and load" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it("STEP_UP_REQUIRED offers a Re-verify link to /step-up and back, keeping the form", async () => {
    reply = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "step up", correlationId: "c" } },
    };
    mount();
    fireEvent.change(screen.getByLabelText(/Fiscal year/), { target: { value: String(FY) } });
    fill();
    const dialog = await confirmLoad();
    expect(await within(dialog).findByText("Re-verify to load")).toBeTruthy();
    const link = within(dialog).getByRole("link", { name: "Re-verify and come back" });
    expect(link.getAttribute("href")).toBe(
      `/step-up?returnTo=${encodeURIComponent("/admin/billing/wage-index")}`,
    );

    fireEvent.click(link);
    expect(await screen.findByTestId("step-up-page")).toBeTruthy();
    expect(readWageIndexDraft()).toEqual({
      fiscalYearStarting: FY,
      sourceReference: "CMS FY2027 hospice wage index table",
      table: TABLE,
    });
  });

  it("restores a stashed draft on mount, and clears it after a successful load", async () => {
    saveWageIndexDraft({
      fiscalYearStarting: FY,
      sourceReference: "CMS FY2027 hospice wage index table",
      table: TABLE,
    });
    reply = {
      status: 200,
      body: {
        fiscalYearStarting: FY,
        sourceReference: "CMS FY2027 hospice wage index table",
        inserted: 2,
        updated: 0,
      },
    };
    mount();
    expect(screen.getByText(/Restored the table/)).toBeTruthy();
    expect((screen.getByLabelText(/Paste the table/) as HTMLTextAreaElement).value).toBe(TABLE);
    expect((screen.getByLabelText(/Source reference/) as HTMLInputElement).value).toBe(
      "CMS FY2027 hospice wage index table",
    );
    expect((screen.getByLabelText(/Fiscal year/) as HTMLSelectElement).value).toBe(String(FY));

    await confirmLoad();
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.body.fiscalYearStarting).toBe(FY);
    expect(await screen.findByText(/2 new values, 0 updated/)).toBeTruthy();
    expect(readWageIndexDraft()).toBeNull();
  });

  it("drops an expired draft instead of restoring it", () => {
    saveWageIndexDraft(
      { fiscalYearStarting: FY, sourceReference: "old", table: TABLE },
      Date.now() - WAGE_INDEX_DRAFT_TTL_MS - 1,
    );
    mount();
    expect(screen.queryByText(/Restored the table/)).toBeNull();
    expect((screen.getByLabelText(/Paste the table/) as HTMLTextAreaElement).value).toBe("");
  });

  it("a plain 403 names the permission", async () => {
    reply = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "no", correlationId: "c" } },
    };
    mount();
    fill();
    const dialog = await confirmLoad();
    expect(await within(dialog).findByText(/billing\.rule_config\.platform_admin/)).toBeTruthy();
  });

  it("a 409 says the submission key was already used", async () => {
    reply = {
      status: 409,
      body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "key reused", correlationId: "c" } },
    };
    mount();
    fill();
    const dialog = await confirmLoad();
    expect(await within(dialog).findByText(/already used/)).toBeTruthy();
  });

  it("a 422 lists the server's row problems by the operator's line numbers", async () => {
    reply = {
      status: 422,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "1 problem(s) in the wage-index file; nothing was loaded",
          details: [{ field: "rows[1]", code: "INVALID", message: "factor out of range" }],
          correlationId: "c",
        },
      },
    };
    mount();
    fill();
    const dialog = await confirmLoad();
    expect(await within(dialog).findByText("Line 3: factor out of range")).toBeTruthy();
  });

  it("keeps the same Idempotency-Key when the operator retries the same confirmation", async () => {
    reply = {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "boom", correlationId: "c" } },
    };
    mount();
    fill();
    const dialog = await confirmLoad();
    await within(dialog).findByText("boom");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Load \d+ rows?$/ }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]?.key).toBe(calls[1]?.key);
  });
});
