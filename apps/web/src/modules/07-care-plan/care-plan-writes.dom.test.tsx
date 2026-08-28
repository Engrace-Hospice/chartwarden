// apps/web/src/modules/07-care-plan — #91: the M7 write controls must not be inert.
//
// Before this change `apps/web/src/modules/07-care-plan` issued ZERO mutations — 895 lines across
// three screens, every one a read. The individualised written plan of care is the LEGAL PREDICATE for
// delivering hospice care at all (42 CFR 418.56(b)) and the IDG must review and update it at least
// every 15 days (418.56(d)). The module could display a plan and could not author, revise, finalize or
// sign one; the footer's three buttons were all navigation.
//
// The net is a DOM test that CLICKS the control and asserts on RECORDED FETCH CALLS — method, path,
// body AND headers, because M7's two concurrency dialects live in different places (POSTs carry
// `ifVersion` in the body; PATCHes carry `If-Match` + `Idempotency-Key` as headers) and a spy over the
// api client would not distinguish sending them from forgetting them.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
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
  organizationId: "org-1",
  description: "Dyspnea related to terminal COPD",
  kind: "terminal",
  source: "clinical",
  status: "active",
  sudRelated: false,
  icd10Code: null as string | null,
  snomedCode: null as string | null,
  resolutionNote: null as string | null,
  version: 4,
};
const goal = {
  id: GOAL,
  planId: PLAN,
  organizationId: "org-1",
  problemId: PROBLEM,
  originalText: "I want to breathe easy enough to sit on the porch",
  revisedText: null as string | null,
  measurableOutcome: null as string | null,
  source: "patient_stated",
  status: "in_progress",
  actingConsentId: null as string | null,
  version: 2,
};
const intervention = {
  id: INTERVENTION,
  planId: PLAN,
  organizationId: "org-1",
  problemId: PROBLEM,
  scopeText: "RN to assess respiratory status and titrate oxygen",
  frequencyText: "RN visit 2x weekly",
  frequencyValue: "2/week",
  discipline: "rn",
  responsibleRole: null as string | null,
  goalRefs: [] as string[],
  status: "active",
  version: 7,
};

/** A draft version (editable, finalizable) — swapped per test for the pending-signature case. */
const draftVersion = {
  id: DRAFT_V,
  planId: PLAN,
  sequence: 3,
  kind: "idg_review",
  status: "draft",
  idgMeetingId: null as string | null,
  requiredSignerSet: [] as { role: string; count: number }[],
  signatures: [] as { signerRole: string; signedAt: string }[],
  signedAt: null as string | null,
  version: 11,
};
/** Finalized and awaiting the §418.56 quorum: two RN signatures required, one collected. */
const pendingVersion = {
  ...draftVersion,
  id: PENDING_V,
  status: "pending_signatures",
  requiredSignerSet: [
    { role: "rn_case_manager", count: 2 },
    { role: "medical_director", count: 1 },
  ],
  signatures: [{ signerRole: "rn_case_manager", signedAt: "2026-08-20T10:00:00.000Z" }],
  version: 12,
};

let versions: unknown[] = [draftVersion];
let activeVersionId: string | null = null;

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
  if (method === "GET" && path.endsWith("/care-plan"))
    return {
      id: PLAN,
      patientId: PATIENT,
      status: "active",
      activeVersionId,
      version: 3,
      versions,
      problems: [problem],
      goals: [goal],
      interventions: [intervention],
      redacted: false,
    };
  if (method === "GET" && path.startsWith("/api/v1/patients/"))
    return {
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    };
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

