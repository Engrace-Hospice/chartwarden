// F-009 (#591) - the Clinical tab never renders a denied or failed read as empty (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ClinicalRail,
  ClinicalTab,
  classifyClinicalRead,
  useClinicalData,
} from "./patient-clinical";
import type { PatientChartData, PatientSummary } from "./patient-overview";

const PPS = "/api/v1/patients/{patientId}/scales/{scaleType}/latest";
const CONSENTS = "/api/v1/patients/{patientId}/consents";
const DPOA = "/api/v1/patients/{patientId}/dpoa/active-primary";

const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
const fail = (status: number) => ({
  data: undefined,
  error: { title: "x" },
  response: { status },
});
const patient = { id: "p1" } as unknown as PatientSummary;
const chart = {} as unknown as PatientChartData;

function Harness() {
  const clinical = useClinicalData("p1", chart, true);
  return (
    <>
      <ClinicalTab patient={patient} data={chart} clinical={clinical} />
      <ClinicalRail patient={patient} data={chart} clinical={clinical} />
    </>
  );
}

function mount(replies: Record<string, unknown>) {
  const get = vi.fn((path: string) => Promise.resolve(replies[path] ?? ok({})));
  render(
    <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return get;
}
const base = {
  [PPS]: ok({ id: "a", scaleType: "pps", score: 60, capturedAt: "2026-10-01T00:00:00Z", data: {} }),
  [CONSENTS]: ok({ data: [] }),
  [DPOA]: ok({ data: null }),
};
const NO_DIRECTIVES = /No advance directive or healthcare DPOA on file/;

describe("classifyClinicalRead", () => {
  it("maps 404 per read kind and defers the rest to classifyRead", () => {
    expect(classifyClinicalRead(fail(404), "empty")).toBe("ok");
    expect(classifyClinicalRead(fail(404), "denied")).toBe("denied");
    expect(classifyClinicalRead(fail(403), "empty")).toBe("denied");
    expect(classifyClinicalRead(fail(500), "denied")).toBe("failed");
    expect(classifyClinicalRead(ok({}), "denied")).toBe("ok");
  });
});

describe("Clinical tab read states", () => {
  it("shows loading while the reads are pending", () => {
    mount(base);
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
  });

  it("shows the empty advance-directive state only when both reads succeed empty", async () => {
    mount(base);
    await screen.findByText(NO_DIRECTIVES);
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
  });

  it.each([
    ["consents", CONSENTS],
    ["DPOA", DPOA],
  ])("treats a 404 on %s as denied, never as none on file", async (_n, path) => {
    mount({ ...base, [path]: fail(404) });
    await screen.findByText(/Advance directives/, { selector: "p" });
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Advance directives/);
  });

  it.each([
    ["consents", CONSENTS],
    ["DPOA", DPOA],
  ])("treats a 403 on %s as denied", async (_n, path) => {
    mount({ ...base, [path]: fail(403) });
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each([
    ["consents", CONSENTS],
    ["DPOA", DPOA],
  ])("shows a failed %s read with retry, which refetches", async (_n, path) => {
    const get = mount({ ...base, [path]: fail(500) });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    const before = get.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it("treats a PPS 404 as no PPS recorded, not an error", async () => {
    mount({ ...base, [PPS]: fail(404) });
    await screen.findByText(NO_DIRECTIVES);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryAllByText("60%")).toHaveLength(0);
  });

  it("shows PPS 403 as denied without retry", async () => {
    mount({ ...base, [PPS]: fail(403) });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Performance status/),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows PPS 500 as failed with retry", async () => {
    mount({ ...base, [PPS]: fail(500) });
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Performance status could not be loaded/)).toBeTruthy();
  });

  it("treats a rejected request as failed", async () => {
    const get = vi.fn((path: string) =>
      path === CONSENTS
        ? Promise.reject(new Error("net"))
        : Promise.resolve(base[path as never] ?? ok({})),
    );
    render(
      <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
  });
});
