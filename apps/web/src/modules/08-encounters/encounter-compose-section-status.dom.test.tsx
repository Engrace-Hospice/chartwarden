// @vitest-environment jsdom
// What the note composer says about a section must be what finalize does. A routine RN visit's Skin and Wounds section is optional (the
// template flags it so and the server's check 1 never asks for it): its chip says Optional, its rail row says Not started rather than
// Required, the banner names only the sections that really stand in the way, and Finalize is not held back by it. The chip says Required
// of a required section, says how an empty one is satisfied, and never says Optional of a section holding a half-filled statement.
// The stub server serves a template shaped like the RN routine visit. Synthetic data only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

const entry = (code: string, label: string, slots: string[] = []) => ({
  code,
  label,
  category: "observation",
  bodySystem: null,
  slots,
  slotSpecs: {},
  exclusiveGroup: null,
});
const section = (sectionId: string, heading: string, extra: Record<string, unknown> = {}) => ({
  sectionId,
  heading,
  required: false,
  allowedCategories: [],
  entries: [],
  recordedPanel: null,
  ...extra,
});
const TEMPLATE = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    section("assessment", "Assessment", {
      required: true,
      entries: [entry("obs-calm", "Patient is calm")],
    }),
    section("symptom_management", "Symptom Management", {
      entries: [entry("sym-site", "Discomfort at the site", ["site"])],
    }),
    section("skin_wounds", "Skin and Wounds", { recordedPanel: "wounds" }),
    section("plan", "Plan and Next Visit", { required: true }),
  ],
};

let calls: Call[];

const routes = (): Record<string, Responder> => ({
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
      sections: [],
      layer1Preview: "",
      version: 3,
      fallIncident: null,
      editedNarrative: null,
      editedNarrativeStale: false,
    },
  }),
  [`GET /api/v1/patients/${PATIENT}`]: () => ({
    body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
  }),
  [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
  [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
    body: { patientId: PATIENT, proposals: [], redacted: false },
  }),
  [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: [] } }),
  [`GET /api/v1/patients/${PATIENT}/wounds`]: () => ({ body: { wounds: [] } }),
});

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
  calls = [];
});
afterEach(cleanup);

const rail = () => screen.getByRole("complementary", { name: "Visit note sections" });
const railButton = (name: string) => within(rail()).getByRole("button", { name });
const openSection = async (user: ReturnType<typeof userEvent.setup>, heading: RegExp) =>
  user.click(await screen.findByRole("button", { name: heading }));
/** The chip beside the open section's heading. */
const chipOf = (heading: string): string =>
  within(screen.getByRole("heading", { level: 2, name: heading }).parentElement as HTMLElement)
    .getAllByText(/^(Required|Optional|Needs details)$/)
    .map((el) => el.textContent)
    .join("|");

describe("Skin and Wounds in a routine RN visit's composer", () => {
  it("is Optional everywhere it is named: chip, rail, banner and Finalize, so nothing tells the author it is required", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });

    // The banner names the two required sections and not this one.
    expect(await screen.findByText("2 sections need attention")).toBeTruthy();
    expect(
      screen.getByText(/Complete Assessment, Plan and Next Visit before finalization/),
    ).toBeTruthy();
    expect(screen.queryByText(/Complete .*Skin and Wounds/)).toBeNull();

    await openSection(user, /^Skin and Wounds/);
    expect(await screen.findByText("No wounds recorded for this patient")).toBeTruthy();
    expect(chipOf("Skin and Wounds")).toBe("Optional");
    expect(railButton("Skin and Wounds: Not started")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skin and Wounds: Required" })).toBeNull();
    expect(
      screen.getByText("Optional. Leave it empty if there is nothing to record."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Finalize note" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("the chip and the notes hint of a required section", () => {
  it("says Required, with the way to satisfy it, until a statement is chosen, and calls the notes optional after", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });

    await openSection(user, /^Assessment/);
    expect(chipOf("Assessment")).toBe("Required");
    expect(railButton("Assessment: Required")).toBeTruthy();
    expect(
      screen.getByText(/^Required\. Select a statement above, or write this section here/),
    ).toBeTruthy();
    expect(screen.queryByText(/^Optional\./)).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: /Patient is calm/ }));
    expect(chipOf("Assessment")).toBe("Required");
    expect(railButton("Assessment: Documented")).toBeTruthy();
    expect(
      screen.getByText(/^Optional\. Enter only information not already represented/),
    ).toBeTruthy();
    expect(screen.getByText("1 section needs attention")).toBeTruthy();
  });
});

describe("an optional section holding a half-filled statement", () => {
  it("says Needs details, in the chip and the rail and the banner, instead of Optional, until the detail is filled in", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });

    await openSection(user, /^Symptom Management/);
    expect(chipOf("Symptom Management")).toBe("Optional");
    await user.click(screen.getByRole("checkbox", { name: /Discomfort at the site/ }));

    expect(chipOf("Symptom Management")).toBe("Needs details");
    expect(railButton("Symptom Management: Needs details")).toBeTruthy();
    expect(screen.getByText("3 sections need attention")).toBeTruthy();
    expect(screen.getByText(/Complete .*Symptom Management/)).toBeTruthy();

    await user.type(screen.getByLabelText("Site"), "left shoulder");
    expect(chipOf("Symptom Management")).toBe("Optional");
    expect(railButton("Symptom Management: Documented")).toBeTruthy();
    expect(screen.getByText("2 sections need attention")).toBeTruthy();
  });
});
