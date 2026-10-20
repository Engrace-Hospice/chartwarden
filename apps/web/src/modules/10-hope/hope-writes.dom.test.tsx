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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A one-section workspace whose only item is answered — enough for the header controls to render. */
function workspaceBody(): Record<string, unknown> {
  return {
    assessment: {
      id: ASSESSMENT,
      status: detailRow.status,
      rfaKind: detailRow.rfaKind,
      targetDate: detailRow.targetDate,
      isc: "HA",
      specVersionId: "spec-1",
      specVersion: "1.00.1",
      version: detailRow.version,
    },
    sections: [
      {
        code: "A",
        label: "Administrative",
        items: [
          {
            itemCode: "A0500A",
            label: "First name",
            section: "A",
            group: null,
            kind: "assessment",
            active: true,
            state: "answered",
            value: "Ada",
            source: "patient_prefill",
            answeredAt: null,
            answeredByMembershipId: null,
            applicability: "applicable",
            skipReason: null,
            options: [],
          },
        ],
      },
    ],
    progress: {
      active: 1,
      applicable: 1,
      notApplicable: 0,
      pending: 0,
      answered: 1,
      skipped: 0,
      unanswered: 0,
    },
  };
}

/** Server readiness: nothing blocks, so a DRAFT offers "Sign & complete". */
function reviewBody(): Record<string, unknown> {
  return {
    assessmentId: ASSESSMENT,
    version: detailRow.version,
    specVersion: "1.00.1",
    isc: "HA",
    status: detailRow.status,
    signedAt: detailRow.signedAt,
    signedByMembershipId: null,
    z0500b: null,
    sections: [
      {
        code: "A",
        active: 1,
        applicable: 1,
        answered: 1,
        skipped: 0,
        pending: 0,
        unanswered: 0,
        errors: 0,
        warnings: 0,
        state: "complete",
      },
    ],
    progress: { active: 1, applicable: 1, answered: 1, skipped: 0, pending: 0, unanswered: 0 },
    validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
    sfv: { required: null },
    readiness: { readyToSign: true, blockers: [] },
  };
}

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
  // The admission/HUV/discharge detail is the CMS item WORKSPACE (#235): it reads `/workspace` and
  // `/review` beside the row, and signs/corrects/requests the summary from that surface.
  if (path.endsWith("/workspace")) return workspaceBody();
  if (path.endsWith("/review")) return reviewBody();
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
  // Sign and correct live in the assessment workspace (hope-assessment-detail.tsx), which pins every
  // write to the version it read (`ifVersion`) — not in `HopeActionModal`, which only skips,
  // regenerates and requests summaries from the queues.
  const detail = () =>
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);

  it("Sign POSTs the signature on a DRAFT, pinned to the version it read", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    detail();
    const open = await screen.findAllByRole("button", { name: "Sign & complete" });
    fireEvent.click(open[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/sign`),
    );
    expect(sentBody().ifVersion).toBe(3);
  });

  it("a DRAFT offers no correction — a correction supersedes a SIGNED row (D7)", async () => {
    detail();
    await screen.findAllByRole("button", { name: "Sign & complete" });
    expect(screen.queryByRole("button", { name: "Create correction" })).toBeNull();
  });

  it("a SIGNED row offers a correction and POSTs the append-only correction", async () => {
    detailRow = {
      ...assessmentRow,
      status: "signed",
      signedAt: "2026-08-21T10:00:00.000Z",
      version: 2,
    };
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("transcription error in Section J");
    try {
      detail();
      const correct = await screen.findAllByRole("button", { name: "Create correction" });
      expect(screen.queryByRole("button", { name: "Sign & complete" })).toBeNull();
      fireEvent.click(correct[0] as HTMLElement);
      await waitFor(() =>
        expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/correct`),
      );
      expect(prompt).toHaveBeenCalled();
      expect(sentBody().correctionReason).toBe("transcription error in Section J");
      expect(sentBody().ifVersion).toBe(2);
      // F-074 — the read projection carries no author discipline (""), so the client must send a
      // value the route accepts rather than echoing the blank.
      expect(sentBody().authorDiscipline).toBe("RN");
    } finally {
      prompt.mockRestore();
    }
  });

  it("a correction with no reason given sends nothing", async () => {
    detailRow = { ...assessmentRow, status: "signed", signedAt: "2026-08-21T10:00:00.000Z" };
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("   ");
    try {
      detail();
      const correct = await screen.findAllByRole("button", { name: "Create correction" });
      fireEvent.click(correct[0] as HTMLElement);
      await waitFor(() => expect(prompt).toHaveBeenCalled());
      expect(writes()).toEqual([]);
    } finally {
      prompt.mockRestore();
    }
  });

  it("Request summary on a signed record POSTs the out-of-band render request", async () => {
    detailRow = { ...assessmentRow, status: "signed", signedAt: "2026-08-21T10:00:00.000Z" };
    detail();
    fireEvent.click(await screen.findByRole("button", { name: "Request summary" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/summary-pdf`),
    );
    expect(await screen.findByRole("button", { name: "Summary requested" })).toBeTruthy();
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

  it("lists timepoints without an Author column the server can never fill, and counts one correctly", async () => {
    mount(`/patients/${PATIENT}/hope`, "/patients/:patientId/hope", <PatientHopeTimeline />);
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "RFA" })).toBeTruthy());
    expect(screen.queryByRole("columnheader", { name: "Author" })).toBeNull();
    expect(screen.getByText(/^1 timepoint$/)).toBeTruthy();
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
