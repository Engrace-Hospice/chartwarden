import { fireEvent, render, screen } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DischargeDetails } from "../discharge-details";
import { MissingDischargeDetailsAlert } from "../discharge-details-alert";
import { detailTarget, validateDetail } from "../discharge-details-model";

const ADM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLAIM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Ana Reyes",
  permissions: ["admission.read", "discharge.death"],
};

const ok = (data: unknown, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});
const fail = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: code } },
  response: new Response(null, { status }),
});

const deathView = (placeOfDeath: string | null = null) => ({
  admissionId: ADM,
  patientId: "p-1",
  admissionState: "discharged",
  discharge: {
    dischargeEventId: DE,
    reason: "death",
    status: "completed",
    effectiveDate: "2026-05-01",
    placeOfDeath,
    placeOfDeathCorrectionReason: null,
    version: 2,
  },
  transferOut: null,
  missing: placeOfDeath === null ? "place_of_death" : null,
});
const transferView = {
  admissionId: ADM,
  patientId: "p-1",
  admissionState: "discharged",
  discharge: null,
  transferOut: {
    transferEventId: TE,
    effectiveDate: "2026-04-10",
    receivingHospiceName: "Desert Sun Hospice",
    receivingCareSetting: null,
    receivingCareSettingCorrectionReason: null,
    version: 0,
  },
  missing: "receiving_care_setting",
};

function getFor(view: unknown) {
  return vi.fn(async (path: string) =>
    path === "/api/v1/admissions/{id}/discharge-details"
      ? ok(view)
      : path === "/api/v1/admissions/{id}"
        ? ok({ id: ADM, state: "discharged", version: 7, patientId: "p-1" })
        : fail(404, "NOT_FOUND"),
  );
}

