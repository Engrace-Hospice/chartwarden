import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/16-bereavement — the assessment-checkpoint panel and completion form on the risk view
// (ADR-0109 D3/D5): the d28 initial and d180 midpoint assessments, eight tri-state factors, an optional PG-13 total, the
// midpoint's delayed-grief prompt, and provenance from the pre-death draft.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavementRiskView } from "./risk-view";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const ADMISSION_ID = "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809";
const ROBIN = "3c4d5e6f-7081-4a92-a3b4-c5d6e7f80910";
const SAM = "4d5e6f70-8192-4ba3-b4c5-d6e7f8091021";
const INITIAL_TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const MIDPOINT_TASK = "aaaaaaaa-0000-4000-8000-000000000002";
const DONE_TASK = "aaaaaaaa-0000-4000-8000-000000000003";
const CARRIED_SCORE = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_SCORE = "bbbbbbbb-0000-4000-8000-000000000002";

const contact = (contactId: string, displayName: string) => ({
  contactId,
  planId: PLAN_ID,
  status: "active",
  displayName,
  relationshipCode: "friend",
  preferredLanguageIso639: "en",
  portalAccountId: null,
  consentRecordId: null,
  allowedOutreachKinds: ["phone_call"],
  volunteerVisibleOnly: false,
  confirmedAt: "2026-06-03T00:00:00.000Z",
  optedOutAt: null,
  unreachableAt: null,
  unreachableProposed: false,
  unreachableProposedAt: null,
  deceasedAt: null,
  mayRescindOptOut: false,
  mailingsAllowed: true,
  currentRiskTier: "moderate",
  version: 2,
});

const PLAN = {
  planId: PLAN_ID,
  patientId: "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
  admissionId: ADMISSION_ID,
  providerEntityId: null,
  status: "active",
  deathDate: "2026-06-01",
  deathTime: null,
  windowEndsAt: "2027-06-01T00:00:00.000Z",
  openedAt: "2026-06-02T00:00:00.000Z",
  currentRiskTier: "moderate",
  firstContactAllowed: true,
  contacts: [contact(ROBIN, "Robin Vale"), contact(SAM, "Sam Reed")],
  stats: { contactsActiveCount: 2, contactsOptedOutCount: 0, completedCount: 0, missedCount: 0 },
  version: 3,
  updatedAt: "2026-08-01T00:00:00.000Z",
  redactedCategories: [],
};

const task = (over: Record<string, unknown>) => ({
  taskId: INITIAL_TASK,
  planId: PLAN_ID,
  contactId: ROBIN,
  taskKind: "initial_assessment",
  status: "scheduled",
  dueAt: "2026-06-29T00:00:00.000Z",
  lateGraceUntil: "2026-07-06T00:00:00.000Z",
  completedAt: null,
  completedByMembershipId: null,
  riskScoreId: null,
  assigneeUserId: null,
  version: 0,
  ...over,
});

const TASKS = [
  task({}),
  task({
    taskId: MIDPOINT_TASK,
    contactId: SAM,
    taskKind: "midpoint_reassessment",
    status: "missed",
    dueAt: "2026-11-28T00:00:00.000Z",
  }),
  task({
    taskId: DONE_TASK,
    contactId: SAM,
    status: "completed",
    completedAt: "2026-07-01T00:00:00.000Z",
    riskScoreId: OTHER_SCORE,
  }),
];

const score = (scoreId: string, contactId: string | null) => ({
  scoreId,
  planId: PLAN_ID,
  contactId,
  scoreKind: "rule_deterministic",
  assessedAt: "2026-06-02T00:00:00.000Z",
  assessedByUserId: null,
  tier: "moderate",
  deterministicTier: "moderate",
  ruleScore: 30,
  dataCompleteness: "partial",
  confidenceBand: "MEDIUM",
  factors: { ambivalent_relationship: true },
  pg13Score: null,
  ipgrScore: null,
  evidenceDegraded: false,
  redactedCategories: [],
});

