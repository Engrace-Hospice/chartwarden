// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SubmissionDetail } from "../submission-detail";

// Group g1 (web-k10, web-k18): a write on the submission page that nobody answered (a rejected request, a timeout, an empty 5xx, a server
// fault) may have been applied, so the page is read again (silently: its own failure words must not take keyboard focus out of an
// open dialog, whose Escape and Tab only work while focus is inside it). A refusal and a busy record (not applied) re-read nothing.

afterEach(cleanup);

const SUB = "33333333-cccc-4ccc-8ccc-333333333333";
const PENDING_ITEM = {
  id: "i-1",
  assessmentId: "aaaaaaaa-0000-4000-8000-000000000001",
  patientId: null,
  rfaKind: "01_admission",
  assessmentStatus: "signed",
  status: "pending",
  iqiesRecordId: null,
  processedAt: null,
  resolution: null,
  correctionAssessmentId: null,
};
const DETAIL = {
  id: SUB,
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status: "packaged",
  packageFilename: "p.zip",
  itemCount: 1,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
  acceptedAt: null,
  items: [PENDING_ITEM],
  findings: [],
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = Response | Promise<Response>;
let calls: string[] = [];
let handler: (method: string, path: string) => Answer | undefined = () => undefined;
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

const DETAIL_PATH = `/api/v1/hope/submissions/${SUB}`;
const MARK = `POST ${DETAIL_PATH}/mark-uploaded`;
const CANCEL = `POST ${DETAIL_PATH}/cancel`;
const RESULTS = `POST ${DETAIL_PATH}/results`;
const detailReads = () => calls.filter((c) => c === `GET ${DETAIL_PATH}`).length;
const offline = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));

/** The detail page: `first` answers the first read, `later` the ones after it; `writes` answer the POSTs by `METHOD path`. */
function routes(opts: {
  first?: unknown;
  later?: () => Answer;
  writes?: Record<string, () => Answer>;
}): void {
  let reads = 0;
  handler = (method, path) => {
    const write = opts.writes?.[`${method} ${path}`];
    if (write) return write();
    if (path !== DETAIL_PATH) return undefined;
    return reads++ === 0 || !opts.later ? json(200, opts.first ?? DETAIL) : opts.later();
  };
}

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
/** Every alert on the page that is not inside the dialog: the page's own words, which must not pull focus out of it. */
const alertsOutside = (dialog: HTMLElement) =>
  [...document.body.querySelectorAll("[role=alert]")].filter((a) => !dialog.contains(a));

async function openCancelDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Cancel package" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "package_lost" } });
  return dialog;
}

describe("a dialog on the page whose write nobody answered, and whose re-read fails too", () => {
  it("keeps focus inside the Cancel package dialog, and Escape still closes it", async () => {
    routes({ writes: { [CANCEL]: offline }, later: offline });
    mountDetail();
    const dialog = await openCancelDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel package" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Could not confirm");
    await waitFor(() => expect(detailReads()).toBe(2)); // the page was read again, and that failed too
    await settle();
    expect(alertsOutside(dialog)).toHaveLength(0);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps focus inside the Record CMS result dialog", async () => {
    routes({
      first: { ...DETAIL, status: "exported" },
      writes: { [RESULTS]: offline },
      later: offline,
    });
    mountDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Record CMS result" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Outcome for/), {
      target: { value: "accepted" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("may not have been");
    await waitFor(() => expect(detailReads()).toBe(2));
    await settle();
    expect(alertsOutside(dialog)).toHaveLength(0);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("still re-reads and shows the page's own words after a refusal that says the page is stale, once the dialog is left", async () => {
    routes({
      writes: {
        [CANCEL]: () => json(409, { error: { code: "CONFLICT", message: "Already uploaded." } }),
      },
      later: () => json(200, { ...DETAIL, status: "submitted_pending_result" }),
    });
    mountDetail();
    const dialog = await openCancelDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel package" }));

    await waitFor(() => expect(detailReads()).toBe(2));
    // The page behind now shows the package as uploaded: it no longer offers Cancel package.
    await waitFor(() =>
      expect(screen.getAllByText("Submitted Pending Result").length).toBeGreaterThan(0),
    );
  });
});

describe("mark uploaded: an outcome nobody confirmed", () => {
  async function confirmMarkUploaded(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Mark uploaded" }));
    fireEvent.click(button("Confirm: mark uploaded to CMS"));
  }
  const MARKED = () => json(200, { ...DETAIL, status: "submitted_pending_result" });

  it.each([
    ["is rejected", offline],
    ["answers 502 with no body", () => new Response(null, { status: 502 })],
    [
      "answers 500 with the server's own fault",
      () => json(500, { error: { code: "INTERNAL", message: "boom" } }),
    ],
  ])(
    "reads the page again when the request %s, so it shows the status it really has",
    async (_name, answer) => {
      routes({ writes: { [MARK]: answer }, later: MARKED });
      mountDetail();

      await confirmMarkUploaded();

      expect((await screen.findByRole("alert")).textContent).toMatch(/could not (be )?confirm/i);
      await waitFor(() => expect(detailReads()).toBe(2));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Mark uploaded" })).toBeNull(),
      );
    },
  );

  it("frees every action without waiting for that re-read", async () => {
    routes({ writes: { [MARK]: offline }, later: () => new Promise<Response>(() => undefined) });
    mountDetail();

    await confirmMarkUploaded();

    await screen.findByRole("alert");
    await waitFor(() => expect(button("Mark uploaded").disabled).toBe(false));
    expect(button("Download ZIP").disabled).toBe(false);
  });

  it.each([
    ["a 422 refusal", () => json(422, { error: { code: "VALIDATION_FAILED", message: "No." } })],
    ["a 403 with no body", () => new Response(null, { status: 403 })],
  ])("does not read the page again after %s", async (_name, answer) => {
    routes({ writes: { [MARK]: answer }, later: MARKED });
    mountDetail();

    await confirmMarkUploaded();

    await screen.findByRole("alert");
    await settle();
    expect(detailReads()).toBe(1);
  });

  it("does not read the page again once the clinician has left it", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    routes({
      writes: {
        [MARK]: () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
      },
      later: MARKED,
    });
    const view = mountDetail();
    await confirmMarkUploaded();
    await waitFor(() => expect(calls).toContain(MARK));

    view.unmount();
    fail(new TypeError("Failed to fetch"));
    await settle();

    expect(detailReads()).toBe(1);
  });
});
