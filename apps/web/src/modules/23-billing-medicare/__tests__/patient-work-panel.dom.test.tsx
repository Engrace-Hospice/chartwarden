// The patient chart's "Needs attention" panel: the work queue narrowed to one patient. It must ask every source for
// that patient only, say so when a source failed (never "nothing waiting"), and drop the last patient's rows on a switch.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientWorkPanel } from "../patient-work-panel";

afterEach(cleanup);

const ok = (items: unknown[], hasMore = false) => ({
  data: { items, hasMore, nextCursor: null },
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "x" } },
  response: new Response(null, { status }),
});
const claim = (claimId: string, patientId: string) => ({
  claimId,
  patientId,
  state: "ready",
  tob: "811",
  serviceFrom: "2026-10-01",
  serviceTo: "2026-10-31",
  claimControlNumber: claimId,
});

function view(get: ApiClient["GET"], patientId: string) {
  const client = { GET: get } as unknown as ApiClient;
  const tree = (id: string) => (
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <PatientWorkPanel patientId={id} />
      </MemoryRouter>
    </ApiClientProvider>
  );
  const r = render(tree(patientId));
  return { rerender: (id: string) => r.rerender(tree(id)) };
}

describe("PatientWorkPanel", () => {
  it("asks every source for this patient only, and lists what is waiting", async () => {
    const get = vi.fn(async (path: string, init?: { params?: { query?: { state?: string } } }) =>
      path === "/api/v1/billing/claims" && init?.params?.query?.state === "ready"
        ? ok([claim("c1", "p1")])
        : ok([]),
    );
    view(get as never, "p1");
    expect(await screen.findByRole("link", { name: "Submit the claim" })).toBeTruthy();
    expect(get).toHaveBeenCalled();
    for (const [, init] of get.mock.calls as unknown as [
      string,
      { params: { query: { patientId?: string } } },
    ][])
      expect(init.params.query.patientId).toBe("p1");
  });

  it("says a source could not be read instead of claiming nothing is waiting", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/api/v1/billing/dde-items" ? fail(500) : ok([]),
    );
    view(get as never, "p1");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/nothing is waiting/i)).toBeNull();
  });

  it("says nothing is waiting only when every source answered whole and empty", async () => {
    view(vi.fn(async () => ok([])) as never, "p1");
    expect(await screen.findByText(/nothing is waiting/i)).toBeTruthy();
  });

  it("drops the previous patient's rows when the patient changes", async () => {
    const get = vi.fn(
      async (
        path: string,
        init?: { params?: { query?: { patientId?: string; state?: string } } },
      ) =>
        path === "/api/v1/billing/claims" && init?.params?.query?.state === "ready"
          ? ok([claim(`c-${init.params.query.patientId}`, init.params.query.patientId as string)])
          : ok([]),
    );
    const v = view(get as never, "p1");
    await screen.findByRole("link", { name: "Submit the claim" });
    v.rerender("p2");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Submit the claim" })).toBeNull(),
    );
    expect(
      (await screen.findByRole("link", { name: "Submit the claim" })).getAttribute("href"),
    ).toBe("/billing/claims/c-p2");
  });
});
