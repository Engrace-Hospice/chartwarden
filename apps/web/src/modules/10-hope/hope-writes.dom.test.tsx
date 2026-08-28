// apps/web/src/modules/10-hope — #91: the M10 write controls must not be inert.
//
// Before this change `apps/web/src/modules/10-hope` issued ZERO mutations — 2701 lines across seven
// screens, every one a read. HOPE is the CMS-mandated HQRP instrument every Medicare-certified hospice
// must submit; the module could display a timepoint window closing in six hours and offered no way to
// record the timepoint that closes it, and the SFV worklist — a queue whose reason to exist is
// completing the follow-up — offered no way to complete one.
//
// Nothing in the repo's gate set can see that. `ui:parity` proves a screen is registered with a
// resolvable permission, `docs:ui` proves the spec corpus is consistent, `openapi:coverage` proves a
// ROUTE carries a contract — none inspects whether a control does anything. So the net is a DOM test
// that CLICKS the control and asserts the request went out, on RECORDED FETCH CALLS rather than a spy
// over the api client: a mocked client would still pass if a button were re-wired to a handler that
// never issues the request, which is the exact failure being fixed. (Same shape as
// `11-orders/orders-writes.dom.test.tsx` and `13-emar/emar-writes.dom.test.tsx`.)
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { HopeAssessmentDetail } from "./hope-assessment-detail";
import { HopeDashboard } from "./hope-dashboard";
import { PatientHopeTimeline } from "./patient-hope-timeline";
import { SfvWorklist } from "./sfv-worklist";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCHEDULE = "cccccccc-3333-4333-8333-cccccccccccc";
const ASSESSMENT = "dddddddd-4444-4444-8444-dddddddddddd";
const SFV = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

/** An OPEN window, comfortably inside its span, so no late-completion branch is armed by default. */
const scheduleRow = {
  id: SCHEDULE,
  patientId: PATIENT,
  admissionId: ADMISSION,
  rfaKind: "02_huv1",
  status: "open",
  windowOpensAt: "2000-01-01T00:00:00.000Z",
  windowClosesAt: "2999-01-01T00:00:00.000Z",
  lateDeadlineAt: "2999-02-01T00:00:00.000Z",
  generatedBy: "system",
  completedByAssessmentId: null as string | null,
};

const sfvRow = {
  id: SFV,
  patientId: PATIENT,
  admissionId: ADMISSION,
  triggeringAssessmentId: ASSESSMENT,
  status: "open",
  triggeredAt: "2026-08-20T10:00:00.000Z",
  dueAt: "2999-01-01T00:00:00.000Z",
  completingAssessmentId: null as string | null,
};

const assessmentRow = {
  id: ASSESSMENT,
  patientId: PATIENT,
  admissionId: ADMISSION,
  rfaKind: "01_admission",
  status: "draft",
  targetDate: "2026-08-20T10:00:00.000Z",
  // The read projection carries NO author discipline — `hope_assessment` has no such column, so the
  // server sends `""` on every row (`hope-route-service-db.ts`). The fixture said `"rn"`, which is what
  // let the correction path pass a value the route then refused (F-074).
  authorDiscipline: "",
  j2051MaxSeverity: null as string | null,
  j2051TriggerFired: false,
  wasLate: false,
  signedAt: null as string | null,
  signedBy: null as string | null,
  correctsAssessmentId: null as string | null,
  supersededByAssessmentId: null as string | null,
  snapshot: null as Record<string, number | null> | null,
  version: 1,
};

/** Overridden per test to put the row in the state whose control is under examination. */
let detailRow: Record<string, unknown> = { ...assessmentRow };
let scheduleStatus = "open";

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
/** The body of the Nth non-GET call, asserted non-empty by the `writes()` expectation above it. */
const sentBody = (n = 0): Record<string, unknown> => bodies[n] as Record<string, unknown>;
/** The api client captures `stubFetch` at construction, so a re-stubbed global never reaches it. */
let writeFailure: { status: number; body: unknown } | null = null;

