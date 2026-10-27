import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/07-care-plan — #91: the M7 write controls must not be inert.
//
// Before this change `apps/web/src/modules/07-care-plan` issued ZERO mutations — 895 lines across
// three screens, every one a read. The individualised written plan of care is the LEGAL PREDICATE for
// delivering hospice care at all (42 CFR 418.56(b)) and the IDG must review and update it at least
// every 15 days (418.56(d)).
//
// The screen is now main's care-plan workspace (#235), whose own write flows replaced the modals this
// suite was first written against. The net is still a DOM test that CLICKS the control and asserts on
// RECORDED FETCH CALLS — method, path, body AND headers, because M7's two concurrency dialects live in
// different places (POSTs carry `ifVersion` in the body; PATCHes carry `If-Match` + `Idempotency-Key`
// as headers) and a spy over the api client would not distinguish sending them from forgetting them.
// (`__tests__/care-plan-workspace.dom.test.tsx` covers the same screen through a mocked client.)
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CarePlanView } from "./care-plan-view";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PLAN = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PROBLEM = "cccccccc-3333-4333-8333-cccccccccccc";
const GOAL = "dddddddd-4444-4444-8444-dddddddddddd";
const INTERVENTION = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const DRAFT_V = "ffffffff-6666-4666-8666-ffffffffffff";
const PENDING_V = "99999999-7777-4777-8777-999999999999";

const problem = {
  id: PROBLEM,
  planId: PLAN,
  description: "Dyspnea related to terminal COPD",
  kind: "terminal",
  source: "clinical",
  status: "active",
  sudRelated: false,
  icd10Code: null as string | null,
  snomedCode: null as string | null,
  onsetAt: null as string | null,
  resolvedAt: null as string | null,
  resolutionNote: null as string | null,
  version: 4,
};
const goal = {
  id: GOAL,
  planId: PLAN,
  problemId: PROBLEM,
  originalText: "I want to breathe easy enough to sit on the porch",
  revisedText: null as string | null,
  measurableOutcome: null as string | null,
  targetAt: null as string | null,
  source: "patient_stated",
  status: "in_progress",
  statusNote: null as string | null,
  actingConsentId: null as string | null,
  version: 2,
};
const intervention = {
  id: INTERVENTION,
  planId: PLAN,
  problemId: PROBLEM,
  scopeText: "RN to assess respiratory status and titrate oxygen",
  frequencyText: "RN visit 2x weekly",
  frequencyValue: "2/week",
  discipline: "rn",
  responsibleRole: null as string | null,
  linkedOrderId: null as string | null,
  goalRefs: [] as string[],
  status: "active",
  discontinueReason: null as string | null,
  version: 7,
};

/** A draft version (editable, finalizable) — swapped per test for the awaiting-signature case. */
const draftVersion = {
  id: DRAFT_V,
  planId: PLAN,
  sequence: 3,
  kind: "idg_review",
  status: "draft",
  idgMeetingId: null as string | null,
  requiredSignerSet: [] as { role: string; count: number }[],
  signatures: [] as { signerRole: string; signedAt: string }[],
  draftedAt: "2026-08-19T10:00:00.000Z",
  signedAt: null as string | null,
  supersededAt: null as string | null,
  stateSnapshot: null,
  version: 11,
};
/**
 * Finalized and awaiting the §418.56 quorum (`in_review`): two RN signatures required, one collected,
 * plus the medical director.
 */
const pendingVersion = {
  ...draftVersion,
  id: PENDING_V,
  status: "in_review",
  requiredSignerSet: [
    { role: "rn_case_manager", count: 2 },
    { role: "medical_director", count: 1 },
  ],
  signatures: [{ signerRole: "rn_case_manager", signedAt: "2026-08-20T10:00:00.000Z" }],
  stateSnapshot: { problems: [], goals: [], interventions: [] },
  version: 12,
};

