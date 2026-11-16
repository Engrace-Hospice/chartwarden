// The Care Plan workspace under the conditions a clinician actually meets: a request that never answers,
// a stale row, a refused step-up, a read that fails, a wire shape that differs from what the screen once
// assumed. Each case drives the real view against a mocked API client and asserts what the user sees.
// jest-dom matchers are registered at runtime by vitest.setup.dom.ts; this import gives the test
// typecheck program their `toHaveAttribute` typings too.
import "@testing-library/jest-dom/vitest";
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type JSX, useEffect, useState } from "react";
import { MemoryRouter, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { clearAllStepUpDrafts, markStepUpReturn } from "../../../shell/step-up-redirect";
import type {
  CarePlan,
  Goal,
  Intervention,
  Problem,
  ProblemSource,
  Version,
} from "../care-plan-api";
import { CarePlanView, PROBLEM_SOURCE_OPTIONS } from "../care-plan-view";

// A date-time at UTC midnight must still read as that calendar day for a clinician west of UTC.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

const PATH = "/patients/patient-1/care-plan";
const FULL_PERMISSIONS = [
  "care_plan.read",
  "care_plan.author",
  "care_plan.finalize",
  "care_plan.sign",
  "care_plan.bootstrap",
];
const sessionWith = (permissions: string[] = FULL_PERMISSIONS): Session => ({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions,
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────
const version = (over: Partial<Version> = {}): Version => ({
  id: "version-1",
  planId: "plan-1",
  sequence: 1,
  kind: "initial",
  status: "draft",
  idgMeetingId: null,
  requiredSignerSet: [],
  signatures: [],
  draftedAt: "2026-08-10T10:00:00.000Z",
  signedAt: null,
  supersededAt: null,
  stateSnapshot: null,
  version: 1,
  ...over,
});
const problem = (over: Partial<Problem> = {}): Problem => ({
  id: "problem-1",
  planId: "plan-1",
  icd10Code: null,
  snomedCode: null,
  description: "Terminal cancer",
  kind: "terminal",
  source: "clinical",
  sudRelated: false,
  status: "active",
  onsetAt: null,
  resolvedAt: null,
  resolutionNote: null,
  version: 1,
  ...over,
});
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "goal-1",
  planId: "plan-1",
  problemId: "problem-1",
  originalText: "Comfort maintained",
  revisedText: null,
  source: "clinical",
  actingConsentId: null,
  measurableOutcome: "Pain at acceptable level",
  targetAt: "2026-12-01T00:00:00.000Z",
  status: "in_progress",
  statusNote: null,
  version: 1,
  ...over,
});
const intervention = (over: Partial<Intervention> = {}): Intervention => ({
  id: "intervention-1",
  planId: "plan-1",
  problemId: "problem-1",
  goalRefs: [],
  scopeText: "RN pain assessment",
  frequencyText: "Twice weekly",
  frequencyValue: "2/wk",
  discipline: "rn",
  responsibleRole: "Primary RN",
  linkedOrderId: null,
  status: "active",
  discontinueReason: null,
  version: 1,
  ...over,
});

const signedInitial = version({
  id: "version-signed",
  status: "signed",
  signedAt: "2026-08-01T12:00:00.000Z",
});
const openDraft = (over: Partial<Version> = {}): Version =>
  version({ id: "version-draft", sequence: 2, kind: "interim_revision", ...over });

function planOf(
  versions: Version[],
  over: Partial<CarePlan> = {},
  active: string | null = "version-signed",
): CarePlan {
  return {
    id: "plan-1",
    patientId: "patient-1",
    admissionId: "admission-1",
    status: "active",
    activeVersionId: active,
    version: 4,
    versions,
    problems: [problem()],
    goals: [goal()],
    interventions: [intervention()],
    redacted: false,
    ...over,
  };
}

const readinessOf = (over: Record<string, unknown> = {}) => ({
  planId: "plan-1",
  openVersionId: "version-draft",
  openVersionStatus: "draft",
  canFinalize: false,
  canSign: false,
  blockers: [],
  signatures: { required: [], collected: [], missing: [] },
  ...over,
});
const reviewOf = (over: Record<string, unknown> = {}) => ({
  planId: "plan-1",
  nextReviewDueAt: "2026-12-20T00:00:00.000Z",
  status: "not_due",
  overdueByDays: 0,
  openReviewVersionId: null,
  openReviewVersionStatus: null,
  canStartReview: false,
  ...over,
});

// ── mocked client ───────────────────────────────────────────────────────────────────────────────────────
const ok = (data: unknown = { id: "created", version: 2 }) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refused = (status: number, error: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});
const envelope = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details ? { details } : {}) },
});

