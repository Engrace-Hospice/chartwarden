// @vitest-environment jsdom
// Finding 8: a DOB is a DATE. US zone BEFORE any Date is built: "1950-03-15" must not read Mar 14.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { ApiClientProvider } from "@chartwarden/ui";
import { act, render, screen } from "@testing-library/react";
import { type ComponentProps, useLayoutEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, describe, expect, it } from "vitest";
import {
  ChartBanner,
  type ChartIdentity,
  PatientSummaryPanel,
  notifyCodeStatusChanged,
} from "./patient-context";

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

describe("patient-context code status chip (ADR-0104)", () => {
  const PATH = "/api/v1/patients/{id}/code-status";
  const entry = (codeStatus: string) => ({
    current: { codeStatus, recordedAt: "2026-10-29T12:00:00.000Z" },
    history: [],
  });
  const bg = (el: HTMLElement) => (el.closest(".wx-status-pill") as HTMLElement).style.background;

  it("shows DNR in the critical tone, like an allergy", async () => {
    renderBanner(IDENTITY, {
      [PATH]: entry("dnr"),
      "/api/v1/patients/{id}/allergies": {
        allergies: [{ allergenText: "Penicillin", verificationStatus: "verified" }],
      },
    });
    const dnr = await screen.findByText("DNR");
    const allergy = await screen.findByText("Allergy: Penicillin");
    expect(bg(dnr)).toBe(bg(allergy));
  });

  it("links the chip to the code status panel from any tab", async () => {
    renderBanner(IDENTITY, { [PATH]: entry("dnr") });
    const link = (await screen.findByText("DNR")).closest("a");
    expect(link?.getAttribute("href")).toBe("/patients/p-1?view=code-status");
  });

  it("names the chip link for assistive tech, including where it goes", async () => {
    renderBanner(IDENTITY, { [PATH]: entry("dnr") });
    expect(await screen.findByRole("link", { name: "Code status: DNR. Open code status" })).toBeTruthy();
  });

  it("never shows the previous patient's status on a reused banner", async () => {
    // Patient p-2's read never settles, so any chip on p-2's banner could only be p-1's leftover.
    const client = {
      GET: async (path: string, init?: { params?: { path?: { id?: string } } }) =>
        path === PATH && init?.params?.path?.id === "p-2"
          ? new Promise(() => {})
          : { data: path === PATH ? entry("dnr") : undefined, error: undefined },
    } as unknown as ComponentProps<typeof ApiClientProvider>["client"];
    // act() flushes effects before any assertion, so sample the DOM at layout-effect time: that is the
    // committed paint, before a passive reset effect could have run.
    const painted: string[] = [];
    function Probe(): null {
      useLayoutEffect(() => {
        painted.push(document.body.textContent ?? "");
      });
      return null;
    }
    const banner = (id: string) => (
      <ApiClientProvider client={client}>
        <MemoryRouter>
          <ChartBanner identity={{ ...IDENTITY, patient: { ...IDENTITY.patient, id } }} />
          <Probe />
        </MemoryRouter>
      </ApiClientProvider>
    );
    const { rerender } = render(banner("p-1"));
    expect(await screen.findByText("DNR")).toBeTruthy();
    painted.length = 0;
    rerender(banner("p-2"));
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.some((text) => text.includes("DNR"))).toBe(false);
  });

  it("labels DNR/DNI and comfort measures only", async () => {
    renderBanner(IDENTITY, { [PATH]: entry("dnr_dni") });
    expect(await screen.findByText("DNR / DNI")).toBeTruthy();
  });

  it("shows Full code in a neutral tone, not the critical one", async () => {
    renderBanner(IDENTITY, {
      [PATH]: entry("full_code"),
      "/api/v1/patients/{id}/allergies": { allergies: [] },
    });
    const full = await screen.findByText("Full code");
    expect(bg(full)).toBe(bg(await screen.findByText("No allergies recorded")));
  });

  it("says not recorded when no status is on file, and never Full code", async () => {
    renderBanner(IDENTITY, { [PATH]: { current: null, history: [] } });
    expect(await screen.findByText("Code status not recorded")).toBeTruthy();
    expect(screen.queryByText("Full code")).toBeNull();
  });

  it("says code status is unavailable when the read failed, never a status", async () => {
    renderBanner(IDENTITY, {});
    expect(await screen.findByText("Code status unavailable")).toBeTruthy();
    expect(screen.queryByText(/DNR|Full code|not recorded/)).toBeNull();
  });

  it("refreshes the chip after a code status is set (no stale DNR / Full code)", async () => {
    const responses: Record<string, unknown> = { [PATH]: entry("full_code") };
    renderBanner(IDENTITY, responses);
    expect(await screen.findByText("Full code")).toBeTruthy();
    responses[PATH] = entry("dnr");
    await act(async () => {
      notifyCodeStatusChanged("p-1");
    });
    expect(await screen.findByText("DNR")).toBeTruthy();
    expect(screen.queryByText("Full code")).toBeNull();
  });

  it("ignores a change notification for another patient", async () => {
    const responses: Record<string, unknown> = { [PATH]: entry("full_code") };
    renderBanner(IDENTITY, responses);
    await screen.findByText("Full code");
    responses[PATH] = entry("dnr");
    await act(async () => {
      notifyCodeStatusChanged("someone-else");
    });
    expect(screen.queryByText("DNR")).toBeNull();
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
