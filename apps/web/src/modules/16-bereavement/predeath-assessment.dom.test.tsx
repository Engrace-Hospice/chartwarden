import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/16-bereavement — the PRE-DEATH risk assessment draft screen (ADR-0109 D5): the care-team MSW,
// chaplain or bereavement counselor states the eight D17 factors for an admission before the death.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
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
  /** What a GET answers once a write has been attempted (the server's state after a conflict). */
  getAfterWrite?: { status: number; body: unknown };
  put?: { status: number; body: unknown };
  /** The first write fails like a dropped connection (the fetch rejects); later ones answer normally. */
  putRejectsOnce?: boolean;
}

function mount(reply: Reply = {}): {
  puts: { path: string; body: unknown; headers: Headers }[];
  gets: string[];
} {
  const puts: { path: string; body: unknown; headers: Headers }[] = [];
  const gets: string[] = [];
  let rejected = false;
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
      if (reply.putRejectsOnce && !rejected) {
        rejected = true;
        throw new TypeError("network down");
      }
      return respond(reply.put ?? { status: 200, body: draft({ version: 4 }) });
    }
    gets.push(url.pathname);
    return respond(
      (puts.length > 0 ? reply.getAfterWrite : undefined) ??
        reply.get ?? { status: 200, body: draft() },
    );
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
  return { puts, gets };
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
    expect(await screen.findByText("Draft saved. Version 4 is now the current one.")).toBeTruthy();
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

  it("a 409 DRAFT_LOCKED on save makes the form read-only, says why, and reloads the closed draft", async () => {
    const { gets } = mount({
      put: {
        status: 409,
        body: {
          error: {
            code: "DRAFT_LOCKED",
            message: "a bereavement plan already exists for this admission; the draft is closed",
          },
        },
      },
      getAfterWrite: {
        status: 200,
        body: draft({ locked: true, carriedScoreId: "bbbbbbbb-0000-4000-8000-000000000001" }),
      },
    });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByText(/was opened for this admission while you were editing/),
    ).toBeTruthy();
    expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    await waitFor(() => expect(gets).toHaveLength(2));
  });

  it("a DRAFT_LOCKED save stays read-only even if the reload cannot be read", async () => {
    mount({
      put: { status: 409, body: { error: { code: "DRAFT_LOCKED", message: "closed" } } },
      getAfterWrite: { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } },
    });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/while you were editing/);
    expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("a stale save (412) says the draft changed, and loads the colleague's version", async () => {
    const { gets } = mount({
      put: { status: 412, body: { error: { code: "STALE_VERSION", message: "stale" } } },
      getAfterWrite: {
        status: 200,
        body: draft({ version: 4, factors: { ...draft().factors, financial_strain: false } }),
      },
    });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/changed while you were working/i)).toBeTruthy();
    await waitFor(() => expect(gets).toHaveLength(2));
    await waitFor(() =>
      expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).value).toBe("false"),
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
  });

  it("a lost response is reported, the form stays usable and the retry reuses the Idempotency-Key", async () => {
    const { puts } = mount({ putRejectsOnce: true });
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    fireEvent.click(save);
    expect(await screen.findByText(/connection dropped/i)).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.headers.get("idempotency-key")).toBe(puts[0]?.headers.get("idempotency-key"));
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();
  });

  it("'Draft saved' goes away as soon as a factor is edited again, and the version is stated once", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Financial strain"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();
    expect(screen.getAllByText(/Version 4/)).toHaveLength(2); // "Last edited … Version 4." and the saved line — not a third beside Save
    fireEvent.change(screen.getByLabelText("Financial strain"), { target: { value: "false" } });
    expect(screen.queryByText(/Draft saved/)).toBeNull();
  });

  it("a failed load is 'Unavailable' with Try again (not 'Not found'); a 404 is not retryable", async () => {
    mount({ get: { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "boom" } } } });
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("a 404 offers no retry", async () => {
    mount({ get: { status: 404, body: { message: "not found" } } });
    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("pre-death assessment — another admission's response", () => {
  const OTHER_ADMISSION = "3c4d5e6f-7081-4a2a-93b4-c5d6e7f8091a";

  it("a slow response for the previous admission never replaces the one now on screen", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const req = input instanceof Request ? input : null;
      const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
      const first = path.endsWith(ADMISSION_ID);
      if (first) await firstHeld;
      const body = first
        ? draft({ factors: { ...draft().factors, financial_strain: true } })
        : draft({
            admissionId: OTHER_ADMISSION,
            factors: { ...draft().factors, financial_strain: false },
          });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    render(
      <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
        <SessionProvider session={{ userId: "u-1", organizationId: "org-1" }}>
          <MemoryRouter initialEntries={[`/bereavement/pre-death/${ADMISSION_ID}`]}>
            <Link to={`/bereavement/pre-death/${OTHER_ADMISSION}`}>other admission</Link>
            <Routes>
              <Route path="/bereavement/pre-death/:admissionId" element={<PredeathAssessment />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "other admission" }));
    const strain = (await screen.findByLabelText("Financial strain")) as HTMLSelectElement;
    expect(strain.value).toBe("false");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((screen.getByLabelText("Financial strain") as HTMLSelectElement).value).toBe("false");
  });
});