interface World {
  plan: CarePlan | null;
  readiness: unknown;
  review: unknown;
  proposed: unknown;
  admissions: unknown;
  /** Return a value to override the default answer for a GET (a refusal, or throw to simulate no answer). */
  intercept?: (path: string) => unknown;
  POST: ReturnType<typeof vi.fn>;
  PATCH: ReturnType<typeof vi.fn>;
}

function worldWith(over: Partial<World> = {}): World {
  return {
    plan: planOf([signedInitial]),
    readiness: readinessOf({ openVersionId: null, openVersionStatus: undefined }),
    review: reviewOf(),
    proposed: {
      versionId: "version-draft",
      kind: "idg_review",
      meetingId: null,
      status: "draft",
      proposals: [],
      changes: [],
    },
    admissions: { items: [], nextCursor: null },
    POST: vi.fn(async () => ok()),
    PATCH: vi.fn(async () => ok()),
    ...over,
  };
}

function clientFor(world: World): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      const forced = world.intercept?.(path);
      if (forced !== undefined) return forced;
      if (path === "/api/v1/patients/{patientId}/care-plan")
        return ok(world.plan ?? { carePlan: null });
      if (path === "/api/v1/patients/{id}")
        return ok({
          mrn: "MRN-7",
          firstName: "June",
          lastName: "Rivera",
          dob: "1950-02-14",
          status: "active",
        });
      if (path === "/api/v1/patients/{patientId}/admissions") return ok(world.admissions);
      if (path === "/api/v1/care-plans/{planId}/readiness") return ok(world.readiness);
      if (path === "/api/v1/care-plans/{planId}/review-status") return ok(world.review);
      if (path.endsWith("/proposed-changes")) return ok(world.proposed);
      return ok({});
    }),
    POST: world.POST,
    PATCH: world.PATCH,
  } as unknown as ApiClient;
}

function StepUpStub(): JSX.Element {
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/";
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    markStepUpReturn(returnTo);
    setVerified(true);
  }, [returnTo]);
  return verified ? <Navigate to={returnTo} replace /> : <p>Verifying…</p>;
}

