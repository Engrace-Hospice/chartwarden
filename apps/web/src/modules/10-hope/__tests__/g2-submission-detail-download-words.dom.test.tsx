// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { ADMISSION_PROJECTION_GAP_MESSAGE, SPEC_NOT_IN_FORCE_MESSAGE } from "../hope-api";
import { SubmissionDetail } from "../submission-detail";

// Group g2: a refused package download is worded by `refusalWordsOf` like every other refusal on the HOPE screens, so a code whose
// server text addresses an integrator (an Idempotency-Key instruction) is never shown to the clinician, while a reason the
// clinician can act on still is.

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
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// An integrator-facing refusal text of the same shape as the backend's (an Idempotency-Key instruction). A fixture, not the exact words:
// the screen words these codes itself and never reads the message.
const INTEGRATOR_TEXT =
  "No HOPE spec version is in force. On POST, PUT and PATCH the idempotency layer replays this 422 for 24 h on the same Idempotency-Key, so use a NEW Idempotency-Key; a GET has no key.";

async function pageFetch(input: RequestInfo | URL): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  return path === `/api/v1/hope/submissions/${SUB}`
    ? json(200, DETAIL)
    : json(404, { message: `unstubbed ${path}` });
}

async function downloadRefusedWith(status: number, body: unknown): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(status, body)),
  );
  render(
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
  fireEvent.click(await screen.findByRole("button", { name: "Download ZIP" }));
  return (await screen.findByRole("alert")).textContent ?? "";
}

describe("a refused package download", () => {
  it("words M10_SPEC_NOT_IN_FORCE in the module's sentence, never the server's integrator text", async () => {
    const shown = await downloadRefusedWith(422, {
      error: { code: "M10_SPEC_NOT_IN_FORCE", message: INTEGRATOR_TEXT },
    });

    expect(shown).toBe(SPEC_NOT_IN_FORCE_MESSAGE);
    expect(shown).not.toMatch(/idempotency/i);
  });

  it("words M10_ADMISSION_PROJECTION_GAP in the module's sentence, never the server's integrator text", async () => {
    const shown = await downloadRefusedWith(422, {
      error: { code: "M10_ADMISSION_PROJECTION_GAP", message: INTEGRATOR_TEXT },
    });

    expect(shown).toBe(ADMISSION_PROJECTION_GAP_MESSAGE);
    expect(shown).not.toMatch(/idempotency/i);
  });

  it("still shows the server's own reason for a refusal the clinician can act on", async () => {
    const shown = await downloadRefusedWith(409, {
      error: { code: "M10_SUBMISSION_CANCELLED", message: "This package was cancelled." },
    });

    expect(shown).toBe("This package was cancelled.");
  });
});
