// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { HopeDashboard } from "../hope-dashboard";
import { IqiesSubmissionPanel } from "../iqies-submission-panel";
import { SubmissionDetail } from "../submission-detail";
import { SubmissionWorklist } from "../submission-worklist";

// Group g1: the submission screens. A refusal that says why is shown with its reason, a write that landed is never reported as
// "could not refresh" alone, the keyboard keeps its place, and a read nobody answers ends in a state that can be retried.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SUB = "33333333-cccc-4ccc-8ccc-333333333333";
const MANAGE = ["hope.submission.manage"];
const DETAIL = {
  id: SUB,
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status: "packaged",
  packageFilename: "p.zip",
  itemCount: 0,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
  acceptedAt: null,
  items: [],
  findings: [],
};
const CANCELLED_MESSAGE =
  "This package was cancelled, so it cannot be downloaded or marked uploaded.";
const cancelledEnvelope = {
  error: { code: "M10_SUBMISSION_CANCELLED", message: CANCELLED_MESSAGE },
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = (): Promise<Response> => new Promise<Response>(() => undefined);
const session = (permissions: string[]) => ({
  userId: "u",
  organizationId: "o",
  membershipId: "m",
  roles: ["compliance_officer"],
  permissions,
  isAdmin: false,
});

/**
 * Runs `action` (the click or mount that starts the request) with fake timers on, and lets REQUEST_TIMEOUT_MS pass, so a
 * request nobody answers is aborted; the request's own timer must be created under the fake clock, hence `action` here.
 */
async function afterTimeout(action: () => void = () => undefined): Promise<void> {
  vi.useFakeTimers();
  try {
    action();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    });
  } finally {
    vi.useRealTimers();
  }
}

type Handler = (method: string, path: string) => Response | Promise<Response> | undefined;
let calls: string[] = [];
let handler: Handler = () => undefined;
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  return (await handler(method, path)) ?? json(404, { message: `unstubbed ${method} ${path}` });
}
beforeEach(() => {
  calls = [];
  handler = () => undefined;
});
const client = () => createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });

