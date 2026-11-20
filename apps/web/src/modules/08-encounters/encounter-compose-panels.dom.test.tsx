// @vitest-environment jsdom
// WF09 in the note composer: the recorded-finding panels (ADLs, nutrition, wounds), the vitals panel and the plan-of-care step are
// parts of the note that keep their own form and their own Save. The composer has to know what they hold: unsaved input guards the
// leave prompt, a write in flight locks Save and Finalize, and a saved ADL or nutrition record documents the section that states it,
// as the server's finalize gate counts it. Assertions are on what the clinician sees and on the requests that were (or were not) sent.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OTHER_ENCOUNTER = "cccccccc-3333-4333-8333-cccccccccccc";
const PLAN = "dddddddd-4444-4444-8444-dddddddddddd";

const ENC = (id: string) => `/api/v1/encounters/${id}`;
const COMPOSE = (id: string) => `/patients/${PATIENT}/encounters/${id}/compose`;

type Reply =
  | {
      status?: number;
      body?: unknown;
      /** Called once the client has taken the body: the answer has been handed over (see `responseWith`). */
      onRead?: () => void;
    }
  | "drop";
type Route = (call: { method: string; path: string; body: unknown }) => Reply | Promise<Reply>;

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const section = (sectionId: string, heading: string, extra: Record<string, unknown> = {}) => ({
  sectionId,
  heading,
  required: false,
  allowedCategories: [],
  entries: [],
  recordedPanel: null,
  ...extra,
});

/** A note with a plain section, a REQUIRED ADL section (its statements come from the saved ADL record), nutrition and wounds. */
const TEMPLATE_SECTIONS = [
  section("assessment", "Assessment"),
  section("adl", "Activities of Daily Living", { required: true, recordedPanel: "adl" }),
  section("nutrition", "Nutrition and Hydration", { recordedPanel: "nutrition" }),
  section("wounds", "Wounds", { recordedPanel: "wounds" }),
];

const STORED_ADL = {
  encounterId: ENCOUNTER,
  patientId: PATIENT,
  version: 1_763_546_400_000,
  items: { bathing: "limited_assist" },
  bladder: null,
  bowel: null,
  devices: [],
  updatedAt: "2026-11-19T10:00:00.000Z",
};

interface World {
  status: string;
  adl: Record<string, unknown> | null;
  nutrition: Record<string, unknown> | null;
  /** The assembled note the selections read answers, per visit. */
  preview: Record<string, string>;
  version: number;
  /** The template's sections, the stored selection tree and the author's saved edit of the note text. */
  templateSections: unknown[];
  storedSections: unknown[];
  editedNarrative: string | null;
  /** The weight history's flag: a stored weight with a number and no unit. */
  weightUnitMissing: boolean;
  routes: Record<string, Route>;
  calls: string[];
  /** The JSON body of every write, with its method and path. */
  bodies: { method: string; path: string; body: unknown }[];
}

let world: World;

function freshWorld(): World {
  return {
    status: "draft",
    adl: null,
    nutrition: null,
    preview: { [ENCOUNTER]: "", [OTHER_ENCOUNTER]: "" },
    version: 3,
    templateSections: TEMPLATE_SECTIONS,
    storedSections: [],
    editedNarrative: null,
    weightUnitMissing: false,
    routes: {},
    calls: [],
    bodies: [],
  };
}

const encounterView = (id: string) => ({
  id,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: "adm-1",
  visitId: null,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-27",
  status: world.status,
  lateEntryTier: "on_time",
  version: world.version,
  authoredByUserId: "user-1",
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
});

const carePlan = {
  id: PLAN,
  patientId: PATIENT,
  admissionId: "adm-1",
  status: "active",
  activeVersionId: null,
  version: 1,
  versions: [],
  problems: [
    { id: "p-1", planId: PLAN, description: "Dyspnea at rest", kind: "terminal", status: "active" },
  ],
  goals: [],
  interventions: [],
  redacted: false,
};

/** The record a PUT stores: the body, the visit and patient it belongs to, and the next version. */
function storedRecord(
  body: unknown,
  encounterId: string,
  held: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(body as object),
    encounterId,
    patientId: PATIENT,
    version: ((held?.version as number | undefined) ?? 0) + 1,
    updatedAt: "2026-11-19T11:00:00.000Z",
  };
}

