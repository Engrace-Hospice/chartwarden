// My Visits shows a visit's purpose in three places (filter option, table cell, search); all three use the one
// shared label, so what a clinician sees is what they can pick and search for.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MyVisits } from "./my-visits";

const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();
const row = (id: string, patientId: string, visitPurpose: string) => ({
  id,
  patientId,
  assignedMembershipId: "m1",
  visitPurpose,
  scheduledStartedAt: startsAt,
  scheduledEndedAt: startsAt,
  status: "published",
});

function mount(): void {
  const rows = [
    row("11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "p1", "recert"),
    row("22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "p2", "f2f"),
    row("33333333-cccc-4ccc-8ccc-cccccccccccc", "p3", "aide_poc"),
  ];
  const client = {
    GET: vi.fn(async (path: string) => ({
      data: path === "/api/v1/visits" ? rows : {},
      error: undefined,
      response: new Response(null, { status: 200 }),
    })),
  } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <MyVisits />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("My Visits purpose wording", () => {
  it("offers the filter options and finds visits by the labels the table shows", async () => {
    mount();

    const filter = await screen.findByLabelText("Visit purpose");
    const options = within(filter)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["Face-to-Face", "HHA Visit", "Recert Kickoff (RN)"]),
    );
    expect(options).not.toContain("F2f");
    expect(options).not.toContain("Aide Poc");

    fireEvent.change(screen.getByLabelText("Search my visits"), { target: { value: "kickoff" } });

    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toContain("Recert Kickoff (RN)");
    expect(cells).not.toContain("Face-to-Face");
    expect(cells).not.toContain("HHA Visit");
  });
});
