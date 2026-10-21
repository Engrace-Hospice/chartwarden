// apps/web/src/modules/05-patient — the Privacy Officer screens (M5 §5.1 "Privacy flags", §4.2 resync):
// the per-patient view renders the SERVER's restrictions/origin/consent state/WardenLens packets (with a
// link to the intake review, never a confirm/reject control), re-syncs and reports the change; the queue
// filters by origin through the query string.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { PatientPrivacy, type PatientPrivacyView } from "./patient-privacy";
import { PrivacyQueue } from "./privacy-queue";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BATCH = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const VIEW: PatientPrivacyView = {
  patient: { id: PATIENT, displayName: "Vance, Ada", mrn: "MRN-77", status: "active" },
  snapshot: {
    exists: true,
    flags: ["sud"],
    capturedAt: "2026-10-03T12:00:00.000Z",
    stale: false,
    invalidatedAt: null,
    sourceConsentVersion: null,
  },
  restrictions: [
    {
      flag: "sud",
      origin: "intake_unconfirmed",
      since: "2026-10-03T12:00:00.000Z",
      sinceFromHistory: true,
    },
  ],
  part2Consent: {
    state: "none",
    consentRecordId: null,
    status: null,
    effectiveAt: null,
    expiresAt: null,
    revokedAt: null,
  },
  intakeDetections: [
    {
      batchId: BATCH,
      sudStatus: "detected",
      batchStatus: "in_review",
      receivedAt: "2026-10-03T11:00:00.000Z",
      pageCount: 12,
      resolvedAt: null,
      contributes: true,
    },
  ],
  history: [
    {
      at: "2026-10-03T12:00:00.000Z",
      actorUserId: null,
      action: "insert",
      flagsBefore: [],
      flagsAfter: ["sud"],
      sudOriginAfter: "m22_intake_unconfirmed",
    },
  ],
  drift: [],
};

let calls: { method: string; path: string; search: string }[] = [];
let resyncChanged = false;
let viewStatus = 200;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  calls.push({ method: req.method, path: url.pathname, search: url.search });
  let body: unknown = {};
  let status = 200;
  if (url.pathname === `/api/v1/patients/${PATIENT}/privacy`) {
    status = viewStatus;
    body = status === 200 ? VIEW : { error: { code: "NOT_FOUND", message: "patient not found" } };
  } else if (url.pathname.endsWith("/privacy-flags/resync")) {
    body = {
      patientId: PATIENT,
      flagsBefore: ["sud"],
      flagsAfter: resyncChanged ? [] : ["sud"],
      sudOriginAfter: null,
      sourceConsentVersion: null,
      flagsChanged: resyncChanged,
      eventEmitted: resyncChanged,
      capturedAt: "2026-10-04T00:00:00.000Z",
    };
  } else if (url.pathname === "/api/v1/privacy/restricted-patients") {
    body = {
      items: [
        {
          patientId: PATIENT,
          displayName: "Vance, Ada",
          mrn: "MRN-77",
          flags: ["sud"],
          origin: "intake_unconfirmed",
          capturedAt: "2026-10-03T12:00:00.000Z",
          stale: false,
        },
      ],
      nextCursor: null,
      counts: {
        total: 3,
        consent: 1,
        intake_unconfirmed: 1,
        intake_confirmed: 0,
        unattributed: 1,
        stale: 0,
      },
    };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount(path: string) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/patients/:id/privacy" element={<PatientPrivacy />} />
          <Route path="/compliance/privacy" element={<PrivacyQueue />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  resyncChanged = false;
  viewStatus = 200;
});

describe("Privacy Officer — patient view", () => {
  it("shows restriction origin, consent state and the WardenLens packet with a link to the intake review", async () => {
    mount(`/patients/${PATIENT}/privacy`);
    const restrictions = await screen.findByRole("region", { name: "Restrictions" });
    expect(within(restrictions).getByText("Substance use (42 CFR Part 2)")).toBeTruthy();
    expect(within(restrictions).getByText("WardenLens detection — unreviewed")).toBeTruthy();
    expect(screen.getByText("No Part 2 release on file")).toBeTruthy();
    const packets = screen.getByRole("region", { name: "WardenLens detections" });
    expect(within(packets).getByText("Unreviewed")).toBeTruthy();
    expect(within(packets).getByText("12")).toBeTruthy();
    const link = within(packets).getByRole("link", { name: "Open intake review" });
    expect(link.getAttribute("href")).toBe(`/intake/${BATCH}/review`);
    // The officer cannot confirm/reject a detection here — that is the licensed reviewer's act.
    expect(screen.queryByRole("button", { name: /confirm|reject/i })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Who can clear what" })).getByText(
        /Only a licensed reviewer/,
      ),
    ).toBeTruthy();
  });

  it("re-syncs from consents and reports the change", async () => {
    resyncChanged = true;
    mount(`/patients/${PATIENT}/privacy`);
    fireEvent.click(await screen.findByRole("button", { name: "Re-sync from consents" }));
    expect(await screen.findByText(/Substance use \(42 CFR Part 2\) → none/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/privacy-flags/resync"))).toBe(
      true,
    );
    // The view is re-read after the resync.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === `/api/v1/patients/${PATIENT}/privacy`)).toHaveLength(2),
    );
  });

  it("says when a resync changed nothing", async () => {
    mount(`/patients/${PATIENT}/privacy`);
    fireEvent.click(await screen.findByRole("button", { name: "Re-sync from consents" }));
    expect(await screen.findByText(/No change to the restrictions/)).toBeTruthy();
  });

  it("a 404 reads as not found, not as an error", async () => {
    viewStatus = 404;
    mount(`/patients/${PATIENT}/privacy`);
    expect(await screen.findByText("Patient not found")).toBeTruthy();
  });
});

describe("Privacy Officer — restricted-patients queue", () => {
  it("lists patients with links to their privacy view and filters by origin", async () => {
    mount("/compliance/privacy");
    const link = await screen.findByRole("link", { name: "Vance, Ada" });
    expect(link.getAttribute("href")).toBe(`/patients/${PATIENT}/privacy`);
    fireEvent.click(screen.getByText("Unreviewed WardenLens detection"));
    await waitFor(() =>
      expect(calls.some((c) => c.search === "?origin=intake_unconfirmed")).toBe(true),
    );
  });
});
