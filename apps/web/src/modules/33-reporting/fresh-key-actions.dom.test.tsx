// The registry's "Refresh" reads the data as it is NOW: every click carries its own Idempotency-Key, never the API client's per-intent key (a
// replay of an earlier lost-reply answer would skip the refresh the operator just asked for).
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ReportingAdmin } from "./reporting-admin";
import { ReportingCatalog } from "./reporting-catalog";

const MV = {
  id: "11111111-1111-4111-8111-111111111111",
  mvKey: "census_daily",
  schemaName: "reporting",
  refreshStrategy: "nightly",
  status: "active",
  expectedFreshnessSeconds: 86_400,
  debounceWindowSeconds: 60,
  lastRefreshedAt: null,
  lastRefreshDurationMs: null,
  refreshFailureCount: 0,
};
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["org_admin"],
  permissions: [],
  isAdmin: true,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("ReportingAdmin refresh", () => {
  it("sends its own Idempotency-Key on every click", async () => {
    const keys: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST") {
          keys.push(request.headers.get("Idempotency-Key"));
          return json({});
        }
        if (path.endsWith("/reporting/admin/mvs")) {
          return json({ items: [MV], nextCursor: null, hasMore: false });
        }
        return json({});
      },
    });
    render(
      <ApiClientProvider client={client}>
        <SessionProvider session={SESSION}>
          <ToastProvider>
            <MemoryRouter>
              <ReportingAdmin />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );

    const refresh = async (nth: number): Promise<void> => {
      fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(keys).toHaveLength(nth));
    };
    await refresh(1);
    await refresh(2);

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe("ReportingCatalog Run", () => {
  it("sends its own Idempotency-Key on every click", async () => {
    const keys: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST") {
          keys.push(request.headers.get("Idempotency-Key"));
          return json({});
        }
        if (path.endsWith("/reporting/bases")) {
          return json({
            items: [
              {
                baseKey: "census",
                displayName: "Census base",
                domain: "census",
                description: "Daily census",
                mvKey: "census_daily",
                status: "active",
              },
            ],
          });
        }
        if (path.endsWith("/reporting/dashboards")) return json({ items: [] });
        return json({});
      },
    });
    render(
      <ApiClientProvider client={client}>
        <SessionProvider session={{ ...SESSION, permissions: ["report.admin.mv_refresh"] }}>
          <ToastProvider>
            <MemoryRouter>
              <ReportingCatalog />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );

    const run = async (nth: number): Promise<void> => {
      fireEvent.click(await screen.findByRole("button", { name: /Run$/ }));
      await waitFor(() => expect(keys).toHaveLength(nth));
    };
    await run(1);
    await run(2);

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
