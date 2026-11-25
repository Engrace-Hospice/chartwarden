// @vitest-environment jsdom
// "No skin or wound concerns at this visit" in the note composer's Skin and Wounds section. The button adds ONE fixed sentence to the
// section's free text, below what the clinician typed, so it takes the same path as typing: the rail reads "Documented", the draft is
// unsaved until Save draft, and the saved free text carries the sentence into the server-assembled note. The stub server words the
// note with the REAL assembler, so the preview is judged against the same code the server runs. A wound recorded afterwards removes the
// exact sentence; a note that is read-only, or a template without the section, offers nothing. Synthetic data only.
import { assembleLayer1, resolveTemplate } from "@chartwarden/hearthnote";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { NO_WOUND_CONCERNS_SENTENCE as SENTENCE } from "../09-assessments";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SACRUM = "dddddddd-4444-4444-8444-dddddddddd02";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;
const WOUNDS = `/api/v1/patients/${PATIENT}/wounds`;
const BUTTON = "No skin or wound concerns at this visit";
const RECORDED = "Added to the note: no skin or wound concerns at this visit";
const REMOVED = `Removed '${SENTENCE}' because a wound was recorded.`;
const SECTION_COUNT = 3;
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

const plain = (sectionId: string, heading: string, extra: Record<string, unknown> = {}) => ({
  sectionId,
  heading,
  required: false,
  allowedCategories: [],
  entries: [],
  recordedPanel: null,
  ...extra,
});
const WITH_WOUNDS = [
  plain("assessment", "Assessment"),
  plain("skin_wounds", "Skin and Wounds", { recordedPanel: "wounds" }),
  plain("plan", "Plan and Next Visit"),
];
// A telephonic note drops the section (see TELEPHONIC_OMITS in the template registry).
const TELEPHONIC = [plain("assessment", "Assessment"), plain("plan", "Plan and Next Visit")];

interface StoredSection {
  sectionId: string;
  entries: unknown[];
  freeText?: string;
}
interface World {
  status: "draft" | "finalized";
  templateSections: unknown[];
  stored: StoredSection[];
  woundOnFile: boolean;
}
let world: World;
let calls: Call[];

const sacrumWound = {
  id: SACRUM,
  patientId: PATIENT,
  siteCode: "sacrum",
  laterality: "midline",
  site: "sacrum",
  etiology: "pressure_injury",
  status: "open",
  acquired: "present_on_admission",
  onsetOn: "2026-11-01",
  closedOn: null,
  createdAt: "2026-11-01T12:00:00.000Z",
};

/** The note as the server words it: the real assembler over the saved sections. */
const narrativeOf = (sections: StoredSection[]): string =>
  assembleLayer1(
    resolveTemplate("routine_visit", "rn") as NonNullable<ReturnType<typeof resolveTemplate>>,
    {
      templateKey: "routine_visit:rn",
      vocabVersion: "2026.1.0",
      encounterType: "routine_visit",
      discipline: "rn",
      sections: sections as never,
    },
    { patient: "Ada Lovelace", serviceDate: "2026-11-24" },
  ).narrative;

function routes(): Record<string, Responder> {
  return {
    [`GET ${BASE}`]: () => ({
      body: {
        id: ENCOUNTER,
        organizationId: "org-1",
        patientId: PATIENT,
        admissionId: "adm-1",
        visitId: null,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate: "2026-11-24",
        status: world.status,
        lateEntryTier: "on_time",
        version: 3,
        authoredByUserId: "user-1",
        isF2f: false,
        signedAt: null,
        cosignedAt: null,
      },
    }),
    [`GET ${BASE}/template`]: () => ({
      body: {
        encounterId: ENCOUNTER,
        templateKey: "routine_visit:rn",
        vocabVersion: "2026.1.0",
        encounterType: "routine_visit",
        discipline: "rn",
        sections: world.templateSections,
      },
    }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: "routine_visit:rn",
        vocabVersion: "2026.1.0",
        sections: world.stored,
        layer1Preview: narrativeOf(world.stored),
        version: 3,
        fallIncident: null,
        editedNarrative: null,
        editedNarrativeStale: false,
      },
    }),
    [`PATCH ${BASE}/selections`]: (call) => {
      world.stored = (call.body as { sections: StoredSection[] }).sections;
      return { body: { version: 4, layer1Preview: narrativeOf(world.stored) } };
    },
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
    }),
    [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
    [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
      body: { patientId: PATIENT, proposals: [], redacted: false },
    }),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: [] } }),
    [`GET ${WOUNDS}`]: () => ({
      body: { wounds: world.woundOnFile ? [{ ...sacrumWound, latestObservation: null }] : [] },
    }),
    [`POST ${WOUNDS}`]: () => {
      world.woundOnFile = true;
      return { status: 201, body: sacrumWound };
    },
  };
}

