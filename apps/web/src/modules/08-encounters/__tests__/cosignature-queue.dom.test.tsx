import { ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosignatureQueue } from "../cosignature-queue";

function Location(): JSX.Element {
  const location = useLocation();
  return (
    <>
      <output aria-label="location">{`${location.pathname}${location.hash}`}</output>
      <output aria-label="search">{location.search}</output>
    </>
  );
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const noteEntry = {
  id: "encounter-12345678",
  patientId: "patient-12345678",
  encounterType: "routine_visit",
  discipline: "lpn",
  serviceDate: "2026-11-15",
  status: "cosign_pending",
  signedAt: hoursAgo(2),
};

/** An amendment's entry is its parent encounter (still signed), with `cosign` naming the addendum and its own clock. */
const amendmentEntry = {
  ...noteEntry,
  status: "signed",
  signedAt: hoursAgo(100),
  cosign: {
    subject: "addendum",
    addendumId: "addendum-87654321",
    requestId: "request-1",
    status: "escalated",
    routedAt: hoursAgo(30),
  },
};

function mountQueue(encounters: readonly unknown[] = [noteEntry]) {
  const client = { GET: vi.fn(async () => ({ data: { encounters } })) };
  render(
    <MemoryRouter initialEntries={["/work/cosignatures"]}>
      <ApiClientProvider client={client as never}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <CosignatureQueue />
                <Location />
              </>
            }
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return client;
}

const rows = async () => {
  const queue = await screen.findByRole("region", { name: "Cosignature queue" });
  return within(queue).getAllByRole("row").slice(1);
};

describe("Cosignature queue task actions", () => {
  it("presents one explicit review action instead of making the whole row an unnamed action", async () => {
    mountQueue();
    const queue = await screen.findByRole("region", { name: "Cosignature queue" });
    const row = within(queue).getByRole("row", { name: /Routine Visit/i });
    expect(row.getAttribute("role")).not.toBe("button");

    fireEvent.click(
      within(row).getByRole("button", {
        name: "Review LPN routine visit for patient patient- on 2026-11-15",
      }),
    );
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-12345678/encounters/encounter-12345678",
    );
  });
});

describe("Cosignature queue: the way back (Workflow 09, WP1)", () => {
  it("sends the queue as the way back from a reviewed note, and keeps the amendment's anchor", async () => {
    const user = userEvent.setup();
    mountQueue([noteEntry, amendmentEntry]);
    const [first] = await rows();
    await user.click(
      within(first as HTMLElement).getByRole("button", {
        name: "Review amendment to LPN routine visit for patient patient- on 2026-11-15",
      }),
    );
    expect(screen.getByLabelText("search").textContent).toBe(
      `?from=${encodeURIComponent("/work/cosignatures")}`,
    );
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-12345678/encounters/encounter-12345678#addendum-cosign-addendum-87654321",
    );
  });
});

describe("Cosignature queue: a note and an amendment of a signed note", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says in plain words which entry is the note and which is an amendment", async () => {
    mountQueue([noteEntry, amendmentEntry]);
    const [first, second] = await rows();
    // The amendment's clock (routed 30h ago, so due in 18h) puts it first; the note's (signed 2h ago) is due in 46h.
    expect(within(first as HTMLElement).getByText("Amendment")).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText("to a signed note")).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText("Note")).toBeInTheDocument();
    expect(within(second as HTMLElement).queryByText("Amendment")).toBeNull();
  });

  it("keys the rows apart, so one encounter holding both raises no duplicate-key warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mountQueue([noteEntry, amendmentEntry]);
    expect(await rows()).toHaveLength(2);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key|unique "key"/i);
  });

  it("opens the encounter at the amendment's own cosign panel, and the note at the encounter", async () => {
    const user = userEvent.setup();
    mountQueue([noteEntry, amendmentEntry]);
    const [first, second] = await rows();
    await user.click(
      within(first as HTMLElement).getByRole("button", {
        name: "Review amendment to LPN routine visit for patient patient- on 2026-11-15",
      }),
    );
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-12345678/encounters/encounter-12345678#addendum-cosign-addendum-87654321",
    );
    expect(
      within(second as HTMLElement).getByRole("button", {
        name: "Review LPN routine visit for patient patient- on 2026-11-15",
      }),
    ).toBeInTheDocument();
  });

  it("shows the amendment's request status, where the note shows its encounter status", async () => {
    mountQueue([noteEntry, amendmentEntry]);
    const [first, second] = await rows();
    expect(within(first as HTMLElement).getByText("Escalated")).toBeInTheDocument();
    expect(within(first as HTMLElement).queryByText("Signed")).toBeNull();
    expect(within(second as HTMLElement).getByText("Cosign Pending")).toBeInTheDocument();
  });

  it("counts the amendment's own 48-hour clock from when it was routed, not from the note's signature", async () => {
    // The parent note was signed 100h ago, past the cap; the amendment was routed 30h ago, so it is not.
    mountQueue([amendmentEntry]);
    await rows();
    expect(screen.getByRole("button", { name: /Past Hard Cap/ })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: /Due < 24h/ })).toHaveTextContent("1");
  });

  it("puts an amendment past its own cap past the cap, whatever its note's clock", async () => {
    mountQueue([
      {
        ...amendmentEntry,
        signedAt: hoursAgo(2),
        cosign: { ...amendmentEntry.cosign, status: "hard_cap_reached", routedAt: hoursAgo(60) },
      },
    ]);
    await rows();
    expect(screen.getByRole("button", { name: /Past Hard Cap/ })).toHaveTextContent("1");
  });

  it("finds an amendment by searching for the word", async () => {
    const user = userEvent.setup();
    mountQueue([noteEntry, { ...amendmentEntry, id: "encounter-other" }]);
    await rows();
    await user.type(screen.getByRole("searchbox", { name: "Search cosignatures" }), "amendment");
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(within(found[0] as HTMLElement).getByText("Amendment")).toBeInTheDocument();
  });

  it("treats an entry with no cosign (an older server) as a note, exactly as before", async () => {
    mountQueue([noteEntry]);
    const [only] = await rows();
    expect(within(only as HTMLElement).getByText("Note")).toBeInTheDocument();
    expect(within(only as HTMLElement).getByText("Cosign Pending")).toBeInTheDocument();
  });

  it("treats a cosign that names no addendum as the note", async () => {
    mountQueue([
      {
        ...noteEntry,
        cosign: {
          subject: "note",
          addendumId: null,
          requestId: "r",
          status: "routed",
          routedAt: null,
        },
      },
    ]);
    const [only] = await rows();
    expect(within(only as HTMLElement).getByText("Note")).toBeInTheDocument();
  });
});
