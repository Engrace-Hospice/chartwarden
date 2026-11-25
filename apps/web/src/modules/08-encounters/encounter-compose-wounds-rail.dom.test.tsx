// @vitest-environment jsdom
// "Skin and Wounds" in the note composer's section rail: a wound assessed AT THIS VISIT is stated by the note, so the section reads
// "Documented" (check and label) and counts in "N of M sections documented", live after saving and after a fresh load of the composer.
// A wound recorded for the patient at an EARLIER visit, a registered wound with no observation yet, and a patient with no wounds leave it
// "Not started". The stub server keeps the wound record and words the note with the REAL `describeRecordedWounds`, so the preview and
// the rail are judged against the same facts. Synthetic data only.
import { type RecordedWound, describeRecordedWounds } from "@chartwarden/hearthnote";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const EARLIER_ENCOUNTER = "cccccccc-3333-4333-8333-cccccccccccc";
const FOOT = "dddddddd-4444-4444-8444-dddddddddd01";
const SACRUM = "dddddddd-4444-4444-8444-dddddddddd02";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;
const WOUNDS = `/api/v1/patients/${PATIENT}/wounds`;

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
const TEMPLATE = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    plain("assessment", "Assessment"),
    plain("skin_wounds", "Skin and Wounds", { recordedPanel: "wounds" }),
    plain("plan", "Plan and Next Visit"),
  ],
};

interface WoundRow {
  id: string;
  siteCode: string;
  laterality: string;
  site: string;
  etiology: string;
  status: "open";
}
interface ObservationRow {
  id: string;
  woundId: string;
  sourceEncounterId: string | null;
  status: "active" | "superseded";
  version: number;
  observedAt: string;
  lengthCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
  trend: string | null;
}
interface World {
  status: "draft" | "finalized";
  wounds: WoundRow[];
  observations: ObservationRow[];
  nextId: number;
}
let world: World;
let calls: Call[];

const footWound: WoundRow = {
  id: FOOT,
  siteCode: "foot",
  laterality: "left",
  site: "left foot",
  etiology: "skin_tear",
  status: "open",
};
const sacrumWound: WoundRow = {
  id: SACRUM,
  siteCode: "sacrum",
  laterality: "midline",
  site: "sacrum",
  etiology: "pressure_injury",
  status: "open",
};
const observed = (
  woundId: string,
  encounterId: string | null,
  over: Partial<ObservationRow> = {},
): ObservationRow => ({
  id: `obs-${woundId.slice(-2)}-${String(encounterId).slice(0, 4)}`,
  woundId,
  sourceEncounterId: encounterId,
  status: "active",
  version: 1,
  observedAt: "2026-11-24T15:00:00.000Z",
  lengthCm: 1,
  widthCm: 1,
  depthCm: 2,
  trend: "stable",
  ...over,
});

const toObservationDto = (o: ObservationRow) => ({
  ...o,
  patientId: PATIENT,
  observedByMembershipId: "membership-1",
  stage: null,
  undermining: null,
  woundBed: [],
  exudateAmount: null,
  exudateType: null,
  odor: null,
  periwound: [],
  painScore: null,
  dressing: null,
  dressingChanged: null,
  infectionSigns: null,
  correctsObservationId: null,
  correctionReason: null,
  createdAt: o.observedAt,
  areaCm2: o.lengthCm !== null && o.widthCm !== null ? o.lengthCm * o.widthCm : null,
  areaChangePercent: null,
  areaChangeSinceObservedAt: null,
});
const toWoundDto = (w: WoundRow) => ({
  ...w,
  patientId: PATIENT,
  acquired: "present_on_admission",
  onsetOn: "2026-11-01",
  closedOn: null,
  createdAt: "2026-11-01T12:00:00.000Z",
});
const activeOf = (woundId: string): ObservationRow[] =>
  world.observations
    .filter((o) => o.woundId === woundId && o.status === "active")
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));
const listItem = (w: WoundRow) => ({
  ...toWoundDto(w),
  latestObservation: activeOf(w.id)[0]
    ? toObservationDto(activeOf(w.id)[0] as ObservationRow)
    : null,
});

/** The wounds the note states: the active observations tagged to THIS encounter, as the server's M9 seam returns them. */
const woundsAtThisVisit = (): RecordedWound[] =>
  world.observations
    .filter((o) => o.sourceEncounterId === ENCOUNTER && o.status === "active")
    .flatMap((o) => {
      const wound = world.wounds.find((w) => w.id === o.woundId);
      return wound
        ? [
            {
              site: wound.site,
              etiology: wound.etiology,
              lengthCm: o.lengthCm,
              widthCm: o.widthCm,
              depthCm: o.depthCm,
              trend: o.trend,
            } as RecordedWound,
          ]
        : [];
    });
