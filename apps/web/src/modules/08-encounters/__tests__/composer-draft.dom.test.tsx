// The visit-note composer with the pre-drafted sections (ADR-0114, S1 PR D): the drafted text with its origin and state, confirm and
// deselect against the hash the clinician saw, a stale answer re-reading the draft, the gate's per-section refusals, the care-plan
// picker and the score trend, and the composer exactly as before when the tenant switch is off or nothing was drafted.
// The net asserts on RECORDED FETCH CALLS (method, path, body). Synthetic data only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterCompose } from "../encounter-compose";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

// axe walks the whole composer subtree in jsdom, which is slow on a busy machine; the default 50s was not always enough.
const AXE_TEST_TIMEOUT_MS = 180_000;
const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const LINK_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const GOAL_ID = "dddddddd-4444-4444-8444-dddddddddddd";
const INTERVENTION_ID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const BASE = `/api/v1/encounters/${ENC}`;
const CORPUS = "2026.1.0";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

type Section = {
  sectionId: string;
  state: string;
  text: string | null;
  contentHash: string | null;
  corpusVersion: string | null;
  part2Derived: boolean | null;
  origins: string[];
};

const drafted = (over: Partial<Section> & { sectionId: string }): Section => ({
  state: "unresolved",
  text: "Drafted sentence.",
  contentHash: `hash-${over.sectionId}-1`,
  corpusVersion: CORPUS,
  part2Derived: false,
  origins: ["care_plan_goal"],
  ...over,
});

const empty = (sectionId: string): Section => ({
  sectionId,
  state: "not_drafted",
  text: null,
  contentHash: null,
  corpusVersion: null,
  part2Derived: null,
  origins: [],
});

const PLAN_TEXT = "Goal in place: comfort at rest.";
const VITALS_TEXT = "Blood pressure 118 over 72. Heart rate 76.";

const template = {
  encounterId: ENC,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    ["chief_concern", "Reason for Visit", false],
    ["vitals_review", "Vital Signs Review", false],
    ["assessment", "Assessment", true],
    ["interventions", "Interventions", false],
    ["plan", "Plan and Next Visit", false],
  ].map(([sectionId, heading, required]) => ({
    sectionId,
    heading,
    required,
    allowedCategories: [],
    entries:
      sectionId === "assessment"
        ? [
            {
              code: "nv.resp.dyspnea_at_rest",
              label: "Dyspnea at rest",
              category: "observation",
              bodySystem: null,
              slots: [],
            },
          ]
        : [],
  })),
};

interface World {
  status: string;
  serviceDate: string;
  draftSections: Section[];
  links: {
    id: string;
    encounterId: string;
    goalId: string | null;
    interventionId: string | null;
    problemId: null;
    createdAt: string;
  }[];
  scales: Record<string, { capturedAt: string; score: number | null }[]>;
}

let world: World;
let calls: Call[];

const link = (goalId: string | null, interventionId: string | null, id = LINK_ID) => ({
  id,
  encounterId: ENC,
  goalId,
  interventionId,
  problemId: null,
  createdAt: "2026-11-17T10:00:00Z",
});

const draftBody = (): Record<string, unknown> => ({
  encounterId: ENC,
  patientId: PATIENT,
  templateKey: "routine_visit:rn",
  asOf: "2026-11-17T23:59:59.999Z",
  sections: world.draftSections,
});

const errorBody = (status: number, code: string, details: unknown[] = []) => ({
  status,
  body: { error: { code, message: "refused", details } },
});

const sectionPut =
  (sectionId: string, answer?: Responder): Responder =>
  (call) => {
    if (answer) return answer(call);
    const body = call.body as { resolution: string };
    const index = world.draftSections.findIndex((s) => s.sectionId === sectionId);
    const current = world.draftSections[index] as Section;
    const next: Section = { ...current, state: body.resolution };
    world.draftSections = world.draftSections.map((s, i) => (i === index ? next : s));
    return { body: next };
  };

