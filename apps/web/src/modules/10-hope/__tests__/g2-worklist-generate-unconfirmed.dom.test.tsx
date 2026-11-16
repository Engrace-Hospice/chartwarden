// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SubmissionWorklist } from "../submission-worklist";

// Group g2: the submissions worklist's "Generate iQIES package" and its provider-entity read.
//  - Generate sends a fresh Idempotency-Key and is not bounded, so a reply that leaves the outcome unknown (an empty 502, a 5xx)
//    may still have built the package, exactly like a rejected request. The list the message tells the clinician to check is
//    re-read, so the batch shows if it was built, and a second press does not silently build a second one.
//  - A provider-entity read that succeeds with NO entity leaves Generate disabled for good: that is said, and focus (which the
//    Retry button took with it) goes to the saying, not to a disabled button.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ENTITIES = { items: [{ id: "pe-1", legalName: "Acme Hospice", ccn: "12345" }] };
const BUILT = {
  id: "44444444-dddd-4ddd-8ddd-444444444444",
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q4",
  status: "packaged",
  itemCount: 3,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
};
const UNCONFIRMED = "the result could not be confirmed";

let listReads = 0;
let listAnswer: () => Response = () => json(200, { submissions: [] });
let assembleAnswer: () => Response = () => json(200, BUILT);
let entitiesAnswer: () => Response | Promise<Response> = () => json(200, ENTITIES);

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  if (path === "/api/v1/hope/submissions" && method === "GET") {
    listReads += 1;
    return listAnswer();
  }
  if (path === "/api/v1/provider-entities") return await entitiesAnswer();
  if (path === "/api/v1/hope/submissions/assemble" && method === "POST") return assembleAnswer();
  return json(404, { message: `unstubbed ${method} ${path}` });
}
beforeEach(() => {
  listReads = 0;
  listAnswer = () => json(200, { submissions: [] });
  assembleAnswer = () => json(200, BUILT);
  entitiesAnswer = () => json(200, ENTITIES);
});

function mountWorklist() {
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
          <MemoryRouter initialEntries={["/hope/submissions"]}>
            <Routes>
              <Route path="/hope/submissions" element={<SubmissionWorklist />} />
              <Route path="/hope/submissions/:id" element={<p>The batch page</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}
const generate = () =>
  screen.getByRole("button", { name: /Generate iQIES package|Generating/ }) as HTMLButtonElement;

async function pressGenerate(): Promise<void> {
  await waitFor(() => expect(generate().disabled).toBe(false));
  await waitFor(() => expect(listReads).toBe(1));
  fireEvent.click(generate());
}

describe("Generate iQIES package: a reply that leaves the outcome unknown", () => {
  it.each([
    ["an empty 502", () => new Response(null, { status: 502 })],
    ["a 500 with an error body", () => json(500, { error: { code: "INTERNAL", message: "boom" } })],
  ])("re-reads the list after %s, and the batch shows if it was built", async (_name, answer) => {
    assembleAnswer = answer;
    mountWorklist();
    await pressGenerate();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(UNCONFIRMED);
    await waitFor(() => expect(listReads).toBe(2));
    expect(screen.queryByText("The batch page")).toBeNull();
  });

  it("shows the batch the first attempt built once the list is re-read", async () => {
    assembleAnswer = () => new Response(null, { status: 502 });
    mountWorklist();
    await pressGenerate();
    listAnswer = () => json(200, { submissions: [BUILT] });

    await screen.findByText(new RegExp(UNCONFIRMED));
    await waitFor(() => expect(screen.getByText("1 matching submissions")).toBeTruthy());
  });

  it.each([
    [
      "a 422 refusal",
      () => json(422, { error: { code: "M10_NO_SIGNED_RECORDS", message: "Nothing to package." } }),
    ],
    [
      "a degraded dependency",
      () => json(503, { error: { code: "DEGRADED", message: "seam down" } }),
    ],
  ])(
    "does not re-read the list after %s: it was answered, nothing was built",
    async (_name, answer) => {
      assembleAnswer = answer;
      mountWorklist();
      await pressGenerate();

      await screen.findByRole("alert");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(listReads).toBe(1);
    },
  );
});

describe("a provider-entity read that succeeds with no entity", () => {
  const NO_ENTITY = "No provider entity is available to you, so a package cannot be generated.";

  it("says why Generate is disabled", async () => {
    entitiesAnswer = () => json(200, { items: [] });
    mountWorklist();

    expect(await screen.findByText(NO_ENTITY)).toBeTruthy();
    expect(generate().disabled).toBe(true);
  });

  it("puts focus on that saying, not on the disabled Generate button, when Retry heals to it", async () => {
    entitiesAnswer = () => Promise.reject(new TypeError("offline"));
    mountWorklist();
    await screen.findByText(/Could not load provider entities/);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();

    entitiesAnswer = () => json(200, { items: [] });
    fireEvent.click(retry);

    const note = await screen.findByText(NO_ENTITY);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("does not say it while the read is out or when there is an entity", async () => {
    mountWorklist();

    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(screen.queryByText(NO_ENTITY)).toBeNull();
  });
});
