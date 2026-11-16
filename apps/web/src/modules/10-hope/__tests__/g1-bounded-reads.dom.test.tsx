// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { useSfvOfSignedRecord } from "../hope-sfv-lookup";
import { HqrpComplianceDashboard } from "../hqrp-compliance-dashboard";
import { PatientHopeTimeline } from "../patient-hope-timeline";
import { SfvWorklist } from "../sfv-worklist";

// Group g1: a read nobody answers (a stalled connection rejects nothing) ends in the failed state the screen already has, with
// its Retry, instead of a spinner or a "loading" lookup that never ends. Each request starts under the fake clock.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PATIENT = {
  id: "p-1",
  mrn: "MRN-1",
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1948-03-02",
  status: "active",
};
const never = () => new Promise<never>(() => undefined);
const empty = { data: {}, error: undefined, response: new Response(null, { status: 200 }) };

/** A client whose GET never answers the paths in `stalled` (and answers anything else with an empty body). */
const clientStalling = (...stalled: string[]): ApiClient =>
  ({
    GET: vi.fn((path: string) =>
      stalled.includes(path)
        ? never()
        : Promise.resolve(path === "/api/v1/patients/{id}" ? { ...empty, data: PATIENT } : empty),
    ),
  }) as unknown as ApiClient;

/** Starts the request(s) under the fake clock and lets REQUEST_TIMEOUT_MS pass. */
async function stallThenTimeout(start: () => void): Promise<void> {
  vi.useFakeTimers();
  try {
    start();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

const providers = (client: ApiClient, children: ReactNode, path = "/") => (
  <ApiClientProvider client={client}>
    <SessionProvider
      session={{
        userId: "u",
        organizationId: "o",
        membershipId: "m",
        roles: [],
        permissions: [],
        isAdmin: false,
      }}
    >
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </ToastProvider>
    </SessionProvider>
  </ApiClientProvider>
);

describe("reads that are never answered", () => {
  it("HQRP compliance dashboard ends in the retryable failed state", async () => {
    await stallThenTimeout(() =>
      render(
        providers(clientStalling("/api/v1/hope/dashboard/compliance"), <HqrpComplianceDashboard />),
      ),
    );
    expect(await screen.findByText(/compliance dashboard could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("SFV worklist ends in the retryable failed state", async () => {
    await stallThenTimeout(() =>
      render(providers(clientStalling("/api/v1/hope/sfv"), <SfvWorklist />)),
    );
    expect(await screen.findByText(/symptom follow-up queue could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("patient HOPE timeline ends in its error state with Try again", async () => {
    await stallThenTimeout(() =>
      render(
        providers(
          clientStalling(
            "/api/v1/patients/{patientId}/hope/assessments",
            "/api/v1/patients/{patientId}/admissions",
          ),
          <Routes>
            <Route path="/patients/:patientId" element={<PatientHopeTimeline />} />
          </Routes>,
          "/patients/p-1",
        ),
      ),
    );
    expect(await screen.findByText("Could not load HOPE timeline.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("the signed record's follow-up lookup ends as failed (Retry offered), not loading for good", async () => {
    const client = clientStalling("/api/v1/hope/sfv");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
    vi.useFakeTimers();
    let hook!: ReturnType<typeof renderHook<ReturnType<typeof useSfvOfSignedRecord>, unknown>>;
    try {
      hook = renderHook(() => useSfvOfSignedRecord("a-1", true, 0), { wrapper });
      expect(hook.result.current.lookup).toEqual({ state: "loading" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(hook.result.current.lookup).toEqual({ state: "failed" });
  });
});