function routes(over: Record<string, Responder> = {}): Record<string, Responder> {
  return {
    [`GET ${BASE}`]: () => ({
      body: {
        id: ENC,
        organizationId: "org-1",
        patientId: PATIENT,
        admissionId: "adm-1",
        visitId: null,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: world.serviceDate,
        status: world.status,
        lateEntryTier: "on_time",
        version: 3,
        authoredByUserId: "user-1",
        isF2f: false,
        signedAt: null,
        cosignedAt: null,
      },
    }),
    [`GET ${BASE}/template`]: () => ({ body: template }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: template.templateKey,
        vocabVersion: template.vocabVersion,
        sections: [],
        layer1Preview: "",
        version: 3,
      },
    }),
    [`PATCH ${BASE}/selections`]: () => ({ body: { version: 4, layer1Preview: "Saved." } }),
    [`POST ${BASE}/finalize`]: () => ({ body: { status: "finalized", version: 5 } }),
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
    }),
    [`GET ${BASE}/draft`]: () => ({ body: draftBody() }),
    [`PUT ${BASE}/draft/sections/plan`]: sectionPut("plan"),
    [`PUT ${BASE}/draft/sections/vitals_review`]: sectionPut("vitals_review"),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: world.links } }),
    [`POST ${BASE}/care-plan-links`]: (call) => {
      const body = call.body as { goalId?: string; interventionId?: string };
      const created = link(body.goalId ?? null, body.interventionId ?? null);
      world.links = [...world.links, created];
      return { status: 201, body: created };
    },
    [`DELETE ${BASE}/care-plan-links/${LINK_ID}`]: () => {
      world.links = world.links.filter((l) => l.id !== LINK_ID);
      return { body: {} };
    },
    "GET /api/v1/internal/care-plan/relevant-elements": () => ({
      body: {
        planId: "plan-1",
        patientId: PATIENT,
        problems: [],
        goals: [
          {
            goalId: GOAL_ID,
            problemId: "prob-1",
            text: "Keep the patient comfortable at rest",
            source: "clinical",
            status: "in_progress",
          },
        ],
        interventions: [
          {
            interventionId: INTERVENTION_ID,
            problemId: "prob-1",
            scopeText: "Assess breathlessness",
            frequencyText: "each visit",
            discipline: "rn",
            status: "active",
          },
        ],
        redacted: false,
      },
    }),
    ...(["pps", "esas_r"] as const).reduce<Record<string, Responder>>((acc, scale) => {
      acc[`GET /api/v1/patients/${PATIENT}/scales/${scale}/series`] = () => ({
        body: {
          scaleType: scale,
          patientId: PATIENT,
          from: "2026-08-19T00:00:00.000Z",
          to: "2026-11-17T23:59:59.999Z",
          points: (world.scales[scale] ?? []).map((p, i) => ({
            assessmentId: `a-${scale}-${i}`,
            capturedAt: p.capturedAt,
            score: p.score,
            scoreInterpretation: null,
            significantChange: false,
          })),
        },
      });
      return acc;
    }, {}),
    ...over,
  };
}

function mountComposer(over: Record<string, Responder> = {}): void {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(routes(over), calls),
  });
  const router = createMemoryRouter(
    [
      {
        path: "/patients/:patientId/encounters/:encounterId/compose",
        element: <EncounterCompose />,
      },
      { path: "*", element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [`/patients/${PATIENT}/encounters/${ENC}/compose`] },
  );
  render(
    <ApiClientProvider client={client}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const ready = (): Promise<unknown> => screen.findByRole("heading", { name: "Compose visit note" });
const sectionList = async (): Promise<HTMLElement> =>
  screen.findByRole("complementary", { name: "Visit note sections" });
const openSection = async (user: ReturnType<typeof userEvent.setup>, heading: RegExp) => {
  await user.click(await within(await sectionList()).findByRole("button", { name: heading }));
};
const callsTo = (method: string, suffix: string): Call[] =>
  calls.filter((c) => c.method === method && c.path.endsWith(suffix));

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}
/** A promise a test settles by hand, to hold a request in flight. */
function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const consoleSpies = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  calls = [];
  world = {
    status: "draft",
    serviceDate: "2026-11-17",
    draftSections: [
      empty("chief_concern"),
      drafted({ sectionId: "vitals_review", origins: ["vitals"], text: VITALS_TEXT }),
      empty("assessment"),
      empty("interventions"),
      drafted({ sectionId: "plan", text: PLAN_TEXT }),
    ],
    links: [],
    scales: {
      pps: [
        { capturedAt: "2026-11-10T10:00:00Z", score: 60 },
        { capturedAt: "2026-11-16T10:00:00Z", score: 50 },
      ],
      esas_r: [],
    },
  };
  spies = consoleSpies.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});

afterEach(() => {
  // PHI never reaches a console: not the drafted text, not an id, nothing.
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
});

