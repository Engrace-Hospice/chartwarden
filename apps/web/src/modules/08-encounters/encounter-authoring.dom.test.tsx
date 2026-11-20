import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/08-encounters — #91: the visit note must be authorable, not just signable.
//
// M8's sign / acknowledge / cosign-sign / supervisor-release ceremonies were already built. The write
// this issue's title names — "the staff app can read and SIGN clinical records but cannot AUTHOR one" —
// was not: `apps/web/src/modules/08-encounters` had no composer at all. A visit note is the CoP
// documentation of the visit and the substantiation behind the claim.
//
// The net asserts on RECORDED FETCH CALLS — method, path, body AND headers — because M8's save carries
// `If-Match` as a typed header param (§7.7), and a spy over the api client would not distinguish
// sending it from forgetting it. Several assertions are about the SHAPE of the selection tree, which the
// server validates section-by-section and code-by-code: a composer that sent a section the template does
// not have would be rejected in production and would pass a shallow "did we PATCH" check.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { JSX } from "react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EncounterCompose } from "./encounter-compose";
import { MyDrafts } from "./my-drafts";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let encounterStatus = "draft";
let storedSections: Record<string, unknown>[] = [];
let storedVersion = 3;

/** A two-section template: one required with a slotted entry, one optional. */
const template = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    {
      sectionId: "assessment",
      heading: "Assessment",
      required: true,
      allowedCategories: ["observation"],
      entries: [
        {
          code: "nv.resp.dyspnea_at_rest",
          label: "Dyspnea at rest",
          category: "observation",
          bodySystem: "respiratory",
          slots: [],
          slotSpecs: {},
          exclusiveGroup: null,
        },
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

/** A test may swap the whole menu (typed slots, exclusive groups); reset in `beforeEach`. */
let templateOverride: Record<string, unknown> | null = null;
/** What the server's selections READ answers as the assembled note (e.g. once vitals are recorded). */
let previewOverride: string | null = null;
/** The scheduled visit this encounter was seeded from (M17), and the purpose that visit reads back with. */
const VISIT = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
let encounterVisitId: string | null = null;
let visitPurpose = "routine_visit";
/** The patient's recorded falls (Quality) and the fall already linked to the stored note. */
const FALL_A = "f1111111-1111-4111-8111-111111111111";
const FALL_B = "f2222222-2222-4222-8222-222222222222";
let fallIncidents: { incidents: unknown[]; unavailable: boolean } = {
  incidents: [],
  unavailable: false,
};
let storedFall: { incidentId: string; occurredOn: string } | null = null;
/** The author's saved edit of the note text, and whether the note moved underneath it. */
let storedEdit: string | null = null;
let storedEditStale = false;

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let headers: Record<string, string>[] = [];
let writeFailure: { status: number; body: unknown } | null = null;
let writeFailurePath: string | null = null;
let writeTransportFailurePath: string | null = null;
let deferredWritePath: string | null = null;
let releaseDeferredWrite: (() => void) | null = null;
let mirrorEncounterIdFromPath = false;
let failedSelectionsEncounterId: string | null = null;
let readTransportFailurePath: string | null = null;
let finalizeCommitsBeforeTransportFailure = false;
let failReloadAfterFinalize = false;
let finalizeSucceeded = false;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path.endsWith("/template")) return templateOverride ?? template;
    if (path.endsWith("/selections"))
      return {
        templateKey: template.templateKey,
        vocabVersion: template.vocabVersion,
        sections: storedSections,
        layer1Preview:
          previewOverride ?? (storedSections.length > 0 ? "Patient reports dyspnea at rest." : ""),
        version: storedVersion,
        fallIncident: storedFall,
        editedNarrative: storedEdit,
        editedNarrativeStale: storedEditStale,
      };
    if (path.endsWith("/fall-incidents")) return fallIncidents;
    if (path === `/api/v1/patients/${PATIENT}`)
      return { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" };
    if (path.endsWith("/vitals")) return { encounterId: ENCOUNTER, vitals: [] };
    if (path.endsWith("/mileage")) return null;
    if (path.endsWith("/my-drafts"))
      return {
        encounters: [
          {
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
            version: storedVersion,
            authoredByUserId: "user-1",
            isF2f: false,
            signedAt: null,
            cosignedAt: null,
            // ADR-0113: a legacy draft (no clock): "Legacy", no deadline, never alerts.
            closure: { clockStartedAt: null, deadlineAt: null, stage: "ok" },
          },
        ],
      };
    if (path === `/api/v1/visits/${VISIT}`) return { id: VISIT, visitPurpose };
    const pathEncounterId = path.match(/^\/api\/v1\/encounters\/([^/]+)$/)?.[1];
    return {
      id: mirrorEncounterIdFromPath && pathEncounterId ? pathEncounterId : ENCOUNTER,
      organizationId: "org-1",
      patientId: PATIENT,
      admissionId: "adm-1",
      visitId: encounterVisitId,
      encounterType: "routine_visit",
      discipline: "rn",
      serviceDate: "2026-08-27",
      status: encounterStatus,
      lateEntryTier: "on_time",
      version: storedVersion,
      authoredByUserId: "user-1",
      isF2f: false,
      signedAt: null,
      cosignedAt: null,
    };
  }
  if (path.endsWith("/selections"))
    return { version: storedVersion + 1, layer1Preview: "Patient reports dyspnea at rest." };
  if (path.endsWith("/vitals")) return { vitalsId: "vitals-1" };
  if (path.endsWith("/finalize")) return { status: "finalized", version: storedVersion + 2 };
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (
    method === "GET" &&
    ((readTransportFailurePath && path.endsWith(readTransportFailurePath)) ||
      (failReloadAfterFinalize && finalizeSucceeded && path === `/api/v1/encounters/${ENCOUNTER}`))
  ) {
    throw new TypeError("connection dropped");
  }
  if (
    method === "GET" &&
    failedSelectionsEncounterId &&
    path === `/api/v1/encounters/${failedSelectionsEncounterId}/selections`
  ) {
    return new Response(
      JSON.stringify({ error: { code: "UNAVAILABLE", message: "unavailable" } }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const collected: Record<string, string> = {};
    if (req) {
      req.headers.forEach((v, k) => {
        collected[k.toLowerCase()] = v;
      });
    } else if (init?.headers)
      for (const [k, v] of Object.entries(init.headers as Record<string, string>))
        collected[k.toLowerCase()] = v;
    headers.push(collected);
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M8 authoring write sends JSON; recording nothing is honest if one ever does not.
      }
    }
    if (writeFailure && (!writeFailurePath || path.endsWith(writeFailurePath))) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (writeTransportFailurePath && path.endsWith(writeTransportFailurePath)) {
      if (path.endsWith("/finalize") && finalizeCommitsBeforeTransportFailure) {
        encounterStatus = "finalized";
      }
      throw new TypeError("connection dropped");
    }
    if (deferredWritePath && path.endsWith(deferredWritePath)) {
      await new Promise<void>((resolve) => {
        releaseDeferredWrite = resolve;
      });
    }
  }
  if (method === "POST" && path.endsWith("/finalize")) {
    encounterStatus = "finalized";
    finalizeSucceeded = true;
  }
  // ADR-0114: the tenant has the visit-note draft switched off, so its read answers 404 and the composer is exactly as before.
  if (method === "GET" && path.endsWith("/draft")) {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
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

function mount(path: string, element: JSX.Element, route: string) {
  const router = createMemoryRouter(
    [
      { path: route, element },
      {
        path: "/patients/:patientId/encounters/:encounterId",
        element: <h1>Encounter destination</h1>,
      },
      { path: "*", element: <h1>Other destination</h1> },
    ],
    { initialEntries: [path] },
  );
  const result = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { ...result, router };
}

const mountCompose = () =>
  mount(
    `/patients/${PATIENT}/encounters/${ENCOUNTER}/compose`,
    <EncounterCompose />,
    "/patients/:patientId/encounters/:encounterId/compose",
  );

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  headers = [];
  writeFailure = null;
  writeFailurePath = null;
  writeTransportFailurePath = null;
  deferredWritePath = null;
  releaseDeferredWrite = null;
  mirrorEncounterIdFromPath = false;
  failedSelectionsEncounterId = null;
  readTransportFailurePath = null;
  finalizeCommitsBeforeTransportFailure = false;
  failReloadAfterFinalize = false;
  finalizeSucceeded = false;
  encounterStatus = "draft";
  storedSections = [];
  storedVersion = 3;
  templateOverride = null;
  previewOverride = null;
  encounterVisitId = null;
  visitPurpose = "routine_visit";
  fallIncidents = { incidents: [], unavailable: false };
  storedFall = null;
  storedEdit = null;
  storedEditStale = false;
});
afterEach(() => {
  writeFailure = null;
  writeFailurePath = null;
  writeTransportFailurePath = null;
  deferredWritePath = null;
  releaseDeferredWrite = null;
  mirrorEncounterIdFromPath = false;
  failedSelectionsEncounterId = null;
  readTransportFailurePath = null;
  finalizeCommitsBeforeTransportFailure = false;
  failReloadAfterFinalize = false;
  finalizeSucceeded = false;
});

