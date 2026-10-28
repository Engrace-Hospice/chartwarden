// §4.12 — an external open refused for a stale step-up sends the user to /step-up and back. Coming back,
// the version chain reopens the same version's dialog with the reason and recipient already chosen;
// an ordinary visit (no verified-return marker) must not pop a dialog open from a stale draft.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import {
  markStepUpReturn,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpDraftKeys,
} from "../../shell/step-up-redirect";
import { DISCLOSE_ACTION } from "./document-actions";
import { VersionHistory } from "./version-history";

const DOCUMENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VERSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PARTNER = "cccccccc-3333-4333-8333-cccccccccccc";
const PATH = `/documents/${DOCUMENT}/versions`;
const OWNER = { userId: "user-1", organizationId: "org-1" };

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(raw, "http://localhost");
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (pathname.endsWith("/versions")) {
    return json({
      items: [
        {
          id: VERSION,
          versionNumber: 2,
          mimeType: "application/pdf",
          byteSize: 2048,
          uploadedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
  }
  if (pathname === `/api/v1/documents/${DOCUMENT}`) {
    return json({
      id: DOCUMENT,
      title: "Discharge summary",
      retentionClass: "clinical",
      status: "active",
      version: 2,
      versionsCount: 1,
    });
  }
  return json({ results: [], items: [], tags: [] });
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          ...OWNER,
          membershipId: "membership-1",
          roles: ["clinician"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[PATH]}>
            <Routes>
              <Route path="/documents/:documentId/versions" element={<VersionHistory />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const draftKey = stepUpDraftKey(OWNER, DISCLOSE_ACTION, VERSION);
const stashDisclosureDraft = () =>
  stashStepUpDraft(draftKey, {
    purpose: "disclosure",
    recipientKind: "facility",
    recipientId: PARTNER,
  });

describe("VersionHistory — back from step-up", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("reopens the refused version's dialog with the reason and recipient restored", async () => {
    stashDisclosureDraft();
    markStepUpReturn(PATH);
    mount();

    expect(await screen.findByText("Open version 2")).toBeTruthy();
    expect((screen.getByLabelText("Reason for access") as HTMLSelectElement).value).toBe(
      "disclosure",
    );
    const dialog = screen.getByRole("dialog", { name: "Open document content" });
    expect(
      (within(dialog).getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("does not pop a dialog open on an ordinary visit, and drops the stale draft", async () => {
    stashDisclosureDraft(); // no return marker: the user abandoned the ceremony
    mount();

    await screen.findByText("Discharge summary");
    expect(screen.queryByText("Open version 2")).toBeNull();
    await waitFor(() => expect(stepUpDraftKeys()).not.toContain(draftKey));
  });

  it("drops a returned draft whose version is not in the loaded chain", async () => {
    const other = "dddddddd-4444-4444-8444-dddddddddddd";
    const otherKey = stepUpDraftKey(OWNER, DISCLOSE_ACTION, other);
    stashStepUpDraft(otherKey, {
      purpose: "disclosure",
      recipientKind: "facility",
      recipientId: PARTNER,
    });
    markStepUpReturn(PATH);
    mount();

    await screen.findByText("Discharge summary");
    expect(screen.queryByText("Open version 2")).toBeNull();
    await waitFor(() => expect(stepUpDraftKeys()).not.toContain(otherKey));
  });
});
