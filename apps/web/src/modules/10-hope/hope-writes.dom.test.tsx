import { HOPE_ATTESTATION_VERSION } from "@chartwarden/types";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
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
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SESSION } from "./__tests__/workspace-test-kit";
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
let sfvStatus = "open";

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
/** The Idempotency-Key of each non-GET call, in order. */
let writeKeys: (string | null)[] = [];
/** The body of the Nth non-GET call, asserted non-empty by the `writes()` expectation above it. */
const sentBody = (n = 0): Record<string, unknown> => bodies[n] as Record<string, unknown>;
/** The api client captures `stubFetch` at construction, so a re-stubbed global never reaches it. */
let writeFailure: { status: number; body: unknown } | null = null;
/** When set, every write is a request that never gets an answer (offline, a reset, a timeout). */
let writesRejected = false;

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
  if (path === "/api/v1/hope/sfv") return { sfvs: [{ ...sfvRow, status: sfvStatus }] };
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
    writeKeys.push(
      typeof input === "object" && "headers" in input ? input.headers.get("Idempotency-Key") : null,
    );
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
  if (method !== "GET" && writesRejected) throw new TypeError("Failed to fetch");
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

/** Where a navigation landed, for a control that moves the user instead of writing. */
function LocationProbe(): JSX.Element {
  const { pathname } = useLocation();
  return <output aria-label="location">{pathname}</output>;
}

/** Stands in for the /step-up page so a redirect is observable as the location it lands on. */
function StepUpProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output aria-label="step-up location">{`${pathname}${search}`}</output>;
}

/** The refusal `requireStepUp` sends when the session's last re-authentication is stale. */
const STEP_UP_REFUSAL = {
  status: 403,
  body: {
    error: {
      code: "STEP_UP_REQUIRED",
      message: "A recent re-authentication is required for this operation",
    },
  },
};

