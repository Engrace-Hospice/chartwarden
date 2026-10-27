// @vitest-environment jsdom
// Finding 8: `nextInspectionDueDate` is a DATE (no time). A US zone BEFORE any Date is built: the
// UTC-midnight parse of "2027-03-15" would render "Mar 14, 2027" in Los Angeles.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { IpuEquipment } from "./ipu-equipment";

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinical_supervisor"],
  permissions: [],
  isAdmin: false,
};

const stubFetch = async (): Promise<Response> =>
  new Response(
    JSON.stringify({
      items: [
        {
          id: "eq-1",
          serialNumber: "SN-001",
          equipmentType: "pca_pump",
          currentStatus: "available",
          nextInspectionDueDate: "2099-03-15",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("IpuEquipment date-only rendering", () => {
  it("shows the stored inspection due day, not the previous one", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <SessionProvider session={SESSION}>
          <ToastProvider>
            <MemoryRouter>
              <IpuEquipment />
            </MemoryRouter>
          </ToastProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Mar 15, 2099")).toBeTruthy();
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
