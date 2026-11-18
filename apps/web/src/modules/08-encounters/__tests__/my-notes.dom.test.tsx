// ADR-0113 slice 1 — My notes (screen id encounter.my-drafts, route /work/drafts): the author's open notes with the server's closure
// stage and deadline per row. Driven through the real API client over a fetch stub, so the rendered states are the wire shape's.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { MyDrafts } from "../my-drafts";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type Stage = "ok" | "at_risk" | "overdue" | "escalated";
const note = (
  id: string,
  over: {
    status?: string;
    encounterType?: string;
    clockStartedAt?: string | null;
    deadlineAt?: string | null;
    stage?: Stage;
  } = {},
) => ({
  id,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: "adm-1",
  visitId: null,
  encounterType: over.encounterType ?? "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-16",
  status: over.status ?? "draft",
  lateEntryTier: "normal",
  version: 1,
  authoredByUserId: "membership-1",
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
  closure: {
    clockStartedAt:
      over.clockStartedAt === undefined ? "2026-11-16T06:00:00.000Z" : over.clockStartedAt,
    deadlineAt: over.deadlineAt === undefined ? "2026-11-17T06:00:00.000Z" : over.deadlineAt,
    stage: over.stage ?? "ok",
  },
});
const LEGACY = { clockStartedAt: null, deadlineAt: null, stage: "ok" as Stage };

let response: { status: number; body: unknown } = { status: 200, body: { encounters: [] } };
let requested: string[] = [];

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "http://localhost").pathname;
  requested.push(path);
  if (path.endsWith("/my-drafts")) {
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }
  if (path === `/api/v1/patients/${PATIENT}`) {
    return new Response(JSON.stringify({ id: PATIENT, firstName: "Ada", lastName: "Lovelace" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: ["encounter.author"],
  isAdmin: false,
};

function mount() {
  const router = createMemoryRouter(
    [
      { path: "/work/drafts", element: <MyDrafts /> },
      { path: "/patients/:patientId/encounters/:encounterId/compose", element: <h1>Composer</h1> },
      { path: "/patients/:patientId/encounters/:encounterId", element: <h1>Encounter read</h1> },
    ],
    { initialEntries: ["/work/drafts"] },
  );
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return router;
}

const rowOf = (cell: HTMLElement): HTMLElement => {
  const row = cell.closest("tr");
  if (!row) throw new Error("row not rendered");
  return row;
};
const bodyRows = (): HTMLElement[] =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

beforeEach(() => {
  response = { status: 200, body: { encounters: [] } };
  requested = [];
});
afterEach(() => {
  response = { status: 200, body: { encounters: [] } };
});

describe("My notes", () => {
  it("is titled My notes and reads the same route", async () => {
    response = { status: 200, body: { encounters: [note("e1")] } };
    mount();
    expect(await screen.findByRole("heading", { name: "My notes" })).toBeTruthy();
    expect(requested).toContain("/api/v1/encounters/my-drafts");
  });

  it("shows each note's server stage and deadline, and labels a note with no clock Legacy with no deadline", async () => {
    response = {
      status: 200,
      body: {
        encounters: [
          note("e-late", { stage: "overdue", encounterType: "routine_visit" }),
          { ...note("e-old", { encounterType: "admission_visit" }), closure: LEGACY },
        ],
      },
    };
    mount();

    const late = rowOf(await screen.findByText("Routine Visit"));
    expect(within(late).getByText("Overdue")).toBeTruthy();
    expect(within(late).getByText(/^Due /)).toBeTruthy();

    const legacy = rowOf(screen.getByText("Admission Visit"));
    expect(within(legacy).getByText("Legacy")).toBeTruthy();
    expect(within(legacy).getByText("No deadline")).toBeTruthy();
    expect(within(legacy).queryByText("Overdue")).toBeNull();
  });

  it("counts Overdue (escalated included) and At risk in the KPI strip; Legacy and on-track notes count in neither", async () => {
    response = {
      status: 200,
      body: {
        encounters: [
          note("a", { stage: "overdue" }),
          note("b", { stage: "escalated" }),
          note("c", { stage: "at_risk" }),
          note("d", { stage: "ok" }),
          { ...note("e"), closure: LEGACY },
        ],
      },
    };
    mount();

    const overdue = await screen.findByRole("button", { name: /^Overdue/ });
    expect(within(overdue).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^At Risk/ })).getByText("1")).toBeTruthy();
    expect(
      within(screen.getByText("Open Notes").parentElement as HTMLElement).getByText("5"),
    ).toBeTruthy();
  });

  it("sorts the nearest deadline first and Legacy last, whatever order the server sent", async () => {
    response = {
      status: 200,
      body: {
        encounters: [
          { ...note("legacy", { encounterType: "chaplain_visit" }), closure: LEGACY },
          note("later", { encounterType: "pt_visit", deadlineAt: "2026-11-18T09:00:00.000Z" }),
          note("soonest", { encounterType: "ot_visit", deadlineAt: "2026-11-17T01:00:00.000Z" }),
        ],
      },
    };
    mount();
    await screen.findByText("Ot Visit");
    const order = bodyRows().map((row) => row.textContent ?? "");
    expect(order[0]).toContain("Ot Visit");
    expect(order[1]).toContain("Pt Visit");
    expect(order[2]).toContain("Chaplain Visit");
  });

  it("includes a finalized note, which opens the read screen where it is signed; a draft opens the composer", async () => {
    response = {
      status: 200,
      body: {
        encounters: [
          note("e-final", { status: "finalized", encounterType: "pt_visit" }),
          note("e-draft", {
            status: "draft",
            encounterType: "ot_visit",
            deadlineAt: "2026-11-18T09:00:00.000Z",
          }),
        ],
      },
    };
    const router = mount();

    const finalized = rowOf(await screen.findByText("Pt Visit"));
    expect(within(finalized).getByText("Finalized")).toBeTruthy();
    expect(within(finalized).getByRole("button", { name: "Review and Sign" })).toBeTruthy();
    fireEvent.click(finalized);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/patients/${PATIENT}/encounters/e-final`),
    );
  });

  it("opens the composer for a draft", async () => {
    response = {
      status: 200,
      body: { encounters: [note("e-draft", { encounterType: "ot_visit" })] },
    };
    const router = mount();
    fireEvent.click(
      within(rowOf(await screen.findByText("Ot Visit"))).getByRole("button", {
        name: "Continue Documentation",
      }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/patients/${PATIENT}/encounters/e-draft/compose`,
      ),
    );
  });

  it("filters to overdue notes from the KPI card and by the Closure select, and clears", async () => {
    response = {
      status: 200,
      body: {
        encounters: [
          note("a", { stage: "overdue", encounterType: "pt_visit" }),
          note("b", { stage: "ok", encounterType: "ot_visit" }),
          { ...note("c", { encounterType: "chaplain_visit" }), closure: LEGACY },
        ],
      },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^Overdue/ }));
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Pt Visit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(bodyRows()).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Filter by closure stage"), {
      target: { value: "legacy" },
    });
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText("Chaplain Visit")).toBeTruthy();
  });

  it("says plainly when nothing is waiting", async () => {
    mount();
    expect(await screen.findByText("No open notes")).toBeTruthy();
    expect(screen.getByText(/Nothing is waiting on you/)).toBeTruthy();
  });

  it("shows an error state, not an empty list, when the notes cannot be loaded", async () => {
    response = { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } };
    mount();
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getAllByText("Could not load your notes.").length).toBeGreaterThan(0);
    expect(screen.queryByText("No open notes")).toBeNull();
  });
});
