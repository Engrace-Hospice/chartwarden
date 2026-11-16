// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SubmissionWorklist } from "../submission-worklist";

// Group g2: the provider-entities Retry on the submissions worklist. Pressing it must not remove its own alert (which dropped the
// keyboard's place and said nothing about the retry in flight): the alert stays, says it is retrying, ignores a second press,
// keeps focus on Retry when the read fails again, and hands focus to Generate when it succeeds.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ENTITIES = { items: [{ id: "pe-1", legalName: "Acme Hospice", ccn: "12345" }] };
const FAILED_TEXT = "Could not load provider entities";

let entityReads = 0;
let answerEntities: () => Response | Promise<Response> = () => json(200, ENTITIES);
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  void init;
  if (path === "/api/v1/hope/submissions") return json(200, { submissions: [] });
  if (path === "/api/v1/provider-entities") {
    entityReads += 1;
    return await answerEntities();
  }
  return json(404, { message: `unstubbed ${path}` });
}
beforeEach(() => {
  entityReads = 0;
  answerEntities = () => json(200, ENTITIES);
});

/** A fresh tree each call: the API client is built anew, so rendering it again over a mounted one swaps the client. */
function worklistTree() {
  return (
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
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>
  );
}
const mountWorklist = () => render(worklistTree());
const generate = () =>
  screen.getByRole("button", { name: "Generate iQIES package" }) as HTMLButtonElement;
const retryButton = () => screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
const entitiesAlert = () =>
  screen
    .getAllByRole("alert")
    .find((el) => /provider entities|Retrying/.test(el.textContent ?? ""));

describe("the provider-entities Retry", () => {
  it("keeps its alert and its focus while the retry is out, and ignores a second press", async () => {
    answerEntities = () => Promise.reject(new TypeError("offline"));
    mountWorklist();
    await screen.findByText(new RegExp(FAILED_TEXT));
    const retry = retryButton();
    retry.focus();

    let release: (r: Response) => void = () => undefined;
    answerEntities = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    fireEvent.click(retry);

    // In flight: the same alert is still mounted and says so, the same button still has focus, and Generate waits.
    await waitFor(() => expect(entitiesAlert()?.textContent).toContain("Retrying"));
    expect(retryButton()).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    expect(generate().disabled).toBe(true);
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(entityReads).toBe(2);

    release(json(200, ENTITIES));
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(screen.queryByText(new RegExp(FAILED_TEXT))).toBeNull();
  });

  it("keeps focus on the same Retry button, and says it failed again, when the read fails again", async () => {
    answerEntities = () => new Response(null, { status: 502 });
    mountWorklist();
    await screen.findByText(new RegExp(FAILED_TEXT));
    const retry = retryButton();
    retry.focus();

    fireEvent.click(retry);
    await waitFor(() => expect(entityReads).toBe(2));
    await waitFor(() => expect(entitiesAlert()?.textContent).toContain(FAILED_TEXT));
    expect(retryButton()).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("false");
    expect(document.activeElement).toBe(retry);

    // And it is pressable again, healing the screen.
    answerEntities = () => json(200, ENTITIES);
    fireEvent.click(retry);
    await waitFor(() => expect(generate().disabled).toBe(false));
  });

  it("moves focus to Generate when the read succeeds and the Retry button leaves with its alert", async () => {
    answerEntities = () => Promise.reject(new TypeError("offline"));
    mountWorklist();
    await screen.findByText(new RegExp(FAILED_TEXT));
    const retry = retryButton();
    retry.focus();

    answerEntities = () => json(200, ENTITIES);
    fireEvent.click(retry);

    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(generate()));
  });
});

// There is deliberately no "reply after the whole screen unmounted" test: React 18 emits no warning for a state update on an
// unmounted component and the update is a no-op, so such a test passes with the `cancelled` check deleted (it did: checked).
// A reply the screen has replaced while it stays mounted is the observable case: a new client restarts the read, and the first
// read's late answer must not overwrite what the newer one found.
describe("a provider-entities reply for a read the screen has since replaced", () => {
  it.each([
    ["empty list", () => json(200, { items: [] }), /No provider entity is available/],
    ["failure", () => json(502, {}), new RegExp(FAILED_TEXT)],
  ])("does not let a late %s replace what the newer read found", async (_name, late, said) => {
    let settleFirst: (r: Response) => void = () => undefined;
    answerEntities = () =>
      new Promise<Response>((resolve) => {
        settleFirst = resolve;
      });
    const view = mountWorklist();
    await waitFor(() => expect(entityReads).toBe(1));

    answerEntities = () => json(200, ENTITIES);
    view.rerender(worklistTree());
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(entityReads).toBe(2);

    await act(async () => {
      settleFirst(late());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(said)).toBeNull();
    expect(generate().disabled).toBe(false);
  });
});