const notePreview = (): string => {
  const body = describeRecordedWounds(woundsAtThisVisit());
  return body === "" ? "" : `Skin and Wounds\n${body}`;
};

function addObservation(woundId: string, body: Record<string, unknown>, supersedes?: string) {
  world.observations = world.observations.map((o) =>
    o.id === supersedes ? { ...o, status: "superseded" as const } : o,
  );
  world.nextId += 1;
  const created = observed(woundId, body.sourceEncounterId as string, {
    id: `obs-new-${world.nextId}`,
    lengthCm: (body.lengthCm as number | undefined) ?? null,
    widthCm: (body.widthCm as number | undefined) ?? null,
    depthCm: (body.depthCm as number | undefined) ?? null,
    trend: (body.trend as string | undefined) ?? null,
    observedAt: `2026-11-24T16:0${world.nextId}:00.000Z`,
  });
  world.observations = [...world.observations, created];
  return { status: 201, body: toObservationDto(created) };
}

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
    [`GET ${BASE}/template`]: () => ({ body: TEMPLATE }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: TEMPLATE.templateKey,
        vocabVersion: TEMPLATE.vocabVersion,
        sections: [],
        layer1Preview: notePreview(),
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
    [`GET ${WOUNDS}`]: () => ({ body: { wounds: world.wounds.map(listItem) } }),
    [`GET ${WOUNDS}/${FOOT}`]: () => woundDetail(FOOT),
    [`GET ${WOUNDS}/${SACRUM}`]: () => woundDetail(SACRUM),
    [`POST ${WOUNDS}/${FOOT}/observations`]: (call) =>
      addObservation(FOOT, call.body as Record<string, unknown>),
    [`POST ${WOUNDS}/${SACRUM}/observations`]: (call) =>
      addObservation(SACRUM, call.body as Record<string, unknown>),
    [`POST ${WOUNDS}`]: () => {
      world.wounds = [...world.wounds, sacrumWound];
      return { status: 201, body: toWoundDto(sacrumWound) };
    },
  };
}
function woundDetail(woundId: string) {
  const wound = world.wounds.find((w) => w.id === woundId) as WoundRow;
  return {
    body: { wound: toWoundDto(wound), observations: activeOf(woundId).map(toObservationDto) },
  };
}

function mountCompose(over: Record<string, Responder> = {}) {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch({ ...routes(), ...over }, calls),
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
  world = { status: "draft", wounds: [], observations: [], nextId: 0 };
  calls = [];
});
afterEach(cleanup);

const railButton = (name: RegExp | string) =>
  within(screen.getByRole("complementary", { name: "Visit note sections" })).getByRole("button", {
    name,
  });
const railState = (state: "Documented" | "Not started") => `Skin and Wounds: ${state}`;
const ready = () => screen.findByRole("heading", { name: "Compose visit note" });
const openWounds = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /^Skin and Wounds/ }));
const checkOf = (button: HTMLElement): string =>
  button.querySelector("[aria-hidden]")?.textContent ?? "";

