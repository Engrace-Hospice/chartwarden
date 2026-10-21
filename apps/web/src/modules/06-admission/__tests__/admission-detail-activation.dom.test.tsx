// @vitest-environment jsdom
// A US zone BEFORE any Date is built: date-only values must not slip a day (UTC-midnight parse).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { act, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionDetail } from "../admission-detail";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["admission.read", "admission.update"],
};
const admissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const windowId = "7d1e5b22-9c3a-4f10-8a6b-1c2d3e4f5a6b";
const referralId = "c0ffee00-1234-4abc-8def-0123456789ab";
const periodId = "3f9c2a10-7b1e-4c55-9d2e-0a1b2c3d4e5f";

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

/**
 * `statuses` is the sequence of patient statuses GET /patients/:id returns (last one repeats); the
 * sentinel "throw" makes that read reject (the first read is the page load and must not throw).
 */
function clientFor(
  statuses: string[],
  admissionState = "active",
): { client: ApiClient; patientReads: () => number } {
  let reads = 0;
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/admissions/{id}")
        return ok({
          id: admissionId,
          state: admissionState,
          status: admissionState,
          version: 6,
          patientId: "patient-1",
          referralId,
          admissionAt: "2026-08-28T10:00:00.000Z",
          activatedAt: "2026-08-28T10:00:00.000Z",
          activationGate: { ready: true, missing: [] },
        });
      if (path === "/api/v1/admissions/{id}/readiness")
        return ok({
          admissionId,
          status: "ready",
          canActivate: false,
          completed: 7,
          blockingRemaining: 0,
          requirements: [],
        });
      if (path === "/api/v1/admissions/{id}/election-periods")
        return ok({
          items: [
            {
              id: periodId,
              state: "active",
              version: 1,
              sequenceNumber: 1,
              effectiveAt: "2026-08-28",
              scheduledEndAt: "2026-11-25",
            },
          ],
        });
      if (path === "/api/v1/admissions/{id}/compliance-windows")
        return ok({
          items: [
            {
              id: windowId,
              state: "open",
              version: 1,
              windowKind: "f2f_recert",
              dueAt: "2026-12-03T20:00:00.000Z",
            },
          ],
        });
      if (path === "/api/v1/patients/{id}") {
        const status = statuses[Math.min(reads, statuses.length - 1)];
        reads += 1;
        if (status === "throw") throw new Error("network down");
        return ok({
          id: "patient-1",
          mrn: "MRN-1001",
          lastName: "Rivera",
          firstName: "Elena",
          dob: "1946-04-12",
          status,
        });
      }
      if (path === "/api/v1/admissions/{admissionId}/hope") return { data: null };
      if (path === "/api/v1/patients/{patientId}/election-certification")
        return ok({ admission: null, periods: [] });
      if (path === "/api/v1/patients/{id}/addresses") return ok({ addresses: [] });
      return ok({ items: [] });
    }),
    POST: vi.fn(),
    PATCH: vi.fn(),
  } as unknown as ApiClient;
  return { client, patientReads: () => reads };
}

function renderPage(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={[`/admissions/${admissionId}`]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/admissions/:id" element={<AdmissionDetail />} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.useRealTimers());

/** Advance fake time one second at a time so each re-render can schedule the next poll. */
async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
}

describe("Admission detail right after activation", () => {
  it("never shows a lagging patient 'Prospective' next to an active admission, then refreshes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, patientReads } = clientFor(["prospective", "active"]);
    renderPage(client);

    await waitFor(() => expect(screen.getAllByText(/MRN/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Prospective/i)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // The poll re-read the patient and got the SECOND response ("active"): only a real promoted status
    // (not the derived display) raises the screen-reader announcement.
    expect(patientReads()).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText("Patient record is now active.")).toBeTruthy();
    expect(screen.getAllByText(/\bActive\b/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Prospective/i)).toBeNull();
  });

  it("does not poll for a pending admission and still shows the patient as Prospective", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, patientReads } = clientFor(["prospective", "active"], "pending");
    renderPage(client);
    await waitFor(() => expect(screen.getAllByText(/Rivera/).length).toBeGreaterThan(0));

    await tick(10);
    expect(patientReads()).toBe(1);
    expect(screen.queryByText("Patient record is now active.")).toBeNull();
  });

  it("survives a re-read that throws: no unhandled rejection, polling stays bounded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { client, patientReads } = clientFor(["prospective", "throw"]);
    renderPage(client);
    await waitFor(() => expect(patientReads()).toBeGreaterThanOrEqual(1));

    await tick(60);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    // The failed attempts still spend the budget: 1 load + at most 5 polls, then it stops.
    expect(patientReads()).toBeGreaterThan(1);
    expect(patientReads()).toBeLessThanOrEqual(6);
    expect(screen.queryByText(/Prospective/i)).toBeNull();
  });

  it("stops polling the patient after a bounded number of attempts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, patientReads } = clientFor(["prospective"]);
    renderPage(client);
    await waitFor(() => expect(patientReads()).toBeGreaterThanOrEqual(1));
    const afterLoad = patientReads();

    await tick(60);
    const settled = patientReads();
    expect(settled).toBeGreaterThan(afterLoad);
    expect(settled - afterLoad).toBeLessThanOrEqual(5);
    await tick(60);
    expect(patientReads()).toBe(settled);
    expect(screen.queryByText(/Prospective/i)).toBeNull();
  });

  it("shows election-period rows without an id and with the stored calendar dates", async () => {
    const { client } = clientFor(["active"]);
    renderPage(client);

    await waitFor(() => expect(screen.getByText(/Period 1/)).toBeTruthy());
    expect(screen.queryByText(periodId)).toBeNull();
    expect(screen.queryByText(periodId.slice(0, 8), { exact: false })).toBeNull();
    // 2026-08-28 stays Aug 28 (not Aug 27) and the 1946-04-12 DOB stays Apr 12 in Los Angeles.
    expect(screen.getByText(/Aug 28, 2026/)).toBeTruthy();
    expect(screen.getByText(/Nov 25, 2026/)).toBeTruthy();
    expect(screen.getByText(/DOB Apr 12, 1946/)).toBeTruthy();
  });

  it("shows compliance windows by kind and due date, and the header never prints ids", async () => {
    const { client } = clientFor(["active"]);
    renderPage(client);

    await waitFor(() => expect(screen.getAllByText(/F2f Recert/i)).toBeTruthy());
    expect(screen.getAllByText(/due Dec 3, 2026/).length).toBeGreaterThan(0);
    // Only the two deliberate "Admission ID" fields print the admission UUID, not the page subtitle.
    expect(screen.getAllByText(admissionId, { exact: false })).toHaveLength(2);
    expect(screen.queryByText(windowId, { exact: false })).toBeNull();
    expect(screen.queryByText(windowId.slice(0, 8), { exact: false })).toBeNull();
    expect(screen.queryByText(referralId.slice(0, 8), { exact: false })).toBeNull();
  });

  it("labels the pending-admission referral with a link, never the id", async () => {
    const { client } = clientFor(["prospective"], "pending");
    renderPage(client);

    await waitFor(() => expect(screen.getAllByText(/Referral/).length).toBeGreaterThan(0));
    expect(screen.queryByText(referralId, { exact: false })).toBeNull();
    expect(screen.queryByText(referralId.slice(0, 8), { exact: false })).toBeNull();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`/referrals/${referralId}`);
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