/** What the server answers when no test overrides the route. */
function defaultReply(method: string, path: string, body: unknown): Reply {
  const encounterId = path.match(/^\/api\/v1\/encounters\/([^/]+)/)?.[1] ?? ENCOUNTER;
  if (method === "GET") {
    if (path === `/api/v1/patients/${PATIENT}`)
      return { body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" } };
    if (path === `/api/v1/patients/${PATIENT}/care-plan`) return { body: carePlan };
    if (path === `/api/v1/patients/${PATIENT}/care-plan-change-proposals`)
      return { body: { patientId: PATIENT, proposals: [], redacted: false } };
    if (path === `/api/v1/patients/${PATIENT}/wounds`) return { body: { wounds: [] } };
    if (path.endsWith("/care-plan-links")) return { body: { links: [] } };
    if (path.endsWith("/template"))
      return {
        body: {
          encounterId,
          templateKey: "routine_visit:rn",
          vocabVersion: "2026.1.0",
          encounterType: "routine_visit",
          discipline: "rn",
          sections: world.templateSections,
        },
      };
    if (path.endsWith("/selections"))
      return {
        body: {
          templateKey: "routine_visit:rn",
          vocabVersion: "2026.1.0",
          sections: world.storedSections,
          layer1Preview: world.preview[encounterId] ?? "",
          version: world.version,
          fallIncident: null,
          editedNarrative: world.editedNarrative,
          editedNarrativeStale: false,
        },
      };
    if (path.endsWith("/adl")) return { body: world.adl };
    if (path.endsWith("/nutrition")) return { body: world.nutrition };
    if (path.endsWith("/weight-history"))
      return {
        body: {
          patientId: PATIENT,
          current: null,
          prior: null,
          history: [],
          weightUnitMissing: world.weightUnitMissing,
        },
      };
    if (path.endsWith("/vitals")) return { body: { encounterId, vitals: [] } };
    return { body: encounterView(encounterId) };
  }
  if (path.endsWith("/selections"))
    return {
      body: { version: world.version + 1, layer1Preview: world.preview[encounterId] ?? "" },
    };
  if (path.endsWith("/adl")) {
    world.adl = storedRecord(body, encounterId, world.adl);
    return { body: world.adl };
  }
  if (path.endsWith("/nutrition")) {
    world.nutrition = storedRecord(body, encounterId, world.nutrition);
    return { body: world.nutrition };
  }
  if (path.endsWith("/vitals")) return { body: { vitalsId: "vitals-1" } };
  if (path.endsWith("/finalize")) {
    world.status = "finalized";
    return { body: { status: "finalized", version: world.version + 2 } };
  }
  return { body: {} };
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input as RequestInfo, init);
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  const text = await request.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  world.calls.push(`${method} ${path}`);
  if (method !== "GET") world.bodies.push({ method, path, body });
  const route = world.routes[`${method} ${path}`];
  const reply = route ? await route({ method, path, body }) : defaultReply(method, path, body);
  if (reply === "drop") throw new TypeError("connection dropped");
  // A stored null (nothing recorded yet) is a null body, not an empty object.
  return responseWith(
    JSON.stringify(reply.body === undefined ? {} : reply.body),
    reply.status ?? 200,
    reply.onRead,
  );
}

/** A response whose body tells the test when the client has taken it, so "the late answer has landed" is a fact, not a guess at timing. */
function responseWith(text: string, status: number, onRead: (() => void) | undefined): Response {
  const headers = { "content-type": "application/json" };
  if (onRead === undefined) return new Response(text, { status, headers });
  const chunk = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    // Pulled again only once the chunk has been read.
    pull(controller) {
      controller.close();
      onRead();
    },
  });
  return new Response(body, { status, headers });
}

