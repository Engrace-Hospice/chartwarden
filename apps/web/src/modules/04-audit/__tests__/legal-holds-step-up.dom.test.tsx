import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/04-audit - WP 5.6 (ADR-0086 proposed): M4 apply and release now demand a FRESH step-up.
// A stale session answers 403 STEP_UP_REQUIRED; the screen sends the user to /step-up with returnTo and keeps
// what they typed for the return trip.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import {
  markStepUpReturn,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import { LegalHolds } from "../legal-holds";

const PATH = "/compliance/legal-holds";
const HOLD = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  organizationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  name: "Smith litigation",
  criteria: { channelIds: ["cccccccc-3333-4333-8333-cccccccccccc"] },
  status: "active",
  reason: "Pending litigation discovery request",
  appliedBy: null,
  appliedAt: "2026-08-26T09:00:00.000Z",
  releasedAt: null,
};
const REASON = "Litigation over, hold no longer required";

let writeCount = 0;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (method !== "GET") {
    writeCount += 1;
    return json(403, { code: "STEP_UP_REQUIRED", title: "Step-up required" });
  }
  return json(200, { items: [HOLD], nextCursor: null });
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
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
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[PATH]}>
            <Routes>
              <Route path={PATH} element={<LegalHolds />} />
              <Route path="/step-up" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const STEP_UP_URL = `/step-up?returnTo=${encodeURIComponent(PATH)}`;

beforeEach(() => {
  writeCount = 0;
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("M4 legal holds step-up routing", () => {
  it("apply: STEP_UP_REQUIRED goes to /step-up and the modal returns with what was typed", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Smith litigation")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New Hold" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jones hold" } });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Regulator preservation request" },
    });
    fireEvent.change(screen.getByLabelText("Resource kinds"), { target: { value: "patient" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply hold" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(STEP_UP_URL));
    expect(writeCount).toBe(1);

    cleanup();
    markStepUpReturn(PATH); // what the step-up page records on success
    mount();
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Jones hold"),
    );
    expect((screen.getByLabelText("Resource kinds") as HTMLInputElement).value).toBe("patient");
  });

  it("release: STEP_UP_REQUIRED goes to /step-up and the hold returns selected with its reason", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Smith litigation")).toBeTruthy());
    fireEvent.click(screen.getByText("Smith litigation"));
    fireEvent.change(screen.getByLabelText("Release reason"), { target: { value: REASON } });
    fireEvent.click(screen.getByRole("button", { name: /release/i, hidden: false }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(STEP_UP_URL));

    cleanup();
    markStepUpReturn(PATH); // what the step-up page records on success
    mount();
    await waitFor(() =>
      expect((screen.getByLabelText("Release reason") as HTMLTextAreaElement).value).toBe(REASON),
    );
  });
});

describe("M4 legal holds: scoped drafts and genuine returns", () => {
  const OWNER = { userId: "u", organizationId: "o" };
  const stashRelease = (owner = OWNER) =>
    stashStepUpDraft(stepUpDraftKey(owner, "audit.legal_hold.release", HOLD.id), {
      holdId: HOLD.id,
      reason: REASON,
    });

  it("an abandoned release draft does not reopen the hold on a later ordinary visit, and is cleaned", async () => {
    stashRelease();
    mount();
    await waitFor(() => expect(screen.getByText("Smith litigation")).toBeTruthy());
    expect(screen.queryByLabelText("Release reason")).toBeNull();
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
  });

  it("an abandoned apply draft does not pop the modal open", async () => {
    stashStepUpDraft(stepUpDraftKey(OWNER, "audit.legal_hold.apply", "new"), {
      name: "Jones hold",
      reason: "Regulator preservation request",
      patientIds: "",
      resourceKinds: "patient",
      from: "",
      to: "",
    });
    mount();
    await waitFor(() => expect(screen.getByText("Smith litigation")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("another user's draft is invisible even right after a genuine return", async () => {
    stashRelease({ userId: "someone-else", organizationId: "o" });
    markStepUpReturn(PATH);
    mount();
    await waitFor(() => expect(screen.getByText("Smith litigation")).toBeTruthy());
    expect(screen.queryByLabelText("Release reason")).toBeNull();
  });

  it("a genuine return reopens the release with its reason", async () => {
    stashRelease();
    markStepUpReturn(PATH);
    mount();
    await waitFor(() =>
      expect((screen.getByLabelText("Release reason") as HTMLTextAreaElement).value).toBe(REASON),
    );
  });
});