function mount(
  path: string,
  pattern: string,
  element: JSX.Element,
  session: Omit<typeof SESSION, "permissions"> & { permissions: string[] } = SESSION,
) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
              <Route path="/hope/assessments/:id" element={<LocationProbe />} />
              <Route path="/step-up" element={<StepUpProbe />} />
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
  writeKeys = [];
  writeFailure = null;
  writesRejected = false;
  scheduleStatus = "open";
  sfvStatus = "open";
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
    // The clinician chooses the reason: none is preselected.
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "transferred_out" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip window" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/hope/schedules/${SCHEDULE}/skip`));
    expect(sentBody().reasonCode).toBe("transferred_out");
  });

  it("a terminal window offers neither control — the server refuses both (F-007)", async () => {
    scheduleStatus = "completed";
    mount("/hope", "/hope", <HopeDashboard />);
    await waitFor(() => expect(calls.some((c) => c.startsWith("GET"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});

describe("a write whose request never gets an answer frees its dialog and says so", () => {
  it("Record timepoint: the dialog shows it, Cancel works, and the dialog can be left", async () => {
    writesRejected = true;
    mount("/hope", "/hope", <HopeDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Record" }));
    fireEvent.click(await screen.findByRole("button", { name: "Record draft" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not confirm that the timepoint was recorded.");
    expect(
      (screen.getByRole("button", { name: "Record draft" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Record draft" })).toBeNull());
  });

  it("Skip window: the dialog shows it and can be left", async () => {
    writesRejected = true;
    mount("/hope", "/hope", <HopeDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: "other" } });
    fireEvent.click(await screen.findByRole("button", { name: "Skip window" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not confirm that the action was applied.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Skip window" })).toBeNull());
  });
});

describe("#91 — the SFV queue takes the clinician to where the follow-up is completed", () => {
  // The follow-up is answered (J2053A–H) in the triggering assessment's "Complete SFV" dialog. The queue used to
  // open a modal that recorded the visit WITHOUT those answers, which the server now refuses, so the control
  // navigates instead of writing. It is a link (navigation is not a button) named for its row.
  const completeName = `Complete symptom follow-up ${SFV.slice(0, 8)}`;

  it("Complete is a link to the triggering assessment and sends no write", async () => {
    mount("/hope/sfv", "/hope/sfv", <SfvWorklist />);
    const complete = await screen.findByRole("link", { name: completeName });
    // ?completeSfv=1 opens the completion dialog on arrival, so the clinician lands where the action is.
    expect(complete.getAttribute("href")).toBe(`/hope/assessments/${ASSESSMENT}?completeSfv=1`);
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    fireEvent.click(complete);
    const where = await screen.findByLabelText("location");
    expect(where.textContent).toBe(`/hope/assessments/${ASSESSMENT}`);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it.each(["open", "overdue"])(
    "offers Complete on a follow-up that is %s, the states the capture hub treats as actionable",
    async (status) => {
      sfvStatus = status;
      mount("/hope/sfv", "/hope/sfv", <SfvWorklist />);
      expect(await screen.findByRole("link", { name: completeName })).toBeTruthy();
    },
  );

  it.each(["missed", "completed"])("offers nothing on a follow-up that is %s", async (status) => {
    sfvStatus = status;
    mount("/hope/sfv", "/hope/sfv", <SfvWorklist />);
    await screen.findByText("Symptom follow-up");
    expect(screen.queryByRole("link", { name: completeName })).toBeNull();
  });
});

describe("#91 — the assessment detail can sign, correct and request its summary", () => {
  // Sign and correct live in the assessment workspace (hope-assessment-detail.tsx), which pins every
  // write to the version it read (`ifVersion`) — not in `HopeActionModal`, which only skips,
  // regenerates and requests summaries from the queues.
  const detail = () =>
    mount(`/hope/assessments/${ASSESSMENT}`, "/hope/assessments/:id", <HopeAssessmentDetail />);

  const openSignDialog = async () => {
    const open = await screen.findAllByRole("button", { name: "Sign & complete" });
    fireEvent.click(open[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    expect(writes()).toEqual([]);
    return dialog;
  };
  const attestSign = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));

  it("Sign POSTs the signature on a DRAFT, pinned to the version it read", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    detail();
    const dialog = await openSignDialog();
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/sign`),
    );
    expect(sentBody().ifVersion).toBe(3);
  });

  it("R-05 — Sign is disabled until the signer ticks the attestation, and the request carries it", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    detail();
    const dialog = await openSignDialog();
    const sign = within(dialog).getByRole("button", {
      name: "Sign & complete",
    }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.click(sign);
    expect(writes()).toEqual([]);
    attestSign(dialog);
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/sign`),
    );
    expect(sentBody()).toEqual({
      ifVersion: 3,
      attestationConfirmed: true,
      attestationVersion: HOPE_ATTESTATION_VERSION,
    });
  });

  it("a changed attestation wording is a definite refusal that holds for the whole page, however often the dialog is reopened", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    writeFailure = {
      status: 409,
      body: {
        error: {
          code: "M10_ATTESTATION_STALE",
          message: "Attestation version 2020-01-01.1 is not current.",
        },
      },
    };
    detail();
    let dialog = await openSignDialog();
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "The attestation wording has changed. Reload the page and review it again.",
    );
    expect(
      (within(dialog).getByRole("button", { name: "Sign & complete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Reopening does not forget: this page cannot send the new wording's version, so it stays refused until reloaded.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "The attestation wording has changed. Reload the page and review it again.",
    );
    attestSign(dialog);
    expect(
      (within(dialog).getByRole("button", { name: "Sign & complete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it("starts the next sign attempt after an answered refusal on a new Idempotency-Key", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    writeFailure = {
      status: 409,
      body: {
        error: { code: "CONFLICT", message: "This assessment changed since you opened it." },
      },
    };
    detail();
    const dialog = await openSignDialog();
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    await within(dialog).findByRole("alert");

    writeFailure = null;
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writeKeys[0]).toBeTruthy();
    expect(writeKeys[1]).toBeTruthy();
    expect(writeKeys[1]).not.toBe(writeKeys[0]);
  });

  it("R-05 — a stale step-up on Sign sends the signer to /step-up?returnTo= this record", async () => {
    detailRow = { ...assessmentRow, version: 3 };
    writeFailure = STEP_UP_REFUSAL;
    detail();
    const dialog = await openSignDialog();
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    const where = await screen.findByLabelText("step-up location");
    expect(where.textContent).toBe(
      `/step-up?returnTo=${encodeURIComponent(`/hope/assessments/${ASSESSMENT}`)}`,
    );
  });

  it.each([
    [409, "CONFLICT", "This assessment changed since you opened it."],
    [403, "FORBIDDEN", "Your role is not eligible to sign this HOPE record."],
  ])(
    "shows a %i (%s) refusal on Sign in the dialog, not swallowed",
    async (status, code, message) => {
      detailRow = { ...assessmentRow, version: 3 };
      writeFailure = { status, body: { error: { code, message } } };
      detail();
      const dialog = await openSignDialog();
      attestSign(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(message);
      expect(screen.queryByLabelText("step-up location")).toBeNull();
    },
  );

  it("an SFV record (RFA-04, never a draft) shows its state and offers no Sign that opens nothing", async () => {
    // RFA-04 is only ever created signed; the legacy view has no sign dialog, so a Sign button here was inert.
    detailRow = { ...assessmentRow, rfaKind: "04_sfv", status: "draft" };
    detail();
    await screen.findByRole("heading", { name: "SFV" });
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
    expect(writes()).toEqual([]);
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
    detail();
    const correct = await screen.findAllByRole("button", { name: "Create correction" });
    expect(screen.queryByRole("button", { name: "Sign & complete" })).toBeNull();
    fireEvent.click(correct[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: /^Correct / });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "transcription error in Section J" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create correction draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/hope/assessments/${ASSESSMENT}/correct`),
    );
    expect(sentBody().correctionReason).toBe("transcription error in Section J");
    expect(sentBody().ifVersion).toBe(2);
    // F-074 — the read projection carries no author discipline (""), so the client sends the ACTING user's own
    // (the session is an RN) rather than echoing the blank, and never a role key.
    expect(sentBody().authorDiscipline).toBe("RN");
  });

  it("a correction with no reason given sends nothing", async () => {
    detailRow = { ...assessmentRow, status: "signed", signedAt: "2026-08-21T10:00:00.000Z" };
    detail();
    const correct = await screen.findAllByRole("button", { name: "Create correction" });
    fireEvent.click(correct[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: /^Correct / });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), {
      target: { value: "   " },
    });
    const create = within(dialog).getByRole("button", {
      name: "Create correction draft",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(writes()).toEqual([]);
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
  it("keeps the patient's chart banner and summary rail, like every other chart tab", async () => {
    mount(`/patients/${PATIENT}/hope`, "/patients/:patientId/hope", <PatientHopeTimeline />);
    // The rail's Patient Summary and the banner both show who the chart belongs to ...
    await waitFor(() => expect(screen.getByText("Patient Summary")).toBeTruthy());
    expect((await screen.findAllByText(/Ada Vance/)).length).toBeGreaterThanOrEqual(2);
    // ... and the page's own title sits in the content pane, as the one level-one heading.
    expect(screen.getByRole("heading", { level: 1, name: "HOPE Timeline" })).toBeTruthy();
    expect(calls).toContain(`GET /api/v1/patients/${PATIENT}`);
  });

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

  it("Create missing timepoint windows POSTs the §4.1 route-20 admin write", async () => {
    // The button is offered to a session known to hold the platform-category permission (or one whose permissions are unknown).
    const withPermission = { ...SESSION, permissions: ["hope.admin.regenerate_schedules"] };
    mount(
      `/patients/${PATIENT}/hope`,
      "/patients/:patientId/hope",
      <PatientHopeTimeline />,
      withPermission,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create missing timepoint windows" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create missing timepoint windows" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create missing windows" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create missing windows" }));
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
