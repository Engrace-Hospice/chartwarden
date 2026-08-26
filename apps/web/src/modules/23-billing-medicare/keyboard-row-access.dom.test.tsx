// apps/web/src/modules/23-billing-medicare — #32: the A/R metric drawer must open without a mouse.
//
// `ArDashboard` opens its detail panel from `<tr onClick={() => onSelectRow(row.id)}>` with no
// `tabIndex` and no key handler. `setSelectedRowId` has exactly one caller — that row click — so the
// panel was reachable by pointer and by nothing else. WCAG 2.1 2.1.1 Keyboard (Level A).
//
// Only `/api/v1/billing/ar-dashboard` is required by the screen; the other three reads are
// best-effort and a 503 simply leaves their tiles out. Stubbing just the aging rollup therefore
// exercises the real degraded path as well as the rows under test.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ArDashboard } from "./ar-dashboard";

const AGING = {
  bucket0to30Cents: 1_250_00,
  bucket31to60Cents: 400_00,
  bucket61to90Cents: 90_00,
  bucket90PlusCents: 12_00,
};

function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith("/billing/ar-dashboard")) {
    return Promise.resolve(
      new Response(JSON.stringify(AGING), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  // best-effort tiles: absent, not fatal
  return Promise.resolve(
    new Response(JSON.stringify({ error: { code: "STUB", message: "not bound" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <ArDashboard />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

/**
 * The "0-30 days" row of the work table.
 *
 * The label renders twice inside its own row — once in the label cell, once in a status pill — so a
 * text lookup returns two nodes that share one `<tr>`. Deduped by the row element, and it throws
 * rather than guessing if the match ever spans more than one row, so this helper cannot quietly
 * start testing the wrong node.
 */
async function agingRow(): Promise<HTMLElement> {
  await screen.findAllByText("0-30 days");
  const rows = new Set(
    screen
      .getAllByText("0-30 days")
      .map((el) => el.closest("tr"))
      .filter((r): r is HTMLTableRowElement => r !== null),
  );
  if (rows.size !== 1)
    throw new Error(`expected exactly one "0-30 days" table row, got ${rows.size}`);
  return [...rows][0] as HTMLElement;
}

beforeEach(() => {
  window.history.pushState({}, "", "/billing/ar");
});

describe("#32 — the A/R metric drawer opens from the keyboard", () => {
  it("Enter on an aging row opens the drawer", async () => {
    mount();
    const row = await agingRow();

    expect(screen.queryByText("Billing Metric")).toBeNull();
    row.focus();
    expect(document.activeElement, "the row is not focusable, so Enter can never reach it").toBe(
      row,
    );
    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Billing Metric")).toBeTruthy());
  });

  it("Space activates it too", async () => {
    mount();
    const row = await agingRow();
    fireEvent.keyDown(row, { key: " " });
    await waitFor(() => expect(screen.getByText("Billing Metric")).toBeTruthy());
  });

  it("Space does not also scroll the page", async () => {
    // Space on a focused element scrolls by default. A row that activates on Space must consume the
    // event, or the drawer opens and the surface jumps under the user at the same moment.
    mount();
    const row = await agingRow();
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("the row announces itself as an activatable control and reports its state", async () => {
    mount();
    const row = await agingRow();
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(row.getAttribute("aria-pressed")).toBe("true"));
  });

  it("an unrelated key does nothing", async () => {
    // Only Enter and Space activate. A row that fired on any keystroke would open the drawer while
    // someone was type-ahead searching the table.
    mount();
    const row = await agingRow();
    fireEvent.keyDown(row, { key: "a" });
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(screen.queryByText("Billing Metric")).toBeNull();
  });

  it("the mouse path still works", async () => {
    mount();
    fireEvent.click(await agingRow());
    await waitFor(() => expect(screen.getByText("Billing Metric")).toBeTruthy());
  });
});