describe("a drafted section", () => {
  it("shows the drafted text, where it came from and its state", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);

    const panel = await screen.findByRole("region", { name: "Pre-drafted from the record" });
    expect(within(panel).getByText(PLAN_TEXT)).toBeInTheDocument();
    expect(within(panel).getByText(/Built from care plan goals\./)).toBeInTheDocument();
    expect(within(panel).getByText("Needs your review")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Confirm section" })).toBeEnabled();
    expect(within(panel).getByRole("button", { name: "Deselect section" })).toBeEnabled();
  });

  it("names every drafted section's state in the section list", async () => {
    mountComposer();
    await ready();
    const list = await sectionList();
    expect(
      await within(list).findByRole("button", {
        name: /^Vital Signs Review.*draft needs your review/,
      }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: /^Plan and Next Visit.*draft needs your review/ }),
    ).toBeInTheDocument();
    // A section with nothing drafted keeps its plain label.
    expect(
      within(list).getByRole("button", { name: "Reason for Visit: Not started" }),
    ).toBeInTheDocument();
  });

  it("counts the drafted sections that are resolved and lists the rest", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    const summary = await screen.findByRole("region", { name: "Drafted sections" });
    expect(within(summary).getByText(/0 of 2/)).toBeInTheDocument();
    expect(within(summary).getByText(/Signing stays blocked/)).toBeInTheDocument();

    // Each unresolved section is a button that opens it.
    await user.click(within(summary).getByRole("button", { name: "Plan and Next Visit" }));
    expect(await screen.findByText(PLAN_TEXT)).toBeInTheDocument();
  });

  it("says a section with nothing to draft from has nothing, once the note is drafted elsewhere", async () => {
    mountComposer();
    await ready();
    // The first section the composer opens is chief_concern, which has no source.
    expect(
      await screen.findByText(/nothing in the record to draft this section from/i),
    ).toBeInTheDocument();
  });
});

describe("confirm and deselect", () => {
  it("confirms against the hash and corpus version the clinician saw, then moves focus to the section heading", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);

    await user.click(await screen.findByRole("button", { name: "Confirm section" }));

    await waitFor(() => expect(callsTo("PUT", "/draft/sections/plan")).toHaveLength(1));
    expect(callsTo("PUT", "/draft/sections/plan")[0]?.body).toEqual({
      resolution: "confirmed",
      contentHash: "hash-plan-1",
      corpusVersion: CORPUS,
    });
    const panel = await screen.findByRole("region", { name: "Pre-drafted from the record" });
    expect(await within(panel).findByText("Confirmed")).toBeInTheDocument();
    expect(
      within(panel).getByText(/The note will read exactly what you saw here/),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Confirm section" })).toBeNull();
    expect(
      within(panel).getByRole("heading", { name: "Pre-drafted from the record" }),
    ).toHaveFocus();
    const summary = screen.getByRole("region", { name: "Drafted sections" });
    expect(within(summary).getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("works from the keyboard alone", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const confirm = await screen.findByRole("button", { name: "Confirm section" });
    confirm.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Confirmed")).toBeInTheDocument();
  });

  it("deselects: the drafted text is shown as left out, and a care-plan deselect re-reads the picker's links", async () => {
    const user = userEvent.setup();
    world.links = [link(GOAL_ID, null)];
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const picker = await screen.findByRole("heading", { name: "Care plan for this visit" });
    const goal = await within(picker.closest("section") as HTMLElement).findByRole("checkbox", {
      name: "Keep the patient comfortable at rest",
    });
    expect(goal).toBeChecked();
    const linkReads = callsTo("GET", "/care-plan-links").length;

    expect(
      screen.getByText(/unlinks this section's care-plan goals and interventions/),
    ).toBeInTheDocument();
    // The server's deselect unlinks the goal; the picker must show that.
    world.links = [];
    await user.click(screen.getByRole("button", { name: "Deselect section" }));

    expect(callsTo("PUT", "/draft/sections/plan")[0]?.body).toMatchObject({
      resolution: "deselected",
    });
    expect(await screen.findByText(/Left out of the note:/)).toBeInTheDocument();
    expect(
      screen.getByText(/Its care-plan items were unlinked from this visit/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(callsTo("GET", "/care-plan-links").length).toBeGreaterThan(linkReads),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
      ).not.toBeChecked(),
    );
    // And it offers the way back for the section's remaining text.
    expect(screen.getByRole("button", { name: "Confirm section" })).toBeInTheDocument();
  });

  it("explains a section the deselect left empty", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`PUT ${BASE}/draft/sections/plan`]: () => {
        world.draftSections = world.draftSections.map((s) =>
          s.sectionId === "plan" ? empty("plan") : s,
        );
        return { body: empty("plan") };
      },
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    await user.click(await screen.findByRole("button", { name: "Deselect section" }));
    expect(await screen.findByText(/Nothing is left to draft in it/)).toBeInTheDocument();
    // The heading the focus was on is gone with the drafted text: focus lands on the region that replaced it, not on the page.
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Pre-drafted from the record" })).toHaveFocus(),
    );
  });
});

