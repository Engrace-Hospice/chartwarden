// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { RecordCmsResultModal } from "../record-cms-result-modal";
import { SubmissionDetail } from "../submission-detail";

// Group g1: the submission page after an action. A success that makes the acted-on button disappear must leave the keyboard
// user somewhere that says so (not on the document), a 409 "the record is busy" is not a stale page (the step was NOT applied, so
// the page is not re-read and nothing is held shut), and a 404 on the page read is final: Try again cannot help it.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SUB = "33333333-cccc-4ccc-8ccc-333333333333";
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
const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";
const busyEnvelope = { error: { code: "M10_RECORD_BUSY", message: BUSY_MESSAGE } };
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
let handler: (method: string, path: string) => Response | Promise<Response> | undefined = () =>
  undefined;
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

function mountDetail() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: ["compliance_officer"],
          permissions: ["hope.submission.manage"],
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
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const detailReads = () => calls.filter((c) => c === `GET /api/v1/hope/submissions/${SUB}`).length;
const MARK = `POST /api/v1/hope/submissions/${SUB}/mark-uploaded`;
const CANCEL = `POST /api/v1/hope/submissions/${SUB}/cancel`;

/** The detail page: `first` for the first read, `after` for the reads that follow an action. */
function routes(opts: {
  first?: unknown;
  after?: unknown;
  mark?: () => Response;
  cancel?: () => Response;
}): void {
  let reads = 0;
  handler = (method, path) => {
    const key = `${method} ${path}`;
    if (key === MARK)
      return opts.mark?.() ?? json(200, { ...DETAIL, status: "submitted_pending_result" });
    if (key === CANCEL) return opts.cancel?.() ?? json(200, { ...DETAIL, status: "cancelled" });
    if (path === `/api/v1/hope/submissions/${SUB}`)
      return json(200, reads++ === 0 ? (opts.first ?? DETAIL) : (opts.after ?? DETAIL));
    return undefined;
  };
}
async function confirmMarkUploaded(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Mark uploaded" }));
  fireEvent.click(button("Confirm: mark uploaded to CMS"));
}

describe("submission detail: a success that removes the button that was used", () => {
  it("says the package was marked uploaded, and focuses that note, when the Mark uploaded button is gone", async () => {
    routes({ after: { ...DETAIL, status: "submitted_pending_result" } });
    mountDetail();
    await confirmMarkUploaded();
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("marked uploaded");
    expect(screen.queryByRole("button", { name: "Mark uploaded" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("says the package was cancelled, and focuses that note, when Cancel package is gone", async () => {
    routes({ after: { ...DETAIL, status: "cancelled" } });
    mountDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel package" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "package_lost" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel package" }));
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("Package cancelled");
    // The note is set when the cancel is answered; the button goes with the re-read that follows, a second read.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel package" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(note));
  });
});

describe("submission detail: M10_RECORD_BUSY is not a stale page", () => {
  it("shows the server's words for a busy download, does not re-read, and frees every action", async () => {
    routes({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, busyEnvelope)),
    );
    mountDetail();
    await screen.findByRole("button", { name: "Download ZIP" });
    fireEvent.click(button("Download ZIP"));
    expect((await screen.findByRole("alert")).textContent).toBe(BUSY_MESSAGE);
    await waitFor(() => expect(button("Download ZIP").disabled).toBe(false));
    expect(detailReads()).toBe(1);
  });

  it("shows the server's words for a busy mark-uploaded, does not re-read, and frees every action", async () => {
    routes({ mark: () => json(409, busyEnvelope) });
    mountDetail();
    await confirmMarkUploaded();
    expect((await screen.findByRole("alert")).textContent).toBe(BUSY_MESSAGE);
    await waitFor(() => expect(button("Mark uploaded").disabled).toBe(false));
    expect(detailReads()).toBe(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("submission detail: a 404 on the page read", () => {
  it("is final: not available to this user, with no Try again that cannot help", async () => {
    handler = (_method, path) =>
      path === `/api/v1/hope/submissions/${SUB}`
        ? json(404, { error: { code: "NOT_FOUND", message: "Not found" } })
        : undefined;
    mountDetail();
    expect(await screen.findByText(/not found, or not available to you/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(detailReads()).toBe(1);
  });

  it("is still retryable for a 502", async () => {
    handler = (_method, path) =>
      path === `/api/v1/hope/submissions/${SUB}` ? new Response(null, { status: 502 }) : undefined;
    mountDetail();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("the CMS result dialog: M10_RECORD_BUSY is not a stale page either", () => {
  const refusal = (status: number, code: string) => ({
    data: undefined,
    error: { error: { code, message: `server words for ${code}` } },
    response: new Response(null, { status }),
  });
  function submitResult(post: ReturnType<typeof vi.fn>, onConflict: () => void) {
    render(
      <ApiClientProvider client={{ GET: vi.fn(), POST: post } as unknown as ApiClient}>
        <RecordCmsResultModal
          open
          submissionId="sub-1"
          items={[{ assessmentId: "a-1", label: "Lovelace, Ada — Admission" }]}
          onClose={vi.fn()}
          onDone={vi.fn()}
          onConflict={onConflict}
        />
      </ApiClientProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Record CMS result" });
    fireEvent.change(
      within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 1"),
      {
        target: { value: "accepted" },
      },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
    return dialog;
  }

  it("shows the server's words and does not ask the page to re-read, for a busy record", async () => {
    const onConflict = vi.fn();
    const dialog = submitResult(
      vi.fn(async () => refusal(409, "M10_RECORD_BUSY")),
      onConflict,
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain("M10_RECORD_BUSY");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("still asks the page to re-read for any other 409", async () => {
    const onConflict = vi.fn();
    const dialog = submitResult(
      vi.fn(async () => refusal(409, "M10_RESULT_ALREADY_RECORDED")),
      onConflict,
    );
    await within(dialog).findByRole("alert");
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
  });
});