function mountCompose() {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(routes(), calls),
  });
  const router = createMemoryRouter(
    [
      {
        path: "/patients/:patientId/encounters/:encounterId/compose",
        element: <EncounterCompose />,
      },
      { path: "*", element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [`/patients/${PATIENT}/encounters/${ENCOUNTER}/compose`] },
  );
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  world = { status: "draft", templateSections: WITH_WOUNDS, stored: [], woundOnFile: false };
  calls = [];
});
afterEach(cleanup);

type User = ReturnType<typeof userEvent.setup>;
const railState = (state: "Documented" | "Not started") => `Skin and Wounds: ${state}`;
const openWounds = async (user: User) => {
  await screen.findByRole("heading", { name: "Compose visit note" });
  await user.click(await screen.findByRole("button", { name: /^Skin and Wounds/ }));
};
const notes = async () => (await screen.findByLabelText("Additional notes")) as HTMLTextAreaElement;
const saveBodies = (): unknown[] =>
  calls.filter((c) => c.method === "PATCH" && c.path === `${BASE}/selections`).map((c) => c.body);
const sentenceInPreview = () =>
  screen.findByText(
    /Skin and Wounds\s+No skin breakdown or wounds were identified at this visit\./,
  );

describe("No skin or wound concerns, in the composer", () => {
  it("goes to the rail as Documented and to the notes box as one sentence, unsaved until Save draft", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    expect(screen.getByRole("button", { name: railState("Not started") })).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    expect((await notes()).value).toBe(SENTENCE);
    expect(screen.getByRole("button", { name: railState("Documented") })).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByText(RECORDED)).toBeTruthy();
    expect(saveBodies()).toHaveLength(0);
  });

  it("saves the sentence as the section's free text, and the server-assembled preview states it", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(saveBodies()).toHaveLength(1));
    expect(saveBodies()[0]).toEqual({
      fallIncidentId: null,
      sections: [{ sectionId: "skin_wounds", entries: [], freeText: SENTENCE }],
    });
    expect(await sentenceInPreview()).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  });

  it("appends to what the clinician already typed, and the saved free text carries both", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.type(await notes(), "Skin warm and dry.");

    await user.click(await screen.findByRole("button", { name: BUTTON }));

    expect((await notes()).value).toBe(`Skin warm and dry.\n${SENTENCE}`);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(saveBodies()).toHaveLength(1));
    expect(saveBodies()[0]).toEqual({
      fallIncidentId: null,
      sections: [
        {
          sectionId: "skin_wounds",
          entries: [],
          freeText: `Skin warm and dry.\n${SENTENCE}`,
        },
      ],
    });
  });

  it("Undo removes exactly the sentence, leaves what else was typed, and the rail goes back with it", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.type(await notes(), "Skin warm and dry.");
    await user.click(await screen.findByRole("button", { name: BUTTON }));

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect((await notes()).value).toBe("Skin warm and dry.");
    expect(screen.queryByText(RECORDED)).toBeNull();
    expect(screen.getByRole("button", { name: BUTTON })).toBeTruthy();
    // Still documented: the clinician's own words are there.
    expect(screen.getByRole("button", { name: railState("Documented") })).toBeTruthy();
  });

  it("Undo of a lone sentence returns the section to Not started", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    expect(screen.getByRole("button", { name: railState("Documented") })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect((await notes()).value).toBe("");
    expect(screen.getByRole("button", { name: railState("Not started") })).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("recognises the sentence typed by hand as the statement", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await screen.findByRole("button", { name: BUTTON });

    await user.type(await notes(), SENTENCE);

    expect(await screen.findByText(RECORDED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(screen.getByRole("button", { name: /^Undo/ })).toBeTruthy();
  });

  it("is not offered when the patient has a wound on file", async () => {
    const user = userEvent.setup();
    world.woundOnFile = true;
    mountCompose();
    await openWounds(user);

    expect(await screen.findByText("Not recorded at this visit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
  });

  it("takes the sentence out, and says so, when a wound is recorded after it was added", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.type(await notes(), "Skin warm and dry.");
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    expect((await notes()).value).toBe(`Skin warm and dry.\n${SENTENCE}`);

    await user.click(screen.getByRole("button", { name: "Add a new wound" }));
    const register = within(await screen.findByRole("form", { name: "Register a wound" }));
    await user.selectOptions(register.getByLabelText(/^Site/), "sacrum");
    await user.selectOptions(register.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(register.getByRole("button", { name: "Register wound" }));

    // Said in the panel and in the composer's own notice above the note, which carries a title.
    expect((await screen.findAllByText(REMOVED)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Sentence removed")).toBeInTheDocument();
    expect((await notes()).value).toBe("Skin warm and dry.");
    expect(screen.queryByText(RECORDED)).toBeNull();
  });

  it("leaves a sentence the clinician edited alone, and warns that the note says there are no wounds", async () => {
    const user = userEvent.setup();
    const edited = "No skin breakdown or wounds were identified at this visit, except the sacrum";
    world.woundOnFile = true;
    world.stored = [{ sectionId: "skin_wounds", entries: [], freeText: edited }];
    mountCompose();
    await openWounds(user);

    expect(
      await screen.findByText(/The notes say there is no skin breakdown or wound/),
    ).toBeTruthy();
    expect((await notes()).value).toBe(edited);
    expect(screen.queryByText(REMOVED)).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("takes a saved sentence out on load when a wound is on file, leaving the note unsaved for the clinician to save", async () => {
    const user = userEvent.setup();
    world.woundOnFile = true;
    world.stored = [
      { sectionId: "skin_wounds", entries: [], freeText: `Skin warm and dry.\n${SENTENCE}` },
    ];
    mountCompose();
    await openWounds(user);

    expect((await screen.findAllByText(REMOVED)).length).toBeGreaterThanOrEqual(1);
    expect((await notes()).value).toBe("Skin warm and dry.");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("says so in the composer, not only inside the hidden Skin and Wounds panel, when a saved sentence is taken out on load", async () => {
    world.woundOnFile = true;
    world.stored = [
      { sectionId: "skin_wounds", entries: [], freeText: `Skin warm and dry.\n${SENTENCE}` },
    ];
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });

    // Another section is open, so the wounds panel is hidden: the notice has to be outside it.
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    await waitFor(() => {
      const visibleNotices = screen
        .getAllByRole("status")
        .map((notice) => notice.textContent ?? "");
      // The notice is titled, so its text is the title followed by the removal sentence.
      expect(
        visibleNotices.some(
          (text) => text.startsWith("Sentence removed") && text.endsWith(REMOVED),
        ),
      ).toBe(true);
    });
  });

  it("keeps an earlier warning notice and adds the removal to it, rather than replacing it", async () => {
    world.woundOnFile = true;
    world.stored = [
      // A saved statement this template does not offer is dropped on load, which raises its own warning.
      {
        sectionId: "symptom_management",
        entries: [{ code: "nv.sym.pain_uncontrolled", params: { pain_score: "7" } }],
        freeText: "",
      },
      { sectionId: "skin_wounds", entries: [], freeText: `Skin warm and dry.\n${SENTENCE}` },
    ];
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });

    await waitFor(() => {
      const notice = screen
        .getAllByRole("status")
        .map((output) => output.textContent ?? "")
        .find((text) => text.includes(REMOVED));
      expect(notice).toContain("no longer offered in its section and was removed here");
      expect(notice).toContain("Save the draft to apply the change.");
    });
  });

  it("raises no composer notice when nothing was taken out", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openWounds(user);
    await user.click(await screen.findByRole("button", { name: BUTTON }));

    expect(screen.getAllByRole("status").map((notice) => notice.textContent)).not.toContain(
      REMOVED,
    );
  });

  it("is not offered once the note is finalized, and a saved sentence reads as recorded with no Undo", async () => {
    const user = userEvent.setup();
    world.status = "finalized";
    world.stored = [{ sectionId: "skin_wounds", entries: [], freeText: SENTENCE }];
    mountCompose();
    await openWounds(user);

    expect(await screen.findByText(RECORDED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a new wound" })).toBeNull();
  });

  it("shows nothing of it, and reads no wounds, for a template without the Skin and Wounds section", async () => {
    world.templateSections = TELEPHONIC;
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });
    await screen.findByRole("button", { name: /^Assessment/ });

    expect(screen.queryByRole("button", { name: /^Skin and Wounds/ })).toBeNull();
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(calls.some((c) => c.path === WOUNDS)).toBe(false);
  });
});