function mountDetail() {
  return render(
    <ApiClientProvider client={client()}>
      <SessionProvider session={session(MANAGE)}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/hope/submissions/${SUB}`]}>
            <Routes>
              <Route path="/hope/submissions/:id" element={<SubmissionDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const detailReads = () => calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length;
const MARK = `POST /api/v1/hope/submissions/${SUB}/mark-uploaded`;

/** The detail page for a packaged batch; `mark` answers the mark-uploaded write, `reread` the reads after the first. */
function detailRoutes(opts: {
  mark?: () => Response | Promise<Response>;
  reread?: () => Response | Promise<Response>;
}): void {
  let reads = 0;
  handler = (method, path) => {
    if (`${method} ${path}` === MARK) return opts.mark?.() ?? json(200, DETAIL);
    if (path === `/api/v1/hope/submissions/${SUB}`)
      return reads++ === 0 || !opts.reread ? json(200, DETAIL) : opts.reread();
    return undefined;
  };
}
async function confirmMarkUploaded(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Mark uploaded" }));
  fireEvent.click(button("Confirm: mark uploaded to CMS"));
}

describe("submission detail: a package refused after this page loaded", () => {
  it("shows the server's reason for a refused download, and re-reads the page", async () => {
    detailRoutes({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, cancelledEnvelope)),
    );
    mountDetail();
    await screen.findByRole("button", { name: "Download ZIP" });
    fireEvent.click(button("Download ZIP"));
    expect((await screen.findByRole("alert")).textContent).toBe(CANCELLED_MESSAGE);
    // The page was out of date (it still offered a dead package): it is re-read.
    await waitFor(() => expect(detailReads()).toBe(2));
    expect(button("Download ZIP").disabled).toBe(false);
  });

  // The download advances a packaged batch to exported (which is what lets Record CMS result appear) before the package is sent, so a
  // download that failed on the way back, or never got an answer, may have changed the batch: the page is re-read, quietly (the
  // plain message stays). A refusal that was answered applied nothing.
  it.each([
    ["a gateway fault with no body", async () => new Response(null, { status: 502 })],
    ["a request that is rejected", async () => Promise.reject(new TypeError("offline"))],
  ])(
    "keeps the plain message and re-reads the page for a download that failed with %s",
    async (_name, answer) => {
      detailRoutes({});
      vi.stubGlobal("fetch", vi.fn(answer));
      mountDetail();
      await screen.findByRole("button", { name: "Download ZIP" });
      fireEvent.click(button("Download ZIP"));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not download the package.",
      );
      await waitFor(() => expect(detailReads()).toBe(2));
      expect(button("Download ZIP").disabled).toBe(false);
    },
  );

  it("keeps the plain message, and does not re-read, for a download refused with no reason", async () => {
    detailRoutes({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    mountDetail();
    await screen.findByRole("button", { name: "Download ZIP" });
    fireEvent.click(button("Download ZIP"));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not download the package.");
    expect(button("Download ZIP").disabled).toBe(false);
    expect(detailReads()).toBe(1);
  });

  it("shows the server's reason for a refused mark-uploaded, and re-reads the page", async () => {
    detailRoutes({ mark: () => json(409, cancelledEnvelope) });
    mountDetail();
    await confirmMarkUploaded();
    expect((await screen.findByRole("alert")).textContent).toBe(CANCELLED_MESSAGE);
    await waitFor(() => expect(detailReads()).toBe(2));
  });
});

describe("submission detail: mark uploaded", () => {
  it("says the package WAS marked uploaded when only the re-read afterwards fails", async () => {
    detailRoutes({ reread: () => new Response(null, { status: 502 }) });
    mountDetail();
    await confirmMarkUploaded();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The package was marked uploaded");
    expect(alert.textContent).not.toContain("could not be marked");
  });

  it("says it too when the re-read is never answered", async () => {
    detailRoutes({ reread: never });
    mountDetail();
    await screen.findByRole("button", { name: "Mark uploaded" });
    await afterTimeout(() => {
      fireEvent.click(button("Mark uploaded"));
      fireEvent.click(button("Confirm: mark uploaded to CMS"));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The package was marked uploaded",
    );
  });

  it("moves focus to the refusal after a failed write, so the keyboard user keeps their place", async () => {
    detailRoutes({
      mark: () => json(422, { error: { code: "VALIDATION_FAILED", message: "No." } }),
    });
    mountDetail();
    await confirmMarkUploaded();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("returns focus to Mark uploaded when the write ended without an error", async () => {
    // The page still reads as packaged afterwards (a replayed answer), so the button is still there.
    detailRoutes({});
    mountDetail();
    await confirmMarkUploaded();
    await waitFor(() => expect(button("Mark uploaded").disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(button("Mark uploaded")));
  });
});

describe("submissions worklist: reads that never end", () => {
  function mountWorklist(permissions: string[]) {
    return render(
      <ApiClientProvider client={client()}>
        <SessionProvider session={session(permissions)}>
          <ToastProvider>
            <MemoryRouter initialEntries={["/hope/submissions"]}>
              <Routes>
                <Route path="/hope/submissions" element={<SubmissionWorklist />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
  }
  const entities = { items: [{ id: "pe-1", legalName: "Acme Hospice", ccn: "12345" }] };
  const generate = () =>
    screen.getByRole("button", { name: "Generate iQIES package" }) as HTMLButtonElement;

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline"))],
    ["a non-OK reply with no body", () => new Response(null, { status: 502 })],
  ])(
    "says why Generate is disabled, with Retry that heals it, after %s on provider entities",
    async (_name, answer) => {
      let attempts = 0;
      handler = (_method, path) => {
        if (path === "/api/v1/hope/submissions") return json(200, { submissions: [] });
        if (path === "/api/v1/provider-entities")
          return attempts++ === 0 ? answer() : json(200, entities);
        return undefined;
      };
      mountWorklist(MANAGE);
      expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain(
        "Could not load provider entities",
      );
      expect(generate().disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(generate().disabled).toBe(false));
      expect(screen.queryByText(/Could not load provider entities/)).toBeNull();
    },
  );

  it("says it when the provider entities read is never answered", async () => {
    handler = (_method, path) => {
      if (path === "/api/v1/hope/submissions") return json(200, { submissions: [] });
      if (path === "/api/v1/provider-entities") return never();
      return undefined;
    };
    await afterTimeout(() => mountWorklist(MANAGE));
    expect(await screen.findByText(/Could not load provider entities/)).toBeTruthy();
  });

  it("ends in the retryable failed state when the submissions read is never answered", async () => {
    handler = (_method, path) => (path === "/api/v1/hope/submissions" ? never() : undefined);
    await afterTimeout(() => mountWorklist([]));
    expect(await screen.findByText(/HOPE submissions could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("HOPE schedules dashboard: a read that never ends", () => {
  it("ends in the retryable failed state", async () => {
    handler = (_method, path) => (path === "/api/v1/hope/schedules" ? never() : undefined);
    await afterTimeout(() =>
      render(
        <ApiClientProvider client={client()}>
          <SessionProvider session={session([])}>
            <ToastProvider>
              <MemoryRouter>
                <HopeDashboard />
              </MemoryRouter>
            </ToastProvider>
          </SessionProvider>
        </ApiClientProvider>,
      ),
    );
    expect(await screen.findByText(/HOPE schedules could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("iQIES submission panel: the lookup is bounded and judged by its reply", () => {
  const panel = (GET: ReturnType<typeof vi.fn>) =>
    render(
      <MemoryRouter>
        <ApiClientProvider client={{ GET } as unknown as ApiClient}>
          <IqiesSubmissionPanel assessmentId="a-1" />
        </ApiClientProvider>
      </MemoryRouter>,
    );

  it("aborts a lookup nobody answers, and shows nothing for it", async () => {
    const GET = vi.fn((_path: string, init: { signal: AbortSignal }) => {
      void init;
      return new Promise(() => undefined);
    });
    await afterTimeout(() => panel(GET));
    expect(GET).toHaveBeenCalledTimes(1);
    const signal = (GET.mock.calls[0] as unknown as [string, { signal: AbortSignal }])[1].signal;
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("group", { name: "iQIES submission" })).toBeNull();
  });

  it("does not read an empty non-OK reply as 'Not yet packaged'", async () => {
    const GET = vi.fn(async () => ({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 502 }),
    }));
    panel(GET);
    await waitFor(() => expect(GET).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText("Not yet packaged")).toBeNull();
  });

  it("shows the batch when the lookup answers", async () => {
    const GET = vi.fn(async () => ({
      data: { submissions: [{ submissionId: "s-1", status: "packaged" }] },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    panel(GET);
    expect(await screen.findByText("View batch")).toBeTruthy();
  });
});
