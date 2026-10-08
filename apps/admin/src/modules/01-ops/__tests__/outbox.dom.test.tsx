// Outbox: the list + right-drawer screen keeps its selection in `?event=`, so the old detail route must redirect there,
// a link must open the drawer, a row must be operable from the keyboard, and Escape must close the drawer and give focus back.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxEventRedirect, OutboxList } from "../outbox-list";

const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";

const row = (id: string, eventType: string) => ({
  id,
  eventType,
  aggregateKind: "invoice",
  aggregateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "dispatched",
  attemptCount: 1,
  createdAt: "2026-10-08T10:00:00.000Z",
  dispatchedAt: "2026-10-08T10:00:01.000Z",
  nextAttemptAt: null,
});
const ROWS = [row(EVENT_A, "m1.alpha.happened"), row(EVENT_B, "m1.beta.happened")];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url).pathname;
  if (path === "/api/v1/ops/outbox") return json({ data: ROWS });
  const found = ROWS.find((r) => path === `/api/v1/ops/outbox/${r.id}`);
  if (found) return json({ ...found, lastError: null, payload: { ok: true } });
  return json({ error: { code: "NOT_FOUND", message: "nope", correlationId: "c" } }, 404);
}

function Where(): JSX.Element {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{`${pathname}${search}`}</div>;
}

function mount(entry: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/admin/ops/outbox" element={<OutboxList />} />
          <Route path="/admin/ops/outbox/:id" element={<OutboxEventRedirect />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(() => cleanup());

describe("Outbox list + drawer", () => {
  it("the old detail route redirects to the list with that event open", async () => {
    mount(`/admin/ops/outbox/${EVENT_B}`);
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(`/admin/ops/outbox?event=${EVENT_B}`),
    );
    const drawer = await screen.findByRole("complementary", { name: "Outbox event" });
    expect(await screen.findByRole("heading", { name: "m1.beta.happened" })).toBeTruthy();
    expect(drawer).toBeTruthy();
  });

  it("opens an event from the keyboard, keeps the rest of the list, and closes on Escape with focus returned to the row", async () => {
    mount("/admin/ops/outbox");
    const rows = await screen.findAllByRole("button", { name: /m1\.alpha\.happened/ });
    const alpha = rows[0] as HTMLElement;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(`/admin/ops/outbox?event=${EVENT_A}`),
    );
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    const drawer = await screen.findByRole("complementary", { name: "Outbox event" });
    await waitFor(() => expect(document.activeElement).toBe(drawer));
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/admin/ops/outbox"));
    expect(screen.queryByRole("complementary", { name: "Outbox event" })).toBeNull();
    expect(document.activeElement).toBe(alpha);
  });

  it("an unknown event id shows the drawer's own not-found message rather than nothing", async () => {
    mount("/admin/ops/outbox?event=99999999-9999-4999-8999-999999999999");
    expect(await screen.findByText("This outbox event could not be found.")).toBeTruthy();
  });
});
