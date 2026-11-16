// @vitest-environment jsdom
// Group g2: the submission page. Its instants are shown in the viewer's zone (never the UTC wall time with no zone on it), and a
// successful package download leaves keyboard focus on the Download ZIP button, not on the document.
// A US zone BEFORE any Date is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SubmissionDetail } from "../submission-detail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

const SUB = "33333333-cccc-4ccc-8ccc-333333333333";
const BASE = {
  id: SUB,
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status: "exported",
  packageFilename: "p.zip",
  itemCount: 0,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
  acceptedAt: null,
  items: [],
  findings: [],
};
// Sep 11 evenings in Chicago (CDT, UTC-5): each is already Sep 12 in UTC. A distinct minute per field so one fixed site cannot
// mask another.
const INSTANTS = {
  transmittedAt: "2026-09-12T00:31:00.000Z", // 19:31 CDT
  submittedAt: "2026-09-12T01:32:00.000Z", // 20:32 CDT
  acceptedAt: "2026-09-12T02:33:00.000Z", // 21:33 CDT
  resultImportedAt: "2026-09-12T03:34:00.000Z", // 22:34 CDT
  cancelledAt: "2026-09-12T04:35:00.000Z", // 23:35 CDT
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let detail: Record<string, unknown> = BASE;
async function pageFetch(input: RequestInfo | URL): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  return path === `/api/v1/hope/submissions/${SUB}`
    ? json(200, detail)
    : json(404, { message: `unstubbed ${path}` });
}
beforeEach(() => {
  detail = BASE;
});

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: pageFetch })}>
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

describe("the submission page's instants", () => {
  it("shows transmitted, uploaded, accepted and result-recorded times in the viewer's zone", async () => {
    detail = { ...BASE, ...INSTANTS, status: "accepted" };
    mount();

    expect(await screen.findByText("2026-09-11 19:31")).toBeTruthy();
    expect(screen.getByText("2026-09-11 20:32")).toBeTruthy();
    expect(screen.getByText("2026-09-11 21:33")).toBeTruthy();
    expect(screen.getByText("2026-09-11 22:34")).toBeTruthy();
    // The UTC wall time these fields used to show.
    expect(screen.queryByText("2026-09-12 00:31")).toBeNull();
  });

  it("shows the cancelled time in the viewer's zone, and the raw value when it cannot be read", async () => {
    detail = { ...BASE, status: "cancelled", cancelledAt: INSTANTS.cancelledAt };
    const first = mount();
    expect(await screen.findByText(/^2026-09-11 23:35 — /)).toBeTruthy();
    first.unmount();

    detail = { ...BASE, status: "cancelled", cancelledAt: "not a date" };
    mount();
    expect(await screen.findByText(/^not a date — /)).toBeTruthy();
  });
});

describe("a successful package download", () => {
  it("leaves focus on the Download ZIP button even when the browser dropped it while the button was disabled", async () => {
    detail = { ...BASE, status: "packaged" };
    // jsdom has no object URLs and would try to navigate on the anchor click.
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:zip"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Firefox and Safari: a focused control that becomes disabled drops focus to the document.
        (document.activeElement as HTMLElement | null)?.blur();
        return new Response("zip-bytes", { status: 200 });
      }),
    );
    mount();
    const download = (await screen.findByRole("button", {
      name: "Download ZIP",
    })) as HTMLButtonElement;
    download.focus();

    fireEvent.click(download);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download ZIP" }));
    });
  });

  it("leaves focus on the refusal, not the button, when the download is refused", async () => {
    detail = { ...BASE, status: "packaged" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        return json(409, { error: { code: "M10_SUBMISSION_CANCELLED", message: "Cancelled." } });
      }),
    );
    mount();
    const download = await screen.findByRole("button", { name: "Download ZIP" });
    download.focus();

    fireEvent.click(download);

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});
