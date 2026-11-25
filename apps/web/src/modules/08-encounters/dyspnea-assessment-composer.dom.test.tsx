// @vitest-environment jsdom
// The dyspnea assessment helper inside the real composer: under Symptom Management the impact statement is listed as before, the
// helper's own statements are NOT listed beside it, ticking "dyspnea limiting function" opens the helper, and what is recorded in it
// is sent in the same section's selection tree. The Plan section carries the matching plan-of-care prompt beside the pain one, each
// under its own title.
// Synthetic values only.
import { DYSPNEA_ASSESSMENT_CODES as D, DYSPNEA_STATEMENT_CODE } from "@chartwarden/types";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;
const PAIN_LIMITING = "nv.sym.pain_uncontrolled";
const PAIN_PROMPT_TITLE = "Consider a plan-of-care review";
const PROMPT_TITLE = "Consider a plan-of-care review (dyspnea)";

const score = { kind: "integer", min: 0, max: 10, label: "Score (0–10)" };
const menuEntry = (code: string, label: string, slots: string[], slotSpecs = {}) => ({
  code,
  label,
  category: "symptom_impact",
  bodySystem: null,
  slots,
  slotSpecs,
  exclusiveGroup: null,
});

const TEMPLATE = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    {
      sectionId: "symptom_management",
      heading: "Symptom Management",
      required: false,
      allowedCategories: ["symptom_impact"],
      entries: [
        menuEntry(PAIN_LIMITING, "Symptom impact — pain limiting function", ["pain_score"], {
          pain_score: score,
        }),
        menuEntry(DYSPNEA_STATEMENT_CODE, "Symptom impact — dyspnea limiting function", [
          "ambulation_distance",
        ]),
        menuEntry(D.onset, "Dyspnea assessment — onset", ["dyspnea_onset"]),
        menuEntry(D.score, "Dyspnea assessment — intensity", ["dyspnea_score"], {
          dyspnea_score: score,
        }),
      ],
    },
    {
      sectionId: "plan",
      heading: "Plan and Next Visit",
      required: false,
      allowedCategories: [],
      entries: [],
      recordedPanel: null,
    },
  ],
};

let calls: Call[];
let storedSections: unknown[];

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
        serviceDate: "2026-08-27",
        status: "draft",
        lateEntryTier: "on_time",
        version: 3,
        authoredByUserId: "user-1",
        isF2f: false,
        signedAt: null,
        cosignedAt: null,
      },
    }),
    [`GET ${BASE}/template`]: () => ({ body: TEMPLATE }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: TEMPLATE.templateKey,
        vocabVersion: TEMPLATE.vocabVersion,
        sections: storedSections,
        layer1Preview: "",
        version: 3,
        fallIncident: null,
        editedNarrative: null,
        editedNarrativeStale: false,
      },
    }),
    [`PATCH ${BASE}/selections`]: () => ({ body: { version: 4, layer1Preview: "" } }),
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
    }),
    [`GET /api/v1/patients/${PATIENT}/fall-incidents`]: () => ({
      body: { incidents: [], unavailable: false },
    }),
    [`GET ${BASE}/vitals`]: () => ({ body: { encounterId: ENCOUNTER, vitals: [] } }),
    [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
    [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
      body: { patientId: PATIENT, proposals: [], redacted: false },
    }),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: [] } }),
    "GET /api/v1/visits": () => ({ body: [] }),
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
      { path: "*", element: <h1>Other destination</h1> },
    ],
    { initialEntries: [`/patients/${PATIENT}/encounters/${ENCOUNTER}/compose`] },
  );
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["rn_case_manager"],
          permissions: ["visit.read", "visit.create"],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const openSection = async (name: RegExp): Promise<void> => {
  await screen.findByRole("heading", { name: "Compose visit note" });
  fireEvent.click(await screen.findByRole("button", { name }));
};

beforeEach(() => {
  calls = [];
  storedSections = [];
});
afterEach(cleanup);

