import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HopeSfvCapture, HopeTimepointCapture } from "../hope-capture-workspace";

const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workflow(status = "late") {
  return {
    admissionId,
    patientId: "patient-1",
    admissionStatus: "active",
    admissionAt: "2026-08-27T00:00:00.000Z",
    admissionAssessment: {
      kind: "01_admission",
      status: "completed",
      windowStart: "2026-08-27T00:00:00.000Z",
      windowEnd: "2026-08-31T23:59:59.999Z",
      lateDeadline: "2026-09-07T23:59:59.999Z",
      assessmentId: "assess-adm",
    },
    huv1: {
      kind: "02_huv1",
      status,
      windowStart: "2026-09-02T00:00:00.000Z",
      windowEnd: "2026-09-11T23:59:59.999Z",
      lateDeadline: "2026-09-18T23:59:59.999Z",
      assessmentId: null,
    },
    huv2: {
      kind: "03_huv2",
      status: "upcoming",
      windowStart: "2026-09-12T00:00:00.000Z",
      windowEnd: "2026-09-26T23:59:59.999Z",
      lateDeadline: "2026-10-03T23:59:59.999Z",
      assessmentId: null,
    },
    sfvs: [
      {
        id: "sfv-1",
        status: "open",
        triggeringAssessmentId: "assess-adm",
        triggeringRfaKind: "01_admission",
        dueAt: "2026-09-04T23:59:59.999Z",
        completingAssessmentId: null,
      },
    ],
    dischargeAssessment: {
      kind: "05_discharge",
      status: "not_applicable",
      windowStart: null,
      windowEnd: null,
      lateDeadline: null,
      assessmentId: null,
    },
  };
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function fail(code: string) {
  return {
    data: undefined,
    error: { error: { code } },
    response: new Response(null, { status: code === "M10_LATE_REASON_REQUIRED" ? 400 : 409 }),
  };
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

function renderRoute(client: ApiClient, initial: string): void {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route
            path="/admissions/:admissionId/hope/timepoints/:kind"
            element={
              <>
                <HopeTimepointCapture />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/admissions/:admissionId/hope/sfv/:sfvId"
            element={
              <>
                <HopeSfvCapture />
                <LocationProbe />
              </>
            }
          />
          <Route path="/hope/assessments/:id" element={<LocationProbe />} />
          <Route path="/admissions/:admissionId/hope" element={<LocationProbe />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("HOPE capture workspace", () => {
  it("shows late-completion reason when M10 reports a late HUV window", async () => {
    const client = {
      GET: vi.fn(async () => ok(workflow("late"))),
      POST: vi.fn(async () => ok({ id: "draft-1" })),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "HUV1 Assessment" })).toBeTruthy(),
    );
    expect(screen.getByText("Late completion")).toBeTruthy();
    expect(screen.getByLabelText("Late completion reason")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Late completion reason"), {
      target: { value: "hospitalization" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe("/hope/assessments/draft-1"),
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions/{admissionId}/hope/timepoints",
      expect.objectContaining({
        body: expect.objectContaining({
          rfaKind: "02_huv1",
          lateCompletionReasonCode: "hospitalization",
        }),
      }),
    );
  });

  it("renders structured M10 late and before-window errors instead of recalculating in React", async () => {
    const client = {
      GET: vi.fn(async () => ok(workflow("open"))),
      POST: vi.fn(async () => fail("M10_LATE_REASON_REQUIRED")),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "HUV1 Assessment" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Select a late completion reason"),
    );
  });

  it("opens and completes an existing backend-created SFV through recordSfv", async () => {
    const client = {
      GET: vi.fn(async () => ok(workflow("open"))),
      POST: vi.fn(async () => ok({ id: "sfv-assessment-1" })),
    } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/sfv/sfv-1`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Symptom Follow-Up" })).toBeTruthy(),
    );
    expect(screen.getByText("Triggered by Admission.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create HOPE draft/ }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(`/admissions/${admissionId}/hope`),
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admissions/{admissionId}/hope/sfv",
      expect.objectContaining({
        body: expect.objectContaining({ triggeringAssessmentId: "assess-adm" }),
      }),
    );
  });

  it("names the patient and shows the admission's calendar day in any timezone", async () => {
    // admissionAt is a date serialized as midnight UTC; in a US zone a local-time render reads Aug 26.
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/patients/{id}"
        ? ok({ id: "patient-1", firstName: "Ada", lastName: "Lovelace" })
        : ok(workflow("open")),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    expect(await screen.findByText("Lovelace, Ada")).toBeTruthy();
    expect(screen.queryByText("patient-1")).toBeNull();
    expect(screen.getByText(/Admission Aug 27, 2026/)).toBeTruthy();
  });

  it("falls back to the patient id when the name cannot be read", async () => {
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/patients/{id}" ? { data: undefined, error: {} } : ok(workflow("open")),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    renderRoute(client, `/admissions/${admissionId}/hope/timepoints/02_huv1`);

    expect(await screen.findByText("patient-1")).toBeTruthy();
  });
});