describe("Skin and Wounds in the section rail", () => {
  it("is Documented, with a check and counted, when a wound was assessed at this visit and the composer is freshly loaded", async () => {
    world.wounds = [footWound];
    world.observations = [observed(FOOT, ENCOUNTER)];
    mountCompose();
    await ready();

    const rail = await screen.findByRole("button", { name: railState("Documented") });
    expect(checkOf(rail)).toBe("✓");
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
    expect(await screen.findByText(/Left foot skin tear/)).toBeTruthy();
  });

  it("stays Documented when the author moves to another tab and back", async () => {
    const user = userEvent.setup();
    world.wounds = [footWound];
    world.observations = [observed(FOOT, ENCOUNTER)];
    mountCompose();
    await ready();
    await screen.findByRole("button", { name: railState("Documented") });

    await user.click(railButton(/^Assessment/));
    expect(railButton(railState("Documented"))).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
    await openWounds(user);
    expect(railButton(railState("Documented"))).toBeTruthy();
  });

  it("is Not started for a wound last observed at an EARLIER visit", async () => {
    const user = userEvent.setup();
    world.wounds = [footWound];
    world.observations = [observed(FOOT, EARLIER_ENCOUNTER)];
    mountCompose();
    await ready();

    await openWounds(user);
    expect(await screen.findByText("Not recorded at this visit")).toBeTruthy();
    expect(railButton(railState("Not started"))).toBeTruthy();
    expect(checkOf(railButton(railState("Not started")))).not.toBe("✓");
    expect(screen.getByText(`0 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
  });

  it("is Not started for a patient with no wounds", async () => {
    const user = userEvent.setup();
    mountCompose();
    await ready();

    await openWounds(user);
    expect(await screen.findByText("No wounds recorded for this patient")).toBeTruthy();
    expect(railButton(railState("Not started"))).toBeTruthy();
    expect(screen.getByText(`0 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
  });

  it("goes Documented live when the first observation is saved, states the wound in the note, and survives a reload", async () => {
    const user = userEvent.setup();
    world.wounds = [footWound];
    world.observations = [observed(FOOT, EARLIER_ENCOUNTER)];
    mountCompose();
    await ready();
    await openWounds(user);
    expect(railButton(railState("Not started"))).toBeTruthy();

    await user.click(
      await screen.findByRole("button", { name: "Record today's observation: Left foot" }),
    );
    await user.type(await screen.findByLabelText("Length (cm)"), "1");
    await user.type(screen.getByLabelText("Width (cm)"), "1");
    await user.type(screen.getByLabelText("Depth (cm)"), "2");
    await user.click(screen.getByRole("button", { name: "Record observation" }));

    expect(await screen.findByRole("button", { name: railState("Documented") })).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
    expect(await screen.findByText(/Left foot skin tear, 1\.0 x 1\.0 x 2\.0 cm/)).toBeTruthy();

    cleanup();
    mountCompose();
    await ready();
    expect(await screen.findByRole("button", { name: railState("Documented") })).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
  });

  it("stays Documented through a correction and a second wound, and the note states both wounds", async () => {
    const user = userEvent.setup();
    world.wounds = [footWound];
    world.observations = [observed(FOOT, ENCOUNTER)];
    mountCompose({
      [`POST ${WOUNDS}/${FOOT}/observations/obs-01-bbbb/corrections`]: (call) =>
        addObservation(FOOT, call.body as Record<string, unknown>, "obs-01-bbbb"),
    });
    await ready();
    await openWounds(user);
    await screen.findByRole("button", { name: railState("Documented") });

    await user.click(
      await screen.findByRole("button", { name: "Correct this visit's observation: Left foot" }),
    );
    const length = await screen.findByLabelText("Length (cm)");
    await user.clear(length);
    await user.type(length, "2");
    await user.selectOptions(
      screen.getByLabelText(/^Reason for the correction/),
      "measurement_error",
    );
    await user.click(screen.getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText(/Left foot skin tear, 2\.0 x 1\.0 x 2\.0 cm/)).toBeTruthy();
    expect(railButton(railState("Documented"))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add a new wound" }));
    await user.selectOptions(await screen.findByLabelText(/^Site/), "sacrum");
    await user.selectOptions(screen.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(screen.getByRole("button", { name: "Register wound" }));
    // A registered wound with no observation yet adds nothing to the note, and the section stays documented by the first wound.
    await user.selectOptions(await screen.findByLabelText("Trend"), "new");
    await user.click(screen.getByRole("button", { name: "Record observation" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === `${WOUNDS}/${SACRUM}/observations`),
      ).toBe(true),
    );
    expect(await screen.findByText(/Sacrum pressure injury/)).toBeTruthy();
    expect(screen.getByText(/Left foot skin tear/)).toBeTruthy();
    expect(railButton(railState("Documented"))).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
  });

  it("is Documented with the draft wording on, where the wound section is never drafted and a drafted section still waits for its author", async () => {
    world.wounds = [footWound];
    world.observations = [observed(FOOT, ENCOUNTER)];
    const section = (sectionId: string, state: string) => ({
      sectionId,
      state,
      text: state === "unresolved" ? "Goal in place: comfort at rest." : null,
      contentHash: state === "unresolved" ? "hash-plan-1" : null,
      corpusVersion: state === "unresolved" ? "2026.1.0" : null,
      part2Derived: state === "unresolved" ? false : null,
      origins: state === "unresolved" ? ["care_plan_goal"] : [],
    });
    mountCompose({
      [`GET ${BASE}/draft`]: () => ({
        body: {
          encounterId: ENCOUNTER,
          patientId: PATIENT,
          templateKey: "routine_visit:rn",
          asOf: "2026-11-24T23:59:59.999Z",
          sections: [
            section("assessment", "not_drafted"),
            section("skin_wounds", "not_drafted"),
            section("plan", "unresolved"),
          ],
        },
      }),
    });
    await ready();

    expect(await screen.findByRole("button", { name: railState("Documented") })).toBeTruthy();
    // The drafted section is not documented by the recorded wound: it is the author's to confirm.
    expect(railButton("Plan and Next Visit: Not started, draft needs your review")).toBeTruthy();
    expect(screen.getByText(`1 of ${SECTION_COUNT} sections documented`)).toBeTruthy();
  });

  it("is Documented and read-only once the note is finalized", async () => {
    const user = userEvent.setup();
    world.status = "finalized";
    world.wounds = [footWound];
    world.observations = [observed(FOOT, ENCOUNTER)];
    mountCompose();
    await screen.findByRole("button", { name: railState("Documented") });

    await openWounds(user);
    expect(await screen.findByText("Recorded at this visit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Correct this visit's observation/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a new wound" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record today's observation/ })).toBeNull();
  });
});