let versions: unknown[] = [draftVersion];
let activeVersionId: string | null = null;
/** The server's readiness verdict — which lifecycle controls are live is ITS answer, not the client's. */
let readiness: Record<string, unknown> = {};
let reviewStatus: Record<string, unknown> = {};

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let headers: Record<string, string>[] = [];
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
    // F-066 (#161) — the patient's admissions, the read the plan bootstrap resolves its key from. Must
    // be matched BEFORE the generic patient branch below, which would otherwise swallow it.
    if (path.endsWith("/admissions")) return { items: admissions, nextCursor: null };
    // The no-plan branch of the read union: `{ carePlan: null }`, no `id`.
    if (path.endsWith("/care-plan") && noPlan) return { carePlan: null };
    if (path.endsWith("/care-plan"))
      return {
        id: PLAN,
        patientId: PATIENT,
        admissionId: "admission-1",
        status: "active",
        activeVersionId,
        version: 3,
        versions,
        problems: [problem],
        goals: [goal],
        interventions: [intervention],
        redacted: false,
      };
    if (path.endsWith("/readiness")) return readiness;
    if (path.endsWith("/review-status")) return reviewStatus;
    if (path.endsWith("/proposed-changes"))
      return {
        versionId: DRAFT_V,
        kind: "idg_review",
        meetingId: null,
        status: "draft",
        proposals: [],
        changes: [],
      };
    // M38 terminology: the ICD-10-CM catalog is loaded; SNOMED CT is not (licensed, unloaded).
    if (path === "/api/v1/terminology/icd10cm/search")
      return {
        results: [
          { code: "I50.84", display: "End stage heart failure", status: "active" },
          { code: "I50.9", display: "Heart failure, unspecified", status: "active" },
        ],
      };
    if (path === "/api/v1/terminology/snomed/search") return { results: [] };
    if (path.endsWith("/validate")) return { valid: false };
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
  if (path.includes("/problems")) return problem;
  if (path.includes("/goals")) return goal;
  if (path.includes("/interventions")) return intervention;
  return draftVersion;
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const collected: Record<string, string> = {};
    if (req) {
      req.headers.forEach((v, k) => {
        collected[k.toLowerCase()] = v;
      });
    } else if (init?.headers)
      for (const [k, v] of Object.entries(init.headers as Record<string, string>))
        collected[k.toLowerCase()] = v;
    headers.push(collected);
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M7 write sends JSON; recording nothing is the honest answer if one ever does not.
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

/** An RN case manager who may author, finalize and sign — the controls render per permission. */
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: ["care_plan.read", "care_plan.author", "care_plan.finalize", "care_plan.sign"],
  isAdmin: false,
};