function mount(world: World, permissions?: string[]): void {
  render(
    <MemoryRouter initialEntries={[PATH]}>
      <ApiClientProvider client={clientFor(world)}>
        <ToastProvider>
          <SessionProvider session={sessionWith(permissions)}>
            <Routes>
              <Route path="/patients/:patientId/care-plan" element={<CarePlanView />} />
              <Route path="/step-up" element={<StepUpStub />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearAllStepUpDrafts();
  window.sessionStorage.clear();
});

const workspace = () => screen.findByRole("heading", { name: "Plan of Care" });
const openProblemsTab = async () => {
  await workspace();
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
};
const draftWorld = (over: Partial<World> = {}): World =>
  worldWith({
    plan: planOf([signedInitial, openDraft()]),
    readiness: readinessOf({ canFinalize: true }),
    ...over,
  });
const addProblemDialog = async () => {
  await openProblemsTab();
  fireEvent.click(screen.getByRole("button", { name: "+ Add problem" }));
  return screen.findByRole("dialog", { name: "Add problem" });
};
const describeIt = (dialog: HTMLElement, value = "Anxiety at end of life") =>
  fireEvent.change(within(dialog).getByLabelText("Problem description"), {
    target: { value },
  });
const save = (dialog: HTMLElement, name = "Save problem") =>
  fireEvent.click(within(dialog).getByRole("button", { name }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("problem sources match the contract", () => {
  const CONTRACT_SOURCES: Record<ProblemSource, true> = {
    clinical: true,
    patient_reported: true,
    family_reported: true,
    history: true,
    intake_extraction: true,
  };

  it("offers every contract value, labelled, and nothing the server would refuse", async () => {
    const world = draftWorld();
    mount(world);
    const dialog = await addProblemDialog();

    const options = Array.from(within(dialog).getByLabelText("Source").querySelectorAll("option"));
    expect(options.map((o) => o.value).sort()).toEqual(Object.keys(CONTRACT_SOURCES).sort());
    expect(PROBLEM_SOURCE_OPTIONS.map((o) => o.value).sort()).toEqual(
      Object.keys(CONTRACT_SOURCES).sort(),
    );
    expect(options.every((o) => o.textContent && !o.textContent.includes("_"))).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Source"), {
      target: { value: "patient_reported" },
    });
    describeIt(dialog);
    save(dialog);
    await waitFor(() => expect(world.POST).toHaveBeenCalled());
    expect(world.POST.mock.calls[0]?.[1]).toMatchObject({
      body: { source: "patient_reported", description: "Anxiety at end of life" },
    });
  });
});

describe("a request that never answers", () => {
  it("clears the busy state and says the change may not have saved", async () => {
    const world = draftWorld();
    world.POST.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount(world);
    const dialog = await addProblemDialog();
    describeIt(dialog);
    save(dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("No response");
    expect(alert.textContent).toContain("may not have saved");
    expect(within(dialog).getByRole("button", { name: "Save problem" })).toBeEnabled();
  });

  it("does not leave a workspace read spinning forever: it shows the failure with a retry", async () => {
    const world = worldWith();
    let attempts = 0;
    world.intercept = (path) => {
      if (path !== "/api/v1/patients/{patientId}/care-plan") return undefined;
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return undefined;
    };
    mount(world);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await workspace()).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("reports a bootstrap that never answered instead of throwing", async () => {
    const world = worldWith({
      plan: null,
      admissions: {
        items: [{ id: "adm-1", state: "active", admissionAt: null, dischargedAt: null }],
      },
    });
    world.POST.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mount(world);
    fireEvent.click(await screen.findByRole("button", { name: "Start the care plan" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not start the care plan");
    expect(alert.textContent).toContain("No response");
    expect(screen.getByRole("button", { name: "Start the care plan" })).toBeEnabled();
  });
});

describe("a dialog with a write in flight", () => {
  it("cannot be dismissed by Escape or Close, and a scrim click never discards typed text", async () => {
    const world = draftWorld();
    const pending = deferred<ReturnType<typeof ok>>();
    world.POST.mockImplementationOnce(() => pending.promise);
    mount(world);
    const dialog = await addProblemDialog();
    describeIt(dialog);

    // Idle: the scrim must not throw away what was typed.
    const scrim = document.querySelector(".wx-modal-scrim > button") as HTMLElement;
    fireEvent.click(scrim);
    expect(screen.getByRole("dialog", { name: "Add problem" })).toBeTruthy();

    save(dialog);
    await waitFor(() => expect(world.POST).toHaveBeenCalled());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Add problem" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();

    await act(async () => pending.resolve(ok()));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add problem" })).toBeNull());
  });
});

describe("a stale write", () => {
  it("re-reads the plan, re-seeds the dialog with the current version and keeps the typed text", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, openDraft()], { problems: [problem({ version: 1 })] }),
    });
    world.PATCH.mockImplementationOnce(async () => {
      // Someone else saved first: the next read carries the new row version.
      world.plan = planOf([signedInitial, openDraft()], {
        problems: [problem({ version: 7, description: "Terminal cancer (edited)" })],
      });
      return refused(409, envelope("STALE_VERSION", "version 1 is stale"));
    });
    mount(world);
    await openProblemsTab();
    fireEvent.click(screen.getByLabelText("Actions for Terminal cancer"));
    fireEvent.click(screen.getByRole("button", { name: "Edit problem" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit problem" });
    describeIt(dialog, "My careful rewrite");
    save(dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("changed while you were working");
    expect(within(dialog).getByLabelText("Problem description")).toHaveValue("My careful rewrite");

    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save problem" })).toBeEnabled(),
    );
    save(dialog);
    await waitFor(() => expect(world.PATCH).toHaveBeenCalledTimes(2));
    expect(world.PATCH.mock.calls[1]?.[1]).toMatchObject({
      params: { header: { "If-Match": "7" } },
      body: { description: "My careful rewrite" },
    });
  });
});

describe("a write whose outcome the server could not confirm (IDEMPOTENCY_KEY_STUCK)", () => {
  it("re-reads the plan first, so the next click is judged against what the server holds", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, openDraft()], { problems: [problem({ version: 1 })] }),
    });
    world.PATCH.mockImplementationOnce(async () => {
      // The first attempt did commit, after its idempotency key gave up.
      world.plan = planOf([signedInitial, openDraft()], {
        problems: [problem({ version: 2, description: "Terminal cancer (committed late)" })],
      });
      return refused(409, envelope("IDEMPOTENCY_KEY_STUCK", "unknown outcome"));
    });
    mount(world);
    await openProblemsTab();
    fireEvent.click(screen.getByLabelText("Actions for Terminal cancer"));
    fireEvent.click(screen.getByRole("button", { name: "Edit problem" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit problem" });
    describeIt(dialog, "My careful rewrite");
    save(dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/could not confirm/);
    // The workspace behind the dialog now shows the row as the server holds it.
    await waitFor(() => expect(screen.queryAllByText(/committed late/).length).toBeGreaterThan(0));

    // …and a repeat quotes that version, not the one read before the write.
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save problem" })).toBeEnabled(),
    );
    save(dialog);
    await waitFor(() => expect(world.PATCH).toHaveBeenCalledTimes(2));
    expect(world.PATCH.mock.calls[1]?.[1]).toMatchObject({
      params: { header: { "If-Match": "2" } },
    });
  });
});

describe("a stale write does not revert what the user never edited", () => {
  const openGoalEditor = async (world: World) => {
    mount(world);
    await openProblemsTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return screen.findByRole("dialog", { name: "Edit goal" });
  };
  const goalText = (d: HTMLElement) => within(d).getByLabelText("Goal statement");
  const retryAfterStale = async (world: World, dialog: HTMLElement) => {
    await within(dialog).findByRole("alert");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save goal" })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(world.PATCH).toHaveBeenCalledTimes(2));
    return world.PATCH.mock.calls[1]?.[1];
  };

  it("sends only the edited field, and shows the other editor's change in the untouched ones", async () => {
    const world = draftWorld();
    world.PATCH.mockImplementationOnce(async () => {
      // The other editor moved the target date and saved first.
      world.plan = planOf([signedInitial, openDraft()], {
        goals: [goal({ version: 7, targetAt: "2027-01-15T00:00:00.000Z" })],
      });
      return refused(409, envelope("STALE_VERSION", "version 1 is stale"));
    });
    const dialog = await openGoalEditor(world);
    fireEvent.change(goalText(dialog), { target: { value: "Comfort at rest" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save goal" }));

    const retry = await retryAfterStale(world, dialog);
    expect(within(dialog).getByLabelText("Target date")).toHaveValue("2027-01-15");
    expect(retry).toMatchObject({
      params: { header: { "If-Match": "7" } },
      body: { revisedText: "Comfort at rest" },
    });
    // Nothing the user did not touch is written back over the other editor's value.
    expect(retry.body).toEqual({ revisedText: "Comfort at rest" });
  });

  it("does not keep a status the row has since moved past", async () => {
    const world = draftWorld();
    world.PATCH.mockImplementationOnce(async () => {
      world.plan = planOf([signedInitial, openDraft()], {
        goals: [goal({ version: 7, status: "met" })],
      });
      return refused(409, envelope("STALE_VERSION", "version 1 is stale"));
    });
    const dialog = await openGoalEditor(world);
    fireEvent.change(goalText(dialog), { target: { value: "Comfort at rest" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save goal" }));

    const retry = await retryAfterStale(world, dialog);
    expect(within(dialog).getByLabelText("Status")).toHaveValue("met");
    expect(retry.body).toEqual({ revisedText: "Comfort at rest" });
  });

  it("says so when the re-read itself failed, instead of claiming the latest is loaded", async () => {
    const world = draftWorld();
    world.PATCH.mockImplementationOnce(async () => {
      world.intercept = (path) =>
        path === "/api/v1/patients/{patientId}/care-plan"
          ? refused(503, envelope("UNAVAILABLE", "try later"))
          : undefined;
      return refused(409, envelope("STALE_VERSION", "version 1 is stale"));
    });
    const dialog = await openGoalEditor(world);
    fireEvent.change(goalText(dialog), { target: { value: "Comfort at rest" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save goal" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(alert.textContent).not.toContain("latest version is loaded");
  });

  it("will not save an unchanged form, and saves once something changes", async () => {
    const dialog = await openGoalEditor(draftWorld());
    expect(within(dialog).getByRole("button", { name: "Save goal" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Target date"), {
      target: { value: "2027-01-15" },
    });
    expect(within(dialog).getByRole("button", { name: "Save goal" })).toBeEnabled();
  });
});

describe("rows the server will not change offer no Edit", () => {
  it("hides Edit on a met goal and on a discontinued intervention", async () => {
    mount(
      draftWorld({
        plan: planOf([signedInitial, openDraft()], {
          goals: [goal({ status: "met" })],
          interventions: [intervention({ status: "discontinued" })],
        }),
      }),
    );
    await openProblemsTab();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit intervention" })).toBeNull();
  });
});

describe("what needs attention comes from the server's verdict", () => {
  it("does not flag a healthy signed plan for having no open version", async () => {
    mount(
      worldWith({
        readiness: readinessOf({
          openVersionId: null,
          openVersionStatus: undefined,
          blockers: [
            { code: "OPEN_VERSION_REQUIRED", message: "no draft or in-review version is open" },
          ],
        }),
      }),
    );
    expect(await screen.findByRole("heading", { name: "Care Plan is active" })).toBeTruthy();
    expect(screen.queryByText("Care Plan needs attention")).toBeNull();
  });

  it("does not demand a terminal problem of a revision the server is willing to send", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, openDraft()], {
        problems: [problem({ kind: "related" })],
      }),
    });
    mount(world);
    expect(await screen.findByRole("button", { name: "Send for physician review" })).toBeEnabled();
    expect(screen.queryByText(/Active terminal problem required/)).toBeNull();
  });
});

describe("calendar dates", () => {
  it("shows a goal's UTC-midnight target date as that day for a clinician west of UTC", async () => {
    mount(draftWorld());
    await openProblemsTab();
    expect(screen.getByText(/target Dec 1, 2026/)).toBeTruthy();
  });
});

describe("IDG proposals", () => {
  const idgDraft = openDraft({ kind: "idg_review" });
  const proposal = (over: Record<string, unknown> = {}) => ({
    id: "proposal-1",
    decisionId: "decision-1",
    meetingId: "meeting-1",
    sourceOutboxEventId: "event-1",
    status: "proposed",
    proposedAt: null,
    inReviewAt: null,
    appliedAt: null,
    conflictReason: null,
    ...over,
  });

  it("shows a failed proposed-changes read and does not infer that a change is required", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, idgDraft]),
      readiness: readinessOf({ canFinalize: true }),
    });
    world.intercept = (path) => (path.endsWith("/proposed-changes") ? refused(500, {}) : undefined);
    mount(world);
    await workspace();
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain(
      "Could not load the IDG proposed changes",
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    expect(screen.queryByText("Record IDG proposed changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Send to IDG team" })).toBeEnabled();
  });

  it("uses the server's blocker when a proposal really is required", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, idgDraft]),
      readiness: readinessOf({
        blockers: [{ code: "IDG_PROPOSAL_REQUIRED", message: "Record an IDG decision first." }],
      }),
    });
    mount(world);
    await workspace();
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    expect(screen.getByText("Record IDG proposed changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to IDG team" })).toBeDisabled();
  });

  it("shows a proposal in conflict with its reason and will not send over it", async () => {
    const world = draftWorld({
      plan: planOf([signedInitial, idgDraft]),
      readiness: readinessOf({ canFinalize: true }),
      proposed: {
        versionId: "version-draft",
        kind: "idg_review",
        meetingId: "meeting-1",
        status: "draft",
        proposals: [proposal({ status: "conflict", conflictReason: "baseline_changed" })],
        changes: [],
      },
    });
    mount(world);
    await workspace();
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    expect(
      screen.getAllByText(/the Care Plan changed after the IDG decision was recorded/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send to IDG team" })).toBeDisabled();
  });
});

