import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DischargesHub } from "../discharges-hub";
import { hubAbilities, matchesPatient, unresolvedPatientIds } from "../discharges-hub-model";
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
  admissionState: "active",
  admissionAt: "2026-03-02T15:00:00.000Z",
  dischargedAt: null,
  missing: null,
  dischargeEventId: null,
  transferEventId: null,
  dischargeType: null,
  effectiveDate: null,
  ...over,
});

const READY = [
  row({ admissionId: "a-1", patientId: "p-1" }),
  row({ admissionId: "a-2", patientId: "p-2", admissionState: "on_hold" }),
];
const NEEDS = [
  row({
    admissionId: "a-3",
    patientId: "p-3",
    admissionState: "bereavement",
    missing: "place_of_death",
    dischargeEventId: "de-3",
    dischargeType: "death",
    effectiveDate: "2026-05-01",
  }),
];
const COSIGN = [
  row({
    admissionId: "a-4",
    patientId: "p-4",
    dischargeEventId: "de-4",
    dischargeType: "for_cause",
    effectiveDate: "2026-06-03",
  }),
];
const RECENT = [
  row({
    admissionId: "a-5",
    patientId: "p-5",
    admissionState: "discharged",
    dischargeType: "no_longer_terminal",
    effectiveDate: "2026-06-20",
    dischargedAt: "2026-06-20T17:00:00.000Z",
  }),
];
const QIO = [
  row({ admissionId: "a-6", patientId: "p-1", nextDeadlineAt: null }),
  row({ admissionId: "a-7", patientId: "p-2", nextDeadlineAt: "2099-01-12T17:00:00.000Z" }),
];
const NO_DEADLINE = [
  row({ admissionId: "a-8", patientId: "p-3", noticeDeliveredAt: "2026-01-10T15:30:00.000Z" }),
];
const PATIENTS: Record<string, unknown> = {
  "p-5": { id: "p-5", firstName: "Lena", lastName: "Park", mrn: "MRN-5005" },
  "p-1": { id: "p-1", firstName: "Maria", lastName: "Lopez", mrn: "MRN-1001" },
  "p-2": { id: "p-2", firstName: "James", lastName: "Carter", mrn: "MRN-2002" },
  "p-3": { id: "p-3", firstName: "Ruth", lastName: "Kim", mrn: "MRN-3003" },
  "p-4": { id: "p-4", firstName: "Omar", lastName: "Diaz", mrn: "MRN-4004" },
};

function makeClient(opts: { failReady?: boolean; failNoDeadline?: boolean } = {}) {
  const GET = vi.fn(
    async (
      path: string,
      init?: { params?: { query?: { bucket?: string }; path?: { id: string } } },
    ) => {
      if (path === "/api/v1/discharges/worklist") {
        const bucket = init?.params?.query?.bucket;
        if (bucket === "ready")
          return opts.failReady ? fail(500) : ok({ items: READY, nextCursor: null });
        if (bucket === "needs_details") return ok({ items: NEEDS, nextCursor: null });
        if (bucket === "awaiting_cosign") return ok({ items: COSIGN, nextCursor: null });
        if (bucket === "recently_discharged") return ok({ items: RECENT, nextCursor: null });
        if (bucket === "qio_review_open") return ok({ items: QIO, nextCursor: null });
        if (bucket === "nomnc_no_deadline")
          return opts.failNoDeadline ? fail(500) : ok({ items: NO_DEADLINE, nextCursor: null });
      }
      if (path === "/api/v1/patients/{id}") {
        const id = init?.params?.path?.id ?? "";
        return ok(PATIENTS[id]);
      }
      return fail(404);
    },
  );
  return { GET };
}

function mount(permissions: string[], client = makeClient()) {
  const session: Session = {
    userId: "u-1",
    organizationId: "org-1",
    displayName: "Ana Reyes",
    permissions,
  };
  render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={["/admissions/discharges"]}>
          <Routes>
            <Route path="/admissions/discharges" element={<DischargesHub />} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return client;
}

const tableNamed = (name: string) => screen.getByRole("table", { name });

