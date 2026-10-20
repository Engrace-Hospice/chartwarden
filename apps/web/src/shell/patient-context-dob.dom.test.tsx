// @vitest-environment jsdom
// Finding 8: a DOB is a DATE. US zone BEFORE any Date is built: "1950-03-15" must not read Mar 14.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { render, screen } from "@testing-library/react";
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
    render(
      <MemoryRouter>
        <ChartBanner identity={IDENTITY} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/Mar 15, 1950/).length).toBeGreaterThan(0);
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