describe("starting a care plan", () => {
  const openAdmission = {
    items: [{ id: "adm-1", state: "active", admissionAt: null, dischargedAt: null }],
  };

  it("offers no Start control without care_plan.bootstrap, and says why", async () => {
    mount(worldWith({ plan: null, admissions: openAdmission }), ["care_plan.read"]);
    await waitFor(() => expect(screen.getByText("No care plan yet")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Start the care plan" })).toBeNull();
    expect(screen.getByText(/your role cannot start one/i)).toBeTruthy();
  });

  it("does not claim 'admit the patient' when the admissions read failed, and offers a retry", async () => {
    const world = worldWith({ plan: null });
    let reads = 0;
    world.intercept = (path) => {
      if (path !== "/api/v1/patients/{patientId}/admissions") return undefined;
      reads += 1;
      return reads === 1 ? refused(500, envelope("INTERNAL", "admissions are down")) : undefined;
    };
    mount(world);
    expect(await screen.findByText("Could not check admissions")).toBeTruthy();
    expect(screen.getByText("admissions are down")).toBeTruthy();
    expect(screen.queryByText(/Admit the patient first/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("No care plan yet")).toBeTruthy());
  });

  it("shows the server's reason when the bootstrap is refused", async () => {
    const world = worldWith({ plan: null, admissions: openAdmission });
    world.POST.mockResolvedValueOnce(
      refused(403, envelope("FORBIDDEN", "This admission belongs to another team.")),
    );
    mount(world);
    fireEvent.click(await screen.findByRole("button", { name: "Start the care plan" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This admission belongs to another team.",
    );
  });
});

describe("signing", () => {
  const idgInReview = version({
    id: "version-draft",
    sequence: 3,
    kind: "idg_review",
    status: "in_review",
    requiredSignerSet: [
      { role: "rn_case_manager", count: 1 },
      { role: "msw", count: 1 },
    ],
    signatures: [],
    stateSnapshot: {
      problems: [{ id: "p1", description: "x", kind: "terminal", status: "active" }],
      goals: [],
      interventions: [],
    },
    version: 5,
  });
  const signingWorld = (open: Version = idgInReview): World =>
    worldWith({
      plan: planOf([signedInitial, open]),
      readiness: readinessOf({
        openVersionStatus: "in_review",
        canSign: true,
        signatures: {
          required: idgInReview.requiredSignerSet,
          collected: [],
          missing: idgInReview.requiredSignerSet,
        },
      }),
    });
  const openSignDialog = async () => {
    await workspace();
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Review & sign" })[0] as HTMLElement);
    return screen.findByRole("dialog", { name: "Sign Care Plan version" });
  };

  it("names the version being signed and what is in it", async () => {
    mount(signingWorld());
    const dialog = await openSignDialog();
    expect(within(dialog).getByText("v3 · Idg Review")).toBeTruthy();
    const counts = within(dialog).getByLabelText("Version being signed");
    expect(counts.textContent).toContain("Problems");
    expect(counts.textContent).toContain("1");
  });

  const withRedacted = (redacted: boolean): Version => ({
    ...idgInReview,
    stateSnapshot: { ...(idgInReview.stateSnapshot as object), redacted },
  });

  it("tells the signer that restricted content is left out of the counts they are signing", async () => {
    mount(signingWorld(withRedacted(true)));
    const dialog = await openSignDialog();
    expect(within(dialog).getByRole("note").textContent).toMatch(/Restricted content omitted/);
    // The counts still show what this caller may see.
    expect(within(dialog).getByLabelText("Version being signed").textContent).toContain("Problems");
  });

  it("shows no omission notice in the sign dialog when nothing was withheld", async () => {
    mount(signingWorld(withRedacted(false)));
    const dialog = await openSignDialog();
    expect(within(dialog).queryByRole("note")).toBeNull();
  });

  it("says the signature was recorded even when the re-read that follows gets no answer", async () => {
    const world = signingWorld();
    world.POST.mockResolvedValueOnce(ok({ ...idgInReview, status: "signed" }));
    mount(world);
    const dialog = await openSignDialog();
    // Only the re-read after the write fails; the first load already succeeded.
    world.intercept = (path) => {
      if (path !== "/api/v1/patients/{patientId}/care-plan") return undefined;
      throw new Error("network down");
    };
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign care plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Signature recorded.")).toBeTruthy();
    expect(
      screen.getByText(/Your change was saved, but the workspace could not be refreshed/),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No response — the Care Plan workspace could not be loaded/),
    ).toBeNull();

    // What is on screen is stale, so nothing writable stays live: a repeat of an entry that did save would
    // create it a second time under a new key.
    const guide = screen.getByRole("region", { name: "Care Plan next step" });
    for (const button of within(guide).getAllByRole("button")) expect(button).toBeDisabled();

    // Refresh re-reads, takes the warning away and hands the controls back.
    world.intercept = () => undefined;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull());
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
  });

  it("says the same when the re-read is refused, keeping the recorded notice", async () => {
    const world = signingWorld();
    world.POST.mockResolvedValueOnce(ok({ ...idgInReview, status: "signed" }));
    mount(world);
    const dialog = await openSignDialog();
    world.intercept = (path) =>
      path === "/api/v1/patients/{patientId}/care-plan"
        ? refused(500, envelope("INTERNAL", "boom"))
        : undefined;
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign care plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Signature recorded.")).toBeTruthy();
    expect(
      screen.getByText(/Your change was saved, but the workspace could not be refreshed/),
    ).toBeTruthy();
  });

  it("restores the typed note after the step-up round trip", async () => {
    const world = signingWorld();
    world.POST.mockResolvedValueOnce(
      refused(403, envelope("STEP_UP_REQUIRED", "Re-verify to continue.")),
    );
    mount(world);
    const dialog = await openSignDialog();
    fireEvent.change(within(dialog).getByLabelText("Patient/family understanding note"), {
      target: { value: "Family understands the plan." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign care plan" }));

    // The stub completes step-up and returns; the sign dialog reopens with the note intact.
    const reopened = await screen.findByRole("dialog", { name: "Sign Care Plan version" });
    expect(within(reopened).getByLabelText("Patient/family understanding note")).toHaveValue(
      "Family understands the plan.",
    );
  });

  it("trusts the re-read after a signature rather than fabricating an active plan", async () => {
    const world = signingWorld();
    world.POST.mockResolvedValueOnce(ok({ ...idgInReview, status: "signed" }));
    mount(world);
    const dialog = await openSignDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign care plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The server still reports the version in review (more signatures outstanding): so does the screen.
    expect(
      screen.getAllByText(/Team signatures pending|signer slots? remain/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Care Plan is active" })).toBeNull();
  });
});

describe("review wording follows who actually signs", () => {
  it("does not send an IDG review to 'the hospice physician'", async () => {
    mount(
      draftWorld({
        plan: planOf([signedInitial, openDraft({ kind: "idg_review" })]),
        readiness: readinessOf({ canFinalize: true }),
      }),
    );
    await workspace();
    expect(screen.queryByText(/hospice physician/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send for team signatures" })).toBeTruthy();
  });

  it("names the physician only when only a physician is outstanding", async () => {
    const inReview = openDraft({
      kind: "idg_review",
      status: "in_review",
      requiredSignerSet: [{ role: "hospice_physician|medical_director", count: 1 }],
    });
    mount(
      worldWith({
        plan: planOf([signedInitial, inReview]),
        readiness: readinessOf({
          openVersionStatus: "in_review",
          signatures: {
            required: inReview.requiredSignerSet,
            collected: [],
            missing: inReview.requiredSignerSet,
          },
        }),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Hospice physician review pending" }),
    ).toBeTruthy();
  });
});

describe("values the update contract cannot clear", () => {
  it("blocks saving a goal whose recorded measurable outcome was blanked, with a field message", async () => {
    mount(draftWorld());
    await openProblemsTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit goal" });
    fireEvent.change(within(dialog).getByLabelText("Measurable outcome"), {
      target: { value: "" },
    });

    expect(within(dialog).getByText(/can be changed but not cleared/)).toBeTruthy();
    expect(within(dialog).getByLabelText("Measurable outcome")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(within(dialog).getByRole("button", { name: "Save goal" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Measurable outcome"), {
      target: { value: "Pain 2/10" },
    });
    expect(within(dialog).getByRole("button", { name: "Save goal" })).toBeEnabled();
  });
});

describe("starting a revision", () => {
  const dueWorld = (): World =>
    worldWith({
      readiness: readinessOf({ openVersionId: null, openVersionStatus: undefined }),
      review: reviewOf({ status: "due", canStartReview: true }),
    });

  it("stays on the current tab and shows the refusal when the version could not be opened", async () => {
    const world = dueWorld();
    world.POST.mockResolvedValueOnce(
      refused(409, envelope("CONFLICT", "Another open revision already exists.")),
    );
    mount(world);
    fireEvent.click(await screen.findByRole("button", { name: "Start review" }));
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain(
      "Another open revision already exists.",
    );
    expect(screen.getByRole("tab", { name: /^Goals/ })).toHaveAttribute("aria-selected", "true");
  });

  it("disables every start control while a version is being opened", async () => {
    const world = dueWorld();
    const pending = deferred<ReturnType<typeof ok>>();
    world.POST.mockImplementationOnce(() => pending.promise);
    mount(world);
    fireEvent.click(await screen.findByRole("button", { name: "Start review" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Review & Sign/ }));
    expect(screen.getByRole("button", { name: "Document condition change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start scheduled review" })).toBeDisabled();
    await act(async () => pending.resolve(ok()));
  });
});

describe("accessibility", () => {
  it("is a tabs pattern: one tab stop, arrow keys, and a panel the active tab controls", async () => {
    mount(draftWorld());
    await workspace();
    const goals = screen.getByRole("tab", { name: /^Goals/ });
    const interventions = screen.getByRole("tab", { name: /^Interventions/ });
    expect(goals).toHaveAttribute("tabindex", "0");
    expect(interventions).toHaveAttribute("tabindex", "-1");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", goals.id);
    expect(goals).toHaveAttribute("aria-controls", panel.id);

    goals.focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(interventions).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(interventions);
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(screen.getByRole("tab", { name: "Revisions" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(screen.getByRole("tab", { name: /^Goals/ })).toHaveAttribute("aria-selected", "true");
  });

  it("closes a row's ⋯ menu when an item is chosen and on Escape", async () => {
    mount(draftWorld());
    await openProblemsTab();
    const toggle = screen.getByLabelText("Actions for Terminal cancer");
    const menu = toggle.closest("details") as HTMLDetailsElement;

    fireEvent.click(toggle);
    expect(menu.open).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(menu.open).toBe(false);

    fireEvent.click(toggle);
    expect(menu.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit problem" }));
    expect(menu.open).toBe(false);
  });

  it("ties a field error to its own input, and only that input", async () => {
    const world = draftWorld();
    world.POST.mockResolvedValueOnce(
      refused(
        422,
        envelope("VALIDATION_FAILED", "invalid", [
          {
            field: "description",
            code: "too_short",
            message: "Describe the problem in more detail.",
          },
        ]),
      ),
    );
    mount(world);
    const dialog = await addProblemDialog();
    describeIt(dialog);
    save(dialog);

    const description = await waitFor(() => {
      const el = within(dialog).getByLabelText("Problem description");
      expect(el).toHaveAttribute("aria-invalid", "true");
      return el;
    });
    const describedBy = description.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Describe the problem in more detail.",
    );
    expect(within(dialog).getByLabelText("Problem type")).not.toHaveAttribute("aria-invalid");
  });

  it("does not print a message under every input whose name it happens to contain", async () => {
    const world = draftWorld();
    world.POST.mockResolvedValueOnce(
      refused(
        422,
        envelope(
          "VALIDATION_FAILED",
          "body/kind must be equal to one of the allowed values (see description)",
        ),
      ),
    );
    mount(world);
    const dialog = await addProblemDialog();
    describeIt(dialog);
    save(dialog);

    await waitFor(() =>
      expect(within(dialog).getByLabelText("Problem type")).toHaveAttribute("aria-invalid", "true"),
    );
    expect(within(dialog).getByLabelText("Problem description")).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("refreshes in place after a write instead of unmounting the workspace", async () => {
    mount(draftWorld());
    const dialog = await addProblemDialog();
    const tablist = screen.getByRole("tablist");
    describeIt(dialog);
    save(dialog);
    expect(await screen.findByText("Problem added.")).toBeTruthy();
    expect(screen.getByRole("tablist")).toBe(tablist);
  });
});