describe("Workflow 04 — patient context and recoverable navigation", () => {
  it("keeps patient identity visible and returns to the canonical encounter route", async () => {
    mountCompose();

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("MRN-9")).toBeTruthy();

    // One way back (WP1): the old "Back to encounter" / "Open record" pair, which went to the same place, is one link.
    expect(screen.queryByRole("button", { name: "Open record" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Back to encounter" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("link", { name: "Back to encounter" }));
    expect(await screen.findByRole("heading", { name: "Encounter destination" })).toBeTruthy();
  });

  it("does not show the previous chart while a new encounter route loads", async () => {
    const { router } = mountCompose();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();

    await act(async () => {
      await router.navigate(
        `/patients/${PATIENT}/encounters/cccccccc-3333-4333-8333-cccccccccccc/compose`,
      );
    });

    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("does not expose the previous narrative when the next encounter selections fail", async () => {
    const nextEncounter = "cccccccc-3333-4333-8333-cccccccccccc";
    mirrorEncounterIdFromPath = true;
    storedSections = [
      {
        sectionId: "assessment",
        entries: [{ code: "nv.resp.dyspnea_at_rest" }],
        freeText: "",
      },
    ];
    const { router } = mountCompose();
    expect(await screen.findByText("Patient reports dyspnea at rest.")).toBeTruthy();
    failedSelectionsEncounterId = nextEncounter;

    await act(async () => {
      await router.navigate(`/patients/${PATIENT}/encounters/${nextEncounter}/compose`);
    });

    expect(await screen.findByText("Could not load this encounter.")).toBeTruthy();
    expect(screen.queryByText("Patient reports dyspnea at rest.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("shows a recoverable error when the initial encounter transport rejects", async () => {
    readTransportFailurePath = `/api/v1/encounters/${ENCOUNTER}`;
    mountCompose();

    expect(await screen.findByText(/Could not load this encounter/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("announces unsaved work, guards route and browser exits, and clears the guard after save", async () => {
    const { router } = mountCompose();
    expect(await screen.findByText("All changes saved")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Dyspnea at rest/i));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await act(async () => {
      await router.navigate(`/patients/${PATIENT}/encounters/${ENCOUNTER}`);
    });
    expect(screen.getByRole("alertdialog", { name: "Leave without saving?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("All changes saved")).toBeTruthy();
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("links a server care-plan blocker to the canonical M7 correction route", async () => {
    writeFailurePath = "/finalize";
    writeFailure = {
      status: 422,
      body: {
        error: {
          code: "COMPLIANCE_GATE_FAILED",
          message: "The encounter is not ready to finalize.",
          details: [
            {
              code: "CARE_PLAN_REVIEW_OVERDUE",
              field: "carePlan",
              message: "The patient's care plan is past its review window.",
            },
          ],
        },
      },
    };
    const { router } = mountCompose();

    fireEvent.click(await screen.findByRole("button", { name: "Finalize note" }));
    const link = await screen.findByRole("button", { name: "Open care plan" });
    fireEvent.click(link);

    expect(router.state.location.pathname).toBe(`/patients/${PATIENT}/care-plan`);
  });
});

describe("#91 — the note can be composed", () => {
  it("the menu comes from the SERVER's template route, not from a corpus in the browser", async () => {
    mountCompose();
    // The whole reason authoring was impossible: `sectionId`/`code` are free strings the server
    // rejects if unknown, and nothing put the template or the vocabulary on the wire (F-063).
    await waitFor(() => expect(calls).toContain(`GET /api/v1/encounters/${ENCOUNTER}/template`));
    expect(await screen.findByText("Dyspnea at rest")).toBeTruthy();
    expect(screen.queryByText("nv.resp.dyspnea_at_rest")).toBeNull();
  });

  it("selecting a phrase PATCHes it into its template section with the version as If-Match", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as { sections: { sectionId: string; entries: { code: string }[] }[] };
    expect(sent.sections).toHaveLength(1);
    expect(sent.sections[0]?.sectionId).toBe("assessment");
    expect(sent.sections[0]?.entries[0]?.code).toBe("nv.resp.dyspnea_at_rest");
    // §7.7 — the save is version-conditioned. Sending it unconditioned would silently overwrite a
    // colleague's concurrent save, which on a shared draft is the failure the header exists to stop.
    expect(headers[0]?.["if-match"]).toBe("3");
  });

  it("a slotted phrase sends its ${slot} value as params — the assembly interpolates it verbatim", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Pain score recorded/i)));
    // "Pain Score" (the slot) and "Pain score recorded" (the entry) both match — take the slot input.
    fireEvent.change(await waitFor(() => screen.getByLabelText("Pain Score")), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as {
      sections: { entries: { code: string; params?: Record<string, unknown> }[] }[];
    };
    expect(sent.sections[0]?.entries[0]?.params).toEqual({ pain_score: "4" });
  });

  it("a section with only free text is still sent — verbatim prose is content", async () => {
    mountCompose();
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Additional notes/i)), {
      target: { value: "Family present; no new concerns raised." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as { sections: { sectionId: string; freeText?: string }[] };
    expect(sent.sections[0]?.freeText).toBe("Family present; no new concerns raised.");
  });

  it("an empty section is NOT sent — assembly omits it, so storing it would persist an unrenderable row", async () => {
    mountCompose();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    expect((bodies[0] as { sections: unknown[] }).sections).toEqual([]);
  });

  it("the narrative shown is the SERVER's assembly, never composed in the client", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    // The preview text comes back from the PATCH; nothing here builds a sentence out of the labels.
    expect(await screen.findByText("Patient reports dyspnea at rest.")).toBeTruthy();
  });
});

describe("#91 — finalize is the server's gate, and its refusals are legible", () => {
  it("Finalize SAVES first, so the gate reads the tree the clinician is looking at", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Finalize note" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/encounters/${ENCOUNTER}/finalize`),
    );
    // Order matters: finalizing an unsaved draft would gate on what the server last saw.
    expect(writes()[0]).toBe(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`);
    expect(writes()[1]).toBe(`POST /api/v1/encounters/${ENCOUNTER}/finalize`);
  });

  it("locks authoring controls and prevents discarding while finalization saves the draft", async () => {
    deferredWritePath = "/selections";
    const { router } = mountCompose();
    const choice = (await screen.findByLabelText(/Dyspnea at rest/i)) as HTMLInputElement;
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Finalize note" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );

    expect(choice.disabled).toBe(true);
    expect((screen.getByLabelText(/Additional notes/i) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Vitals" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      await router.navigate("/other");
    });
    expect(screen.getByText(/visit note is being saved/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();

    await act(async () => releaseDeferredWrite?.());
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/encounters/${ENCOUNTER}/finalize`),
    );
  });

  it("Finalize stays ENABLED with a required section empty — the §2.6 gate is the server's", async () => {
    // The prompt names what is missing; it does not pre-empt. The server's checks are more than
    // "required sections are non-empty", so a client that guessed would either block a legal note or
    // promise an illegal one.
    mountCompose();
    const button = await waitFor(() => screen.getByRole("button", { name: "Finalize note" }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(
      await screen.findByText(/Add an entry or finish the details in Assessment/i),
    ).toBeTruthy();
  });

  it("a 409 STALE_VERSION reads as a concurrent save, not as a generic error", async () => {
    writeFailure = { status: 409, body: { error: { code: "STALE_VERSION", message: "stale" } } };
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect((await screen.findByText(/updated after you opened it/i)).textContent).toMatch(
      /Reload the latest version/i,
    );
  });

  it("releases the authoring lock when the save transport rejects", async () => {
    writeTransportFailurePath = "/selections";
    mountCompose();
    const choice = (await screen.findByLabelText(/Dyspnea at rest/i)) as HTMLInputElement;
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByText(/connection was interrupted/i)).toBeTruthy();
    expect(choice.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("releases the authoring lock when the finalize transport rejects", async () => {
    writeTransportFailurePath = "/finalize";
    finalizeCommitsBeforeTransportFailure = true;
    mountCompose();
    const choice = (await screen.findByLabelText(/Dyspnea at rest/i)) as HTMLInputElement;
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Finalize note" }));

    expect(await screen.findByText(/server confirmed finalization/i)).toBeTruthy();
    expect(choice.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Finalize note" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not spin forever when the post-finalize reload transport rejects", async () => {
    failReloadAfterFinalize = true;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/Dyspnea at rest/i));
    fireEvent.click(screen.getByRole("button", { name: "Finalize note" }));

    expect(await screen.findByText(/updated record could not be reloaded/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("a D11 VOCAB_VERSION_MISMATCH says the corpus moved, which is what the clinician must act on", async () => {
    writeFailure = {
      status: 409,
      body: { error: { code: "VOCAB_VERSION_MISMATCH", message: "corpus moved" } },
    };
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/clinical vocabulary was updated/i)).toBeTruthy();
  });

  it("a signed encounter offers no authoring controls at all", async () => {
    encounterStatus = "signed";
    mountCompose();
    const save = await waitFor(() => screen.getByRole("button", { name: "Save draft" }));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Finalize note" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Vitals" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("#91 — vitals capture", () => {
  it("records only the fields actually entered, leaving the rest for the server to treat as absent", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Vitals" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/BP systolic/i)), {
      target: { value: "118" },
    });
    fireEvent.change(screen.getByLabelText(/BP diastolic/i), { target: { value: "72" } });
    fireEvent.click(screen.getByRole("button", { name: "Record vitals" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/encounters/${ENCOUNTER}/vitals`));
    // Not `{bpSystolic: 118, heartRate: NaN, …}` — an empty box means "not taken", and the server's
    // envelope validation would reject a NaN it was never asked to store.
    expect(bodies[0]).toEqual({ bpSystolic: 118, bpDiastolic: 72 });
  });
});

describe("vitals recorded while the note is being signed", () => {
  // A capture racing a sign either lands before the note is sealed or is refused 409 IMMUTABLE_AFTER_SIGN; the server's text is not shown.
  it("say, in the app's words, that the note was signed and nothing was saved, with the next step", async () => {
    writeFailure = {
      status: 409,
      body: {
        error: {
          code: "IMMUTABLE_AFTER_SIGN",
          message: "encounter is 'signed'; edits are only permitted via an addendum",
        },
      },
    };
    writeFailurePath = "/vitals";
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Vitals" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/BP systolic/i)), {
      target: { value: "118" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record vitals" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/signed while you were working/);
    expect(alert.textContent).toMatch(/not saved/);
    expect(alert.textContent).toMatch(/Reload/);
    expect(alert.textContent).not.toMatch(/edits are only permitted/);
  });
});

describe("#91 — My notes (was My Drafts) leads somewhere a draft can be finished", () => {
  it("a draft row opens the COMPOSER, not the read screen", async () => {
    mount("/work/drafts", <MyDrafts />, "/work/drafts");
    // The row holds its own controls, so it is a focusable row, not `role="button"` (a button may not
    // wrap focusable content — see `interactiveRowProps`). Find it by its content instead.
    const row = await waitFor(() => {
      const el = screen.getByText(/Routine Visit/i).closest("tr");
      if (!el) throw new Error("draft row not rendered");
      return el;
    });
    fireEvent.click(row);
    // Until the composer existed, every row in the author's unfinished-work queue led to a read-only
    // view of the thing they came here to write.
    expect(await screen.findByRole("heading", { name: "Other destination" })).toBeTruthy();
  });

  it("names the patient instead of a truncated id", async () => {
    mount("/work/drafts", <MyDrafts />, "/work/drafts");
    expect(await screen.findByText("Lovelace, Ada")).toBeTruthy();
    expect(screen.queryByText(PATIENT.slice(0, 8))).toBeNull();
  });
});

// WF09 step 1 — the composer rendered every slot as a free text box and let contradictory statements sit
// side by side, which is how a note came to read "oxygen at 79 L/min", "requires 14 assistance" and "pain
// well controlled" next to "pain limiting function". The server now refuses those writes; the composer
// renders the same rules so a clinician is stopped before the round trip, not after it.
describe("WF09 step 1 — typed slots and contradictory statements", () => {
  const menuEntry = (code: string, label: string, extra: Record<string, unknown> = {}) => ({
    code,
    label,
    category: "observation",
    bodySystem: null,
    slots: [],
    slotSpecs: {},
    exclusiveGroup: null,
    ...extra,
  });
  const painScore = { kind: "integer", min: 0, max: 10, label: "Pain score (0–10)" };
  const section = (sectionId: string, heading: string, entries: unknown[], required = false) => ({
    sectionId,
    heading,
    required,
    allowedCategories: [],
    entries,
  });
  const medrec = menuEntry("nv.cp.medrec", "Medication reconciliation reviewed");
  const typedTemplate = {
    ...template,
    sections: [
      section(
        "assessment",
        "Assessment",
        [
          menuEntry("nv.resp.unlabored", "Respiratory — unlabored", {
            exclusiveGroup: "respiratory-status",
          }),
          menuEntry("nv.resp.dyspnea", "Respiratory — dyspnea", {
            slots: ["o2_lpm"],
            slotSpecs: {
              o2_lpm: { kind: "number", min: 0.5, max: 6, unit: "L/min", label: "Oxygen flow" },
            },
            exclusiveGroup: "respiratory-status",
          }),
          menuEntry("nv.msk.limited", "Musculoskeletal — limited mobility", {
            slots: ["assist_level"],
            slotSpecs: {
              assist_level: {
                kind: "choice",
                options: ["minimal", "moderate", "maximal", "total"],
                label: "Assistance needed",
              },
            },
          }),
          menuEntry("nv.sym.pain_uncontrolled", "Pain limiting function", {
            slots: ["pain_score"],
            slotSpecs: { pain_score: painScore },
            exclusiveGroup: "pain-status",
          }),
        ],
        true,
      ),
      section("symptom_management", "Symptom Management", [
        menuEntry("nv.sym.pain_controlled", "Pain controlled", {
          slots: ["pain_score"],
          slotSpecs: { pain_score: painScore },
          exclusiveGroup: "pain-status",
        }),
      ]),
      section("interventions", "Interventions", [medrec]),
      section("med_reconciliation", "Medication Reconciliation", [medrec]),
    ],
  };
  // The section list only: the Review panel carries an Edit button per section too.
  const goTo = (heading: RegExp) =>
    fireEvent.click(
      within(screen.getByLabelText("Visit note sections")).getByRole("button", { name: heading }),
    );
  const checkbox = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;

  it("renders a choice slot as a select and sends the chosen option", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/limited mobility/i));
    const select = (await screen.findByLabelText("Assistance needed")) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["minimal", "moderate", "maximal", "total"]));
    expect(options).not.toContain("14");

    fireEvent.change(select, { target: { value: "moderate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as { sections: { entries: { params?: unknown }[] }[] };
    expect(sent.sections[0]?.entries[0]?.params).toEqual({ assist_level: "moderate" });
  });

  it("renders a number slot with its range, so 79 L/min cannot be typed as a valid value", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/dyspnea/i));
    const flow = (await screen.findByLabelText("Oxygen flow")) as HTMLInputElement;
    expect(flow.type).toBe("number");
    expect(flow.min).toBe("0.5");
    expect(flow.max).toBe("6");
    expect(screen.getByText(/0\.5.*6.*L\/min/)).toBeTruthy();
  });

  it("selecting a contradictory statement replaces its sibling", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/dyspnea/i));
    expect(checkbox(/dyspnea/i).checked).toBe(true);

    fireEvent.click(checkbox(/unlabored/i));
    expect(checkbox(/unlabored/i).checked).toBe(true);
    expect(checkbox(/dyspnea/i).checked).toBe(false);
  });

  it("the replacement works across sections, matching the server's whole-note rule", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/Pain limiting function/i));

    goTo(/Symptom Management/);
    fireEvent.click(checkbox(/Pain controlled/i));

    goTo(/^Assessment/);
    expect(checkbox(/Pain limiting function/i).checked).toBe(false);
  });

  it("disables a statement already recorded in another section and says where", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    await screen.findByLabelText(/limited mobility/i);
    goTo(/^Interventions/);
    fireEvent.click(checkbox(/Medication reconciliation reviewed/i));

    goTo(/^Medication Reconciliation/);
    expect(checkbox(/Medication reconciliation reviewed/i).disabled).toBe(true);
    expect(screen.getByText(/Already recorded in Interventions/i)).toBeTruthy();
  });

  it("drops a stored statement the menu no longer offers in its section, and says so", async () => {
    storedSections = [
      { sectionId: "assessment", entries: [{ code: "nv.removed.from.menu" }], freeText: "" },
    ];
    mountCompose();
    expect(await screen.findByText(/no longer offered/i)).toBeTruthy();
    // The removal is a change the author must save, never a silent rewrite of the stored note.
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    expect((bodies[0] as { sections: unknown[] }).sections).toEqual([]);
  });

  it("shows the server's reason when it refuses a value", async () => {
    writeFailurePath = "/selections";
    writeFailure = {
      status: 422,
      body: {
        error: {
          code: "INVALID_SELECTION",
          message: "Oxygen flow must be a number from 0.5 to 6 L/min.",
          details: [
            {
              field: "assessment",
              code: "SLOT_INVALID",
              message: "Oxygen flow must be a number from 0.5 to 6 L/min.",
            },
          ],
        },
      },
    };
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/Dyspnea at rest/i));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByText(/Oxygen flow must be a number from 0\.5 to 6 L\/min\./),
    ).toBeTruthy();
  });

  it("a statement with an empty slot leaves its section 'Needs details', not 'Entered'", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/limited mobility/i));

    expect(screen.getByRole("button", { name: "Assessment: Needs details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Assessment: Entered" })).toBeNull();
    expect(screen.getByText(/0 of 4 sections have an entry/i)).toBeTruthy();
    // The banner names it too, so the author is not told "complete" while finalize would refuse.
    expect(screen.getByText(/Add an entry or finish the details in Assessment/i)).toBeTruthy();

    fireEvent.change(await screen.findByLabelText("Assistance needed"), {
      target: { value: "moderate" },
    });
    expect(screen.getByRole("button", { name: "Assessment: Entered" })).toBeTruthy();
    expect(screen.getByText(/1 of 4 sections have an entry/i)).toBeTruthy();
  });

  it("an optional section with an empty slot is flagged as well, since finalize refuses it too", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    await screen.findByLabelText(/limited mobility/i);
    goTo(/^Symptom Management/);
    fireEvent.click(checkbox(/Pain controlled/i));
    expect(screen.getByRole("button", { name: "Symptom Management: Needs details" })).toBeTruthy();
  });

  it("recording vitals refreshes the note from the server and keeps the author's unsaved edits", async () => {
    templateOverride = typedTemplate;
    mountCompose();
    fireEvent.click(await screen.findByLabelText(/limited mobility/i));
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Vitals" })));
    fireEvent.change(await screen.findByLabelText(/BP systolic/i), { target: { value: "118" } });
    fireEvent.change(screen.getByLabelText(/BP diastolic/i), { target: { value: "72" } });
    previewOverride = "Vital Signs Review\nVital signs: blood pressure 118/72 mmHg.";
    fireEvent.click(screen.getByRole("button", { name: "Record vitals" }));

    expect(await screen.findByText(/Vital signs: blood pressure 118\/72 mmHg\./)).toBeTruthy();
    expect(checkbox(/limited mobility/i).checked).toBe(true);
  });

  it("sends the unit the vitals panel shows, so the note does not state a bare temperature", async () => {
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Vitals" })));
    fireEvent.change(await screen.findByLabelText(/Temperature/i), { target: { value: "97.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Record vitals" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/encounters/${ENCOUNTER}/vitals`));
    expect(bodies[0]).toEqual({ temperature: 97.8, temperatureUnit: "f" });
  });
});

describe("WF09 step 2 — Reason for Visit is a select", () => {
  const reasonEntry = (code: string, label: string) => ({
    code,
    label,
    category: "visit_reason",
    bodySystem: null,
    slots: [],
    slotSpecs: {},
    exclusiveGroup: "visit-reason",
  });
  const reasonTemplate = {
    ...template,
    sections: [
      {
        sectionId: "chief_concern",
        heading: "Reason for Visit",
        required: true,
        allowedCategories: ["visit_reason"],
        entries: [
          reasonEntry("nv.reason.routine", "Routine scheduled visit"),
          reasonEntry("nv.reason.fall_followup", "Follow-up after a fall"),
          reasonEntry("nv.reason.pain", "Pain assessment and management"),
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
  const reasonSelect = async () =>
    (await screen.findByLabelText("Reason for Visit")) as HTMLSelectElement;
  const saved = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    return (bodies[0] as { sections: { entries: { code: string }[] }[] }).sections;
  };

  it("offers the reasons as one select, not a list of checkboxes", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    const select = await reasonSelect();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Select…",
      "Routine scheduled visit",
      "Follow-up after a fall",
      "Pain assessment and management",
    ]);
    expect(select.value).toBe("");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(/^Choose one\./)).toBeTruthy();
  });

  it("records the chosen reason, and choosing another replaces it", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    const select = await reasonSelect();
    fireEvent.change(select, { target: { value: "nv.reason.fall_followup" } });
    expect(select.value).toBe("nv.reason.fall_followup");
    fireEvent.change(select, { target: { value: "nv.reason.pain" } });

    const sections = await saved();
    expect(sections[0]?.entries.map((e) => e.code)).toEqual(["nv.reason.pain"]);
  });

  it("choosing 'Select…' again clears the reason", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    const select = await reasonSelect();
    fireEvent.change(select, { target: { value: "nv.reason.routine" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
    expect(
      screen.getByRole("button", { name: "Reason for Visit: Required, no entry" }),
    ).toBeTruthy();
  });

  it("a chosen reason documents the section, and free text stays available for the detail", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    fireEvent.change(await reasonSelect(), { target: { value: "nv.reason.fall_followup" } });
    expect(screen.getByRole("button", { name: "Reason for Visit: Entered" })).toBeTruthy();
    expect(screen.getByLabelText("Additional notes")).toBeTruthy();
    expect(
      screen.getByText(/Optional\. Enter only information not already represented/),
    ).toBeTruthy();
  });

  it("shows the stored reason as the selected option", async () => {
    templateOverride = reasonTemplate;
    storedSections = [
      { sectionId: "chief_concern", entries: [{ code: "nv.reason.pain" }], freeText: "" },
    ];
    mountCompose();
    expect((await reasonSelect()).value).toBe("nv.reason.pain");
  });
});

describe("WF09 — a scheduled visit suggests its reason", () => {
  const reasonEntry = (code: string, label: string) => ({
    code,
    label,
    category: "visit_reason",
    bodySystem: null,
    slots: [],
    slotSpecs: {},
    exclusiveGroup: "visit-reason",
  });
  const reasonTemplate = {
    ...template,
    sections: [
      {
        sectionId: "chief_concern",
        heading: "Reason for Visit",
        required: true,
        allowedCategories: ["visit_reason"],
        entries: [
          reasonEntry("nv.reason.routine", "Routine scheduled visit"),
          reasonEntry("nv.reason.fall_followup", "Follow-up after a fall"),
        ],
      },
    ],
  };
  const select = async () =>
    (await screen.findByLabelText("Reason for Visit")) as HTMLSelectElement;
  const visitReads = () => calls.filter((c) => c === `GET /api/v1/visits/${VISIT}`);

  it("pre-selects the reason a routine visit implies, as an unsaved choice the clinician confirms", async () => {
    templateOverride = reasonTemplate;
    encounterVisitId = VISIT;
    mountCompose();
    await waitFor(async () => expect((await select()).value).toBe("nv.reason.routine"));
    expect(screen.getByText(/Suggested from the scheduled visit \(Routine Visit\)/)).toBeTruthy();
    // Nothing was written by suggesting: it is the clinician's to keep.
    expect(writes()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    const sent = bodies[0] as { sections: { sectionId: string; entries: { code: string }[] }[] };
    expect(sent.sections.find((s) => s.sectionId === "chief_concern")?.entries).toEqual([
      expect.objectContaining({ code: "nv.reason.routine" }),
    ]);
  });

  it("suggests nothing for a purpose that says what kind of visit it is, not why the clinician is there", async () => {
    templateOverride = reasonTemplate;
    encounterVisitId = VISIT;
    visitPurpose = "prn";
    mountCompose();
    expect((await select()).value).toBe("");
    // Two reads of the visit: the composer's reason lookup and the visit context header's (scheduled window, clinician).
    await waitFor(() => expect(visitReads()).toHaveLength(2));
    expect(screen.queryByText(/Suggested from the scheduled visit/)).toBeNull();
  });

  it("leaves a reason the clinician already saved alone", async () => {
    templateOverride = reasonTemplate;
    encounterVisitId = VISIT;
    storedSections = [
      { sectionId: "chief_concern", entries: [{ code: "nv.reason.fall_followup" }], freeText: "" },
    ];
    mountCompose();
    expect((await select()).value).toBe("nv.reason.fall_followup");
    await waitFor(() => expect(visitReads()).toHaveLength(2));
    expect((await select()).value).toBe("nv.reason.fall_followup");
    expect(screen.queryByText(/Suggested from the scheduled visit/)).toBeNull();
  });

  it("does not look for a visit when the note was started on site", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    expect((await select()).value).toBe("");
    expect(visitReads()).toHaveLength(0);
  });
});

describe("WF09 — linking the recorded fall a follow-up visit follows up", () => {
  const reasonEntry = (code: string, label: string) => ({
    code,
    label,
    category: "visit_reason",
    bodySystem: null,
    slots: [],
    slotSpecs: {},
    exclusiveGroup: "visit-reason",
  });
  const reasonTemplate = {
    ...template,
    sections: [
      {
        sectionId: "chief_concern",
        heading: "Reason for Visit",
        required: true,
        allowedCategories: ["visit_reason"],
        entries: [
          reasonEntry("nv.reason.routine", "Routine scheduled visit"),
          reasonEntry("nv.reason.fall_followup", "Follow-up after a fall"),
        ],
      },
    ],
  };
  const FALLS = {
    incidents: [
      { incidentId: FALL_A, occurredOn: "2026-08-25", severity: "moderate" },
      { incidentId: FALL_B, occurredOn: "2026-08-10", severity: "minor" },
    ],
    unavailable: false,
  };
  const reason = async () =>
    (await screen.findByLabelText("Reason for Visit")) as HTMLSelectElement;
  const which = async () => (await screen.findByLabelText("Which fall?")) as HTMLSelectElement;
  const fallReads = () => calls.filter((c) => c.endsWith("/fall-incidents"));
  const saveBody = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    return bodies[0] as { fallIncidentId?: string | null };
  };

  it("offers the patient's recorded falls under the follow-up reason, and saves the one chosen", async () => {
    templateOverride = reasonTemplate;
    fallIncidents = FALLS;
    mountCompose();
    fireEvent.change(await reason(), { target: { value: "nv.reason.fall_followup" } });

    const picker = await which();
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      "No fall linked",
      "2026-08-25 — Moderate",
      "2026-08-10 — Minor",
    ]);
    fireEvent.change(picker, { target: { value: FALL_A } });

    expect((await saveBody()).fallIncidentId).toBe(FALL_A);
  });

  it("shows nothing about falls, and sends no link, for any other reason", async () => {
    templateOverride = reasonTemplate;
    fallIncidents = FALLS;
    mountCompose();
    fireEvent.change(await reason(), { target: { value: "nv.reason.routine" } });
    expect(screen.queryByLabelText("Which fall?")).toBeNull();
    expect((await saveBody()).fallIncidentId).toBeNull();
    // The recorded falls are not even read for a note that never asks for them.
    expect(fallReads()).toEqual([]);
  });

  it("preselects a fall already linked, and clears it when the author unlinks it", async () => {
    templateOverride = reasonTemplate;
    fallIncidents = FALLS;
    storedFall = { incidentId: FALL_B, occurredOn: "2026-08-10" };
    storedSections = [
      { sectionId: "chief_concern", entries: [{ code: "nv.reason.fall_followup" }], freeText: "" },
    ];
    mountCompose();
    const picker = await which();
    await waitFor(() => expect(picker.value).toBe(FALL_B));

    fireEvent.change(picker, { target: { value: "" } });
    expect((await saveBody()).fallIncidentId).toBeNull();
  });

  it("keeps a fall linked earlier that the list no longer offers, so saving does not drop it", async () => {
    templateOverride = reasonTemplate;
    fallIncidents = { incidents: [], unavailable: false };
    storedFall = { incidentId: FALL_B, occurredOn: "2026-03-01" };
    storedSections = [
      { sectionId: "chief_concern", entries: [{ code: "nv.reason.fall_followup" }], freeText: "" },
    ];
    mountCompose();
    const picker = await which();
    await waitFor(() => expect(picker.value).toBe(FALL_B));
    expect(Array.from(picker.options).map((o) => o.textContent)).toContain(
      "2026-03-01 — linked earlier",
    );
  });

  it("says so when the patient has no recorded fall, and when the register could not be read", async () => {
    templateOverride = reasonTemplate;
    mountCompose();
    fireEvent.change(await reason(), { target: { value: "nv.reason.fall_followup" } });
    expect(await screen.findByText(/No fall is recorded for this patient/)).toBeTruthy();
  });

  it("does not claim there are no falls when the register is unavailable", async () => {
    templateOverride = reasonTemplate;
    fallIncidents = { incidents: [], unavailable: true };
    mountCompose();
    fireEvent.change(await reason(), { target: { value: "nv.reason.fall_followup" } });
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No fall is recorded/)).toBeNull();
    expect((await saveBody()).fallIncidentId).toBeNull();
  });
});

describe("WF09 — editing the note text", () => {
  const GENERATED = "Patient reports dyspnea at rest.";
  const EDITED = "Patient is comfortable and resting; daughter at the bedside.";
  const withSavedNote = () => {
    storedSections = [{ sectionId: "assessment", entries: [{ code: "nv.resp.dyspnea_at_rest" }] }];
  };
  const patchBody = () => bodies[bodies.length - 1] as Record<string, unknown>;
  const box = async () => (await screen.findByLabelText("Note text")) as HTMLTextAreaElement;

  it("offers Edit beside Save & refresh preview, and opens the note text for editing", async () => {
    withSavedNote();
    mountCompose();
    expect(await screen.findByRole("button", { name: "Save & refresh preview" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((await box()).value).toBe(GENERATED);
    expect(screen.getByText("Editing")).toBeTruthy();
    // Nothing is written by opening the editor.
    expect(writes()).toEqual([]);
  });

  it("applies the edit: sends the text, then shows it as the note, marked as edited", async () => {
    withSavedNote();
    mountCompose();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await box(), { target: { value: EDITED } });
    storedEdit = EDITED; // what the server holds once the write lands
    fireEvent.click(screen.getByRole("button", { name: "Apply edit" }));

    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    expect(patchBody().editedNarrative).toBe(EDITED);
    expect(await screen.findByText(EDITED)).toBeTruthy();
    expect(screen.getByText("Edited by you")).toBeTruthy();
    expect(screen.getByText("Your edited text will be signed.")).toBeTruthy();
  });

  it("discards an edit by sending null, and Cancel writes nothing", async () => {
    withSavedNote();
    storedEdit = EDITED;
    mountCompose();
    expect(await screen.findByText(EDITED)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(writes()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(patchBody().editedNarrative).toBeNull();
  });

  it("saves selections that are not yet saved before it opens the note text", async () => {
    mountCompose();
    // Tick a statement so the draft is unsaved.
    fireEvent.click(await screen.findByLabelText(/Dyspnea at rest/));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(writes()).toContain(`PATCH /api/v1/encounters/${ENCOUNTER}/selections`),
    );
    expect(await box()).toBeTruthy();
    // The save carried no edit: it only brought the note up to date.
    expect(patchBody()).not.toHaveProperty("editedNarrative");
  });

  it("holds Save draft, Finalize and the selections while the text is being edited", async () => {
    withSavedNote();
    mountCompose();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await box();
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Finalize note" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText(/Dyspnea at rest/) as HTMLInputElement).disabled).toBe(true);
  });

  it("will not apply empty text", async () => {
    withSavedNote();
    mountCompose();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(await box(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Apply edit" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("warns when the note moved after the edit, and says it cannot be finalized until reviewed", async () => {
    withSavedNote();
    storedEdit = EDITED;
    storedEditStale = true;
    mountCompose();
    expect(await screen.findByText(/The note changed after you edited this text/)).toBeTruthy();
    expect(screen.getByText(/cannot be finalized until you do/)).toBeTruthy();
  });

  it("shows the note as it now reads, not the out-of-date edit, and keeps the old edit to copy from", async () => {
    withSavedNote();
    storedEdit = EDITED;
    storedEditStale = true;
    mountCompose();
    await screen.findByText(/The note changed after you edited this text/);
    // The box carries the current, complete note; the old edit is only inside the collapsed "earlier edit".
    expect(screen.getByText(GENERATED)).toBeTruthy();
    expect(screen.getByText("Edit out of date")).toBeTruthy();
    expect(screen.queryByText("Edited by you")).toBeNull();
    expect(screen.queryByText("Your edited text will be signed.")).toBeNull();
    const earlier = screen.getByText("Your earlier edit").closest("details");
    expect(earlier?.textContent).toContain(EDITED);
  });

  it("starts editing from the current note when the old edit is out of date", async () => {
    withSavedNote();
    storedEdit = EDITED;
    storedEditStale = true;
    mountCompose();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(((await box()) as HTMLTextAreaElement).value).toBe(GENERATED);
  });

  it("offers no edit on a note that is no longer a draft", async () => {
    encounterStatus = "finalized";
    withSavedNote();
    mountCompose();
    await screen.findByText("Note as it reads");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

// Workflow 09, WP1 — the composer's visit context: one patient banner that opens the chart, one way back, the Document / Review /
// Complete strip, and the two anchors Review and Complete move to.
describe("Workflow 09, WP1 — the composer's visit context header", () => {
  const composePath = `/patients/${PATIENT}/encounters/${ENCOUNTER}/compose`;
  const mountComposeAt = (suffix: string) =>
    mount(
      `${composePath}${suffix}`,
      <EncounterCompose />,
      "/patients/:patientId/encounters/:encounterId/compose",
    );
  const origin = (path: string) => `?from=${encodeURIComponent(path)}`;

  it("names the encounter and offers the patient's chart from the banner (T01, T22)", async () => {
    mountCompose();
    const header = await screen.findByRole("region", { name: "Visit context" });
    expect(within(header).getByText("Routine Visit")).toBeTruthy();
    expect(within(header).getByText("Draft")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}`,
    );
  });

  it("has one Back link and no second 'Open record' button (T36)", async () => {
    mountCompose();
    await screen.findByRole("region", { name: "Visit context" });
    expect(screen.getAllByRole("link", { name: /^Back to/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open record" })).toBeNull();
  });

  it("goes back to where the note was opened from, and keeps the record one link away (T36)", async () => {
    mountComposeAt(origin("/me/visits?status=in_visit"));
    const back = await screen.findByRole("link", { name: "Back to My Visits" });
    expect(back.getAttribute("href")).toBe("/me/visits?status=in_visit");
    expect(screen.getByRole("link", { name: "Encounter record" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}/encounters/${ENCOUNTER}${origin("/me/visits?status=in_visit")}`,
    );
  });

  it("ignores a way back that is not one of the app's screens", async () => {
    mountComposeAt(origin("https://evil.example/me/visits"));
    expect(
      (await screen.findByRole("link", { name: "Back to encounter" })).getAttribute("href"),
    ).toBe(`/patients/${PATIENT}/encounters/${ENCOUNTER}`);
    expect(document.querySelector("a[href*='evil']")).toBeNull();
  });

  it("has the anchors the strip and the review panels use", async () => {
    mountCompose();
    await screen.findByRole("region", { name: "Visit context" });
    for (const id of ["visit-document", "visit-review", "visit-complete"]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it("lands on the Review anchor when opened at it (a copied address, a link from another screen)", async () => {
    mountComposeAt("#visit-review");
    await waitFor(() => expect(document.activeElement?.id).toBe("visit-review"));
  });

  it("says finalizing is not signing and links to the record's sign-off, keeping the way back", async () => {
    const { router } = mountComposeAt(origin("/work/drafts"));
    fireEvent.click(await screen.findByRole("button", { name: "Finalize note" }));

    expect(await screen.findByText("Note finalized")).toBeTruthy();
    expect(screen.getByText(/Finalizing is not signing/)).toBeTruthy();
    expect(screen.queryByText("Sign it from the encounter record.")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Go to sign-off" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/patients/${PATIENT}/encounters/${ENCOUNTER}`),
    );
    expect(router.state.location.search).toBe(origin("/work/drafts"));
    expect(router.state.location.hash).toBe("#visit-complete");
  });

  it("has no accessibility violations with the header, the strip and the anchors in place", async () => {
    mountComposeAt(origin("/me/visits"));
    await screen.findByRole("region", { name: "Visit context" });
    const results = await axe.run(document.body, {
      // Page-level landmark rules judge the app shell this harness does not mount, not the screen under test.
      rules: { region: { enabled: false }, "landmark-main-is-top-level": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("offers no sign-off link while the note is still a draft", async () => {
    mountCompose();
    await screen.findByRole("region", { name: "Visit context" });
    expect(screen.queryByRole("button", { name: "Go to sign-off" })).toBeNull();
  });

  it("sends Complete to the record once the note is finalized, because signing is not done in the composer", async () => {
    encounterStatus = "finalized";
    mountComposeAt(origin("/work/drafts"));
    const strip = await screen.findByRole("navigation", { name: "Note workflow" });
    expect(within(strip).getByRole("link", { name: "Complete" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}/encounters/${ENCOUNTER}${origin("/work/drafts")}#visit-complete`,
    );
  });
});
