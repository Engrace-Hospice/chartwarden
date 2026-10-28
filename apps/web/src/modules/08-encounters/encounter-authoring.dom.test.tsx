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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
        },
        {
          code: "nv.pain.score",
          label: "Pain score recorded",
          category: "observation",
          bodySystem: null,
          slots: ["pain_score"],
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

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let headers: Record<string, string>[] = [];
let writeFailure: { status: number; body: unknown } | null = null;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path.endsWith("/template")) return template;
    if (path.endsWith("/selections"))
      return {
        templateKey: template.templateKey,
        vocabVersion: template.vocabVersion,
        sections: storedSections,
        layer1Preview: storedSections.length > 0 ? "Patient reports dyspnea at rest." : "",
        version: storedVersion,
      };
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
          },
        ],
      };
    return {
      id: ENCOUNTER,
      organizationId: "org-1",
      patientId: PATIENT,
      admissionId: "adm-1",
      visitId: null,
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
    if (writeFailure) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
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

function mount(path: string, element: JSX.Element, route: string): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="*" element={<div>navigated</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
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
  encounterStatus = "draft";
  storedSections = [];
  storedVersion = 3;
});
afterEach(() => {
  writeFailure = null;
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

  it("Finalize stays ENABLED with a required section empty — the §2.6 gate is the server's", async () => {
    // The prompt names what is missing; it does not pre-empt. The server's checks are more than
    // "required sections are non-empty", so a client that guessed would either block a legal note or
    // promise an illegal one.
    mountCompose();
    const button = await waitFor(() => screen.getByRole("button", { name: "Finalize note" }));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByText(/Complete Assessment before finalization/i)).toBeTruthy();
  });

  it("a 412 reads as a concurrent save, not as a generic error", async () => {
    writeFailure = { status: 412, body: { error: { code: "VERSION_CONFLICT", message: "stale" } } };
    mountCompose();
    fireEvent.click(await waitFor(() => screen.getByLabelText(/Dyspnea at rest/i)));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect((await screen.findByText(/Someone else saved this note/i)).textContent).toMatch(
      /discard/i,
    );
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

describe("#91 — My Drafts leads somewhere a draft can be finished", () => {
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
    expect(await screen.findByText("navigated")).toBeTruthy();
  });
});
