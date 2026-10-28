// @vitest-environment jsdom
// Finding 8: license `effectiveDate` / `expiresAt` are DATE columns. US zone BEFORE any Date is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ScaleLicenseRegistry } from "./scale-license-registry";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["admin"],
  permissions: [],
  isAdmin: true,
};

const stubFetch = async (): Promise<Response> =>
  new Response(
    JSON.stringify({
      licenses: [
        {
          id: "lic-1",
          scaleType: "fast",
          vendor: "Acme Scales",
          effectiveDate: "2026-03-15",
          expiresAt: "2027-03-01",
          seats: 5,
          status: "active",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("ScaleLicenseRegistry date-only rendering", () => {
  it("shows the stored effective and expiry days, not the previous ones", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider session={SESSION}>
          <ToastProvider>
            <MemoryRouter>
              <ScaleLicenseRegistry />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Mar 15, 2026")).toBeTruthy();
    expect(screen.getByText("Mar 1, 2027")).toBeTruthy();
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
