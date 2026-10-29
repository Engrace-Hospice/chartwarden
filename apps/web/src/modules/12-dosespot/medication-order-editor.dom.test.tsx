// The editor's pre-submit checks run before any request: a blank prescriber or SIG route never reaches the server.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicationOrderEditor } from "./medication-order-editor";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["hospice_physician"],
  permissions: [],
  isAdmin: false,
};

describe("MedicationOrderEditor pre-submit checks", () => {
  it("names the missing prescriber and SIG route and sends nothing", async () => {
    const calls: string[] = [];
    const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (
        input instanceof Request ? input.method : (init?.method ?? "GET")
      ).toUpperCase();
      calls.push(method);
      return new Response(JSON.stringify({ admissions: [], orders: [], results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    window.scrollTo = () => undefined;
    const router = createMemoryRouter(
      [{ path: "/patients/:patientId/medications/new", element: <MedicationOrderEditor /> }],
      { initialEntries: [`/patients/${PATIENT}/medications/new`] },
    );
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}
      >
        <SessionProvider session={SESSION}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/Select a prescribing physician\./)).toBeTruthy();
    expect(screen.getByText(/SIG route is required\./)).toBeTruthy();
    expect(calls.filter((m) => m !== "GET")).toEqual([]);
  });
});