describe("the dyspnea assessment helper in the composer", () => {
  it("lists the impact statement and none of the helper's own, and shows no helper until it is picked", async () => {
    mountCompose();
    await openSection(/Symptom Management/);
    expect(await screen.findByLabelText(/dyspnea limiting function/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Dyspnea assessment — onset/)).toBeNull();
    expect(screen.queryByLabelText(/Dyspnea assessment — intensity/)).toBeNull();
    expect(screen.queryByText(/characteristics documented/)).toBeNull();
  });

  it("opens the helper when 'dyspnea limiting function' is picked and sends what is recorded in the same section", async () => {
    mountCompose();
    await openSection(/Symptom Management/);
    fireEvent.click(await screen.findByLabelText(/dyspnea limiting function/i));
    fireEvent.change(await screen.findByLabelText("Ambulation Distance"), {
      target: { value: "20 feet" },
    });

    expect(
      await screen.findByText("Dyspnea assessment: 1 of 8 characteristics documented"),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: PROMPT_TITLE })).toBeTruthy();
    expect(screen.queryByText(/Pain assessment:/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Onset"), { target: { value: "two days ago" } });
    fireEvent.change(screen.getByLabelText("Intensity (0 to 10)"), { target: { value: "6" } });
    expect(screen.getByText("Dyspnea assessment: 3 of 8 characteristics documented")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")?.body as {
      sections: { sectionId: string; entries: { code: string; params?: unknown }[] }[];
    };
    expect(sent.sections.find((s) => s.sectionId === "symptom_management")?.entries).toEqual([
      { code: DYSPNEA_STATEMENT_CODE, params: { ambulation_distance: "20 feet" } },
      { code: D.onset, params: { dyspnea_onset: "two days ago" } },
      { code: D.score, params: { dyspnea_score: "6" } },
    ]);
  });

  it("'Go to Plan of care' brings the Plan of care step into view and writes nothing", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as never;
    try {
      mountCompose();
      await openSection(/Symptom Management/);
      const plan = await screen.findByRole("region", { name: "Plan of care" });
      expect(plan).toBeVisible();
      fireEvent.click(await screen.findByLabelText(/dyspnea limiting function/i));
      fireEvent.click(await screen.findByRole("button", { name: "Go to Plan of care" }));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const scrolled = scrollIntoView.mock.contexts[0] as Element;
      expect(scrolled.contains(plan)).toBe(true);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      // jsdom has no scrollIntoView: leave it as it was found.
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("the plan-of-care prompts in the Plan section", () => {
  const selected = (code: string, params: Record<string, string>) => ({
    sectionId: "symptom_management",
    entries: [{ code, params }],
    freeText: "",
  });

  it("shows the dyspnea prompt, naming dyspnea, when the note records dyspnea limiting function", async () => {
    storedSections = [selected(DYSPNEA_STATEMENT_CODE, { ambulation_distance: "20 feet" })];
    mountCompose();
    await openSection(/^Plan and Next Visit/);

    expect(await screen.findByText(/review the plan of care for dyspnea\./)).toBeTruthy();
    expect(screen.queryByText(/review the plan of care for pain\./)).toBeNull();
    expect(screen.getAllByRole("region", { name: PROMPT_TITLE })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: PAIN_PROMPT_TITLE })).toBeNull();
  });

  it("keeps the pain prompt as it was when the note records pain only", async () => {
    storedSections = [selected(PAIN_LIMITING, { pain_score: "7" })];
    mountCompose();
    await openSection(/^Plan and Next Visit/);

    expect(await screen.findByText(/review the plan of care for pain\./)).toBeTruthy();
    expect(screen.queryByText(/review the plan of care for dyspnea\./)).toBeNull();
    expect(screen.getAllByRole("region", { name: PAIN_PROMPT_TITLE })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: PROMPT_TITLE })).toBeNull();
  });

  it("shows no prompt when the note records neither", async () => {
    mountCompose();
    await openSection(/^Plan and Next Visit/);
    await screen.findByRole("region", { name: "Next visit and schedule" });
    expect(screen.queryByRole("region", { name: PROMPT_TITLE })).toBeNull();
    expect(screen.queryByRole("region", { name: PAIN_PROMPT_TITLE })).toBeNull();
  });
});

describe("pain and dyspnea in one note", () => {
  const both = {
    sectionId: "symptom_management",
    entries: [
      { code: PAIN_LIMITING, params: { pain_score: "7" } },
      { code: DYSPNEA_STATEMENT_CODE, params: { ambulation_distance: "20 feet" } },
    ],
    freeText: "",
  };

  /** One card per subject, each under its own accessible name, each saying which subject it is for. */
  const expectOneCardEach = (): void => {
    const pain = screen.getAllByRole("region", { name: PAIN_PROMPT_TITLE });
    const dyspnea = screen.getAllByRole("region", { name: PROMPT_TITLE });
    expect(pain).toHaveLength(1);
    expect(dyspnea).toHaveLength(1);
    expect(
      within(pain[0] as HTMLElement).getByText(/review the plan of care for pain\./),
    ).toBeTruthy();
    expect(
      within(dyspnea[0] as HTMLElement).getByText(/review the plan of care for dyspnea\./),
    ).toBeTruthy();
  };

  it("shows both helpers in Symptom Management, each with its own prompt card", async () => {
    storedSections = [both];
    mountCompose();
    await openSection(/Symptom Management/);

    expect(await screen.findByText(/Pain assessment:/)).toBeTruthy();
    expect(screen.getByText(/Dyspnea assessment:/)).toBeTruthy();
    expectOneCardEach();
  });

  it("shows both cards, under distinct names, in the Plan section", async () => {
    storedSections = [both];
    mountCompose();
    await openSection(/^Plan and Next Visit/);

    await screen.findAllByRole("region", { name: PROMPT_TITLE });
    expectOneCardEach();
  });
});