const DRAFT = {
  admissionId: ADMISSION_ID,
  exists: true,
  factors: {
    ambivalent_relationship: true,
    sudden_unexpected_death: "unknown",
    prior_unresolved_loss: false,
    preexisting_mental_health: true,
    social_isolation: false,
    financial_strain: "unknown",
    primary_caregiver_role: true,
    active_substance_use: "unknown",
  },
  lastEditedDiscipline: "medical_social_worker",
  lastEditedAt: "2026-05-20T00:00:00.000Z",
  carriedScoreId: CARRIED_SCORE,
  carriedAt: "2026-06-02T00:00:00.000Z",
  locked: true,
  version: 2,
  redactedCategories: ["sud"],
};

interface Opts {
  tasks?: unknown;
  draft?: "ok" | "404";
  /** The ledger rows for a scope filter (null = every score on the plan). */
  scoresFor?: (contactId: string | null) => unknown[];
  /** The ledger request for this contact filter is held until the promise settles. */
  hold?: { contactId: string; until: Promise<void> };
}

function mount(opts: Opts = {}): { posts: { path: string; body: Record<string, unknown> }[] } {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST") {
      const text = req ? await req.text() : String(init?.body ?? "");
      posts.push({ path: url.pathname, body: text ? JSON.parse(text) : {} });
      return reply(score(crypto.randomUUID(), ROBIN), 201);
    }
    if (url.pathname.endsWith("/assessment-tasks")) {
      return reply(opts.tasks ?? { items: TASKS, redactedCategories: [] });
    }
    if (url.pathname.includes("/pre-death-assessments/")) {
      return opts.draft === "404" ? reply({ message: "not found" }, 404) : reply(DRAFT);
    }
    if (url.pathname.endsWith("/risk-scores")) {
      const wanted = url.searchParams.get("contactId");
      if (opts.hold && wanted === opts.hold.contactId) await opts.hold.until;
      return reply({
        data: opts.scoresFor?.(wanted) ?? [score(CARRIED_SCORE, null), score(OTHER_SCORE, SAM)],
        next_cursor: null,
        has_more: false,
      });
    }
    return reply(PLAN);
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1" }}>
        <MemoryRouter initialEntries={[`/bereavement/plans/${PLAN_ID}/risk`]}>
          <Routes>
            <Route path="/bereavement/plans/:planId/risk" element={<BereavementRiskView />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { posts };
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("risk view — assessment checkpoints", () => {
  it("lists each checkpoint with its contact, due date and status; only open ones can be completed", async () => {
    mount();
    const panel = (await screen.findByRole("heading", { name: /Assessment checkpoints/ })).closest(
      "section",
    ) as HTMLElement;
    expect(within(panel).getAllByText("Initial assessment (day 28)").length).toBe(2);
    expect(within(panel).getByText("Midpoint reassessment (day 180)")).toBeTruthy();
    expect(within(panel).getByText("Missed")).toBeTruthy();
    expect(within(panel).getByText("Completed")).toBeTruthy();
    // scheduled + missed are completable; the completed one is not
    expect(within(panel).getAllByRole("button", { name: /^Complete assessment: / })).toHaveLength(
      2,
    );
  });

  it("says so when the scope holds no clinical content, without claiming there are none ('(0)')", async () => {
    mount({ tasks: { items: [], redactedCategories: ["clinical_risk"] } });
    expect(await screen.findByText(/not shown in your scope/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Assessment checkpoints" })).toBeTruthy();
  });

  it("names each Complete button for its checkpoint and survivor", async () => {
    mount();
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels).toContain("Complete assessment: Initial assessment (day 28) for Robin Vale");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("after completing, the page reloads in place (nothing unmounts) and focus lands on the status line", async () => {
    mount();
    const heading = await screen.findByRole("heading", { name: /Assessment checkpoints/ });
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    fireEvent.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete assessment" }));
    const status = await screen.findByText(
      "The assessment was recorded and the checkpoint is complete.",
    );
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(screen.getByRole("heading", { name: /Assessment checkpoints/ })).toBe(heading);
  });

  it("a slow ledger response for a previous scope never overwrites the scope now selected", async () => {
    let release: () => void = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows = (contactId: string | null) => [
      { ...score(crypto.randomUUID(), contactId), ruleScore: contactId === ROBIN ? 41 : 77 },
    ];
    mount({ scoresFor: rows, hold: { contactId: ROBIN, until } });
    const scope = await screen.findByLabelText("Scope");
    fireEvent.change(scope, { target: { value: ROBIN } }); // held
    fireEvent.change(scope, { target: { value: SAM } }); // answers at once
    await waitFor(() => expect(screen.queryAllByText("77").length).toBeGreaterThan(0));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryAllByText("41")).toHaveLength(0);
    expect(screen.queryAllByText("77").length).toBeGreaterThan(0);
  });

  it("completing the INITIAL assessment posts the task, its contact and all eight factors, prefilled from the draft", async () => {
    const { posts } = mount();
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    fireEvent.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Complete initial assessment")).toBeTruthy();
    // the contact is the task's; there is no scope picker and no "supply factors" switch
    expect(within(dialog).queryByLabelText("Scope")).toBeNull();
    expect(within(dialog).getByText(/Robin Vale/)).toBeTruthy();
    // provenance: the factors came from the pre-death draft
    expect(within(dialog).getByText(/from pre-death draft/i)).toBeTruthy();
    expect(
      (
        within(dialog).getByLabelText(
          "Ambivalent relationship with the decedent",
        ) as HTMLSelectElement
      ).value,
    ).toBe("true");
    expect(
      (within(dialog).getByLabelText("Prior unresolved loss") as HTMLSelectElement).value,
    ).toBe("false");
    // a clinician states what they observed (change one factor, add the optional PG-13 total)
    fireEvent.change(within(dialog).getByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.change(within(dialog).getByLabelText("PG-13 total (optional, 0–52)"), {
      target: { value: "18" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete assessment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.path).toBe(`/api/v1/bereavement/plans/${PLAN_ID}/recompute-risk`);
    expect(posts[0]?.body).toMatchObject({
      bereavedContactId: ROBIN,
      assessmentTaskId: INITIAL_TASK,
      factors: {
        ambivalent_relationship: true,
        sudden_unexpected_death: "unknown",
        prior_unresolved_loss: false,
        preexisting_mental_health: true,
        social_isolation: false,
        financial_strain: true,
        primary_caregiver_role: true,
        active_substance_use: "unknown",
        pg13_score: 18,
      },
    });
  });

  it("without a draft (404) nothing is prefilled and no provenance is claimed", async () => {
    mount({ draft: "404" });
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    fireEvent.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/from pre-death draft/i)).toBeNull();
    expect(
      (
        within(dialog).getByLabelText(
          "Ambivalent relationship with the decedent",
        ) as HTMLSelectElement
      ).value,
    ).toBe("unknown");
  });

  it("the MIDPOINT asks about delayed-grief signs; 'yes' makes the PG-13 total required", async () => {
    const { posts } = mount();
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    fireEvent.click(buttons[1]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Complete midpoint reassessment")).toBeTruthy();
    const prompt = within(dialog).getByLabelText("Any signs of delayed or prolonged grief?");
    const submit = within(dialog).getByRole("button", {
      name: "Complete assessment",
    }) as HTMLButtonElement;
    // the prompt must be answered before the reassessment can be completed
    expect(submit.disabled).toBe(true);
    fireEvent.change(prompt, { target: { value: "yes" } });
    expect(within(dialog).getByText(/enter the PG-13 total/i)).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("PG-13 total (required, 0–52)"), {
      target: { value: "27" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toMatchObject({
      bereavedContactId: SAM,
      assessmentTaskId: MIDPOINT_TASK,
      factors: { pg13_score: 27 },
    });
  });

  it("answering 'no' to the delayed-grief prompt lets the midpoint be completed without a total", async () => {
    const { posts } = mount();
    const buttons = await screen.findAllByRole("button", { name: /^Complete assessment: / });
    fireEvent.click(buttons[1]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Any signs of delayed or prolonged grief?"), {
      target: { value: "no" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete assessment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0]?.body.factors as Record<string, unknown>).pg13_score).toBeUndefined();
  });
});

describe("risk view — pre-death provenance on the ledger", () => {
  it("marks the score that consumed the pre-death draft, and only that one", async () => {
    mount();
    expect(await screen.findByText("from pre-death draft")).toBeTruthy();
    expect(screen.getAllByText("from pre-death draft")).toHaveLength(1);
  });

  it("claims no provenance when the draft cannot be read", async () => {
    mount({ draft: "404" });
    await screen.findByText(/Score ledger/);
    expect(screen.queryByText("from pre-death draft")).toBeNull();
  });
});