// openapi-fetch calls `fetch(new Request(url, init))` — the method rides on the Request, NOT on a
// separate `init`, so reading `init.method` alone records every call as a GET.
function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method !== "GET") return { ...assessmentRow, status: "signed" };
  if (path === "/api/v1/hope/schedules")
    return { schedules: [{ ...scheduleRow, status: scheduleStatus }] };
  if (path === "/api/v1/hope/sfv") return { sfvs: [sfvRow] };
  if (path.endsWith("/validation")) return { assessmentId: ASSESSMENT, findings: [] };
  if (path.endsWith("/hope/assessments")) return { assessments: [detailRow] };
  if (path.startsWith("/api/v1/hope/assessments/")) return detailRow;
  if (path.startsWith("/api/v1/patients/"))
    return {
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    };
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const raw =
      typeof input === "object" && "clone" in input
        ? await (input as Request).clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // No M10 write sends a non-JSON body; recording nothing is the honest answer.
      }
    }
  }
  if (method !== "GET" && writeFailure) {
    return new Response(JSON.stringify(writeFailure.body), {
      status: writeFailure.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** An RN session — ONE author role, so the modal needs no discipline prompt to be submittable. */
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, pattern: string, element: JSX.Element, session = SESSION) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  scheduleStatus = "open";
  detailRow = { ...assessmentRow };
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — the timepoint worklist can record and skip the window it displays", () => {
  it("Record on an open window POSTs the capture, pinned to that schedule and its RFA", async () => {
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record draft" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/admissions/${ADMISSION}/hope/timepoints`),
    );
    const sent = sentBody();
    // The schedule pins BOTH: a payload whose RFA does not match the window is refused server-side.
    expect(sent.scheduleId).toBe(SCHEDULE);
    expect(sent.rfaKind).toBe("02_huv1");
    // F-074 — this asserted `"rn"`, the M3 ROLE KEY, against a stub that 200s any non-GET. The route
    // schema is `Union([Literal("RN"), Literal("NP"), Literal("MD")])`, so the real server answered 422
    // `authorDiscipline: Expected union value` for every capture the UI has ever sent. A mocked write
    // path can only prove the client is self-consistent; this line is the one that has to name the
    // CONTRACT, which is why the e2e spec (`e2e/specs/hope.spec.ts`) exists beside it.
    expect(sent.authorDiscipline).toBe("RN");
  });

  it("Skip POSTs the route-3 ceremony with the reason code the server records", async () => {
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Skip window" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Skip window" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/hope/schedules/${SCHEDULE}/skip`));
    expect(typeof sentBody().reasonCode).toBe("string");
    expect((sentBody().reasonCode as string).length).toBeGreaterThan(0);
  });

  it("a terminal window offers neither control — the server refuses both (F-007)", async () => {
    scheduleStatus = "completed";
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(calls.some((c) => c.startsWith("GET"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});

describe("#91 — the SFV queue can complete the follow-up it lists", () => {
  it("Record POSTs to the SFV route, naming the obligation it completes", async () => {
    mount("/hope/sfv", "/hope/sfv", <SfvWorklist />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record follow-up" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record follow-up" }));
    // A DIFFERENT endpoint from the timepoint capture — it matches the OPEN obligation rather than
    // creating a free-standing RFA-04, and carries its own RN/NP author floor.
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/admissions/${ADMISSION}/hope/sfv`),
    );
    expect(sentBody().triggeringAssessmentId).toBe(ASSESSMENT);
  });
});

describe("#91 — the assessment detail can sign, correct and request its summary", () => {
  it("Sign POSTs the signature on a DRAFT", async () => {
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Sign" }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/sign`),
    );
    expect(sentBody().attestationConfirmed).toBe(true);
  });

  it("a DRAFT offers no Correct — a correction supersedes a SIGNED row (D7)", async () => {
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
  });

  it("a SIGNED row offers Correct and POSTs the append-only correction", async () => {
    detailRow = { ...assessmentRow, status: "signed", signedAt: "2026-08-21T10:00:00.000Z" };
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Correct" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const input = await waitFor(() => screen.getByLabelText(/Correction reason/i));
    fireEvent.change(input, { target: { value: "transcription error in Section J" } });
    fireEvent.click(screen.getByRole("button", { name: "Record correction" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/correct`),
    );
    expect(sentBody().correctionReason).toBe("transcription error in Section J");
  });

  it("Request summary POSTs the out-of-band render request", async () => {
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request summary" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Request summary" }));
    // The footer button and the modal's submit share a label; the SECOND is the one that commits.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Request summary" }).length).toBe(2),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Request summary" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/summary-pdf`),
    );
  });
});

describe("#91 — the patient timeline can record and recompute", () => {
  it("Record timepoint POSTs an unscheduled capture against the patient's admission", async () => {
    mount(`/patients/${PATIENT}/hope`, "/patients/:patientId/hope", <PatientHopeTimeline />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record timepoint" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record timepoint" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record draft" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/admissions/${ADMISSION}/hope/timepoints`),
    );
    // No window pins it, so no scheduleId is sent — the server treats it as an unscheduled capture.
    expect(sentBody().scheduleId).toBeUndefined();
  });

  it("Recompute schedules POSTs the §4.1 route-20 admin write", async () => {
    mount(`/patients/${PATIENT}/hope`, "/patients/:patientId/hope", <PatientHopeTimeline />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Recompute schedules" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recompute schedules" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Recompute" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/hope/admin/regenerate-schedules"));
    expect(sentBody().admissionId).toBe(ADMISSION);
  });
});

describe("#91 — a refusal is rendered, not swallowed", () => {
  it("a 403 on the capture leaves the modal open and shows the server's own message", async () => {
    writeFailure = {
      status: 403,
      body: {
        message: "Author discipline not permitted for this RFA (hope.authorDisciplineAllowed).",
      },
    };
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record draft" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record draft" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    // Surfaced VERBATIM: M10's 4xx family carries precise codes, and any sentence this layer
    // substituted would be strictly less useful than the server's own.
    expect(alert.textContent).toContain("hope.authorDisciplineAllowed");
    expect(screen.getByRole("button", { name: "Record draft" })).toBeTruthy();
  });
});

describe("#91 — the J2051 trigger preview is informational, never blocking", () => {
  it("a moderate symptom warns that a follow-up will be created and still allows the capture", async () => {
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    const pain = await waitFor(() => screen.getByLabelText("Pain"));
    fireEvent.change(pain, { target: { value: "moderate" } });
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toContain("2 calendar days");
    // The clinician records what is clinically true; the SFV is the consequence, not a veto (D4).
    const submit = screen.getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/admissions/${ADMISSION}/hope/timepoints`),
    );
    const j = sentBody().data as { J?: { J2051?: { entries?: { symptomCode: string }[] } } };
    expect(j.J?.J2051?.entries?.[0]?.symptomCode).toBe("pain");
  });
});
