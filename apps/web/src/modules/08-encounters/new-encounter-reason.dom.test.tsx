// WF09 — a clinician who starts a visit on site, with nothing scheduled, chooses its reason in the New Encounter
// form. The choices come from the server for the picked type × discipline (the browser carries no corpus), and the
// choice rides the create request so the note opens with it already recorded.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { PrnEncounterModal } from "./patient-encounters";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "cccccccc-3333-4333-8333-cccccccccccc";

let reasonsFor: (type: string, discipline: string) => { code: string; label: string }[] = () => [];
let posted: Record<string, unknown>[] = [];
let reasonQueries: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
  const parsed = new URL(url, "http://localhost");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (method === "GET" && parsed.pathname === "/api/v1/encounters/visit-reasons") {
    const type = parsed.searchParams.get("encounterType") ?? "";
    const discipline = parsed.searchParams.get("discipline") ?? "";
    reasonQueries.push(`${type}/${discipline}`);
    return json({ encounterType: type, discipline, reasons: reasonsFor(type, discipline) });
  }
  if (method === "GET" && parsed.pathname === `/api/v1/patients/${PATIENT}/admissions`) {
    return json({
      items: [{ id: ADMISSION, state: "active", admissionAt: null, dischargedAt: null }],
    });
  }
  if (method === "POST" && parsed.pathname === "/api/v1/encounters") {
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    posted.push(JSON.parse(raw) as Record<string, unknown>);
    return json({ id: "dddddddd-4444-4444-8444-dddddddddddd", status: "draft", version: 1 }, 201);
  }
  return json({});
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mountModal(onCreated: (id: string) => void = () => undefined) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <PrnEncounterModal
              open
              patientId={PATIENT}
              onClose={() => undefined}
              onCreated={onCreated}
            />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const RN_REASONS = [
  { code: "nv.reason.routine", label: "Routine scheduled visit" },
  { code: "nv.reason.fall_followup", label: "Follow-up after a fall" },
];

async function pickAdmission(): Promise<void> {
  fireEvent.focus(await screen.findByRole("combobox", { name: /Active admission/ }));
  fireEvent.click(await within(await screen.findByRole("listbox")).findByRole("option"));
}

beforeEach(() => {
  posted = [];
  reasonQueries = [];
  reasonsFor = () => RN_REASONS;
});

describe("New Encounter — reason for visit", () => {
  it("offers the reasons the server lists for the picked visit type and discipline", async () => {
    mountModal();
    const select = (await screen.findByLabelText("Reason for visit")) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Select…",
      "Routine scheduled visit",
      "Follow-up after a fall",
    ]);
    expect(select.value).toBe("");
    expect(reasonQueries).toContain("routine_visit/rn");
  });

  it("shows no reason field when the visit offers none", async () => {
    reasonsFor = () => [];
    mountModal();
    await waitFor(() => expect(reasonQueries.length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Reason for visit")).toBeNull();
  });

  it("sends the chosen reason with the create request", async () => {
    const created: string[] = [];
    mountModal((id) => created.push(id));
    await pickAdmission();
    const select = (await screen.findByLabelText("Reason for visit")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "nv.reason.fall_followup" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Encounter" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: "routine_visit",
      discipline: "rn",
      reasonCode: "nv.reason.fall_followup",
    });
    await waitFor(() => expect(created).toEqual(["dddddddd-4444-4444-8444-dddddddddddd"]));
  });

  it("sends no reason when none was chosen — it is optional, and is still chosen in the note", async () => {
    mountModal();
    await pickAdmission();
    await screen.findByLabelText("Reason for visit");
    fireEvent.click(screen.getByRole("button", { name: "Create Encounter" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty("reasonCode");
  });
});