describe("a section whose inputs changed", () => {
  it("says so and shows what to do: re-read, then confirm again", async () => {
    const user = userEvent.setup();
    world.draftSections = world.draftSections.map((s) =>
      s.sectionId === "plan" ? { ...s, state: "needs_reconfirmation" } : s,
    );
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const panel = await screen.findByRole("region", { name: "Pre-drafted from the record" });
    expect(within(panel).getByText("Changed, review again")).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /changed after you resolved it\. Re-read the text below, then confirm it again/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Confirm again" })).toBeInTheDocument();
  });

  it("re-reads the draft and explains when a confirm answers 409 DRAFT_SECTION_STALE", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`PUT ${BASE}/draft/sections/plan`]: () => {
        // Someone linked another goal while this was open: the text and its hash moved.
        world.draftSections = world.draftSections.map((s) =>
          s.sectionId === "plan"
            ? {
                ...s,
                text: "Goals in place: comfort at rest and a quiet room.",
                contentHash: "hash-plan-2",
              }
            : s,
        );
        return errorBody(409, "DRAFT_SECTION_STALE");
      },
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const reads = callsTo("GET", "/draft").length;

    await user.click(await screen.findByRole("button", { name: "Confirm section" }));

    expect(
      await screen.findByText(/changed after you opened it, so nothing was recorded/),
    ).toBeInTheDocument();
    await waitFor(() => expect(callsTo("GET", "/draft").length).toBeGreaterThan(reads));
    expect(
      await screen.findByText("Goals in place: comfort at rest and a quiet room."),
    ).toBeInTheDocument();
    // The next confirm carries the NEW hash.
    await user.click(screen.getByRole("button", { name: "Confirm section" }));
    await waitFor(() => expect(callsTo("PUT", "/draft/sections/plan")).toHaveLength(2));
    expect(callsTo("PUT", "/draft/sections/plan")[1]?.body).toMatchObject({
      contentHash: "hash-plan-2",
    });
  });

  it("shows a plain sentence, and keeps the section as it was, on any other refusal", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`PUT ${BASE}/draft/sections/plan`]: () => errorBody(503, "DRAFT_UNAVAILABLE"),
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    await user.click(await screen.findByRole("button", { name: "Confirm section" }));
    expect(
      await screen.findByText(/could not be checked right now\. Nothing was changed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm section" })).toBeEnabled();
  });

  it("falls back to the plain composer when the switch is turned off mid-session", async () => {
    const user = userEvent.setup();
    mountComposer({ [`PUT ${BASE}/draft/sections/plan`]: () => errorBody(404, "NOT_FOUND") });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    await user.click(await screen.findByRole("button", { name: "Confirm section" }));
    await waitFor(() => expect(screen.queryByText(PLAN_TEXT)).toBeNull());
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
  });
});

