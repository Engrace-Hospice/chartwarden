// WF09 WP3 — shared fixtures for the composer's review and finalize suites: a synthetic note with a routine-visit template, the routes it
// reads and writes, and the mount. The net answers by "METHOD /path", so a test reads what was sent from `world.calls`. Imported only by
// *.dom.test.tsx files.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { SessionProvider } from "../../../../shell/session";
import { type Call, type Responder, makeFetch } from "../../__tests__/closure-test-harness";
import { EncounterCompose } from "../../encounter-compose";

export const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const BASE = `/api/v1/encounters/${ENC}`;
export const FINALIZE = `POST ${BASE}/finalize`;
export const FORTY = "The visit was documented late because the chart was unavailable.";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};

export const template = {
  encounterId: ENC,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    ["chief_concern", "Reason for Visit", false],
    ["vitals_review", "Vital Signs Review", true],
    ["assessment", "Assessment", true],
    ["plan", "Plan and Next Visit", false],
  ].map(([sectionId, heading, required]) => ({
    sectionId,
    heading,
    required,
    allowedCategories: [],
    recordedPanel: null,
    entries:
      sectionId === "assessment"
        ? [
            {
              code: "nv.resp.dyspnea_at_rest",
              label: "Dyspnea at rest",
              category: "observation",
              bodySystem: null,
              slots: [],
              slotSpecs: {},
              exclusiveGroup: null,
            },
          ]
        : [],
  })),
};

/** What the net holds between tests: the note's status, and every request it received. */
export const world: { status: string; calls: Call[] } = { status: "draft", calls: [] };

export function resetWorld(): void {
  world.status = "draft";
  world.calls = [];
}

export const refusal = (
  httpStatus: number,
  code: string,
  details: unknown[] = [],
  message = "refused",
) => ({
  status: httpStatus,
  body: { error: { code, message, details } },
});

export function routes(over: Record<string, Responder> = {}): Record<string, Responder> {
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
        serviceDate: "2026-11-17",
        status: world.status,
        lateEntryTier: "normal",
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
    [FINALIZE]: () => {
      world.status = "finalized";
      return { body: { status: "finalized", version: 5 } };
    },
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
    }),
    [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
    [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
      body: { patientId: PATIENT, proposals: [], redacted: false },
    }),
    // The tenant has the visit-note draft switched off.
    [`GET ${BASE}/draft`]: () => refusal(404, "NOT_FOUND"),
    ...over,
  };
}

export function mountComposer(
  over: Record<string, Responder> = {},
  entry = `/patients/${PATIENT}/encounters/${ENC}/compose`,
): void {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(routes(over), world.calls),
  });
  const router = createMemoryRouter(
    [
      {
        path: "/patients/:patientId/encounters/:encounterId/compose",
        element: <EncounterCompose />,
      },
      { path: "/patients/:patientId/care-plan", element: <h1>Care plan screen</h1> },
      { path: "*", element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [entry] },
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

export const ready = (): Promise<unknown> =>
  screen.findByRole("heading", { name: "Compose visit note" });
export const checksPanel = (): HTMLElement =>
  screen.getByRole("region", { name: "Finalize and sign checks" });
export const reviewPanel = (): HTMLElement => screen.getByRole("region", { name: "Review note" });
export const openSection = async (
  user: ReturnType<typeof userEvent.setup>,
  heading: RegExp,
): Promise<void> => {
  await user.click(
    within(await screen.findByLabelText("Visit note sections")).getByRole("button", {
      name: heading,
    }),
  );
};
export const finalizeCalls = (): Call[] =>
  world.calls.filter((c) => `${c.method} ${c.path}` === `POST ${BASE}/finalize`);
export const firstBlocker = (): HTMLElement | undefined =>
  within(checksPanel())
    .getAllByRole("listitem")
    .find((row) => row.dataset.blocker !== undefined);