function mount(session = SESSION): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/patients/${PATIENT}/care-plan`]}>
            <Routes>
              <Route path="/patients/:patientId/care-plan" element={<CarePlanView />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

/** F-066 — flips the care-plan read to its no-plan branch so the empty state renders. */
let noPlan = false;
/** F-066 — what `GET /patients/:patientId/admissions` answers for this test. */
let admissions: {
  id: string;
  state: string;
  admissionAt: string | null;
  dischargedAt: string | null;
}[] = [];

const writes = () => calls.filter((c) => !c.startsWith("GET "));

function readinessFor(
  over: Partial<{
    canFinalize: boolean;
    canSign: boolean;
    openVersionId: string;
    openVersionStatus: string;
  }>,
  missing: { role: string; count: number }[] = [],
): Record<string, unknown> {
  return {
    planId: PLAN,
    openVersionId: DRAFT_V,
    openVersionStatus: "draft",
    canFinalize: false,
    canSign: false,
    blockers: [],
    signatures: { required: [], collected: [], missing },
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  bodies = [];
  headers = [];
  writeFailure = null;
  versions = [draftVersion];
  activeVersionId = null;
  readiness = readinessFor({});
  reviewStatus = {
    planId: PLAN,
    nextReviewDueAt: "2026-09-01T00:00:00.000Z",
    status: "not_due",
    overdueByDays: 0,
    openReviewVersionId: null,
    openReviewVersionStatus: null,
    canStartReview: false,
  };
  noPlan = false;
  admissions = [];
});
afterEach(() => {
  writeFailure = null;
});

/** Mount on an open draft and switch to the Problems view, where each problem carries its actions. */
async function problemsView(): Promise<void> {
  mount();
  fireEvent.click(await screen.findByRole("tab", { name: "Problems" }));
  await screen.findByRole("heading", { name: problem.description });
}

/** The problem's ⋯ menu (a `<details>`), then one of its items. */
function problemMenu(item: "Edit problem" | "Resolve problem"): void {
  fireEvent.click(screen.getByLabelText(`Actions for ${problem.description}`));
  fireEvent.click(screen.getByRole("button", { name: item }));
}

describe("#91 — the IPOC can be authored", () => {
  it("Add problem POSTs the problem with its CoP-relevant relationship to the terminal prognosis", async () => {
    await problemsView();
    fireEvent.click(screen.getByRole("button", { name: "+ Add problem" }));
    const dialog = await screen.findByRole("dialog", { name: "Add problem" });
    fireEvent.change(within(dialog).getByLabelText("Problem description"), {
      target: { value: "Anxiety at end of life" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save problem" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/problems`));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.description).toBe("Anxiety at end of life");
    // terminal / related is covered by the benefit and unrelated is not — the field drives billing.
    expect(sent.kind).toBe("related");
    expect(sent.source).toBe("clinical");
  });

  it("Add problem codes the problem from the ICD-10 catalog and keeps an unloaded SNOMED code as entered", async () => {
    await problemsView();
    fireEvent.click(screen.getByRole("button", { name: "+ Add problem" }));
    const dialog = await screen.findByRole("dialog", { name: "Add problem" });
    fireEvent.change(within(dialog).getByLabelText("Problem description"), {
      target: { value: "End-stage heart failure with dyspnea" },
    });
    const icd = within(dialog).getByRole("combobox", { name: /ICD-10 code/ });
    fireEvent.focus(icd);
    fireEvent.change(icd, { target: { value: "heart failure" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /I50\.84/ }));
    expect((icd as HTMLInputElement).value).toBe("I50.84 \u2013 End stage heart failure");

    const snomed = within(dialog).getByRole("combobox", { name: /SNOMED code/ });
    fireEvent.focus(snomed);
    fireEvent.change(snomed, { target: { value: "84114007" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /as entered/ }));
    await waitFor(() =>
      expect(within(dialog).getByText(/Not found in the SNOMED CT catalog/)).toBeTruthy(),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Save problem" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/problems`));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.icd10Code).toBe("I50.84");
    expect(sent.snomedCode).toBe("84114007");
  });

  it("Add goal hangs the goal off the problem it was opened from", async () => {
    await problemsView();
    fireEvent.click(screen.getByRole("button", { name: "+ Add goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Add goal" });
    fireEvent.change(within(dialog).getByLabelText("Goal statement"), {
      target: { value: "I want to see my grandson graduate" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/goals`));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.problemId).toBe(PROBLEM);
    expect(sent.originalText).toBe("I want to see my grandson graduate");
  });

  it("Add intervention records BOTH the written frequency and the machine-readable one", async () => {
    await problemsView();
    fireEvent.click(screen.getByRole("button", { name: "+ Add intervention" }));
    const dialog = await screen.findByRole("dialog", { name: "Add intervention" });
    fireEvent.change(within(dialog).getByLabelText("Intervention / scope"), {
      target: { value: "MSW counselling for anticipatory grief" },
    });
    fireEvent.change(within(dialog).getByLabelText("Frequency"), {
      target: { value: "MSW visit weekly" },
    });
    fireEvent.change(within(dialog).getByLabelText("Frequency value"), {
      target: { value: "1/week" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save intervention" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/interventions`),
    );
    const sent = bodies[0] as Record<string, unknown>;
    // The written frequency is what a surveyor reads; the value is what scheduling and missed-visit
    // detection run on. Sending only one of them would silently break one of those two readers.
    expect(sent.problemId).toBe(PROBLEM);
    expect(sent.frequencyText).toBe("MSW visit weekly");
    expect(sent.frequencyValue).toBe("1/week");
  });
});

describe("#91 — §7.7 optimistic concurrency is carried, in the dialect each route speaks", () => {
  it("a PATCH sends the row version it READ as If-Match, plus an Idempotency-Key", async () => {
    await problemsView();
    problemMenu("Edit problem");
    const dialog = await screen.findByRole("dialog", { name: "Edit problem" });
    fireEvent.change(within(dialog).getByLabelText("Problem description"), {
      target: { value: "Dyspnea, worsening" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save problem" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/care-plans/${PLAN}/problems/${PROBLEM}`),
    );
    // The version comes from the READ, verbatim. `requireIfMatch` answers 428 without it and
    // `requireIdempotencyKey` 400 without a key — both before the handler runs.
    expect(headers[0]?.["if-match"]).toBe("4");
    expect(String(headers[0]?.["idempotency-key"] ?? "").length).toBeGreaterThan(0);
    expect((bodies[0] as Record<string, unknown>).description).toBe("Dyspnea, worsening");
  });

  it("a POST state-change sends ifVersion in the BODY, not as a header", async () => {
    await problemsView();
    problemMenu("Resolve problem");
    const dialog = await screen.findByRole("dialog", { name: "Resolve problem" });
    fireEvent.change(within(dialog).getByLabelText("Resolution note"), {
      target: { value: "Symptom controlled; problem closed at IDG" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/problems/${PROBLEM}/resolve`),
    );
    expect(bodies[0]).toEqual({
      ifVersion: 4,
      resolutionNote: "Symptom controlled; problem closed at IDG",
    });
    expect(headers[0]?.["if-match"]).toBeUndefined();
  });

  it("a 412 says the plan moved under the caller, inside the dialog, and keeps it open", async () => {
    // The platform envelope the M7 routes actually answer a stale write with.
    writeFailure = {
      status: 412,
      body: { error: { code: "STALE_VERSION", message: "version 4 is stale" } },
    };
    await problemsView();
    problemMenu("Resolve problem");
    const dialog = await screen.findByRole("dialog", { name: "Resolve problem" });
    fireEvent.change(within(dialog).getByLabelText("Resolution note"), {
      target: { value: "Closed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));
    // On a plan a whole IDG edits, a stale version is ordinary rather than exceptional, and the copy
    // says what to do rather than reporting a status code — where the user is looking.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("changed while you were working");
    expect(within(dialog).getByRole("button", { name: "Resolve" })).toBeTruthy();
  });
});

describe("#91 — the version lifecycle can be advanced", () => {
  it("a ready DRAFT is sent for signature, finalizing with the version it read", async () => {
    // An `idg_review` draft additionally needs a recorded IDG proposed change before it can be sent, so this
    // lifecycle test uses an interim revision (the plain ready-to-send path).
    versions = [{ ...draftVersion, kind: "interim_revision" }];
    readiness = readinessFor({ canFinalize: true });
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: /^Review & Sign/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send to hospice physician" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/versions/${DRAFT_V}/finalize`),
    );
    expect(bodies[0]).toEqual({ ifVersion: 11 });
  });

  it("a version awaiting signatures offers Review & sign, and signs an open slot with its version", async () => {
    versions = [pendingVersion];
    readiness = readinessFor(
      { openVersionId: PENDING_V, openVersionStatus: "in_review", canSign: true },
      [
        { role: "rn_case_manager", count: 1 },
        { role: "medical_director", count: 1 },
      ],
    );
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: /^Review & Sign/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Review & sign" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Sign Care Plan version" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign care plan" }));
    await waitFor(() =>
      expect(writes()).toContain(
        `POST /api/v1/care-plans/${PLAN}/versions/${PENDING_V}/signatures`,
      ),
    );
    const sent = bodies[0] as Record<string, unknown>;
    // The role defaults to the first slot still short of its count — RN (1 of 2) — and is NOT a claim
    // to be allowed to sign, which `SIGNER_MATCH` decides server-side.
    expect(sent.signerRole).toBe("rn_case_manager");
    expect(sent.ifVersion).toBe(12);
  });

  it("a draft offers no signing, and a pending version offers no send-for-signature (F-007)", async () => {
    readiness = readinessFor({ canFinalize: true });
    const first = mount();
    fireEvent.click(await screen.findByRole("tab", { name: /^Review & Sign/ }));
    expect(screen.getByRole("button", { name: "Send to hospice physician" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review & sign" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to draft" })).toBeNull();
    first.unmount();

    versions = [pendingVersion];
    readiness = readinessFor({
      openVersionId: PENDING_V,
      openVersionStatus: "in_review",
      canSign: true,
    });
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: /^Review & Sign/ }));
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send to hospice physician" })).toBeNull();
  });

  it("with no open version and a review due, the plan offers Start review", async () => {
    versions = [{ ...draftVersion, status: "signed", signedAt: "2026-08-01T00:00:00.000Z" }];
    activeVersionId = DRAFT_V;
    readiness = readinessFor({ openVersionId: undefined as unknown as string });
    reviewStatus = { ...reviewStatus, status: "due", canStartReview: true };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Start review" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/versions`));
    // The 15-day CoP cadence (418.56(d)) is the reason this version is opened.
    expect(bodies[0]).toEqual({ kind: "idg_review" });
  });
});

describe("#91 — the quorum is reported from the server's slots, not a fixed string", () => {
  it("names the roles still outstanding, counting multi-signature slots", async () => {
    versions = [pendingVersion];
    readiness = readinessFor(
      { openVersionId: PENDING_V, openVersionStatus: "in_review", canSign: true },
      [
        { role: "rn_case_manager", count: 1 },
        { role: "medical_director", count: 1 },
      ],
    );
    mount();
    // The next-step card counts the open slots…
    expect(await screen.findByText(/2 required signer slots remain/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    // …and the signature panel names them, with the multi-signature RN slot counted (1 of 2).
    const missing = screen.getByText(/^Missing:/).textContent ?? "";
    expect(missing).toContain("Rn Case Manager (1)");
    expect(missing).toContain("Medical Director (1)");
    expect(screen.getByText(/Rn Case Manager · 1 of 2/)).toBeTruthy();
  });
});

// F-066 (#161) — the plan bootstrap. `POST /patients/:id/care-plan` had a client and no control, and
// the screen said so: "a 'create care plan' button would need an admissionId this screen does not
// read". Nothing could read one for a patient at all — the org-wide census takes no patient filter and
// its items carry no `patientId` — so the control was not omitted by preference, it was unbuildable.
describe("F-066 — the care plan can be STARTED, not only displayed", () => {
  const OPEN_ADMISSION = "11111111-8888-4888-8888-111111111111";
  const DISCHARGED_ADMISSION = "22222222-9999-4999-8999-222222222222";

  it("offers Start the care plan when the patient has an open admission, and POSTs that admission", async () => {
    noPlan = true;
    admissions = [
      // Newest first, as the route answers — and the newest one is DISCHARGED, so "newest" and
      // "open" are deliberately different answers here.
      {
        id: DISCHARGED_ADMISSION,
        state: "discharged",
        admissionAt: "2026-01-04T00:00:00.000Z",
        dischargedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: OPEN_ADMISSION,
        state: "active",
        admissionAt: "2025-11-02T00:00:00.000Z",
        dischargedAt: null,
      },
    ];
    mount();
    const button = await screen.findByRole("button", { name: "Start the care plan" });
    fireEvent.click(button);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/patients/${PATIENT}/care-plan`));
    // The OPEN admission, not the newest row.
    expect(bodies[0]).toEqual({ admissionId: OPEN_ADMISSION });
  });

  it("offers no control when every admission is discharged, and says why", async () => {
    noPlan = true;
    admissions = [
      {
        id: DISCHARGED_ADMISSION,
        state: "discharged",
        admissionAt: "2026-01-04T00:00:00.000Z",
        dischargedAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    mount();
    await waitFor(() => expect(screen.getByText("No care plan yet")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Start the care plan" })).toBeNull();
    expect(screen.getByText(/no open admission/i)).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("no longer claims the plan appears by itself on admission — nothing in the product did that", async () => {
    noPlan = true;
    admissions = [
      {
        id: OPEN_ADMISSION,
        state: "active",
        admissionAt: "2025-11-02T00:00:00.000Z",
        dischargedAt: null,
      },
    ];
    mount();
    await waitFor(() => expect(screen.getByText("No care plan yet")).toBeTruthy());
    expect(screen.queryByText(/created when the patient is admitted/i)).toBeNull();
  });

  it("a refused bootstrap says so and leaves the control offered", async () => {
    noPlan = true;
    admissions = [
      {
        id: OPEN_ADMISSION,
        state: "active",
        admissionAt: "2025-11-02T00:00:00.000Z",
        dischargedAt: null,
      },
    ];
    writeFailure = {
      status: 409,
      body: { error: { code: "CONFLICT", message: "already exists" } },
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Start the care plan" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not start/i));
    expect(screen.getByRole("button", { name: "Start the care plan" })).toBeTruthy();
  });
});
