// @vitest-environment jsdom
// ADR-0113 in the shell: the closure-status poll (authors only, silent on failure), the banner states it feeds, and the watcher's
// reaction to a 403 NOTE_CLOSURE_REQUIRED observed through the real API client (move to My notes off a refused screen, stay on an
// allowed one, never route the gate's 503 to /maintenance).
import { type ApiClient, ApiClientProvider, createApiClient, useApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app";
import {
  getGlobalResponseSignal,
  handleObservedResponse,
  setGlobalResponseSignal,
} from "./global-response-signal";
import {
  NOTE_CLOSURE_BLOCKED_POLL_INTERVAL_MS,
  NOTE_CLOSURE_MIN_REFRESH_GAP_MS,
  NOTE_CLOSURE_POLL_INTERVAL_MS,
  NoteClosureProvider,
  type NoteClosureStatus,
  useNoteClosure,
} from "./note-closure";
import { NoteClosureBanner } from "./note-closure-banner";
import { createScreenRegistry } from "./screen-registry";
import { type Session, SessionProvider } from "./session";
import { systemScreens } from "./system-pages";

const OLDEST = "e0000000-0000-4000-8000-000000000001";
const PATIENT = "11111111-1111-4111-8111-111111111111";

const author: Session = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Test User",
  organizationName: "Test Organization",
  roles: ["rn"],
  isAdmin: false,
  permissions: ["encounter.author"],
};

const status = (over: Partial<NoteClosureStatus> = {}): NoteClosureStatus => ({
  mode: "warn",
  thresholdHours: 24,
  verdict: "clear",
  stage: "ok",
  encounterId: null,
  patientId: null,
  encounterStatus: null,
  deadlineAt: null,
  hoursOverdue: 0,
  overdueCount: 0,
  overrideExpiresAt: null,
  ...over,
});
const BLOCKED = status({
  mode: "block",
  verdict: "blocked",
  stage: "overdue",
  encounterId: OLDEST,
  patientId: PATIENT,
  encounterStatus: "draft",
  deadlineAt: "2026-11-17T06:00:00.000Z",
  hoursOverdue: 6,
  overdueCount: 2,
});

type Call = { path: string; headers?: Record<string, string> };

const ENCOUNTER_READ = "/api/v1/encounters/{encounterId}";

/** A stand-in client: `closure-status` answers from `answers` (the last repeats); every other path answers an empty inbox. */
function mockClient(answers: (NoteClosureStatus | "fail")[]) {
  const calls: Call[] = [];
  let closureReads = 0;
  const GET = vi.fn(async (path: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ path, headers: init?.headers });
    if (path === "/api/v1/encounters/closure-status") {
      const answer = answers[Math.min(closureReads, answers.length - 1)];
      closureReads += 1;
      if (answer === "fail") throw new TypeError("Failed to fetch");
      return { data: answer, error: undefined, response: new Response() };
    }
    return { data: { alerts: [] }, error: undefined, response: new Response() };
  });
  const client = { GET, POST: vi.fn() } as unknown as ApiClient;
  const closureCalls = (): Call[] =>
    calls.filter((c) => c.path === "/api/v1/encounters/closure-status");
  const encounterReads = (): Call[] => calls.filter((c) => c.path === ENCOUNTER_READ);
  return { client, closureCalls, encounterReads };
}