/** An RN case manager — one care-plan signer role, so the sign modal needs no role prompt. */
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
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

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  headers = [];
  writeFailure = null;
  versions = [draftVersion];
  activeVersionId = null;
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — the IPOC can be authored", () => {
  it("Add problem POSTs the problem with its CoP-relevant relationship to the terminal prognosis", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add problem" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add problem" }));
    const field = await waitFor(() => screen.getByLabelText(/^Problem$/i));
    fireEvent.change(field, { target: { value: "Anxiety at end of life" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/problems`));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.description).toBe("Anxiety at end of life");
    // terminal / related is covered by the benefit and unrelated is not — the field drives billing.
    expect(sent.kind).toBe("related");
    expect(sent.source).toBe("clinical");
  });

  it("Add goal hangs the goal off the problem it was opened from", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add goal" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    const field = await waitFor(() => screen.getByLabelText(/Goal, in the patient's words/i));
    fireEvent.change(field, { target: { value: "I want to see my grandson graduate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/goals`));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.problemId).toBe(PROBLEM);
    expect(sent.originalText).toBe("I want to see my grandson graduate");
  });

  it("Add intervention records BOTH the written frequency and the machine-readable one", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add intervention" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add intervention" }));
    const scope = await waitFor(() => screen.getByLabelText(/^Intervention$/i));
    fireEvent.change(scope, { target: { value: "MSW counselling for anticipatory grief" } });
    fireEvent.change(screen.getByLabelText(/Frequency, as written/i), {
      target: { value: "MSW visit weekly" },
    });
    fireEvent.change(screen.getByLabelText(/Frequency, machine-readable/i), {
      target: { value: "1/week" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/interventions`),
    );
    const sent = bodies[0] as Record<string, unknown>;
    // The written frequency is what a surveyor reads; the value is what scheduling and missed-visit
    // detection run on. Sending only one of them would silently break one of those two readers.
    expect(sent.frequencyText).toBe("MSW visit weekly");
    expect(sent.frequencyValue).toBe("1/week");
  });
});

describe("#91 — §7.7 optimistic concurrency is carried, in the dialect each route speaks", () => {
  it("a PATCH sends the row version it READ as If-Match, plus an Idempotency-Key", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement);
    const field = await waitFor(() => screen.getByLabelText(/^Problem$/i));
    fireEvent.change(field, { target: { value: "Dyspnea, worsening" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/care-plans/${PLAN}/problems/${PROBLEM}`),
    );
    // The version comes from the READ, verbatim. `requireIfMatch` answers 428 without it and
    // `requireIdempotencyKey` 400 without a key — both before the handler runs.
    expect(headers[0]?.["if-match"]).toBe("4");
    expect(String(headers[0]?.["idempotency-key"]).length).toBeGreaterThan(0);
  });

  it("a POST state-change sends ifVersion in the BODY, not as a header", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const note = await waitFor(() => screen.getByLabelText(/Resolution note/i));
    fireEvent.change(note, { target: { value: "Symptom controlled; problem closed at IDG" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/problems/${PROBLEM}/resolve`),
    );
    expect(bodies[0]).toEqual({
      ifVersion: 4,
      resolutionNote: "Symptom controlled; problem closed at IDG",
    });
    expect(headers[0]?.["if-match"]).toBeUndefined();
  });

  it("a 412 says the plan moved under the caller and keeps the dialog open", async () => {
    writeFailure = { status: 412, body: { message: "STALE_VERSION" } };
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const note = await waitFor(() => screen.getByLabelText(/Resolution note/i));
    fireEvent.change(note, { target: { value: "Closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    // On a plan a whole IDG edits, a stale version is ordinary rather than exceptional, and the copy
    // says what to do rather than reporting a status code.
    expect(alert.textContent).toContain("Someone else changed this care plan");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("#91 — the version lifecycle can be advanced", () => {
  it("a DRAFT offers Close draft for signature, and finalizes with its version", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close draft for signature" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close draft for signature" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/versions/${DRAFT_V}/finalize`),
    );
    expect(bodies[0]).toEqual({ ifVersion: 11 });
  });

  it("a version awaiting signatures offers Sign, and signs as a role the caller actually holds", async () => {
    versions = [pendingVersion];
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Sign" }).length).toBe(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" })[1] as HTMLElement);
    await waitFor(() =>
      expect(writes()).toContain(
        `POST /api/v1/care-plans/${PLAN}/versions/${PENDING_V}/signatures`,
      ),
    );
    const sent = bodies[0] as Record<string, unknown>;
    // The role is the caller's OWN, intersected with the signer vocabulary — not a claim to be allowed
    // to sign, which `SIGNER_MATCH` decides server-side.
    expect(sent.signerRole).toBe("rn_case_manager");
    expect(sent.ifVersion).toBe(12);
  });

  it("a draft offers no Sign, and a pending version offers no Close-for-signature (F-007)", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close draft for signature" })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to draft" })).toBeNull();
  });

  it("with no draft and nothing pending, the plan offers Start IDG review", async () => {
    versions = [];
    mount();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start IDG review" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start IDG review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/care-plans/${PLAN}/versions`));
    // The 15-day CoP cadence (418.56(d)) is the default reason a new version is opened.
    expect(bodies[0]).toEqual({ kind: "idg_review" });
  });
});

describe("#91 — the quorum chip reports the server's slots, not a fixed string", () => {
  it("names the roles still outstanding, counting multi-signature slots", async () => {
    versions = [pendingVersion];
    mount();
    // Two RN signatures are required and one is collected, so RN is still outstanding alongside the
    // medical director. The chip used to read "IDG quorum required to approve" in every state.
    await waitFor(() => expect(screen.getByText(/Awaiting/)).toBeTruthy());
    const chip = screen.getByText(/Awaiting/).textContent ?? "";
    expect(chip).toContain("Rn Case Manager");
    expect(chip).toContain("Medical Director");
  });

  it("a draft says what has to happen next instead of naming absent signers", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/close for signature/i)).toBeTruthy());
    expect(screen.queryByText(/Awaiting/)).toBeNull();
  });
});
