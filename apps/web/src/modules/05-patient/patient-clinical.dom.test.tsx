// F-009 (#591) - the Clinical tab never renders a denied or failed read as empty (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ClinicalRail, ClinicalTab, useClinicalData } from "./patient-clinical";
import type { PatientChartData, PatientSummary } from "./patient-overview";

const PPS = "/api/v1/patients/{patientId}/scales/{scaleType}/latest";
const CONSENTS = "/api/v1/patients/{patientId}/consents";
const DPOA = "/api/v1/patients/{patientId}/dpoa/active-primary";
const SERIES = "/api/v1/patients/{patientId}/scales/{scaleType}/series";
const ASSESSMENTS = "/api/v1/patients/{patientId}/assessments";
const CHANGES = "/api/v1/patients/{patientId}/significant-changes";

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
  // A reply may be a function so a test can answer the first call and the retry differently.
  const get = vi.fn((path: string) => {
    const reply = replies[path];
    return Promise.resolve(typeof reply === "function" ? reply() : (reply ?? ok({})));
  });
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

describe("Clinical tab read states", () => {
  it("shows loading while the reads are pending", async () => {
    mount(base);
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    await screen.findByText(NO_DIRECTIVES);
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
    await screen.findByText(/advance directives/, { selector: "p" });
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/advance directives/);
  });

  it.each([
    ["consents", CONSENTS],
    ["DPOA", DPOA],
  ])("treats a 403 on %s as denied", async (_n, path) => {
    mount({ ...base, [path]: fail(403) });
    await waitFor(() => expect(screen.getAllByRole("status").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each([
    ["consents", CONSENTS, ok({ data: [] })],
    ["DPOA", DPOA, ok({ data: null })],
  ])("shows a failed %s read with retry, which recovers", async (_n, path, good) => {
    let calls = 0;
    const get = mount({ ...base, [path]: () => (++calls === 1 ? fail(500) : good) });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(NO_DIRECTIVES)).toBeNull();
    fireEvent.click(retry);
    await screen.findByText(NO_DIRECTIVES);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(get.mock.calls.filter(([p]) => p === path)).toHaveLength(2);
  });

  it("prefers a retryable failure over a denial in the advance-directives notice", async () => {
    mount({ ...base, [CONSENTS]: fail(404), [DPOA]: fail(500) });
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Advance directives could not be loaded/)).toBeTruthy();
  });

  it.each([
    [
      "significant changes",
      CHANGES,
      /Significant-change alerts could not be loaded/,
      /No open significant-change alerts|^No open changes$/,
    ],
    [
      "ESAS assessments",
      ASSESSMENTS,
      /Symptom (assessments|scores) could not be loaded/,
      /No ESAS-r symptom assessment/,
    ],
    [
      "PPS series",
      SERIES,
      /The PPS trend could not be loaded/,
      /No PPS captured in the last 30 days/,
    ],
  ])("shows a failed %s read as failed, never as empty", async (_n, path, failed, empty) => {
    mount({ ...base, [path]: fail(500) });
    await screen.findAllByText(failed);
    expect(screen.queryByText(empty)).toBeNull();
  });

  it("shows a denied significant-changes read without the green no-changes pill", async () => {
    mount({ ...base, [CHANGES]: fail(403) });
    await screen.findByText("Changes unavailable");
    expect(screen.queryByText("No open changes")).toBeNull();
  });

  it("shows no open changes only when the read succeeded empty", async () => {
    mount({ ...base, [CHANGES]: ok({ events: [] }) });
    await screen.findByText("No open changes");
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
      expect(screen.getByRole("status").textContent).toMatch(/performance status/),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows PPS 500 as failed with retry", async () => {
    mount({ ...base, [PPS]: fail(500) });
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Performance status could not be loaded/)).toBeTruthy();
  });

  it("keeps keyboard focus off <body> after Retry succeeds", async () => {
    let calls = 0;
    mount({
      ...base,
      [PPS]: () => {
        calls += 1;
        return calls === 1 ? fail(500) : base[PPS];
      },
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
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

  it("does not let a previous patient's late response land on the next patient", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const get = vi.fn((path: string) =>
      path === CONSENTS
        ? new Promise((resolve) => resolvers.push(resolve))
        : Promise.resolve(base[path as never] ?? ok({})),
    );
    const Switcher = ({ id }: { id: string }) => {
      const clinical = useClinicalData(id, chart, true);
      return <ClinicalRail patient={patient} data={chart} clinical={clinical} />;
    };
    const tree = (id: string) => (
      <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
        <MemoryRouter>
          <Switcher key={id} id={id} />
        </MemoryRouter>
      </ApiClientProvider>
    );
    const { rerender } = render(tree("p1"));
    rerender(tree("p2"));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    // p1's consents reply arrives late with an active directive; p2 is still loading.
    await act(async () => {
      resolvers[0]?.(
        ok({ data: [{ id: "c", typeKey: "advance_directive_acknowledgment", status: "active" }] }),
      );
    });
    expect(screen.queryByText("Advance directive on file")).toBeNull();
    // Positive control: the current patient's own reply does render.
    await act(async () => {
      resolvers[1]?.(
        ok({ data: [{ id: "c2", typeKey: "advance_directive_acknowledgment", status: "active" }] }),
      );
    });
    expect(await screen.findByText("Advance directive on file")).toBeTruthy();
  });
});
