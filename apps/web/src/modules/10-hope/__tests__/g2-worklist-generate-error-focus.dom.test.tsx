// @vitest-environment jsdom
// Group g2: a refused "Generate iQIES package" takes keyboard focus to its alert (the pressed button is disabled while the request is
// out, and Firefox and Safari drop focus from a disabled control to the document), and the alert's dismiss control has a real name
// and hands focus back to Generate.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { SubmissionWorklist } from "../submission-worklist";

afterEach(cleanup);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REFUSED = "Nothing to package.";

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  if (path === "/api/v1/hope/submissions" && method === "GET")
    return json(200, { submissions: [] });
  if (path === "/api/v1/provider-entities") {
    return json(200, { items: [{ id: "pe-1", legalName: "Acme Hospice", ccn: "12345" }] });
  }
  if (path === "/api/v1/hope/submissions/assemble" && method === "POST") {
    // The browser drops focus from the control that was disabled while the request is out.
    (document.activeElement as HTMLElement | null)?.blur();
    return json(422, { error: { code: "M10_NO_SIGNED_RECORDS", message: REFUSED } });
  }
  return json(404, { message: `unstubbed ${method} ${path}` });
}

function mountWorklist() {
  render(
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
    </ApiClientProvider>,
  );
}
const generate = () => screen.getByRole("button", { name: /Generate iQIES package|Generating/ });

async function refuseGenerate(): Promise<HTMLElement> {
  mountWorklist();
  await waitFor(() => expect((generate() as HTMLButtonElement).disabled).toBe(false));
  generate().focus();
  fireEvent.click(generate());
  return await screen.findByRole("alert");
}

describe("a refused Generate", () => {
  it("moves focus to the alert that announces it", async () => {
    const alert = await refuseGenerate();

    expect(alert.textContent).toContain(REFUSED);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("offers a dismiss control named for what it does, and returns focus to Generate when it is used", async () => {
    await refuseGenerate();

    const dismiss = screen.getByRole("button", { name: "Dismiss error" });
    fireEvent.click(dismiss);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(generate());
  });
});