describe("discharges hub model", () => {
  it("derives the row actions from the actor's keys", () => {
    expect(hubAbilities(["transfer.out"])).toEqual({
      discharge: true,
      death: false,
      cosign: false,
      readmit: false,
      nomnc: false,
    });
    expect(hubAbilities(["discharge.death", "discharge.cosign_for_cause"])).toEqual({
      discharge: false,
      death: true,
      cosign: true,
      readmit: false,
      nomnc: false,
    });
    expect(hubAbilities(["admission.create"]).readmit).toBe(true);
    expect(hubAbilities(["nomnc.read"]).nomnc).toBe(true);
    expect(hubAbilities(null)).toEqual({
      discharge: false,
      death: false,
      cosign: false,
      readmit: false,
      nomnc: false,
    });
  });
  it("matches a patient by name or MRN and lists only unknown patient ids", () => {
    const p = { id: "p-1", firstName: "Maria", lastName: "Lopez", mrn: "MRN-1001" };
    expect(matchesPatient(p, "lopez")).toBe(true);
    expect(matchesPatient(p, "1001")).toBe(true);
    expect(matchesPatient(p, "carter")).toBe(false);
    expect(matchesPatient(undefined, "")).toBe(true);
    expect(unresolvedPatientIds(READY as never, { "p-1": null })).toEqual(["p-2"]);
  });
});

