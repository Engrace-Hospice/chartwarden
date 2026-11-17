// apps/web/src/modules/10-hope — the submission detail's requests end: a request nobody answers or a rejected one frees the
// page's actions and says "could not confirm" where the write may have landed, and a failed load offers Try again.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { REQUEST_TIMEOUT_MS } from "./hope-api";
import { SubmissionDetail } from "./submission-detail";

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

type Answer = "ok" | "stall" | "reject" | "empty502";
/** What the next request to each route does; every route answers normally unless a test says otherwise. */
let readAnswers: Answer[] = [];
let markUploadedAnswer: Answer = "ok";
let calls: string[] = [];

const never = (): Promise<Response> => new Promise<Response>(() => undefined);

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && path === `/api/v1/hope/submissions/${SUB}/mark-uploaded`) {
    if (markUploadedAnswer === "stall") return never();
    if (markUploadedAnswer === "reject") throw new TypeError("offline");
    return json(200, { ...DETAIL, status: "submitted_pending_result" });
  }
  if (path === `/api/v1/hope/submissions/${SUB}`) {
    const answer = readAnswers.shift() ?? "ok";
    if (answer === "stall") return never();
    if (answer === "empty502") return new Response(null, { status: 502 });
    return json(200, DETAIL);
  }
  return json(404, { message: `unstubbed ${method} ${path}` });
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: ["compliance_officer"],
          permissions: MANAGE,
          isAdmin: false,
        }}
      >
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

/** Runs `act` with fake timers on and lets REQUEST_TIMEOUT_MS pass, so a request nobody answers is aborted. */
async function whileFakeClock(action: () => void): Promise<void> {
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

const button = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

async function openConfirm(): Promise<void> {
  await screen.findByRole("button", { name: "Mark uploaded" });
  fireEvent.click(button("Mark uploaded"));
}

beforeEach(() => {
  readAnswers = [];
  markUploadedAnswer = "ok";
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mark uploaded: a request that gets no answer", () => {
  it("is aborted after the wait, says it could not confirm, and frees every action beside it", async () => {
    markUploadedAnswer = "stall";
    mount();
    await openConfirm();

    await whileFakeClock(() => fireEvent.click(button("Confirm: mark uploaded to CMS")));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not confirm that the package was marked uploaded",
    );
    expect(button("Download ZIP").disabled).toBe(false);
    expect(button("Cancel package").disabled).toBe(false);
    expect(button("Mark uploaded").disabled).toBe(false);
  });

  it("is reported as unconfirmed, never as 'could not mark', when the request is rejected", async () => {
    markUploadedAnswer = "reject";
    mount();
    await openConfirm();

    fireEvent.click(button("Confirm: mark uploaded to CMS"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not confirm that the package was marked uploaded");
    expect(alert.textContent).not.toContain("Could not mark this package uploaded");
    expect(button("Mark uploaded").disabled).toBe(false);
  });

  it("does not leave the page disabled when the re-read after a successful write is never answered", async () => {
    readAnswers = ["ok", "stall"]; // the first load, then the re-read the write triggers
    mount();
    await openConfirm();

    await whileFakeClock(() => fireEvent.click(button("Confirm: mark uploaded to CMS")));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not refresh the HOPE submission.",
    );
    expect(button("Cancel package").disabled).toBe(false);
  });
});

describe("download: a request that gets no answer", () => {
  it("is aborted after the wait, says it could not download, and frees the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => never()),
    );
    mount();
    await screen.findByRole("button", { name: "Download ZIP" });

    await whileFakeClock(() => fireEvent.click(button("Download ZIP")));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not download the package.");
    expect(button("Download ZIP").disabled).toBe(false);
    expect(button("Cancel package").disabled).toBe(false);
  });
});

describe("a submission that could not be loaded", () => {
  it("offers Try again after an empty 502, and the retry shows the submission", async () => {
    readAnswers = ["empty502", "ok"];
    mount();

    expect(await screen.findByText("Could not load the HOPE submission.")).toBeTruthy();
    fireEvent.click(button("Try again"));

    expect(await screen.findByRole("button", { name: "Mark uploaded" })).toBeTruthy();
    expect(screen.queryByText("Could not load the HOPE submission.")).toBeNull();
    expect(calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`)).toHaveLength(2);
  });

  it("takes focus back to the error when the retry fails too, so Try again is the next Tab stop", async () => {
    readAnswers = ["empty502", "empty502"];
    mount();
    await screen.findByText("Could not load the HOPE submission.");

    fireEvent.click(button("Try again"));

    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => {
      const region = screen.getByText("Could not load the HOPE submission.").closest("[tabindex]");
      expect(document.activeElement).toBe(region);
    });
  });

  it("ends as the error state, not a spinner that never stops, when the read is never answered", async () => {
    readAnswers = ["stall", "ok"];
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText("Could not load the HOPE submission.")).toBeTruthy();
    fireEvent.click(button("Try again"));
    expect(await screen.findByRole("button", { name: "Mark uploaded" })).toBeTruthy();
  });
});
