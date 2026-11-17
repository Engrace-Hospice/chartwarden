// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeDashboard } from "../hope-dashboard";

// Group g2: the HOPE schedule worklist's search matches text the table SHOWS (the patient, the MRN, the timepoint, the state), not the
// raw UTC window instants, which no column prints (the Closes column is a countdown). Same class as the SFV queue's search.

afterEach(cleanup);

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SCHEDULE = "cccccccc-3333-4333-8333-cccccccccccc";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/api/v1/hope/schedules") {
    return json({
      schedules: [
        {
          id: SCHEDULE,
          patientId: PATIENT,
          admissionId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          rfaKind: "02_huv1",
          status: "open",
          windowOpensAt: "2000-01-01T00:00:00.000Z",
          windowClosesAt: "2999-01-01T00:00:00.000Z",
          lateDeadlineAt: "2999-02-01T00:00:00.000Z",
        },
      ],
    });
  }
  if (path === `/api/v1/patients/${PATIENT}`) {
    return json({ id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" });
  }
  return json({});
}

async function mount(): Promise<HTMLInputElement> {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "11111111-1111-4111-8111-111111111111",
          organizationId: "org-1",
          displayName: "Dr",
          permissions: ["hope.schedule.read"],
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <HopeDashboard />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  await screen.findByText("Lovelace, Ada");
  return screen.getByLabelText("Search HOPE schedules") as HTMLInputElement;
}

describe("searching the HOPE schedule worklist finds only what the table shows", () => {
  it("finds the row by the patient's name", async () => {
    const search = await mount();

    fireEvent.change(search, { target: { value: "lovelace" } });

    expect(screen.getByText("Lovelace, Ada")).toBeTruthy();
  });

  it.each([
    ["the window-close date, which the table shows only as a countdown", "2999-01-01"],
    ["the window-open date", "2000-01-01"],
    ["a raw window instant", "2999-01-01t00:00"],
  ])("finds nothing for %s", async (_name, query) => {
    const search = await mount();

    fireEvent.change(search, { target: { value: query } });

    expect(screen.getByText("No HOPE schedules")).toBeTruthy();
    expect(screen.queryByText("Lovelace, Ada")).toBeNull();
  });
});