describe("discharges hub screen", () => {
  it("is registered as a static Admissions nav path gated on discharge.create", () => {
    const hub = admissionScreens.screens.find((s) => s.id === "admission.discharges");
    expect(hub).toMatchObject({
      path: "/admissions/discharges",
      title: "Discharge / transfer",
      navGroup: "Admissions",
      requiredPermission: "discharge.create",
    });
  });

  it("lists ready admissions with names, MRNs and both actions for a clinician holding both keys", async () => {
    mount(["admission.read", "discharge.create", "discharge.death"]);
    const ready = await waitFor(() => tableNamed("Admissions ready for discharge"));
    expect(await within(ready).findByText("Maria Lopez")).toBeTruthy();
    expect(within(ready).getByText("MRN-2002")).toBeTruthy();
    expect(within(ready).getByText("On Hold")).toBeTruthy();
    const discharge = within(ready).getByRole("link", {
      name: "Discharge or transfer Maria Lopez",
    });
    expect(discharge.getAttribute("href")).toBe("/admissions/a-1/discharge");
    const death = within(ready).getByRole("link", { name: "Record death for Maria Lopez" });
    expect(death.getAttribute("href")).toBe("/admissions/a-1/death");
  });

  it("shows only the actions the actor holds, and no cosign queue without the cosign key", async () => {
    const client = mount(["admission.read", "discharge.create"]);
    const ready = await waitFor(() => tableNamed("Admissions ready for discharge"));
    await within(ready).findByText("Maria Lopez");
    expect(within(ready).queryByRole("link", { name: /Record death/ })).toBeNull();
    expect(screen.queryByText("Awaiting for-cause cosign")).toBeNull();
    expect(
      client.GET.mock.calls.some(
        ([, init]) =>
          (init as { params?: { query?: { bucket?: string } } })?.params?.query?.bucket ===
          "awaiting_cosign",
      ),
    ).toBe(false);
  });

  it("filters the ready list by name or MRN", async () => {
    mount(["admission.read", "discharge.create"]);
    const ready = await waitFor(() => tableNamed("Admissions ready for discharge"));
    await within(ready).findByText("James Carter");
    fireEvent.change(screen.getByLabelText("Search admissions ready for discharge"), {
      target: { value: "MRN-1001" },
    });
    expect(
      within(tableNamed("Admissions ready for discharge")).queryByText("James Carter"),
    ).toBeNull();
    expect(
      within(tableNamed("Admissions ready for discharge")).getByText("Maria Lopez"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search admissions ready for discharge"), {
      target: { value: "nobody" },
    });
    expect(screen.getByText("No matching patients")).toBeTruthy();
  });

  it("links an ended stay missing its place of death to the discharge-details screen", async () => {
    mount(["admission.read", "discharge.create"]);
    const needs = await waitFor(() => tableNamed("Ended stays missing discharge details"));
    expect(await within(needs).findByText("Ruth Kim")).toBeTruthy();
    expect(within(needs).getByText("Place of death")).toBeTruthy();
    expect(within(needs).getByText("Death")).toBeTruthy();
    expect(within(needs).getByRole("link", { name: "Add details" }).getAttribute("href")).toBe(
      "/admissions/a-3/discharge-details",
    );
  });

  it("shows the cosign queue to a medical director, linking to the cosign screen", async () => {
    mount(["admission.read", "discharge.create", "discharge.cosign_for_cause"]);
    const cosign = await waitFor(() => tableNamed("For-cause discharges awaiting cosign"));
    expect(await within(cosign).findByText("Omar Diaz")).toBeTruthy();
    expect(within(cosign).getByRole("link", { name: "Review & cosign" }).getAttribute("href")).toBe(
      "/discharges/de-4/cosign",
    );
  });

  it("lists open QIO reviews (no deadline typed is flagged) and NOMNC records with no deadline, only with nomnc.read", async () => {
    mount(["admission.read", "discharge.create", "nomnc.read"]);
    const qio = await waitFor(() => tableNamed("Admissions with an open QIO review"));
    expect(await within(qio).findByText("No deadline recorded")).toBeTruthy();
    expect(within(qio).getAllByRole("link", { name: "Open record" })[0]?.getAttribute("href")).toBe(
      "/admissions/a-6",
    );
    const missing = await waitFor(() => tableNamed("NOMNC records with no deadline typed"));
    expect(
      within(missing).getByRole("link", { name: "Enter the deadline" }).getAttribute("href"),
    ).toBe("/admissions/a-8");
  });

  it("a failed 'no deadline' list is visible with a retry, not silently hidden", async () => {
    mount(["admission.read", "discharge.create", "nomnc.read"], makeClient({ failNoDeadline: true }));
    const panel = await screen.findByText("NOMNC with no appeal-request deadline");
    expect(panel).toBeTruthy();
    expect((await screen.findAllByText("This list could not be loaded.")).length).toBeGreaterThan(0);
  });

  it("does not fetch or show the QIO buckets without nomnc.read", async () => {
    const client = mount(["admission.read", "discharge.create"]);
    await waitFor(() => tableNamed("Admissions ready for discharge"));
    expect(screen.queryByText("QIO review open")).toBeNull();
    const buckets = client.GET.mock.calls.map(
      ([, init]) => (init as { params?: { query?: { bucket?: string } } })?.params?.query?.bucket,
    );
    expect(buckets).not.toContain("qio_review_open");
    expect(buckets).not.toContain("nomnc_no_deadline");
  });

  it("explains which workflow to use in the rail", async () => {
    mount(["admission.read", "discharge.create"]);
    const rail = screen.getByRole("complementary", { name: "Which workflow" });
    const terms = within(rail)
      .getAllByRole("term")
      .map((t) => t.textContent);
    expect(terms).toEqual(
      expect.arrayContaining([
        "Moved out of service area",
        "Transfer out to another hospice",
        "Revocation",
        "Death",
      ]),
    );
    expect(within(rail).getByText(/the benefit period carries over/)).toBeTruthy();
    await waitFor(() => tableNamed("Admissions ready for discharge"));
  });

  it("reports a failed list with a retry, without hiding the other sections", async () => {
    const client = makeClient({ failReady: true });
    mount(["admission.read", "discharge.create"], client);
    expect(await screen.findByText("This list could not be loaded.")).toBeTruthy();
    expect(await screen.findByText("Ruth Kim")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        client.GET.mock.calls.filter(
          ([path, init]) =>
            path === "/api/v1/discharges/worklist" &&
            (init as { params?: { query?: { bucket?: string } } })?.params?.query?.bucket ===
              "ready",
        ).length,
      ).toBe(2),
    );
  });

  it("lists recent live discharges with a Readmit action only for admission.create", async () => {
    mount(["admission.read", "admission.create"]);
    const table = await screen.findByRole("table", { name: "Recently discharged patients" });
    expect(await within(table).findByText("Lena Park")).toBeTruthy();
    expect(within(table).getByText("No longer terminal")).toBeTruthy();
    const link = within(table).getByRole("link", { name: "Readmit Lena Park" });
    expect(link.getAttribute("href")).toBe("/admissions/a-5/readmit");
  });

  it("hides Readmit without admission.create", async () => {
    mount(["admission.read"]);
    const table = await screen.findByRole("table", { name: "Recently discharged patients" });
    await within(table).findByText("Lena Park");
    expect(within(table).queryByRole("link", { name: /Readmit/ })).toBeNull();
  });
});