function mount(path: string, el: JSX.Element, routePath: string, client: object) {
  return render(
    <ApiClientProvider client={client as unknown as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={el} />
            <Route path="*" element={<p>elsewhere</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const ROUTE = "/admissions/:id/discharge-details";

describe("discharge-details model", () => {
  it("targets the missing place of death, or a correction when one is recorded", () => {
    expect(detailTarget(deathView() as never)).toMatchObject({
      detail: "place_of_death",
      recordId: DE,
      version: 2,
      correcting: false,
    });
    expect(detailTarget(deathView("home") as never)?.correcting).toBe(true);
    expect(detailTarget(transferView as never)).toMatchObject({
      detail: "receiving_care_setting",
      recordId: TE,
    });
  });
  it("requires a value, and a different value plus a reason when correcting", () => {
    const fill = detailTarget(deathView() as never)!;
    expect(validateDetail(fill, "", "").value).toBe("Choose where the patient died.");
    const fix = detailTarget(deathView("home") as never)!;
    expect(validateDetail(fix, "home", "x".repeat(25)).value).toMatch(/already the recorded value/);
    expect(validateDetail(fix, "facility", "short").reason).toMatch(/at least 20/);
    expect(validateDetail(fix, "facility", "certificate lists the nursing facility")).toEqual({});
  });
});

describe("DischargeDetails screen", () => {
  it("explains, records the place of death and links back to the claim", async () => {
    const POST = vi.fn(async () =>
      ok({ id: DE, admissionId: ADM, detail: "place_of_death", value: "facility", changed: true }),
    );
    mount(`/admissions/${ADM}/discharge-details?claimId=${CLAIM}`, <DischargeDetails />, ROUTE, {
      GET: getFor(deathView()),
      POST,
    });
    // Step 1 — the plain-language reason the claim is held.
    expect(
      await screen.findByText(/CMS requires the patient status on the final claim/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record the place of death" }));
    // Step 2 — choose; Review without a choice shows the field error with the hint still visible.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Choose where the patient died.")).toBeTruthy();
    expect(screen.getByText("Sets the patient status on the final Medicare claim.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /In a facility/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    // Step 3 — confirm shows the status code it sets.
    expect(screen.getByText(/^41 — /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save place of death" }));
    expect(await screen.findByText("The place of death is recorded")).toBeTruthy();
    expect(POST).toHaveBeenCalledWith("/api/v1/discharges/{id}/place-of-death", {
      params: { path: { id: DE } },
      body: { placeOfDeath: "facility", ifVersion: 2 },
    });
    expect(screen.getByRole("link", { name: "Back to claim" }).getAttribute("href")).toBe(
      `/billing/claims/${CLAIM}`,
    );
    expect(screen.getByRole("link", { name: "Re-validate claim" }).getAttribute("href")).toBe(
      `/billing/claims/${CLAIM}/validation`,
    );
  });

  it("records a transfer's receiving care setting on the transfer record", async () => {
    const POST = vi.fn(async () => ok({ id: TE, changed: true }));
    mount(`/admissions/${ADM}/discharge-details`, <DischargeDetails />, ROUTE, {
      GET: getFor(transferView),
      POST,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Record the receiving care setting" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /At home/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Save receiving care setting" }));
    await screen.findByText("The receiving care setting is recorded");
    expect(POST).toHaveBeenCalledWith("/api/v1/transfers/{id}/receiving-care-setting", {
      params: { path: { id: TE } },
      body: { receivingCareSetting: "home", ifVersion: 0 },
    });
    expect(screen.getByRole("link", { name: "Back to admission" })).toBeTruthy();
  });

  it("offers a correction (with a reason) when the value is already recorded", async () => {
    const POST = vi.fn(async () => ok({ id: DE, changed: true }));
    mount(`/admissions/${ADM}/discharge-details`, <DischargeDetails />, ROUTE, {
      GET: getFor(deathView("home")),
      POST,
    });
    expect(await screen.findByText(/Nothing is missing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Correct the recorded value" }));
    fireEvent.click(screen.getByRole("radio", { name: /In a facility/ }));
    fireEvent.change(screen.getByLabelText(/Reason for the correction/), {
      target: { value: "death certificate lists the nursing facility" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Save place of death" }));
    await screen.findByText("The place of death is recorded");
    expect(POST).toHaveBeenCalledWith("/api/v1/discharges/{id}/place-of-death", {
      params: { path: { id: DE } },
      body: {
        placeOfDeath: "facility",
        ifVersion: 2,
        correctionReason: "death certificate lists the nursing facility",
      },
    });
  });

  it("names the permission on a 403 and maps a stale version", async () => {
    const POST = vi
      .fn()
      .mockResolvedValueOnce(fail(403, "FORBIDDEN"))
      .mockResolvedValueOnce(fail(409, "VERSION_MISMATCH"));
    mount(`/admissions/${ADM}/discharge-details`, <DischargeDetails />, ROUTE, {
      GET: getFor(deathView()),
      POST,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record the place of death" }));
    fireEvent.click(screen.getByRole("radio", { name: /At home/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Save place of death" }));
    expect(
      await screen.findByText(/needs the permission to record deaths \(discharge\.death\)/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save place of death" }));
    expect(
      await screen.findByText(/changed this discharge record after you opened it/),
    ).toBeTruthy();
  });
});

describe("MissingDischargeDetailsAlert", () => {
  it("shows the held-claim alert with a link to the guided screen for an ended admission", async () => {
    const GET = getFor(deathView());
    mount(
      `/admissions/${ADM}`,
      <MissingDischargeDetailsAlert admissionId={ADM} admissionState="discharged" />,
      "/admissions/:id",
      { GET },
    );
    const link = await screen.findByRole("link", { name: "Record the place of death" });
    expect(link.getAttribute("href")).toBe(`/admissions/${ADM}/discharge-details`);
    expect(screen.getByText(/the place of death is not recorded/)).toBeTruthy();
  });

  it("does not read or render for an active admission or when nothing is missing", async () => {
    const GET = getFor(deathView("unknown"));
    const { container } = mount(
      `/admissions/${ADM}`,
      <MissingDischargeDetailsAlert admissionId={ADM} admissionState="active" />,
      "/admissions/:id",
      { GET },
    );
    expect(GET).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
