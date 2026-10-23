// Audit F-028: when the advice read fails the worklist says "unavailable", so the KPI strip and the
// "N of M advices" count must not render beside it (a labelled "835 Advices" tile reads as data).
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { RemittanceWorklist } from "./remittance-worklist";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "ffffffff-6666-4666-8666-ffffffffffff",
  roles: ["billing_specialist"],
  permissions: [],
  isAdmin: false,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(advicesStatus: number): void {
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/v1/remittance/advices")
      return advicesStatus === 200
        ? json(200, { items: [], nextCursor: null })
        : json(advicesStatus, { error: { code: "FORBIDDEN", message: "no" } });
    return json(200, { items: [], nextCursor: null });
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <RemittanceWorklist />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(cleanup);

describe("RemittanceWorklist unavailable state", () => {
  it("shows no KPI tiles or advice count when the advice read fails", async () => {
    mount(403);
    await screen.findByRole("alert");
    expect(screen.queryByText("835 Advices")).toBeNull();
    expect(screen.queryByText(/advices ·/)).toBeNull();
  });

  it("still shows the KPI strip when the read succeeds", async () => {
    mount(200);
    await waitFor(() => expect(screen.getByText("835 Advices")).toBeTruthy());
  });
});
