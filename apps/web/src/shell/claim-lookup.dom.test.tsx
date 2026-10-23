// ClaimLookupField: the billing claim list has no text filter, so the filter is applied client-side and must
// page through the cursor until it has matches (a first page of non-matches must not read as "No matches").
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimLookupField } from "./entity-lookups";

const claim = (n: number, control: string | null) => ({
  claimId: `0000000${n}-0000-4000-8000-000000000000`,
  claimControlNumber: control,
  serviceFrom: n % 2 ? null : "2026-01-01",
  serviceTo: "2026-01-31",
  state: "draft",
});

let requests: string[] = [];
let pages: Record<string, { items: unknown[]; nextCursor: string | null }>;

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const req = input as Request;
  const url = new URL(req.url, "http://localhost");
  const cursor = url.searchParams.get("cursor") ?? "";
  requests.push(cursor);
  return new Response(JSON.stringify(pages[cursor] ?? { items: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount(): void {
  render(
    <MemoryRouter>
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <ClaimLookupField label="Claim" value="" onChange={() => {}} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const type = async (value: string): Promise<void> => {
  const input = screen.getByRole("combobox");
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    await new Promise((r) => setTimeout(r, 250));
  });
};

beforeEach(() => {
  requests = [];
  pages = {
    "": { items: [claim(1, "AAA-1"), claim(2, "AAA-2")], nextCursor: "p2" },
    p2: { items: [claim(3, null), claim(4, "AAA-4")], nextCursor: "p3" },
    p3: { items: [claim(5, "ZZZ-TARGET")], nextCursor: null },
  };
});
afterEach(() => cleanup());

describe("ClaimLookupField filter", () => {
  it("pages through the cursor until a later page yields a match, tolerating null control numbers and dates", async () => {
    mount();
    await type("zzz");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByText("ZZZ-TARGET")).toBeTruthy();
    expect(requests).toEqual(["", "p2", "p3"]);
  });

  it("stops reading once the list is exhausted and shows no matches", async () => {
    mount();
    await type("nothing-like-this");
    await waitFor(() => expect(screen.getByText("No matches")).toBeTruthy());
    expect(requests).toEqual(["", "p2", "p3"]);
  });
});
