// GAP-122 — the level-of-care change form: GIP shows the three D12 attestations and stays unsubmittable until
// all are checked; the request carries them; IRC/GIP success says the bed is still being assigned.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { LevelOfCareChange } from "../level-of-care-change";
import {
  type LocDraft,
  emptyDraft,
  locRequestBody,
  validateLocDraft,
} from "../level-of-care-model";

const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let calls: string[] = [];
let bodies: Array<Record<string, unknown>> = [];
let admissionState = "active";

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && typeof input === "object" && "clone" in input) {
    bodies.push(JSON.parse(await (input as Request).clone().text()));
    return json({ id: "loc-1", state: "active", version: 1 }, 201);
  }
  if (path === `/api/v1/admissions/${ADM}`)
    return json({ id: ADM, patientId: "p-1", state: admissionState, version: 1 });
  if (path === "/api/v1/patients/p-1")
    return json({
      id: "p-1",
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    });
  return json({});
}

const session = {
  userId: "u-1",
  organizationId: "org-1",
  displayName: "Ana",
  permissions: ["loc.change"],
};

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/admissions/${ADM}/level-of-care/new`]}>
            <Routes>
              <Route path="/admissions/:id/level-of-care/new" element={<LevelOfCareChange />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  bodies = [];
  admissionState = "active";
});

describe("level-of-care model", () => {
  const base: LocDraft = { ...emptyDraft("2026-10-06"), reason: "crisis symptoms at home now" };

  it("GIP needs the 30-character reason, a facility and all three attestations", () => {
    const gip: LocDraft = { ...base, newLevel: "general_inpatient_care", reason: "too short" };
    const errors = validateLocDraft(gip);
    expect(Object.keys(errors).sort()).toEqual(["attestations", "facilityId", "reason"]);
  });

  it("a complete GIP draft is valid and sends the attestations", () => {
    const gip: LocDraft = {
      ...base,
      newLevel: "general_inpatient_care",
      reason: "uncontrolled pain requiring inpatient management now",
      facilityId: "f-1",
      attestations: {
        symptomsNotManageableElsewhere: true,
        intensityWarrantsGip: true,
        inpatientSettingIdentified: true,
      },
    };
    expect(validateLocDraft(gip)).toEqual({});
    expect(locRequestBody(gip)).toMatchObject({
      newLevel: "general_inpatient_care",
      facilityId: "f-1",
      gipAttestations: { intensityWarrantsGip: true },
    });
  });

  it("a non-GIP draft sends no attestations and no facility for home levels", () => {
    expect(locRequestBody(base)).toEqual({
      newLevel: "routine_home_care",
      effectiveStart: "2026-10-06",
      reason: "crisis symptoms at home now",
    });
  });
});

describe("GAP-122 — the form", () => {
  it("RHC -> CHC submits without attestations", async () => {
    mount();
    fireEvent.click(await screen.findByLabelText(/Continuous home care/));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "crisis symptoms needing continuous nursing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request level of care change" }));
    await waitFor(() => expect(calls).toContain(`POST /api/v1/admissions/${ADM}/level-of-care`));
    expect(bodies[0]?.gipAttestations).toBeUndefined();
    expect(bodies[0]?.newLevel).toBe("continuous_home_care");
  });

  it("selecting GIP reveals the checklist and keeps Submit disabled until all three are checked", async () => {
    mount();
    fireEvent.click(await screen.findByLabelText(/General inpatient care/));
    expect(screen.getByText("GIP documentation (required)")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Request level of care change" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    // still blocked: no facility and the reason is empty
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("an admission that is not active offers no way to submit", async () => {
    admissionState = "discharged";
    mount();
    expect(await screen.findByText(/can only change while it is active or on hold/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Request level of care change" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