/** One turn of the event loop inside act: everything the answer just set in motion (parsing, the state it sets) has run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

function mountCompose(encounterId = ENCOUNTER) {
  const router = createMemoryRouter(
    [
      {
        path: "/patients/:patientId/encounters/:encounterId/compose",
        element: <EncounterCompose />,
      },
      { path: "*", element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [COMPOSE(encounterId)] },
  );
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return router;
}

const writes = () => world.calls.filter((call) => !call.startsWith("GET "));
const bodyOf = (method: string, path: string): unknown =>
  world.bodies.find((write) => write.method === method && write.path === path)?.body;
const reads = (path: string) => world.calls.filter((call) => call === `GET ${path}`);

const openSection = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
  user.click(await screen.findByRole("button", { name }));
const bathing = () => screen.getByRole("combobox", { name: "Bathing" }) as HTMLSelectElement;
const saveDraft = () => screen.getByRole("button", { name: "Save draft" });
const finalizeButton = () => screen.getByRole("button", { name: "Finalize note" });
const unload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  world = freshWorld();
});

describe("the recorded panels in the composer", () => {
  it("counts a saved ADL record as documenting the required ADL section: banner, nav pill, progress and hint", async () => {
    world.adl = STORED_ADL;
    const user = userEvent.setup();
    mountCompose();

    expect(await screen.findByText("Required documentation is complete")).toBeTruthy();
    expect(screen.queryByText(/needs? attention/)).toBeNull();
    expect(screen.getByText("1 of 4 sections documented")).toBeTruthy();
    expect(
      within(screen.getByText("required remaining").parentElement as HTMLElement).getByText("0"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activities of Daily Living: Documented" }),
    ).toBeTruthy();

    await openSection(user, /^Activities of Daily Living/);
    expect(screen.getByText(/The saved record above documents this section/)).toBeTruthy();
    expect(screen.queryByText(/Required\. This section has no preset statements/)).toBeNull();
  });

  it("starts the same section as required, and counts it once the ADLs are saved", async () => {
    const user = userEvent.setup();
    mountCompose();

    expect(await screen.findByText("1 section needs attention")).toBeTruthy();
    expect(
      screen.getByText(/Complete Activities of Daily Living before finalization/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activities of Daily Living: Required" }),
    ).toBeTruthy();
    expect(screen.getByText("0 of 4 sections documented")).toBeTruthy();

    await openSection(user, /^Activities of Daily Living/);
    expect(screen.getByText(/Required\. This section has no preset statements/)).toBeTruthy();
    await user.selectOptions(bathing(), "Limited assist");
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByText("Required documentation is complete")).toBeTruthy();
    expect(screen.getByText("1 of 4 sections documented")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activities of Daily Living: Documented" }),
    ).toBeTruthy();
  });

  it("does not count a wound panel as documenting anything: the server does not", async () => {
    const user = userEvent.setup();
    world.adl = STORED_ADL;
    mountCompose();
    await screen.findByText("Required documentation is complete");

    await openSection(user, /^Wounds/);
    expect(await screen.findByText("No wounds recorded for this patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wounds: Not started" })).toBeTruthy();
  });

  it("keeps one panel per recorded section mounted, reading each record once, and shows only the open section's", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("Documentation progress");

    await openSection(user, /^Activities of Daily Living/);
    expect(
      screen.getByRole("heading", { level: 2, name: "Activities of Daily Living" }),
    ).toBeVisible();
    // Panel headings sit one level under the section heading.
    expect(
      screen.getByRole("heading", { level: 3, name: "Activities of daily living" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Nutrition and hydration" })).toBeNull();

    await openSection(user, /^Nutrition and Hydration/);
    expect(
      screen.getByRole("heading", { level: 3, name: "Nutrition and hydration" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Activities of daily living" })).toBeNull();

    await openSection(user, /^Activities of Daily Living/);
    expect(reads(`${ENC(ENCOUNTER)}/adl`)).toHaveLength(1);
    expect(reads(`${ENC(ENCOUNTER)}/nutrition`)).toHaveLength(1);
  });

  it("makes the panels read-only while the composer saves the draft, and gives them back after", async () => {
    const user = userEvent.setup();
    const patch = gate();
    world.routes[`PATCH ${ENC(ENCOUNTER)}/selections`] = async () => {
      await patch.promise;
      return { body: { version: 4, layer1Preview: "" } };
    };
    mountCompose();
    await screen.findByText("Documentation progress");
    await openSection(user, /^Activities of Daily Living/);
    await screen.findByRole("combobox", { name: "Bathing" });

    fireEvent.click(saveDraft());
    await waitFor(() => expect(bathing().matches(":disabled")).toBe(true));
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();

    await act(async () => patch.release());
    await waitFor(() => expect(bathing().matches(":disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeEnabled();
  });
});

describe("unsaved input in a panel", () => {
  it("is announced, guards the browser and the router, and survives a switch of section", async () => {
    const user = userEvent.setup();
    const router = mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );

    expect(
      await screen.findByText(
        /Unsaved entries in a section\. Use that section's own Save button\./,
      ),
    ).toBeTruthy();
    expect(unload().defaultPrevented).toBe(true);

    // Another section and back: what was chosen is still chosen, and nothing was read a second time.
    await openSection(user, /^Assessment/);
    await openSection(user, /^Activities of Daily Living/);
    expect(bathing().value).toBe("supervision");
    expect(reads(`${ENC(ENCOUNTER)}/adl`)).toHaveLength(1);

    await act(async () => {
      await router.navigate("/elsewhere");
    });
    expect(screen.getByRole("alertdialog", { name: "Leave without saving?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText(/Unsaved entries in a section/)).toBeTruthy();
  });

  it("stops guarding once the panel saves it", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(unload().defaultPrevented).toBe(false);
  });

  it("is not lost silently by Finalize: the note says to save it first and sends nothing", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Nutrition and Hydration/);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Appetite" }), "Poor");

    await user.click(finalizeButton());

    expect(await screen.findByText("Unsaved entries in a section")).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("counts an open, typed-in wound form as unsaved", async () => {
    const user = userEvent.setup();
    world.routes[`GET /api/v1/patients/${PATIENT}/wounds`] = () => ({
      body: {
        wounds: [
          {
            id: "wound-1",
            patientId: PATIENT,
            siteCode: "heel",
            laterality: "left",
            site: "left heel",
            etiology: "pressure_injury",
            acquired: "present_on_admission",
            onsetOn: "2026-11-01",
            status: "open",
            closedOn: null,
            createdAt: "2026-11-01T12:00:00.000Z",
            latestObservation: null,
          },
        ],
      },
    });
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Wounds/);
    await user.click(
      await screen.findByRole("button", { name: "Record today's observation: Left heel" }),
    );
    expect(screen.getByText("All changes saved")).toBeTruthy();

    await user.type(screen.getByLabelText("Length (cm)"), "3");

    expect(await screen.findByText(/Unsaved entries in a section/)).toBeTruthy();
    expect(unload().defaultPrevented).toBe(true);
  });
});

describe("a panel write in flight", () => {
  it("locks Save draft and Finalize and says so, then gives them back and refreshes the note", async () => {
    const user = userEvent.setup();
    const put = gate();
    world.routes[`PUT ${ENC(ENCOUNTER)}/adl`] = async ({ body }) => {
      await put.promise;
      world.adl = storedRecord(body, ENCOUNTER, world.adl);
      return { body: world.adl };
    };
    world.preview[ENCOUNTER] = "";
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByText("Saving a section…")).toBeTruthy();
    expect(saveDraft()).toBeDisabled();
    expect(finalizeButton()).toBeDisabled();
    const readsBefore = reads(`${ENC(ENCOUNTER)}/selections`).length;

    world.preview[ENCOUNTER] = "Patient needs supervision with bathing.";
    await act(async () => put.release());
    expect(await screen.findByText("Patient needs supervision with bathing.")).toBeTruthy();
    expect(reads(`${ENC(ENCOUNTER)}/selections`).length).toBe(readsBefore + 1);
    expect(saveDraft()).toBeEnabled();
    expect(finalizeButton()).toBeEnabled();
  });

  it("holds the leave prompt while it is out", async () => {
    const user = userEvent.setup();
    const put = gate();
    world.routes[`PUT ${ENC(ENCOUNTER)}/adl`] = async () => {
      await put.promise;
      return "drop" as const;
    };
    const router = mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save ADLs" }));
    await screen.findByText("Saving a section…");

    await act(async () => {
      await router.navigate("/elsewhere");
    });

    const dialog = screen.getByRole("alertdialog", { name: "Leave without saving?" });
    expect(within(dialog).getByText(/Your visit note is being saved/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Discard changes" })).toBeNull();
    await act(async () => put.release());
  });
});

describe("the note's preview after a panel saves", () => {
  async function saveAdlWith(readFails: Reply) {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    // From here the note cannot be read again.
    world.routes[`GET ${ENC(ENCOUNTER)}/selections`] = () => readFails;
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));
  }

  it("says so when the note could not be read again after a refused read", async () => {
    await saveAdlWith({ status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } });

    expect(await screen.findByText("Note preview not refreshed")).toBeTruthy();
    expect(screen.getByText("ADLs saved.")).toBeTruthy();
  });

  it("says so, and leaves no unhandled rejection, when the connection drops on the re-read", async () => {
    await saveAdlWith("drop");

    expect(await screen.findByText("Note preview not refreshed")).toBeTruthy();
  });

  it("does not let a late answer for one note overwrite the note the author moved to", async () => {
    const user = userEvent.setup();
    world.preview[ENCOUNTER] = "";
    world.preview[OTHER_ENCOUNTER] = "The other note.";
    const router = mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    const late = gate();
    const lateTaken = gate();
    world.routes[`GET ${ENC(ENCOUNTER)}/selections`] = async () => {
      await late.promise;
      return {
        onRead: lateTaken.release,
        body: {
          templateKey: "routine_visit:rn",
          vocabVersion: "2026.1.0",
          sections: [],
          layer1Preview: "The first note.",
          version: 4,
          fallIncident: null,
          editedNarrative: null,
          editedNarrativeStale: false,
        },
      };
    };
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));
    await waitFor(() => expect(reads(`${ENC(ENCOUNTER)}/selections`).length).toBe(2));

    // Browser Back or Forward to another note while the first note's re-read is still out.
    await act(async () => {
      await router.navigate(COMPOSE(OTHER_ENCOUNTER));
    });
    expect(await screen.findByText("The other note.")).toBeTruthy();
    await act(async () => late.release());
    // The first note's answer is delivered and handled; only then is "it changed nothing" worth asserting.
    await lateTaken.promise;
    await settle();

    expect(screen.getByText("The other note.")).toBeTruthy();
    expect(screen.queryByText("The first note.")).toBeNull();
  });
});

describe("the vitals panel", () => {
  const openVitals = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    return screen.findByRole("heading", { name: "Visit vitals" });
  };

  it("refuses a weight or height that is not a number, in words, and sends nothing", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openVitals(user);

    await user.type(screen.getByRole("textbox", { name: "Weight" }), "heavy");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));

    expect(await screen.findByText("Correct the weight or height before recording.")).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("says so on a dropped connection and gives the form back instead of staying on Recording…", async () => {
    const user = userEvent.setup();
    world.routes[`POST ${ENC(ENCOUNTER)}/vitals`] = () => "drop";
    mountCompose();
    await openVitals(user);

    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "88");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));

    expect(
      await screen.findByText(
        "The connection was interrupted. Your changes are still here; try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record vitals" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Heart rate" })).toHaveValue("88");
  });

  it("says why the last visit's weight is not shown when it could not be read, and still takes a weight", async () => {
    const user = userEvent.setup();
    world.routes[`GET ${ENC(ENCOUNTER)}/weight-history`] = () => ({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "no" } },
    });
    mountCompose();
    await openVitals(user);

    expect(
      await screen.findByText(
        "The last visit's weight is not shown: That visit is no longer available to you.",
      ),
    ).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Weight" }), "150");
    expect(screen.getByRole("button", { name: "Record vitals" })).toBeEnabled();
  });

  it("counts typed vitals as unsaved and a vitals write in flight as busy", async () => {
    const user = userEvent.setup();
    const post = gate();
    world.routes[`POST ${ENC(ENCOUNTER)}/vitals`] = async () => {
      await post.promise;
      return { body: { vitalsId: "vitals-1" } };
    };
    mountCompose();
    await openVitals(user);

    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "88");
    expect(screen.getByText(/Unsaved entries in a section/)).toBeTruthy();
    expect(unload().defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Record vitals" }));
    expect(await screen.findByText("Saving a section…")).toBeTruthy();
    expect(finalizeButton()).toBeDisabled();
    await act(async () => post.release());
    expect(await screen.findByText("Vitals recorded")).toBeTruthy();
  });

  it("is read-only while the note text is being edited, so recording cannot refresh the preview under the edit box", async () => {
    const user = userEvent.setup();
    world.preview[ENCOUNTER] = "Patient resting.";
    mountCompose();
    await openVitals(user);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Note text" });

    expect(screen.getByRole("button", { name: "Record vitals" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Heart rate" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Weight" })).toBeDisabled();
  });

  it("is closed, and cannot be opened, once the note is finalized", async () => {
    const user = userEvent.setup();
    world.adl = STORED_ADL;
    mountCompose();
    await openVitals(user);

    await user.click(finalizeButton());

    expect(await screen.findByText("Note finalized")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Visit vitals" })).toBeNull());
    expect(screen.getByRole("button", { name: "Vitals" })).toBeDisabled();
  });
});

describe("the plan-of-care step in the composer", () => {
  it("is its own region with an h2, beside the note's other sections", async () => {
    mountCompose();

    const region = await screen.findByRole("region", { name: "Plan of care" });
    expect(within(region).getByRole("heading", { level: 2, name: "Plan of care" })).toBeVisible();
    expect(await within(region).findByText("Dyspnea at rest")).toBeTruthy();
  });

  it("offers no proposal while the note text is being edited, and offers it again after", async () => {
    const user = userEvent.setup();
    mountCompose();
    const region = await screen.findByRole("region", { name: "Plan of care" });
    expect(await within(region).findByRole("button", { name: "Add problem" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Note text" });
    expect(within(region).queryByRole("button", { name: "Add problem" })).toBeNull();
    expect(
      within(region).getByRole("checkbox", { name: /Addressed on this visit/ }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await within(region).findByRole("button", { name: "Add problem" })).toBeTruthy();
  });

  it("counts a proposal being typed as unsaved, and guards the browser", async () => {
    const user = userEvent.setup();
    mountCompose();
    const region = await screen.findByRole("region", { name: "Plan of care" });
    await user.click(await within(region).findByRole("button", { name: "Add problem" }));
    expect(screen.getByText("All changes saved")).toBeTruthy();

    await user.type(await screen.findByLabelText(/Problem description/), "Anxiety at night");

    expect(await screen.findByText(/Unsaved entries in a section/)).toBeTruthy();
    expect(unload().defaultPrevented).toBe(true);
  });
});

describe("the vitals panel's weight and height", () => {
  const openVitals = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await screen.findByRole("heading", { name: "Visit vitals" });
  };
  const VITALS = `${ENC(ENCOUNTER)}/vitals`;
  const refusal = (details: unknown[]): Reply => ({
    status: 422,
    body: { error: { code: "VALIDATION_FAILED", message: "request validation failed", details } },
  });

  it("sends each measurement with its unit: pounds and inches unless the author chose others", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openVitals(user);

    await user.type(screen.getByRole("textbox", { name: "Weight" }), "150.5");
    await user.type(screen.getByRole("textbox", { name: "Height" }), "65");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));
    await waitFor(() => expect(bodyOf("POST", VITALS)).toBeTruthy());

    expect(bodyOf("POST", VITALS)).toEqual({
      weight: "150.5",
      weightUnit: "lb",
      height: "65",
      heightUnit: "in",
    });
  });

  it("sends the units the author chose, kilograms and centimetres", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openVitals(user);

    await user.selectOptions(screen.getByRole("combobox", { name: "Weight unit" }), "kg");
    await user.selectOptions(screen.getByRole("combobox", { name: "Height unit" }), "cm");
    await user.type(screen.getByRole("textbox", { name: "Weight" }), "68");
    await user.type(screen.getByRole("textbox", { name: "Height" }), "170");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));
    await waitFor(() => expect(bodyOf("POST", VITALS)).toBeTruthy());

    expect(bodyOf("POST", VITALS)).toEqual({
      weight: "68",
      weightUnit: "kg",
      height: "170",
      heightUnit: "cm",
    });
  });

  it("never sends a unit without its value", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openVitals(user);

    await user.selectOptions(screen.getByRole("combobox", { name: "Weight unit" }), "kg");
    await user.selectOptions(screen.getByRole("combobox", { name: "Height unit" }), "cm");
    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "88");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));
    await waitFor(() => expect(bodyOf("POST", VITALS)).toBeTruthy());

    expect(bodyOf("POST", VITALS)).toEqual({ heartRate: 88 });
  });

  it.each(["-5", "1e3", "150,5", "0", "abc"])(
    "refuses a weight of %s, which the server would refuse, in words and before sending anything",
    async (typed) => {
      const user = userEvent.setup();
      mountCompose();
      await openVitals(user);

      await user.type(screen.getByRole("textbox", { name: "Weight" }), typed);
      await user.click(screen.getByRole("button", { name: "Record vitals" }));

      expect(
        await screen.findByText("Correct the weight or height before recording."),
      ).toBeTruthy();
      expect(screen.getByText("Enter the weight as a number greater than 0.")).toBeTruthy();
      expect(world.bodies).toEqual([]);
    },
  );

  it("shows the server's refusals on the fields they name, and clears one when that field is edited", async () => {
    const user = userEvent.setup();
    world.routes[`POST ${VITALS}`] = () =>
      refusal([
        { field: "weight", code: "INVALID", message: "weight must be a positive number" },
        { field: "heightUnit", code: "REQUIRED", message: "a height needs its unit (cm or in)" },
        { field: "heartRate", code: "OUT_OF_RANGE", message: "outside the plausible range" },
      ]);
    mountCompose();
    await openVitals(user);
    await user.type(screen.getByRole("textbox", { name: "Weight" }), "150");
    await user.type(screen.getByRole("textbox", { name: "Height" }), "65");
    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "400");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));

    // Each sentence sits on its own field (a unit's refusal on the value it belongs to).
    expect(await screen.findByText("Weight must be a positive number.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Weight" })).toBeInvalid();
    expect(screen.getByText("A height needs its unit (cm or in).")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Height" })).toBeInvalid();
    expect(screen.getByText("Outside the plausible range.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Heart rate" })).toBeInvalid();
    expect(screen.getByText(/Some entries were not accepted/)).toBeTruthy();
    // What was typed is still there.
    expect(screen.getByRole("textbox", { name: "Weight" })).toHaveValue("150");

    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "0");
    expect(screen.queryByText("Outside the plausible range.")).toBeNull();
    expect(screen.getByText("A height needs its unit (cm or in).")).toBeTruthy();
  });

  it("says a refusal that names no field of the panel in the alert, as a sentence", async () => {
    const user = userEvent.setup();
    world.routes[`POST ${VITALS}`] = () =>
      refusal([
        {
          field: "clinicallyNotIndicatedReason",
          code: "VITALS_CNI_REASON_REQUIRED",
          message: "a reason of at least 10 characters is required",
        },
      ]);
    mountCompose();
    await openVitals(user);
    await user.type(screen.getByRole("textbox", { name: "Heart rate" }), "88");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));

    expect(await screen.findByText(/a reason of at least 10 characters is required/)).toBeTruthy();
    expect(screen.queryByText(/VITALS_CNI_REASON_REQUIRED/)).toBeNull();
  });
});

describe("a note that is no longer a draft", () => {
  it("shows the ADL and nutrition panels read-only once the note is finalized", async () => {
    const user = userEvent.setup();
    world.status = "finalized";
    world.adl = STORED_ADL;
    mountCompose();
    await screen.findByText("Documentation progress");

    await openSection(user, /^Activities of Daily Living/);
    expect(await screen.findByRole("combobox", { name: "Bathing" })).toBeDisabled();
    expect(bathing()).toHaveValue("limited_assist");
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();

    await openSection(user, /^Nutrition and Hydration/);
    expect(await screen.findByRole("combobox", { name: "Appetite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save nutrition" })).toBeDisabled();
    expect(writes()).toEqual([]);
  });

  it("says the note is finalized, in words, if a save slips through after it was finalized elsewhere", async () => {
    const user = userEvent.setup();
    world.routes[`PUT ${ENC(ENCOUNTER)}/adl`] = () => ({
      status: 409,
      body: { error: { code: "NOTE_PINNED_AT_FINALIZE", message: "pinned" } },
    });
    mountCompose();
    await screen.findByText("Documentation progress");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(
      await screen.findByText(
        "This note is finalized, so these findings can no longer be changed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/NOTE_PINNED_AT_FINALIZE/)).toBeNull();
    expect(bathing()).toBeDisabled();
  });

  it("reads the pinned preview of a finalized note without a stale-edit notice or edit controls", async () => {
    world.status = "finalized";
    world.preview[ENCOUNTER] = "The pinned text of the note.";
    mountCompose();

    expect(await screen.findByText("The pinned text of the note.")).toBeTruthy();
    expect(screen.queryByText(/The note changed after you edited this text/)).toBeNull();
    expect(screen.queryByText("Edit out of date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("Available")).toBeTruthy();
  });

  it("reads a pinned edit of a finalized note as the author's, not stale", async () => {
    world.status = "finalized";
    world.preview[ENCOUNTER] = "The generated text.";
    world.editedNarrative = "The text the author signed.";
    mountCompose();

    expect(await screen.findByText("The text the author signed.")).toBeTruthy();
    expect(screen.getByText("Edited by you")).toBeTruthy();
    expect(screen.queryByText("The generated text.")).toBeNull();
  });
});

describe("a stale ADL record in the composer", () => {
  it("keeps the unsaved entry visible and guarded until the author reloads, then takes the current record", async () => {
    const user = userEvent.setup();
    world.adl = STORED_ADL;
    let reads = 0;
    world.routes[`GET ${ENC(ENCOUNTER)}/adl`] = () => {
      reads += 1;
      return {
        body:
          reads === 1
            ? STORED_ADL
            : { ...STORED_ADL, version: STORED_ADL.version + 7, items: { bathing: "independent" } },
      };
    };
    world.routes[`PUT ${ENC(ENCOUNTER)}/adl`] = () => ({
      status: 409,
      body: { error: { code: "STALE_VERSION", message: "stale" } },
    });
    mountCompose();
    await screen.findByText("Documentation progress");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Total dependence",
    );
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByText(/This record changed since you opened it\./)).toBeTruthy();
    expect(bathing().value).toBe("total_dependence");
    expect(unload().defaultPrevented).toBe(true);
    expect(screen.getByText(/Unsaved entries in a section/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reload the record" }));

    await waitFor(() => expect(bathing().value).toBe("independent"));
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(unload().defaultPrevented).toBe(false);
  });
});

describe("statement details the server would refuse", () => {
  const ASSESSMENT = section("assessment", "Assessment", {
    entries: [
      {
        code: "nv.pain.score",
        label: "Pain score recorded",
        category: "observation",
        bodySystem: null,
        slots: ["pain_score"],
        slotSpecs: {},
        exclusiveGroup: null,
      },
    ],
  });

  it("drops a stored detail that is not one of its statement's slots, says so, and saves without it", async () => {
    const user = userEvent.setup();
    world.templateSections = [ASSESSMENT];
    world.storedSections = [
      {
        sectionId: "assessment",
        entries: [{ code: "nv.pain.score", params: { pain_score: "4", patient: "someone else" } }],
        freeText: "",
      },
    ];
    mountCompose();

    expect(
      await screen.findByText(
        /1 saved detail does not belong to its statement and was removed here\. Save the draft to apply the change\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(bodyOf("PATCH", `${ENC(ENCOUNTER)}/selections`)).toBeTruthy());
    expect(bodyOf("PATCH", `${ENC(ENCOUNTER)}/selections`)).toEqual({
      fallIncidentId: null,
      sections: [
        {
          sectionId: "assessment",
          entries: [{ code: "nv.pain.score", params: { pain_score: "4" } }],
        },
      ],
    });
  });

  it("shows the server's sentence, not the code, when a refused detail reaches the author", async () => {
    const user = userEvent.setup();
    world.templateSections = [ASSESSMENT];
    world.routes[`PATCH ${ENC(ENCOUNTER)}/selections`] = () => ({
      status: 422,
      body: {
        error: {
          code: "VALIDATION_FAILED",
          message: "selection validation failed",
          details: [
            {
              field: "assessment",
              code: "SLOT_UNKNOWN",
              message: '"Pain score recorded" has no "patient" value to fill.',
            },
          ],
        },
      },
    });
    mountCompose();
    await screen.findByText("Documentation progress");

    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(
      await screen.findByText('Assessment: "Pain score recorded" has no "patient" value to fill.'),
    ).toBeTruthy();
    expect(screen.queryByText(/SLOT_UNKNOWN/)).toBeNull();
  });

  it("does not say 'save the draft' about details removed from a note that can no longer be saved", async () => {
    world.status = "finalized";
    world.templateSections = [ASSESSMENT];
    world.storedSections = [
      {
        sectionId: "assessment",
        entries: [{ code: "nv.pain.score", params: { pain_score: "4", patient: "someone else" } }],
        freeText: "",
      },
    ];
    mountCompose();

    await screen.findByText("Documentation progress");
    expect(screen.queryByText(/Save the draft to apply the change/)).toBeNull();
  });
});

describe("unsaved panels at Finalize, and the notices around them", () => {
  it("names the section that holds unsaved entries, brings it into view, and lets the author discard them", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    await openSection(user, /^Assessment/);
    expect(screen.queryByRole("combobox", { name: "Bathing" })).toBeNull();

    await user.click(finalizeButton());

    expect(await screen.findByText("Unsaved entries in a section")).toBeTruthy();
    expect(
      screen.getByText(
        "Save or discard the unsaved entries in Activities of Daily Living before finalizing.",
      ),
    ).toBeTruthy();
    // The section that holds them is now the open one, with the way to discard them in reach.
    expect(await screen.findByRole("combobox", { name: "Bathing" })).toHaveValue("supervision");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(bathing().value).toBe("");
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    // The notice that asked for it goes once there is nothing left to save.
    expect(screen.queryByText("Unsaved entries in a section")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("names the vitals when they hold unsaved entries, opens them, and lets them be discarded", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await user.type(await screen.findByRole("textbox", { name: "Heart rate" }), "88");
    await user.click(screen.getByRole("button", { name: "Close vitals" }));

    await user.click(finalizeButton());

    expect(
      await screen.findByText(
        "Save or discard the unsaved entries in Visit vitals before finalizing.",
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Visit vitals" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Discard entries" }));

    expect(screen.getByRole("textbox", { name: "Heart rate" })).toHaveValue("");
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    expect(screen.queryByText("Unsaved entries in a section")).toBeNull();
  });

  it("starts another note without the last note's notice", async () => {
    const user = userEvent.setup();
    world.preview[OTHER_ENCOUNTER] = "The other note.";
    const router = mountCompose();
    await screen.findByText("All changes saved");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Draft saved")).toBeTruthy();

    await act(async () => {
      await router.navigate(COMPOSE(OTHER_ENCOUNTER));
    });

    expect(await screen.findByText("The other note.")).toBeTruthy();
    expect(screen.queryByText("Draft saved")).toBeNull();
  });
});

describe("the preview after a failed re-read", () => {
  it("stays flagged as out of date beside a later success notice, until a read lands", async () => {
    const user = userEvent.setup();
    world.preview[ENCOUNTER] = "Patient resting.";
    mountCompose();
    await screen.findByText("Patient resting.");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const text = await screen.findByRole("textbox", { name: "Note text" });
    // From here the note cannot be read again.
    world.routes[`GET ${ENC(ENCOUNTER)}/selections`] = () => ({ status: 503, body: {} });
    await user.clear(text);
    await user.type(text, "Patient resting comfortably.");
    await user.click(screen.getByRole("button", { name: "Apply edit" }));

    expect(await screen.findByText("Note text updated")).toBeTruthy();
    expect(screen.getByText("Note preview not refreshed")).toBeTruthy();

    // A read that lands clears it.
    delete world.routes[`GET ${ENC(ENCOUNTER)}/selections`];
    await user.click(screen.getByRole("button", { name: "Save & refresh preview" }));
    await waitFor(() => expect(screen.queryByText("Note preview not refreshed")).toBeNull());
  });

  it("does not let a panel's slow re-read overwrite the newer preview a draft save brought", async () => {
    const user = userEvent.setup();
    world.preview[ENCOUNTER] = "";
    mountCompose();
    await screen.findByText("All changes saved");
    await openSection(user, /^Activities of Daily Living/);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Bathing" }),
      "Supervision",
    );
    const slow = gate();
    const slowTaken = gate();
    world.routes[`GET ${ENC(ENCOUNTER)}/selections`] = async () => {
      await slow.promise;
      return {
        onRead: slowTaken.release,
        body: {
          templateKey: "routine_visit:rn",
          vocabVersion: "2026.1.0",
          sections: [],
          layer1Preview: "The older preview.",
          version: 4,
          fallIncident: null,
          editedNarrative: null,
          editedNarrativeStale: false,
        },
      };
    };
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));
    await waitFor(() => expect(reads(`${ENC(ENCOUNTER)}/selections`).length).toBe(2));

    // While that re-read is out, the author saves the draft, which answers with the newer note.
    world.preview[ENCOUNTER] = "The newer preview.";
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("The newer preview.")).toBeTruthy();

    await act(async () => slow.release());
    await slowTaken.promise;
    await settle();

    expect(screen.getByText("The newer preview.")).toBeTruthy();
    expect(screen.queryByText("The older preview.")).toBeNull();
  });
});

describe("the vitals panel keeps what was typed", () => {
  it("survives closing and reopening, and still guards the page while closed", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await user.type(await screen.findByRole("textbox", { name: "Heart rate" }), "88");

    await user.click(screen.getByRole("button", { name: "Close vitals" }));
    expect(screen.queryByRole("heading", { name: "Visit vitals" })).toBeNull();
    expect(screen.getByText(/Unsaved entries in a section/)).toBeTruthy();
    expect(unload().defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Vitals" }));
    expect(await screen.findByRole("textbox", { name: "Heart rate" })).toHaveValue("88");
    // It was read for the weight comparison once, not again on reopening.
    expect(reads(`${ENC(ENCOUNTER)}/weight-history`)).toHaveLength(1);
  });

  it("starts the next set empty once one is recorded", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await user.type(await screen.findByRole("textbox", { name: "Heart rate" }), "88");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));
    await screen.findByText("Vitals recorded");

    await user.click(screen.getByRole("button", { name: "Vitals" }));

    expect(await screen.findByRole("textbox", { name: "Heart rate" })).toHaveValue("");
    expect(screen.getByText("All changes saved")).toBeTruthy();
  });

  it("warns that an earlier weight has no unit and is left out, and clears it once a fresh read says otherwise", async () => {
    const user = userEvent.setup();
    world.weightUnitMissing = true;
    mountCompose();
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));

    const warning = await screen.findByText(
      "A weight recorded earlier on this visit has no unit, so it is left out of the note and BMI. Record it again with its unit.",
    );
    // A status message (the kit's polite <output>), not an alert.
    expect(warning.tagName).toBe("OUTPUT");
    // It is the weight history's own flag: no read beyond the one the panel already makes.
    expect(reads(`${ENC(ENCOUNTER)}/weight-history`)).toHaveLength(1);

    // Recording the weight again with its unit: the same read is asked again, and now says the weight is complete.
    world.weightUnitMissing = false;
    await user.type(screen.getByRole("textbox", { name: "Weight" }), "150");
    await user.click(screen.getByRole("button", { name: "Record vitals" }));
    await screen.findByText("Vitals recorded");
    await waitFor(() => expect(reads(`${ENC(ENCOUNTER)}/weight-history`)).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await screen.findByRole("heading", { name: "Visit vitals" });
    expect(screen.queryByText(/has no unit, so it is left out of the note and BMI/)).toBeNull();
  });

  it("shows no warning when every stored weight has its unit", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByText("Documentation progress");
    await user.click(screen.getByRole("button", { name: "Vitals" }));
    await screen.findByRole("heading", { name: "Visit vitals" });

    expect(screen.queryByText(/has no unit, so it is left out of the note and BMI/)).toBeNull();
  });
});
