import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { embeddedPatients, unresolvedPatientIds } from "../discharges-hub-model";
import { ReadmitList } from "../readmit-list";
import { admissionScreens } from "../screens";

const ok = (data: unknown) => ({ data, error: undefined, response: new Response(null) });
const fail = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "x" } },
  response: new Response(null, { status }),
});

const row = (over: Record<string, unknown>) => ({
  admissionId: "a-1",
  patientId: "p-1",
  admissionState: "discharged",
  admissionAt: "2026-03-02T15:00:00.000Z",
  dischargedAt: "2026-06-20T17:00:00.000Z",
  missing: null,
  dischargeEventId: null,
  transferEventId: null,
  dischargeType: "no_longer_terminal",
  effectiveDate: "2026-06-20",
  ...over,
});

// The server embeds the name + MRN of a readmission candidate (a former patient's chart is usually off the caller's
// caseload, so the patient read would 404); a row without it falls back to the patient read.
const RECENT = [
  row({
    admissionId: "a-5",
    patientId: "p-5",
    patient: { firstName: "Lena", lastName: "Park", mrn: "MRN-5005" },
  }),
  row({
    admissionId: "a-6",
    patientId: "p-6",
    dischargeType: "revocation",
    patient: { firstName: "Tom", lastName: "Reyes", mrn: "MRN-6006" },
  }),
  row({ admissionId: "a-7", patientId: "p-7", dischargeType: "transfer_out" }),
];
const PATIENTS: Record<string, unknown> = {
  "p-7": { id: "p-7", firstName: "Ida", lastName: "Moss", mrn: "MRN-7007" },
};

function makeClient(opts: { items?: unknown[]; fail?: boolean } = {}) {
  const GET = vi.fn(
    async (
      path: string,
      init?: { params?: { query?: { bucket?: string }; path?: { id: string } } },
    ) => {
      if (path === "/api/v1/discharges/worklist") {
        if (opts.fail) return fail(500);
        expect(init?.params?.query?.bucket).toBe("recently_discharged");
        return ok({ items: opts.items ?? RECENT, nextCursor: null });
      }
      if (path === "/api/v1/patients/{id}") return ok(PATIENTS[init?.params?.path?.id ?? ""]);
      return fail(404);
    },
  );
  return { GET };
}

function mount(permissions: string[], client = makeClient()) {
  const session: Session = {
    userId: "u-1",
    organizationId: "org-1",
    displayName: "Rita Alvarez",
    permissions,
  };
  render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={["/admissions/readmit"]}>
          <Routes>
            <Route path="/admissions/readmit" element={<ReadmitList />} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return client;
}

const candidates = () => screen.findByRole("table", { name: "Patients who can be readmitted" });

describe("readmit list model", () => {
  it("takes embedded names and only reads the patients the server did not name", () => {
    expect(embeddedPatients(RECENT as never)).toEqual({
      "p-5": { id: "p-5", firstName: "Lena", lastName: "Park", mrn: "MRN-5005" },
      "p-6": { id: "p-6", firstName: "Tom", lastName: "Reyes", mrn: "MRN-6006" },
    });
    expect(unresolvedPatientIds(RECENT as never, {})).toEqual(["p-7"]);
    // an embedded `null` (M5 could not resolve) is final — no extra read
    expect(unresolvedPatientIds([row({ patientId: "p-9", patient: null })] as never, {})).toEqual(
      [],
    );
  });
});

describe("Readmit list screen", () => {
  it("is a static Admissions nav path gated on admission.create", () => {
    const s = admissionScreens.screens.find((x) => x.id === "admission.readmit-list");
    expect(s).toMatchObject({
      path: "/admissions/readmit",
      title: "Readmit",
      navGroup: "Admissions",
      requiredPermission: "admission.create",
    });
  });

  it("lists the readmission candidates with names, MRNs, how the stay ended and a Readmit… action", async () => {
    const client = mount(["admission.read", "admission.create"]);
    const table = await candidates();
    expect(await within(table).findByText("Lena Park")).toBeTruthy();
    expect(within(table).getByText("MRN-6006")).toBeTruthy();
    expect(within(table).getByText("Revocation")).toBeTruthy();
    expect(within(table).getByText("No longer terminal")).toBeTruthy();
    expect(await within(table).findByText("Ida Moss")).toBeTruthy();
    const link = within(table).getByRole("link", { name: "Readmit Lena Park" });
    expect(link.getAttribute("href")).toBe("/admissions/a-5/readmit");
    // the patient read runs ONLY for the row the server did not name
    const reads = client.GET.mock.calls.filter(([p]) => p === "/api/v1/patients/{id}");
    expect(
      reads.map(([, init]) => (init as { params: { path: { id: string } } }).params.path.id),
    ).toEqual(["p-7"]);
  });

  it("filters by name or MRN and says so when nothing matches", async () => {
    mount(["admission.read", "admission.create"]);
    const table = await candidates();
    await within(table).findByText("Lena Park");
    const search = screen.getByLabelText("Search patients who can be readmitted");
    fireEvent.change(search, { target: { value: "reyes" } });
    expect(within(await candidates()).queryByText("Lena Park")).toBeNull();
    expect(within(await candidates()).getByText("Tom Reyes")).toBeTruthy();
    fireEvent.change(search, { target: { value: "MRN-5005" } });
    expect(within(await candidates()).getByText("Lena Park")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.getByText("No matching patients")).toBeTruthy();
  });

  it("shows an empty state when there is no one to readmit", async () => {
    mount(["admission.read", "admission.create"], makeClient({ items: [] }));
    expect(await screen.findByText("No one to readmit")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reports a failed load with a retry", async () => {
    const client = makeClient({ fail: true });
    mount(["admission.read", "admission.create"], client);
    expect(await screen.findByText("This list could not be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        client.GET.mock.calls.filter(([p]) => p === "/api/v1/discharges/worklist").length,
      ).toBe(2),
    );
  });

  it("hides the Readmit… action without admission.create (display only; the server enforces)", async () => {
    mount(["admission.read"]);
    const table = await candidates();
    await within(table).findByText("Lena Park");
    expect(within(table).queryByRole("link", { name: /Readmit/ })).toBeNull();
  });
});