describe("finalizing with drafted sections", () => {
  it("names each section the gate refused, in words, and re-reads the draft", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/finalize`]: () =>
        errorBody(422, "COMPLIANCE_GATE_FAILED", [
          { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "x" },
          { field: "vitals_review", code: "DRAFT_SECTION_STALE", message: "y" },
        ]),
    });
    await ready();
    const reads = callsTo("GET", "/draft").length;
    await user.click(screen.getByRole("button", { name: "Finalize note" }));

    expect(
      await screen.findByText(/Plan and Next Visit \(not confirmed or deselected yet\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Vital Signs Review \(changed since you resolved it\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Drafted sections need your review")).toBeInTheDocument();
    await waitFor(() => expect(callsTo("GET", "/draft").length).toBeGreaterThan(reads));
  });

  it("repeats the first refusal that is not about the draft, so nothing the gate listed is hidden", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/finalize`]: () =>
        errorBody(422, "COMPLIANCE_GATE_FAILED", [
          {
            field: "vitals",
            code: "VITALS_REQUIRED",
            message: "Vitals are required for this visit",
          },
          { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "x" },
        ]),
    });
    await ready();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(
      await screen.findByText(/Also: Vitals: Vitals are required for this visit/),
    ).toBeInTheDocument();
  });

  it("will not confirm while there are unsaved edits, and says why", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Assessment/);
    await user.click(await screen.findByRole("checkbox", { name: /Dyspnea at rest/ }));
    await openSection(user, /^Plan and Next Visit/);

    const confirm = await screen.findByRole("button", { name: "Confirm section" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Save the draft first/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm section" })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
    // A save changes the section the clinician's words are in, so the draft is re-read.
    expect(callsTo("GET", "/draft").length).toBeGreaterThan(1);
  });

  it("lets a finalized note still be resolved (the server allows it), but not a signed one", async () => {
    const user = userEvent.setup();
    world.status = "finalized";
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    expect(await screen.findByRole("button", { name: "Confirm section" })).toBeEnabled();
  });

  it("shows a signed note's drafted text read-only", async () => {
    const user = userEvent.setup();
    world.status = "signed";
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    expect(await screen.findByRole("button", { name: "Confirm section" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
  });
});

describe("the composer as before", () => {
  const noExtras = (): void => {
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pre-drafted from the record" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Care plan for this visit" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Scores and trend" })).toBeNull();
    expect(callsTo("GET", "/care-plan-links")).toHaveLength(0);
    expect(callsTo("GET", "/care-plan/relevant-elements")).toHaveLength(0);
    expect(calls.filter((c) => c.path.includes("/scales/"))).toHaveLength(0);
  };

  it("adds nothing, and asks for nothing, when the tenant has the draft switched off", async () => {
    mountComposer({ [`GET ${BASE}/draft`]: () => errorBody(404, "NOT_FOUND") });
    await ready();
    expect(
      await within(await sectionList()).findByRole("button", {
        name: "Reason for Visit: Not started",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(callsTo("GET", "/draft")).toHaveLength(1));
    noExtras();
  });

  it("adds nothing when no section has anything to draft from", async () => {
    world.draftSections = world.draftSections.map((s) => empty(s.sectionId));
    mountComposer();
    await ready();
    await waitFor(() => expect(callsTo("GET", "/draft")).toHaveLength(1));
    noExtras();
    expect(screen.queryByText(/nothing in the record to draft/i)).toBeNull();
  });

  it("says the draft could not be read, and offers a retry, when a source fails", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mountComposer({
      [`GET ${BASE}/draft`]: () => {
        attempts += 1;
        return attempts === 1 ? errorBody(503, "DRAFT_UNAVAILABLE") : { body: draftBody() };
      },
    });
    await ready();
    expect(await screen.findByText(/pre-drafted text could not be loaded/)).toBeInTheDocument();
    // The clinician's own documentation still works.
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Drafted sections" })).toBeInTheDocument();
  });
});

describe("deselecting the only drafted section", () => {
  it("keeps its result announced, focus on a live element and the care-plan picker, and drops the strip", async () => {
    const user = userEvent.setup();
    world.draftSections = world.draftSections.map((s) =>
      s.sectionId === "vitals_review" ? empty("vitals_review") : s,
    );
    mountComposer({
      [`PUT ${BASE}/draft/sections/plan`]: () => {
        world.draftSections = world.draftSections.map((s) =>
          s.sectionId === "plan" ? empty("plan") : s,
        );
        return { body: empty("plan") };
      },
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    await screen.findByRole("heading", { name: "Care plan for this visit" });
    await user.click(await screen.findByRole("button", { name: "Deselect section" }));

    const panel = await screen.findByRole("region", { name: "Pre-drafted from the record" });
    // The note is inside the live region that was already mounted, so it is announced; and it points at the care-plan list.
    expect(within(panel).getByRole("status")).toHaveTextContent(
      /Nothing is left to draft in it.*link them again in the care-plan list/,
    );
    await waitFor(() => expect(panel).toHaveFocus());
    expect(document.body).not.toHaveFocus();
    // The list the note points at is still there, and so is the score trend.
    expect(screen.getByRole("heading", { name: "Care plan for this visit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scores and trend" })).toBeInTheDocument();
    // Nothing is drafted any more, so the strip that counts drafted sections has nothing to say.
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
  });

  it("does not show a draft panel for an encounter whose draft was never active", async () => {
    world.draftSections = world.draftSections.map((s) => empty(s.sectionId));
    mountComposer();
    await ready();
    await waitFor(() => expect(callsTo("GET", "/draft")).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Pre-drafted from the record" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Care plan for this visit" })).toBeNull();
  });
});

describe("opening a drafted section from the strip", () => {
  it("moves focus to that section's heading, even when it is the section already open", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    const summary = await screen.findByRole("region", { name: "Drafted sections" });
    await user.click(within(summary).getByRole("button", { name: "Plan and Next Visit" }));
    const heading = await screen.findByRole("heading", { name: "Plan and Next Visit", level: 2 });
    await waitFor(() => expect(heading).toHaveFocus());

    // Pressing it again for the section that is already open still takes the reader to it.
    await user.click(within(summary).getByRole("button", { name: "Plan and Next Visit" }));
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe("a control that waits is still reachable and says why", () => {
  it("keeps a blocked Confirm focusable and tied to its reason, and sends nothing when pressed", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    await openSection(user, /^Assessment/);
    await user.click(await screen.findByRole("checkbox", { name: /Dyspnea at rest/ }));
    await openSection(user, /^Plan and Next Visit/);

    const confirm = await screen.findByRole("button", { name: "Confirm section" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).toHaveAccessibleDescription(/Save the draft first/);
    confirm.focus();
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(callsTo("PUT", "/draft/sections/plan")).toHaveLength(0);
  });

  it("blocks the other sections while one is being recorded, with the reason, instead of ignoring a click", async () => {
    const user = userEvent.setup();
    const putGate = gate();
    mountComposer({
      [`PUT ${BASE}/draft/sections/plan`]: async (call) => {
        await putGate.promise;
        return sectionPut("plan")(call);
      },
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    await user.click(await screen.findByRole("button", { name: "Confirm section" }));
    await openSection(user, /^Vital Signs Review/);

    const confirm = await screen.findByRole("button", { name: "Confirm section" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).toHaveAccessibleDescription(/another section is being recorded/i);
    await user.click(confirm);
    expect(callsTo("PUT", "/draft/sections/vitals_review")).toHaveLength(0);

    putGate.open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm section" })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });

  it("says why the care-plan list cannot be changed once the note is not a draft", async () => {
    world.status = "finalized";
    mountComposer();
    await ready();
    const picker = (
      await screen.findByRole("heading", { name: "Care plan for this visit" })
    ).closest("section") as HTMLElement;
    const goal = await within(picker).findByRole("checkbox", {
      name: "Keep the patient comfortable at rest",
    });
    expect(goal).toBeDisabled();
    expect(goal).toHaveAccessibleDescription(/only while the note is a draft/i);
  });
});

describe("a draft that is being re-read", () => {
  it("will not confirm against text that is about to be replaced, and says so", async () => {
    const user = userEvent.setup();
    const second = gate();
    let reads = 0;
    mountComposer({
      [`GET ${BASE}/draft`]: async () => {
        reads += 1;
        if (reads === 2) await second.promise;
        return { body: draftBody() };
      },
    });
    await ready();
    await openSection(user, /^Assessment/);
    await user.click(await screen.findByRole("checkbox", { name: /Dyspnea at rest/ }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await openSection(user, /^Plan and Next Visit/);

    const confirm = await screen.findByRole("button", { name: "Confirm section" });
    await waitFor(() => expect(confirm).toHaveAccessibleDescription(/Updating the drafted text/));
    expect(confirm).toHaveAttribute("aria-disabled", "true");

    second.open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm section" })).not.toHaveAttribute(
        "aria-disabled",
      ),
    );
  });

  it("re-reads the draft after vitals are recorded, because vitals are a source of it", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/vitals`]: () => ({ status: 201, body: { vitalsId: "vitals-1" } }),
    });
    await ready();
    await screen.findByRole("region", { name: "Drafted sections" });
    const reads = callsTo("GET", "/draft").length;

    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await user.type(await screen.findByLabelText("Heart rate"), "76");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));

    expect(await screen.findByText("Vitals recorded")).toBeInTheDocument();
    await waitFor(() => expect(callsTo("GET", "/draft")).toHaveLength(reads + 1));
  });

  it("re-reads the draft once after a refused finalize, not once for the save and again for the refusal", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/finalize`]: () =>
        errorBody(422, "COMPLIANCE_GATE_FAILED", [
          { field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "x" },
        ]),
    });
    await ready();
    await screen.findByRole("region", { name: "Drafted sections" });
    const reads = callsTo("GET", "/draft").length;
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await screen.findByText(/Plan and Next Visit \(not confirmed or deselected yet\)/);
    await waitFor(() => expect(callsTo("GET", "/draft")).toHaveLength(reads + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callsTo("GET", "/draft")).toHaveLength(reads + 1);
  });

  it("re-reads the draft after the note is finalized, from the finalized note", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/finalize`]: () => {
        world.status = "finalized";
        return { body: { status: "finalized", version: 5 } };
      },
    });
    await ready();
    await screen.findByRole("region", { name: "Drafted sections" });
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await screen.findByText("Note finalized");
    await screen.findByRole("region", { name: "Drafted sections" });
    const finalizedAt = calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/finalize"));
    const lastRead = calls.map((c) => `${c.method} ${c.path}`).lastIndexOf(`GET ${BASE}/draft`);
    expect(lastRead).toBeGreaterThan(finalizedAt);
    expect(
      calls.filter((c, i) => i > finalizedAt && c.method === "GET" && c.path === `${BASE}/draft`),
    ).toHaveLength(1);
  });

  it("shows the retry as working while the draft is being read again", async () => {
    const user = userEvent.setup();
    const retry = gate();
    let attempts = 0;
    mountComposer({
      [`GET ${BASE}/draft`]: async () => {
        attempts += 1;
        if (attempts === 1) return errorBody(503, "DRAFT_UNAVAILABLE");
        await retry.promise;
        return { body: draftBody() };
      },
    });
    await ready();
    await screen.findByText(/pre-drafted text could not be loaded/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Try again/ })).toBeDisabled());
    retry.open();
    // The strip that said the draft could not be read gives way to the one that counts the drafted sections.
    expect(await screen.findByText(/drafted sections are resolved/)).toBeInTheDocument();
    expect(screen.queryByText(/pre-drafted text could not be loaded/)).toBeNull();
  });

  it("says the draft could not be checked, in words, when finalizing answers 503", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/finalize`]: () => errorBody(503, "COMPLIANCE_GATE_UNAVAILABLE"),
    });
    await ready();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(
      await screen.findByText(
        /The visit-note draft could not be checked right now\. The note was not finalized/,
      ),
    ).toBeInTheDocument();
  });
});

describe("a section changed under the clinician", () => {
  it("explains it once, in plain text rather than a live alert, and keeps the one live region empty", async () => {
    const user = userEvent.setup();
    world.draftSections = world.draftSections.map((s) =>
      s.sectionId === "plan" ? { ...s, state: "needs_reconfirmation" } : s,
    );
    mountComposer();
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const panel = await screen.findByRole("region", { name: "Pre-drafted from the record" });
    expect(within(panel).getByText(/changed after you resolved it/)).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
    // The one live region is there from the first render and says nothing until an action does.
    expect(within(panel).getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("a service date the composer cannot read", () => {
  it("still opens the draft, and shows no score trend, instead of failing", async () => {
    world.serviceDate = "not-a-date";
    mountComposer();
    await ready();
    expect(await screen.findByRole("region", { name: "Drafted sections" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Scores and trend" })).toBeNull();
    expect(calls.filter((c) => c.path.includes("/scales/"))).toHaveLength(0);
  });
});

describe("the care-plan picker", () => {
  const pickerOf = async (): Promise<HTMLElement> =>
    (await screen.findByRole("heading", { name: "Care plan for this visit" })).closest(
      "section",
    ) as HTMLElement;

  it("lists the goals and interventions with their link state", async () => {
    world.links = [link(null, INTERVENTION_ID)];
    mountComposer();
    await ready();
    const picker = await pickerOf();
    expect(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    ).not.toBeChecked();
    expect(
      within(picker).getByRole("checkbox", { name: "Assess breathlessness · each visit" }),
    ).toBeChecked();
    expect(within(picker).getByText(/The care plan itself is never changed/)).toBeInTheDocument();
  });

  it("links a goal to the visit and re-reads the draft", async () => {
    const user = userEvent.setup();
    mountComposer();
    await ready();
    const picker = await pickerOf();
    const reads = callsTo("GET", "/draft").length;
    await user.click(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    );
    await waitFor(() => expect(callsTo("POST", "/care-plan-links")).toHaveLength(1));
    expect(callsTo("POST", "/care-plan-links")[0]?.body).toEqual({ goalId: GOAL_ID });
    await waitFor(() =>
      expect(
        within(picker).getByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
      ).toBeChecked(),
    );
    await waitFor(() => expect(callsTo("GET", "/draft").length).toBeGreaterThan(reads));
  });

  it("unlinks a linked goal", async () => {
    const user = userEvent.setup();
    world.links = [link(GOAL_ID, null)];
    mountComposer();
    await ready();
    const picker = await pickerOf();
    await user.click(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    );
    await waitFor(() => expect(callsTo("DELETE", `/care-plan-links/${LINK_ID}`)).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(picker).getByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
      ).not.toBeChecked(),
    );
  });

  it("keeps the checkbox where the server left it, and says why, when a link is refused", async () => {
    const user = userEvent.setup();
    mountComposer({
      [`POST ${BASE}/care-plan-links`]: () => errorBody(409, "ENCOUNTER_NOT_EDITABLE"),
    });
    await ready();
    const picker = await pickerOf();
    await user.click(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    );
    expect(await within(picker).findByRole("alert")).toBeInTheDocument();
    expect(
      within(picker).getByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    ).not.toBeChecked();
  });

  it("is read-only once the note is finalized", async () => {
    world.status = "finalized";
    mountComposer();
    await ready();
    const picker = await pickerOf();
    expect(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    ).toBeDisabled();
  });

  it("shows nothing when the patient has no care plan to link", async () => {
    mountComposer({
      "GET /api/v1/internal/care-plan/relevant-elements": () => errorBody(404, "NOT_FOUND"),
    });
    await ready();
    await screen.findByRole("region", { name: "Drafted sections" });
    await waitFor(() => expect(callsTo("GET", "/care-plan/relevant-elements")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Care plan for this visit" })).toBeNull();
  });

  it("will not let a goal be ticked before the visit's links are known", async () => {
    const links = gate();
    mountComposer({
      [`GET ${BASE}/care-plan-links`]: async () => {
        await links.promise;
        return { body: { links: world.links } };
      },
    });
    await ready();
    const picker = await pickerOf();
    const goal = await within(picker).findByRole("checkbox", {
      name: "Keep the patient comfortable at rest",
    });
    expect(goal).toBeDisabled();
    links.open();
    await waitFor(() => expect(goal).toBeEnabled());
  });

  it("says the links could not be read, offers a retry in place of boxes it cannot trust, and sends nothing", async () => {
    const user = userEvent.setup();
    world.links = [link(GOAL_ID, null)];
    let attempts = 0;
    mountComposer({
      [`GET ${BASE}/care-plan-links`]: () => {
        attempts += 1;
        return attempts === 1 ? errorBody(503, "UNAVAILABLE") : { body: { links: world.links } };
      },
    });
    await ready();
    const picker = await pickerOf();
    expect(await within(picker).findByText(/links could not be loaded/i)).toBeInTheDocument();
    expect(within(picker).queryByRole("checkbox")).toBeNull();
    expect(callsTo("POST", "/care-plan-links")).toHaveLength(0);

    await user.click(within(picker).getByRole("button", { name: "Try again" }));
    const goal = await within(picker).findByRole("checkbox", {
      name: "Keep the patient comfortable at rest",
    });
    expect(goal).toBeEnabled();
    expect(goal).toBeChecked();
  });

  it("does not show an unlinked element as linked when the re-read after a deselect fails", async () => {
    const user = userEvent.setup();
    world.links = [link(GOAL_ID, null)];
    let reads = 0;
    mountComposer({
      [`GET ${BASE}/care-plan-links`]: () => {
        reads += 1;
        return reads === 1 ? { body: { links: world.links } } : errorBody(503, "UNAVAILABLE");
      },
    });
    await ready();
    await openSection(user, /^Plan and Next Visit/);
    const picker = await pickerOf();
    expect(
      await within(picker).findByRole("checkbox", { name: "Keep the patient comfortable at rest" }),
    ).toBeChecked();
    world.links = [];
    await user.click(screen.getByRole("button", { name: "Deselect section" }));
    expect(await within(picker).findByText(/links could not be loaded/i)).toBeInTheDocument();
    expect(within(picker).queryByRole("checkbox")).toBeNull();
  });

  it("shows the care plan as unavailable, not a crash, when the answer is not a list of goals", async () => {
    mountComposer({
      "GET /api/v1/internal/care-plan/relevant-elements": () => ({
        body: { planId: "plan-1", redacted: false },
      }),
    });
    await ready();
    expect(await screen.findByText(/care plan could not be loaded/i)).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Drafted sections" })).toBeInTheDocument();
  });
});

describe("the score trend", () => {
  it("shows the latest reading, the change since the one before, and the date", async () => {
    mountComposer();
    await ready();
    const panel = (await screen.findByRole("heading", { name: "Scores and trend" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(panel).findByText("PPS")).toBeInTheDocument();
    expect(within(panel).getByText("50%")).toBeInTheDocument();
    expect(within(panel).getByText(/down 10 since/)).toBeInTheDocument();
    // ESAS-r has no readings: no row, no empty line.
    expect(within(panel).queryByText("ESAS-r total")).toBeNull();
  });

  it("asks the series route for the 90 days up to the service date", async () => {
    mountComposer();
    await ready();
    await screen.findByRole("heading", { name: "Scores and trend" });
    const read = callsTo("GET", "/scales/pps/series")[0];
    expect(read?.query.get("from")).toBe("2026-08-19");
    expect(read?.query.get("to")).toBe("2026-11-17");
  });

  it("shows nothing for a viewer who may not read scales", async () => {
    const forbidden = () => errorBody(403, "FORBIDDEN");
    mountComposer({
      [`GET /api/v1/patients/${PATIENT}/scales/pps/series`]: forbidden,
      [`GET /api/v1/patients/${PATIENT}/scales/esas_r/series`]: forbidden,
    });
    await ready();
    await screen.findByRole("region", { name: "Drafted sections" });
    await waitFor(() => expect(callsTo("GET", "/scales/pps/series")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Scores and trend" })).toBeNull();
  });

  it("says so, with a retry, when the scores could not be read", async () => {
    mountComposer({
      [`GET /api/v1/patients/${PATIENT}/scales/pps/series`]: () => errorBody(503, "UNAVAILABLE"),
    });
    await ready();
    expect(await screen.findByText("The scores could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it(
    "has no axe violations on the drafted section, its summary and the right rail",
    async () => {
      const user = userEvent.setup();
      mountComposer();
      await ready();
      await openSection(user, /^Plan and Next Visit/);
      await screen.findByRole("heading", { name: "Care plan for this visit" });
      await screen.findByRole("heading", { name: "Scores and trend" });
      for (const name of ["Drafted sections", "Pre-drafted from the record"]) {
        const region = screen.getByRole("region", { name });
        const results = await axe.run(region);
        expect(results.violations).toEqual([]);
      }
      for (const name of ["Care plan for this visit", "Scores and trend"]) {
        const results = await axe.run(
          (await screen.findByRole("heading", { name })).closest("section") as HTMLElement,
        );
        expect(results.violations).toEqual([]);
      }
    },
    AXE_TEST_TIMEOUT_MS,
  );
});
