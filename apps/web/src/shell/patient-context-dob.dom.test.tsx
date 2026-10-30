// @vitest-environment jsdom
// Finding 8: a DOB is a DATE. US zone BEFORE any Date is built: "1950-03-15" must not read Mar 14.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { ApiClientProvider } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it } from "vitest";
import { ChartBanner, type ChartIdentity, PatientSummaryPanel } from "./patient-context";

const IDENTITY: ChartIdentity = {
  patient: {
    id: "p-1",
    organizationId: "org-1",
    mrn: "MRN000123",
    firstName: "Ada",
    lastName: "Lovelace",
    dob: "1950-03-15",
    status: "active",
  },
  sex: "Female",
  medicare: null,
};

/** Renders the banner over a stub client whose GET answers by route pattern (unlisted routes: no data). */
function renderBanner(identity: ChartIdentity, responses: Record<string, unknown>): void {
  const client = {
    GET: async (path: string) => ({ data: responses[path], error: undefined }),
  } as unknown as ComponentProps<typeof ApiClientProvider>["client"];
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter>
        <ChartBanner identity={identity} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("patient-context DOB rendering", () => {
  it("PatientSummaryPanel shows the stored birth day", () => {
    render(
      <MemoryRouter>
        <PatientSummaryPanel identity={IDENTITY} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Mar 15, 1950/)).toBeTruthy();
  });

  it("ChartBanner shows the stored birth day", () => {
    renderBanner(IDENTITY, {});
    expect(screen.getAllByText(/Mar 15, 1950/).length).toBeGreaterThan(0);
  });

  it("ChartBanner shows neither coverage when the patient has none", () => {
    renderBanner(IDENTITY, {});
    expect(screen.queryByText(/Medicare:/)).toBeNull();
    expect(screen.queryByText(/Medicaid:/)).toBeNull();
  });

  it("ChartBanner shows only Medicare when that is the only coverage", () => {
    renderBanner({ ...IDENTITY, medicare: "...5234", medicaid: null, allergies: [] }, {});
    expect(screen.getByText("Medicare: ...5234")).toBeTruthy();
    expect(screen.queryByText(/Medicaid:/)).toBeNull();
  });

  it("ChartBanner shows both when the patient has both", () => {
    renderBanner({ ...IDENTITY, medicare: "...5234", medicaid: "...7766", allergies: [] }, {});
    expect(screen.getByText("Medicare: ...5234")).toBeTruthy();
    expect(screen.getByText("Medicaid: ...7766")).toBeTruthy();
  });

  it("ChartBanner says no allergies are recorded when the list loaded empty", async () => {
    renderBanner(IDENTITY, { "/api/v1/patients/{id}/allergies": { allergies: [] } });
    expect(await screen.findByText("No allergies recorded")).toBeTruthy();
  });

  it("ChartBanner shows no allergy status when the allergy read failed", async () => {
    renderBanner(IDENTITY, {});
    await screen.findByText("Active");
    expect(screen.queryByText("No allergies recorded")).toBeNull();
  });

  it("ChartBanner shows the Medicaid tail and an allergy chip next to the status", async () => {
    renderBanner(IDENTITY, {
      "/api/v1/patients/{id}/payers": {
        payers: [{ coverageKind: "medicaid", subscriberId: "ZZ99887766", current: true }],
      },
      "/api/v1/patients/{id}/allergies": {
        allergies: [
          { allergenText: "Penicillin", verificationStatus: "unverified" },
          { allergenText: "Latex", verificationStatus: "entered_in_error" },
        ],
      },
    });
    expect(await screen.findByText("Allergy: Penicillin")).toBeTruthy();
    expect(screen.getByText("Medicaid: ...7766")).toBeTruthy();
  });

  it("PatientSummaryPanel lists the Medicaid tail from the identity", () => {
    render(
      <MemoryRouter>
        <PatientSummaryPanel identity={{ ...IDENTITY, medicaid: "...7766" }} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Medicaid")).toBeTruthy();
    expect(screen.getByText("...7766")).toBeTruthy();
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
