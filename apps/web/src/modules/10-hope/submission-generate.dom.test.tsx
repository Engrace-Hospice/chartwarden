// apps/web/src/modules/10-hope — the HOPE Submissions worklist can GENERATE the iQIES upload package.
//
// iQIES has no submission API (CMS HOPE FAQs Q30), so the only path to CMS is: generate a package here,
// download the ZIP from the batch's detail page, upload it in the iQIES portal, mark it uploaded. The
// server's `POST /api/v1/hope/submissions/assemble` builds the package, but no screen called it — the
// worklist was read-only. Like the sibling suite (`hope-writes.dom.test.tsx`) this asserts on RECORDED
// FETCH CALLS, so a button re-wired to a handler that never issues the request still fails.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SubmissionWorklist } from "./submission-worklist";

const PROVIDER_ENTITY = "11111111-aaaa-4aaa-8aaa-111111111111";
const OTHER_PROVIDER_ENTITY = "22222222-bbbb-4bbb-8bbb-222222222222";
const SUBMISSION = "33333333-cccc-4ccc-8ccc-333333333333";

const generateLabel = "Generate iQIES package";

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let providerEntities: Array<{ id: string; legalName: string; ccn: string }> = [];
let assembleFailure: { status: number; body: unknown } | null = null;
let assembleThrows = false;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const url = request?.url ?? String(input);
  const method = (request?.method ?? init?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (method === "POST" && path === "/api/v1/hope/submissions/assemble") {
    if (assembleThrows) throw new TypeError("network down");
    const raw = request ? await request.clone().text() : String(init?.body ?? "");
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (assembleFailure) return json(assembleFailure.status, assembleFailure.body);
    return json(201, {
      id: SUBMISSION,
      providerEntityId: String(bodies.at(-1)?.providerEntityId),
      status: "packaged",
      itemCount: 3,
      packageFilename: "HOPE_package.zip",
    });
  }
  if (path === "/api/v1/provider-entities") return json(200, { items: providerEntities });
  if (path === "/api/v1/hope/submissions") return json(200, { submissions: [] });
  return json(404, { message: `unstubbed ${method} ${path}` });
}

function mount(permissions: string[]) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["compliance_officer"],
          permissions,
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={["/hope/submissions"]}>
            <Routes>
              <Route path="/hope/submissions" element={<SubmissionWorklist />} />
              <Route path="/hope/submissions/:id" element={<div>Submission detail page</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  assembleFailure = null;
  assembleThrows = false;
  providerEntities = [{ id: PROVIDER_ENTITY, legalName: "Engrace Hospice", ccn: "123456" }];
});
afterEach(() => {
  assembleFailure = null;
});

describe("HOPE Submissions — generate the iQIES upload package", () => {
  it("POSTs the assemble route for the agency's provider entity, then opens the new batch", async () => {
    mount(["hope.submission.read", "hope.submission.manage"]);
    const button = await screen.findByRole("button", { name: generateLabel });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);

    await waitFor(() => expect(writes()).toEqual(["POST /api/v1/hope/submissions/assemble"]));
    expect(bodies[0]).toEqual({ providerEntityId: PROVIDER_ENTITY });
    // Landing on the detail page is the point: that is where "Download ZIP" lives.
    expect(await screen.findByText("Submission detail page")).toBeTruthy();
  });

  it("asks which provider entity when the organisation has several, and sends the chosen one", async () => {
    providerEntities = [
      { id: PROVIDER_ENTITY, legalName: "Engrace Hospice", ccn: "123456" },
      { id: OTHER_PROVIDER_ENTITY, legalName: "Engrace Hospice North", ccn: "654321" },
    ];
    mount(["hope.submission.manage"]);
    const picker = await screen.findByLabelText("Provider entity");
    fireEvent.change(picker, { target: { value: OTHER_PROVIDER_ENTITY } });

    fireEvent.click(screen.getByRole("button", { name: generateLabel }));

    await waitFor(() => expect(bodies[0]).toEqual({ providerEntityId: OTHER_PROVIDER_ENTITY }));
  });

  it("shows the server's own reason when nothing is eligible and stays on the worklist", async () => {
    assembleFailure = {
      status: 409,
      // The platform's real error envelope, not a bare `{ message }`.
      body: {
        error: {
          code: "CONFLICT",
          message: "No signed HOPE assessments are eligible for iQIES package generation",
        },
      },
    };
    mount(["hope.submission.manage"]);
    const button = await screen.findByRole("button", { name: generateLabel });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "No signed HOPE assessments are eligible",
    );
    expect(screen.queryByText("Submission detail page")).toBeNull();
  });

  it("sends one request when the button is clicked twice before the first renders", async () => {
    mount(["hope.submission.manage"]);
    const button = await screen.findByRole("button", { name: generateLabel });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    // One `act` batches both clicks, so `disabled` has not rendered yet when the second lands: only the
    // synchronous ref guard can stop it. Two separate `fireEvent.click`s each flush, which hides the race.
    act(() => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });

    await screen.findByText("Submission detail page");
    expect(writes()).toEqual(["POST /api/v1/hope/submissions/assemble"]);
  });

  it("shows an error and re-enables the button when the request itself fails", async () => {
    assembleThrows = true;
    mount(["hope.submission.manage"]);
    const button = await screen.findByRole("button", { name: generateLabel });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not generate the iQIES package",
    );
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Submission detail page")).toBeNull();
  });

  it("offers no generate control to a reader without hope.submission.manage", async () => {
    mount(["hope.submission.read"]);
    await screen.findByText("HOPE Submissions");
    expect(screen.queryByRole("button", { name: generateLabel })).toBeNull();
    expect(writes()).toEqual([]);
  });
});
