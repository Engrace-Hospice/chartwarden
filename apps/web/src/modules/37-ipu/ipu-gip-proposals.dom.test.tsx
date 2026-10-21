// apps/web/src/modules/37-ipu — F-219 (#248): the intake worklist lists the M19 GIP PROPOSALS.
//
// Asserted on the recorded `fetch` calls: the section must read `GET /api/v1/ipu-intake/gip-proposals`
// (a pull), show the proposal, carry NO write affordance (a proposal is not an admission), never name the
// patient or show the clinical criteria, render nothing when there are none, and say so — not go silently
// empty — when the read fails.
import { render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IpuAdmissions } from "./ipu-admissions";

const CALL = "9f9f9f9f-1111-4111-8111-000000000001";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SENTINEL = "GIP-CRITERIA-FREE-TEXT";

let calls: string[] = [];
let proposals: unknown[] = [];
let proposalsStatus = 200;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (
    init?.method ??
    (typeof input === "object" && "method" in input ? input.method : "GET") ??
    "GET"
  ).toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (path === "/api/v1/ipu-intake/gip-proposals") {
    return new Response(
      JSON.stringify(proposalsStatus === 200 ? { items: proposals } : { code: "X" }),
      {
        status: proposalsStatus,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinical_supervisor"],
  permissions: [],
  isAdmin: false,
};

function mount(): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/ipu/admissions"]}>
            <Routes>
              <Route path="/ipu/admissions" element={<IpuAdmissions />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

beforeEach(() => {
  calls = [];
  proposalsStatus = 200;
  proposals = [
    {
      triageCallId: CALL,
      patientId: PATIENT,
      admissionId: null,
      providerEntityId: "pe-1",
      locationId: null,
      proposedAt: "2026-09-30T02:00:00.000Z",
      preferredFacility: "Sunrise Inpatient Hospice",
      callState: "documented_pending_encounter",
      gipCriteriaSummary: SENTINEL, // a bad server leaking free text must not reach the screen
    },
  ];
});

describe("F-219 — the intake worklist's M19 GIP-proposed entries", () => {
  it("pulls the proposals and lists them as proposals, with no patient name, no criteria text, no write", async () => {
    const { container } = mount();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /GIP admission proposals/i })).toBeTruthy(),
    );
    expect(calls).toContain("GET /api/v1/ipu-intake/gip-proposals");
    expect(screen.getByText("Sunrise Inpatient Hospice")).toBeTruthy();
    expect(screen.getByText("Documented Pending Encounter")).toBeTruthy();
    expect(screen.getByText("9f9f9f9f")).toBeTruthy(); // short call reference
    expect(screen.getByText(/not yet admissions/i)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(PATIENT);
    // The section is read-only: a proposal is worked through the LOC order, not acted on here.
    const section = screen.getByRole("region", { name: /GIP admission proposals/i });
    expect(section.querySelectorAll("button")).toHaveLength(0);
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });

  it("renders nothing for an org with no proposals (and the admissions worklist is unaffected)", async () => {
    proposals = [];
    mount();
    await waitFor(() => expect(calls).toContain("GET /api/v1/ipu-intake/gip-proposals"));
    expect(screen.queryByRole("region", { name: /GIP admission proposals/i })).toBeNull();
    expect(screen.queryByText(/unavailable right now/i)).toBeNull();
  });

  it("says so when the proposal read fails, rather than showing an empty section", async () => {
    proposalsStatus = 503;
    mount();
    await waitFor(() => expect(screen.getByText(/GIP proposals are unavailable/i)).toBeTruthy());
    expect(screen.queryByRole("region", { name: /GIP admission proposals/i })).toBeNull();
  });
});
