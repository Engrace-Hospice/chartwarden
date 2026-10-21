// apps/web/src/modules/09-assessments — #91: a clinician could read a PPS timeline and not record a PPS.
//
// Six read screens, zero mutations. The scales are the hospice evidence base: PPS/KPS anchor the
// prognosis a recertification rests on, ESAS-r is the symptom record the plan of care is revised
// against, and the significant-change events derived from them are what the IDG reviews. The
// Significant-Change Inbox is a queue whose one action — acknowledge — it did not offer, so a detected
// decline sat unacknowledged forever and the escalation that keys off acknowledgement never stopped.
//
// The net asserts on RECORDED FETCH CALLS. The most important assertions are about where the FORM comes
// from: every field is rendered from `GET /api/v1/scales` (F-067), so a test that drives PPS's five
// ordinal axes without this file naming any of them is the proof that the definitions are the server's.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AssessmentTimeline } from "./assessment-timeline";
import { SignificantChangeInbox } from "./significant-change-inbox";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EVENT = "cccccccc-3333-4333-8333-cccccccccccc";

let admissions: Record<string, unknown>[] = [
  { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
];
let changeStatus = "open";

/** The catalog exactly as the server publishes it: one recordable scale, one that is not. */
const catalog = {
  scales: [
    {
      scaleType: "pps",
      label: "PPS — Palliative Performance Scale",
      family: "performance",
      licenseRequired: false,
      recordable: true,
      scoreRange: [0, 100],
      items: [
        {
          key: "ambulation",
          label: "Ambulation",
          kind: "choice",
          required: true,
          options: [
            { value: "full", label: "Full" },
            { value: "reduced", label: "Reduced" },
          ],
        },
        { key: "notes", label: "Notes", kind: "text", required: false },
      ],
    },
    {
      scaleType: "esas_r",
      label: "ESAS-r — Edmonton Symptom Assessment System (revised)",
      family: "symptoms",
      licenseRequired: false,
      recordable: true,
      scoreRange: [0, 90],
      items: [{ key: "pain", label: "Pain", kind: "number", required: true, min: 0, max: 10 }],
    },
    {
      // One of the ten with no scorer — capture would raise SCALE_SCORER_UNAVAILABLE, a 500.
      scaleType: "braden",
      label: "Braden — Pressure Injury Risk",
      family: "risk",
      licenseRequired: false,
      recordable: false,
      scoreRange: null,
      items: null,
    },
    {
      scaleType: "aims",
      label: "AIMS — Abnormal Involuntary Movement Scale",
      family: "cognitive",
      licenseRequired: true,
      recordable: false,
      scoreRange: null,
      items: null,
    },
  ],
};

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let writeFailure: { status: number; body: unknown } | null = null;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path === "/api/v1/scales") return catalog;
    if (path.endsWith("/admissions")) return { items: admissions };
    if (path.endsWith("/significant-changes"))
      return {
        events: [{ id: EVENT, ruleId: "pps_drop_20", severity: "high", status: changeStatus }],
      };
    if (path.endsWith("/assessments")) return { assessments: [] };
    if (path.startsWith("/api/v1/patients/"))
      return {
        id: PATIENT,
        organizationId: "org-1",
        mrn: "MRN-1",
        lastName: "Vance",
        firstName: "Ada",
        dob: "1948-03-02",
        status: "active",
      };
  }
  return { id: "assessment-1", patientId: PATIENT, scaleType: "pps", score: 60 };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M9 write sends JSON; recording nothing is honest if one ever does not.
      }
    }
    if (writeFailure) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, element: JSX.Element, route: string): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="*" element={<div>navigated</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const mountTimeline = () =>
  mount(
    `/patients/${PATIENT}/assessments`,
    <AssessmentTimeline />,
    "/patients/:patientId/assessments",
  );
const mountInbox = () =>
  mount(
    `/patients/${PATIENT}/assessments/changes`,
    <SignificantChangeInbox />,
    "/patients/:patientId/assessments/changes",
  );

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  changeStatus = "open";
  admissions = [
    { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
  ];
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — a scale can be recorded", () => {
  it("the form is rendered from the SERVER's item definitions, not from a copy in the client", async () => {
    mountTimeline();
    await waitFor(() => expect(calls).toContain("GET /api/v1/scales"));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Record assessment" })));
    // Nothing in this test file's component under test names "Ambulation" — it comes from the catalog.
    const field = (await waitFor(() => screen.getByLabelText("Ambulation"))) as HTMLSelectElement;
    expect([...field.options].map((o) => o.value)).toEqual(["", "full", "reduced"]);
  });

  it("only RECORDABLE scales are offered — the other ten raise a 500 on capture", async () => {
    mountTimeline();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Record assessment" })));
    const picker = (await waitFor(() => screen.getByLabelText("Scale"))) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["pps", "esas_r"]);
    // `braden` and `aims` are in the route's own scaleType enum and would reach
    // SCALE_SCORER_UNAVAILABLE — the picker is what keeps a clinician out of that path.
    expect([...picker.options].map((o) => o.value)).not.toContain("braden");
  });

  it("a capture POSTs the item keys as `data`, typed by the definition's kind", async () => {
    mountTimeline();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Record assessment" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Ambulation")), {
      target: { value: "reduced" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Steadier today." } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/patients/${PATIENT}/assessments`));
    expect(bodies[0]?.scaleType).toBe("pps");
    expect(bodies[0]?.admissionId).toBe(ADMISSION);
    expect(bodies[0]?.data).toEqual({ ambulation: "reduced", notes: "Steadier today." });
    // D6 — no score is sent. The server computes it and ignores anything the client claims.
    expect(bodies[0]).not.toHaveProperty("score");
  });

  it("a number item is sent as a NUMBER, because the scorer sums it", async () => {
    mountTimeline();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Record assessment" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Scale")), {
      target: { value: "esas_r" },
    });
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Pain/)), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/patients/${PATIENT}/assessments`));
    expect((bodies[0]?.data as Record<string, unknown>).pain).toBe(7);
  });

  it("Record is absent when the patient has no open admission (F-065)", async () => {
    admissions = [];
    mountTimeline();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/admissions`));
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
  });

  it("a SCALE_SCORER_UNAVAILABLE reads as 'not built yet', never as a server fault", async () => {
    // It IS a 500. A clinician shown a bare error retries a capture that can never succeed.
    writeFailure = {
      status: 500,
      body: { error: { code: "SCALE_SCORER_UNAVAILABLE", message: "no scorer" } },
    };
    mountTimeline();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Record assessment" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText("Ambulation")), {
      target: { value: "full" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was saved/i);
  });
});

describe("#91 — the significant-change inbox can be acted on", () => {
  it("Acknowledge POSTs against the event the detector raised", async () => {
    mountInbox();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Acknowledge" })));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/significant-changes/${EVENT}/acknowledge`),
    );
    expect(await screen.findByText("Acknowledged.")).toBeTruthy();
  });

  it("an already-acknowledged change offers nothing — the event row is kept either way", async () => {
    changeStatus = "acknowledged";
    mountInbox();
    await waitFor(() => expect(calls.some((c) => c.includes("significant-changes"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});
