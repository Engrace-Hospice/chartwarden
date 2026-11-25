// @vitest-environment jsdom
// The pain assessment helper inside the real composer: under Symptom Management the pain statements are listed as before, the
// helper's own statements are NOT listed beside them, and ticking "pain limiting function" opens the helper. What is recorded in it is
// sent in the same section's selection tree, which is what the server validates and the note is assembled from. Synthetic values only.
import { PAIN_ASSESSMENT_CODES as C } from "@chartwarden/types";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const painScore = { kind: "integer", min: 0, max: 10, label: "Pain score (0–10)" };
const menuEntry = (
  code: string,
  label: string,
  slots: string[] = [],
  slotSpecs: Record<string, unknown> = {},
  exclusiveGroup: string | null = null,
) => ({
  code,
  label,
  category: "symptom_impact",
  bodySystem: null,
  slots,
  slotSpecs,
  exclusiveGroup,
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
        menuEntry(
          "nv.sym.pain_controlled",
          "Symptom impact — pain controlled on current regimen",
          ["pain_score"],
          { pain_score: painScore },
          "pain-status",
        ),
        menuEntry(
          "nv.sym.pain_uncontrolled",
          "Symptom impact — pain limiting function",
          ["pain_score"],
          { pain_score: painScore },
          "pain-status",
        ),
        menuEntry(C.location, "Pain assessment — location", ["pain_location"]),
        menuEntry(C.goal, "Pain assessment — the patient's acceptable pain level", ["pain_goal"], {
          pain_goal: painScore,
        }),
      ],
    },
    {
      sectionId: "plan",
      heading: "Plan and Next Visit",
      required: false,
      allowedCategories: [],
      entries: [],
    },
  ],
};

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];

const ENCOUNTER_BODY = {
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
};

function replyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path.endsWith("/template")) return TEMPLATE;
    if (path.endsWith("/selections"))
      return {
        templateKey: TEMPLATE.templateKey,
        vocabVersion: TEMPLATE.vocabVersion,
        sections: [],
        layer1Preview: "",
        version: 3,
        fallIncident: null,
        editedNarrative: null,
        editedNarrativeStale: false,
      };
    if (path === `/api/v1/patients/${PATIENT}`)
      return { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" };
    if (path.endsWith("/fall-incidents")) return { incidents: [], unavailable: false };
    if (path.endsWith("/vitals")) return { encounterId: ENCOUNTER, vitals: [] };
    if (path === `/api/v1/encounters/${ENCOUNTER}`) return ENCOUNTER_BODY;
    return {};
  }
  if (path.endsWith("/selections")) return { version: 4, layer1Preview: "" };
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
  }
  if (method === "GET" && path.endsWith("/draft")) {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(replyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

function mountCompose() {
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
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function openSymptomManagement(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Symptom Management/ }));
  await screen.findByLabelText(/pain limiting function/i);
}

beforeEach(() => {
  calls = [];
  bodies = [];
});

describe("the pain assessment helper in the composer", () => {
  it("lists the pain statements and none of the helper's own, and shows no helper until pain is picked", async () => {
    mountCompose();
    await openSymptomManagement();
    expect(screen.getByLabelText(/pain controlled on current regimen/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Pain assessment — location/)).toBeNull();
    expect(screen.queryByText(/characteristics documented/)).toBeNull();
  });

  it("opens the helper when 'pain limiting function' is picked and sends what is recorded in the same section", async () => {
    mountCompose();
    await openSymptomManagement();
    fireEvent.click(screen.getByLabelText(/pain limiting function/i));
    fireEvent.change(await screen.findByLabelText("Pain score (0–10)"), { target: { value: "6" } });

    const summary = await screen.findByText(/Pain assessment: 2 of 7 characteristics documented/);
    expect(summary).toBeTruthy();
    expect(screen.getByRole("region", { name: "Consider a plan-of-care review" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "right hip" } });
    fireEvent.change(screen.getByLabelText("The patient's own acceptable pain level"), {
      target: { value: "3" },
    });
    expect(screen.getByText(/3 of 7 characteristics documented/)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Consider a plan-of-care review" })).getByText(
        /above the patient's own acceptable level of 3/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(calls).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as {
      sections: {
        sectionId: string;
        entries: { code: string; params?: Record<string, unknown> }[];
      }[];
    };
    const section = sent.sections.find((s) => s.sectionId === "symptom_management");
    expect(section?.entries).toEqual([
      { code: "nv.sym.pain_uncontrolled", params: { pain_score: "6" } },
      { code: C.location, params: { pain_location: "right hip" } },
      { code: C.goal, params: { pain_goal: "3" } },
    ]);
  });

  it("swapping to 'pain controlled' keeps the helper and its records", async () => {
    mountCompose();
    await openSymptomManagement();
    fireEvent.click(screen.getByLabelText(/pain limiting function/i));
    fireEvent.change(await screen.findByLabelText("Location"), { target: { value: "left knee" } });
    fireEvent.click(screen.getByLabelText(/pain controlled on current regimen/i));
    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("left knee");
  });

  it("'Go to Plan of care' is advisory: it only brings the step into view and writes nothing", async () => {
    mountCompose();
    await openSymptomManagement();
    fireEvent.click(screen.getByLabelText(/pain limiting function/i));
    fireEvent.click(await screen.findByRole("button", { name: "Go to Plan of care" }));
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });
});