function mountBanner(client: ApiClient, session: Session = author) {
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider session={session}>
        <MemoryRouter>
          <NoteClosureProvider>
            <NoteClosureBanner />
          </NoteClosureProvider>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const statusRegion = (): HTMLElement => screen.getAllByRole("status")[0] as HTMLElement;

beforeEach(() => setGlobalResponseSignal(null));
afterEach(() => {
  setGlobalResponseSignal(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("closure banner states", () => {
  it("renders nothing for mode off and for an ok stage", async () => {
    const { client, closureCalls } = mockClient([
      status({ mode: "off", stage: "overdue", verdict: "warn" }),
    ]);
    mountBanner(client);
    await waitFor(() => expect(closureCalls()).toHaveLength(1));
    // Let the answer render before asserting an absence, or a banner shown for `off` could still be on its way.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
    expect(statusRegion().textContent).toBe("");
  });

  it("at risk: a polite info notice that never mentions limits", async () => {
    const { client } = mockClient([
      status({ stage: "at_risk", encounterId: OLDEST, deadlineAt: "2026-11-17T18:00:00.000Z" }),
    ]);
    mountBanner(client);
    expect(await within(statusRegion()).findByText(/A visit note is due soon/)).toBeTruthy();
    expect(statusRegion().textContent).not.toMatch(/limit|block|refus/i);
    expect(
      within(statusRegion()).getByRole("link", { name: "Open My notes" }).getAttribute("href"),
    ).toBe("/work/drafts");
  });

  it("overdue in warn mode: a warning that does not claim access is limited", async () => {
    const { client } = mockClient([
      status({ stage: "overdue", verdict: "warn", overdueCount: 2, encounterId: OLDEST }),
    ]);
    mountBanner(client);
    expect(await within(statusRegion()).findByText(/2 visit notes are overdue/)).toBeTruthy();
    expect(statusRegion().textContent).not.toMatch(/limit|block|refus|access/i);
  });

  it("blocked: the assertive region says access is limited, links to the oldest note and points to a supervisor", async () => {
    const { client } = mockClient([BLOCKED]);
    mountBanner(client);
    const alert = await screen.findByRole("alert");
    expect(await within(alert).findByText(/your access is limited/i)).toBeTruthy();
    expect(alert.textContent).toMatch(/ask a supervisor for a temporary override/i);
    const link = within(alert).getByRole("link", { name: "Open the oldest note" });
    expect(link.getAttribute("href")).toBe(`/patients/${PATIENT}/encounters/${OLDEST}/compose`);
  });

  it("blocked: a finalized oldest note links to the read screen where it is signed, not the read-only composer", async () => {
    const { client } = mockClient([{ ...BLOCKED, encounterStatus: "finalized" }]);
    mountBanner(client);
    const link = within(await screen.findByRole("alert")).getByRole("link", {
      name: "Open the oldest note",
    });
    expect(link.getAttribute("href")).toBe(`/patients/${PATIENT}/encounters/${OLDEST}`);
  });

  it("blocked with no note named: the link goes to My notes", async () => {
    const { client } = mockClient([
      { ...BLOCKED, encounterId: null, patientId: null, encounterStatus: null },
    ]);
    mountBanner(client);
    const link = within(await screen.findByRole("alert")).getByRole("link", {
      name: "Open the oldest note",
    });
    expect(link.getAttribute("href")).toBe("/work/drafts");
  });

  it("blocked: never reads the encounter itself (a read-audited GET would log a view nobody made)", async () => {
    const { client, closureCalls, encounterReads } = mockClient([BLOCKED]);
    mountBanner(client);
    await screen.findByRole("alert");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(closureCalls()).toHaveLength(1);
    expect(encounterReads()).toHaveLength(0);
  });

  it("an active override shows its expiry", async () => {
    const { client } = mockClient([
      status({
        mode: "block",
        verdict: "warn",
        stage: "overdue",
        overdueCount: 1,
        encounterId: OLDEST,
        overrideExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ]);
    mountBanner(client);
    expect(await within(statusRegion()).findByText(/temporarily lifted/i)).toBeTruthy();
    expect(statusRegion().textContent).toMatch(/Until /);
  });
});

describe("closure status polling", () => {
  it("asks nothing for a session without encounter.author", async () => {
    const { client, closureCalls } = mockClient([BLOCKED]);
    mountBanner(client, { ...author, permissions: ["encounter.read"] });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(closureCalls()).toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("asks nothing while the organization is still onboarding", async () => {
    const { client, closureCalls } = mockClient([BLOCKED]);
    mountBanner(client, { ...author, organizationStage: "onboarding" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(closureCalls()).toHaveLength(0);
  });

  it("a failed refresh is silent: the last answer stays and no error appears", async () => {
    const { client, closureCalls } = mockClient([
      status({ stage: "overdue", verdict: "warn", overdueCount: 1 }),
      "fail",
    ]);
    mountBanner(client);
    expect(await within(statusRegion()).findByText(/A visit note is overdue/)).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(2));

    expect(within(statusRegion()).getByText(/A visit note is overdue/)).toBeTruthy();
    expect(screen.queryByText(/could not|failed|error/i)).toBeNull();
  });

  it("polls in the background, faster while blocked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { client, closureCalls } = mockClient([
      status({ stage: "overdue", verdict: "warn", overdueCount: 1 }),
      BLOCKED,
    ]);
    mountBanner(client);
    await waitFor(() => expect(closureCalls()).toHaveLength(1));
    expect(closureCalls()[0]?.headers).toBeUndefined(); // the first read is a normal request

    await act(async () => {
      vi.advanceTimersByTime(NOTE_CLOSURE_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(2));
    expect(closureCalls()[1]?.headers).toEqual({ "x-chartwarden-background": "1" }); // maintenance polling must not extend an idle session
    await screen.findByRole("alert"); // now blocked: the status poll quickens

    await act(async () => {
      vi.advanceTimersByTime(NOTE_CLOSURE_BLOCKED_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(3));
  });

  it("a gate refusal refreshes the status at once, but only once per refresh gap", async () => {
    const { client, closureCalls } = mockClient([status(), BLOCKED]);
    mountBanner(client);
    await waitFor(() => expect(closureCalls()).toHaveLength(1));

    // Inside the gap (the first read just ran): a refusal must not trigger another read, or a refused status read would loop.
    act(() => {
      setGlobalResponseSignal({ kind: "note-closure-required" });
    });
    expect(closureCalls()).toHaveLength(1);

    const later = Date.now() + NOTE_CLOSURE_MIN_REFRESH_GAP_MS + 1_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    act(() => {
      setGlobalResponseSignal({ kind: "note-closure-required" });
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(2));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

// GAP-002: ONE rule (shell/use-refresh-cues.ts) says what counts as the person's activity. A read the PERSON causes (opening the app,
// pressing refresh) is an ordinary request; a read a CUE causes (the poll, returning to the tab, a gate refusal that is often the answer
// to a wallboard's own background poll) carries the background marker, or it would count as activity and the 15-minute idle logoff would
// never fire. My notes and the overdue board follow the same rule.
describe("which closure-status reads count as user activity", () => {
  const BACKGROUND = { "x-chartwarden-background": "1" };
  const afterTheGap = (): number => Date.now() + NOTE_CLOSURE_MIN_REFRESH_GAP_MS + 1_000;

  function RefreshButton(): JSX.Element {
    const { refresh } = useNoteClosure();
    return (
      <button type="button" onClick={refresh}>
        Refresh status
      </button>
    );
  }

  function mountWithRefresh(client: ApiClient) {
    return render(
      <ApiClientProvider client={client}>
        <SessionProvider session={author}>
          <MemoryRouter>
            <NoteClosureProvider>
              <RefreshButton />
            </NoteClosureProvider>
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
  }

  it("marks every cue's read as background (the poll, a gate refusal, a return to the tab); only mount and refresh() are the person's", async () => {
    const { client, closureCalls } = mockClient([status()]);
    mountWithRefresh(client);
    await waitFor(() => expect(closureCalls()).toHaveLength(1));
    expect(closureCalls()[0]?.headers).toBeUndefined(); // mount: the person opened the app

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(afterTheGap());
    act(() => {
      setGlobalResponseSignal({ kind: "note-closure-required" });
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(2));
    expect(closureCalls()[1]?.headers).toEqual(BACKGROUND); // a refusal is not the person asking

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(3));
    expect(closureCalls()[2]?.headers).toEqual(BACKGROUND); // returning to the tab is a cue, not a request the person made

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(closureCalls()).toHaveLength(4));
    expect(closureCalls()[3]?.headers).toBeUndefined(); // the person asked for a refresh
  });

  it("does not read on a gate refusal while the tab is hidden, and reads again once it is visible", async () => {
    const { client, closureCalls } = mockClient([status()]);
    mountWithRefresh(client);
    await waitFor(() => expect(closureCalls()).toHaveLength(1));

    vi.spyOn(Date, "now").mockReturnValue(afterTheGap());
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      setGlobalResponseSignal({ kind: "note-closure-required" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(closureCalls()).toHaveLength(1);

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(closureCalls()).toHaveLength(2));
    expect(closureCalls()[1]?.headers).toEqual(BACKGROUND);
  });
});

// ── the watcher, through the real client and the whole shell ─────────────────────────────────────────────────────────────────
const SETTLE = { timeout: 5000 };

function Probe({ label, call }: { label: string; call: string }): JSX.Element {
  const client = useApiClient();
  useEffect(() => {
    void client.GET(call as never, {} as never);
  }, [client, call]);
  return <h1>{label}</h1>;
}

const probeScreens = {
  moduleId: 8,
  slug: "closure-probes",
  screens: [
    {
      id: "probe.scheduling",
      path: "/scheduling/visits/v-1",
      title: "Visit",
      screen: () => <Probe label="Visit screen" call="/api/v1/scheduling/visits" />,
    },
    {
      id: "probe.compose",
      path: "/patients/:patientId/encounters/:encounterId/compose",
      title: "Compose",
      screen: () => <Probe label="Compose screen" call="/api/v1/scheduling/visits" />,
    },
    {
      id: "probe.my-drafts",
      path: "/work/drafts",
      title: "My Notes",
      screen: () => <Probe label="My notes screen" call="/api/v1/scheduling/visits" />,
    },
  ],
};

function mountShell(at: string, refusal: { status: number; code: string }) {
  const json = (status: number, body: unknown, url: string): Response => {
    const res = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(res, "url", { value: url }); // a constructed Response has none; the shell decides by path
    return res;
  };
  const fetchStub = async (request: Request): Promise<Response> => {
    const url = request.url;
    if (url.includes("/closure-status")) return json(200, BLOCKED, url);
    if (url.includes("/scheduling/")) {
      return json(
        refusal.status,
        {
          error: {
            code: refusal.code,
            message: "x",
            details: [
              { field: "encounterId", code: "OLDEST_OPEN_NOTE", message: OLDEST },
              { field: "overdueCount", code: "OVERDUE_COUNT", message: "2" },
            ],
          },
        },
        url,
      );
    }
    return json(200, { alerts: [] }, url);
  };
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(probeScreens);
  window.history.pushState({}, "", at);
  render(
    <AppShell
      registry={registry}
      client={createApiClient({
        baseUrl: "http://localhost",
        fetch: fetchStub,
        onResponseStatus: handleObservedResponse,
      })}
      session={author}
    />,
  );
}

describe("the shell's reaction to a 403 NOTE_CLOSURE_REQUIRED", () => {
  it("moves a clinician off a screen the gate refuses to My notes and shows the blocking banner", async () => {
    mountShell("/scheduling/visits/v-1", { status: 403, code: "NOTE_CLOSURE_REQUIRED" });
    await waitFor(() => expect(window.location.pathname).toBe("/work/drafts"), SETTLE);
    expect(await screen.findByRole("heading", { name: "My notes screen" }, SETTLE)).toBeTruthy();
    expect(
      await within(await screen.findByRole("alert", {}, SETTLE)).findByText(
        /your access is limited/i,
      ),
    ).toBeTruthy();
    // My notes is allowed: its own refused call does not move it again and the signal is consumed.
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull(), SETTLE);
    expect(window.location.pathname).toBe("/work/drafts");
  });

  it("never navigates away from an allowed screen (it would lose the form), but still shows the banner", async () => {
    const compose = `/patients/${PATIENT}/encounters/${OLDEST}/compose`;
    mountShell(compose, { status: 403, code: "NOTE_CLOSURE_REQUIRED" });
    expect(await screen.findByRole("heading", { name: "Compose screen" }, SETTLE)).toBeTruthy();
    expect(
      await within(await screen.findByRole("alert", {}, SETTLE)).findByText(
        /your access is limited/i,
      ),
    ).toBeTruthy();
    await waitFor(() => expect(getGlobalResponseSignal()).toBeNull(), SETTLE);
    expect(window.location.pathname).toBe(compose);
  });

  it("does not route the gate's 503 NOTE_CLOSURE_UNAVAILABLE to /maintenance", async () => {
    mountShell("/scheduling/visits/v-1", { status: 503, code: "NOTE_CLOSURE_UNAVAILABLE" });
    expect(await screen.findByRole("heading", { name: "Visit screen" }, SETTLE)).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(window.location.pathname).toBe("/scheduling/visits/v-1");
    expect(getGlobalResponseSignal()).toBeNull();
  });
});
