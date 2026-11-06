import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/16-bereavement — the PRE-DEATH risk assessment draft screen (ADR-0109 D5): the care-team MSW,
// chaplain or bereavement counselor states the eight D17 factors for an admission before the death.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { PredeathAssessment } from "./predeath-assessment";

const ADMISSION_ID = "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809";

const draft = (over: Record<string, unknown> = {}) => ({
  admissionId: ADMISSION_ID,
  exists: true,
  factors: {
    ambivalent_relationship: true,
    sudden_unexpected_death: "unknown",
    prior_unresolved_loss: false,
    preexisting_mental_health: "unknown",
    social_isolation: true,
    financial_strain: "unknown",
    primary_caregiver_role: false,
    active_substance_use: "unknown",
  },
  lastEditedDiscipline: "medical_social_worker",
  lastEditedAt: "2026-10-20T14:00:00.000Z",
  carriedScoreId: null,
  carriedAt: null,
  locked: false,
  version: 3,
  redactedCategories: [],
  ...over,
});

interface Reply {
  get?: { status: number; body: unknown };
  put?: { status: number; body: unknown };
}

function mount(reply: Reply = {}): {
  puts: { path: string; body: unknown; headers: Headers }[];
} {
  const puts: { path: string; body: unknown; headers: Headers }[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), "http://localhost");
    const respond = (r: { status: number; body: unknown }) =>
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    if (method === "PUT") {
      const text = req ? await req.text() : String(init?.body ?? "");
      puts.push({
        path: url.pathname,
        body: text ? JSON.parse(text) : null,
        headers: req?.headers ?? new Headers(init?.headers),
      });
      return respond(reply.put ?? { status: 200, body: draft({ version: 4 }) });
    }
    return respond(reply.get ?? { status: 200, body: draft() });
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1" }}>
        <MemoryRouter initialEntries={[`/bereavement/pre-death/${ADMISSION_ID}`]}>
          <Routes>
            <Route path="/bereavement/pre-death/:admissionId" element={<PredeathAssessment />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { puts };
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("pre-death assessment draft", () => {
  it("shows the eight factors as the recorded draft states them, with who recorded it", async () => {
    mount();
    expect(await screen.findByText("Pre-death risk assessment")).toBeTruthy();
    expect(
      (screen.getByLabelText("Ambivalent relationship with the decedent") as HTMLSelectElement)
        .value,
    ).toBe("true");
    expect((screen.getByLabelText("Prior unresolved loss") as HTMLSelectElement).value).toBe(
      "false",
    );
    expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).value).toBe("unknown");
    expect(screen.getByText(/medical social worker/i)).toBeTruthy();
  });

  it("saves the whole vector with the version read (If-Match) and shows the new version", async () => {
    const { puts } = mount();
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.path).toBe(`/api/v1/bereavement/pre-death-assessments/${ADMISSION_ID}`);
    expect(puts[0]?.headers.get("if-match")).toBe("3");
    expect(puts[0]?.headers.get("idempotency-key")).toBeTruthy();
    expect(puts[0]?.body).toEqual({
      factors: {
        ambivalent_relationship: true,
        sudden_unexpected_death: "unknown",
        prior_unresolved_loss: false,
        preexisting_mental_health: "unknown",
        social_isolation: true,
        financial_strain: true,
        primary_caregiver_role: false,
        active_substance_use: "unknown",
      },
    });
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();
    expect(screen.getByText("Version 4")).toBeTruthy();
  });

  it("a draft that does not exist yet starts all unknown and its first save names version 0", async () => {
    const { puts } = mount({
      get: {
        status: 200,
        body: draft({
          exists: false,
          version: 0,
          lastEditedDiscipline: null,
          lastEditedAt: null,
          factors: {
            ambivalent_relationship: "unknown",
            sudden_unexpected_death: "unknown",
            prior_unresolved_loss: "unknown",
            preexisting_mental_health: "unknown",
            social_isolation: "unknown",
            financial_strain: "unknown",
            primary_caregiver_role: "unknown",
            active_substance_use: "unknown",
          },
        }),
      },
    });
    expect(await screen.findByText(/Nothing has been recorded yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.headers.get("if-match")).toBe("0");
  });

  it("explains the substance-use gate and does not let the factor be set when it is withheld", async () => {
    mount({ get: { status: 200, body: draft({ redactedCategories: ["sud"] }) } });
    const sud = (await screen.findByLabelText("Active substance use")) as HTMLSelectElement;
    expect(sud.disabled).toBe(true);
    expect(sud.value).toBe("unknown");
    expect(screen.getByText(/substance-use disorder content is withheld/i)).toBeTruthy();
  });

  it("a locked draft (a plan exists) is read-only and says why", async () => {
    mount({
      get: {
        status: 200,
        body: draft({ locked: true, carriedScoreId: "bbbbbbbb-0000-4000-8000-000000000001" }),
      },
    });
    expect(
      await screen.findByText(/A bereavement plan already exists for this admission/),
    ).toBeTruthy();
    expect(screen.getByText(/it was carried into the plan's initial risk score/i)).toBeTruthy();
    expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("a 404 is 'not found or not yours', never a leak of who is dying", async () => {
    mount({ get: { status: 404, body: { message: "not found" } } });
    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(screen.queryByLabelText("Financial strain")).toBeNull();
  });

  it("a 409 DRAFT_LOCKED on save is explained", async () => {
    mount({
      put: {
        status: 409,
        body: {
          error: {
            code: "DRAFT_LOCKED",
            message: "a bereavement plan already exists for this admission; the draft is closed",
          },
        },
      },
    });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/a bereavement plan already exists/i)).toBeTruthy();
  });

  it("a stale save (412) tells the clinician to reload", async () => {
    mount({ put: { status: 412, body: { status: 412 } } });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/changed while you were working/i)).toBeTruthy();
  });
});
