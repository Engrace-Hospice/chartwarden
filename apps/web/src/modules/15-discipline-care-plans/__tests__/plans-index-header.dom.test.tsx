import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Discipline plans tab shows the SAME patient header as the
// other chart tabs (the shared banner with the patient's identity, and the Patient Summary rail), not a bare page
// title. A regression here is the tab looking different from Plan of care, Assessments and the rest.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DisciplinePlansIndex } from "../plans-index";

const PATIENT = "patient-1";
let clientUnderTest: ApiClient;

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read", "discipline_plan.author"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function renderIndex(planOverrides: Record<string, unknown> = {}): void {
  const mswPlan = {
    planId: "plan-msw",
    patientId: PATIENT,
    admissionId: "admission-1",
    providerEntityId: "provider-1",
    locationId: "location-1",
    kind: "msw_plan",
    status: "draft_revising",
    nextSupervisoryDueAt: null,
    initialAssessmentClockStartedAt: "2026-11-01T00:00:00.000Z",
    initialAssessmentSignedAt: null,
    spiritualCareDeclinedAt: null,
    updatedAt: "2026-11-03T00:00:00.000Z",
    version: 1,
    actionSummary: {
      openVersion: {
        versionId: "version-1",
        sequence: 2,
        status: "draft",
        kind: "interim_revision",
      },
      latestSignedVersion: {
        versionId: "version-0",
        sequence: 1,
        signedAt: "2026-10-20T00:00:00.000Z",
      },
      missingSignerRoles: ["msw"],
      ownerMembershipIds: [],
      idgDecisionId: null,
    },
    ...planOverrides,
  };
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/discipline-plans")
        return ok({ data: [mswPlan], next_cursor: null, has_more: false });
      if (path === "/api/v1/patients/{id}")
        return ok({
          id: PATIENT,
          organizationId: "org-1",
          mrn: "MRN-0007",
          firstName: "June",
          lastName: "Rivera",
          dob: "1950-02-14",
          status: "active",
        });
      return ok({});
    }),
    POST: vi.fn(async () => ok({})),
  } as unknown as ApiClient;
  clientUnderTest = client;
  render(
    <MemoryRouter initialEntries={[`/patients/${PATIENT}/discipline-plans`]}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path="/patients/:patientId/discipline-plans"
                element={<DisciplinePlansIndex />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("discipline plans index — shared patient header", () => {
  it("shows the patient banner and the Patient Summary rail like every other chart tab", async () => {
    renderIndex();
    // The banner names the patient (it is the shared ChartBanner, which links the name to the chart).
    await waitFor(() => expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy());
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    // The banner and the rail share ONE patient read (the identity is loaded once and handed to the banner).
    const patientReads = (
      clientUnderTest.GET as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => c[0] === "/api/v1/patients/{id}");
    expect(patientReads).toHaveLength(1);
    // The page's own title moved into the content, and the printable summary stays one click away.
    expect(screen.getByRole("heading", { name: "Discipline plans" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Printable summary" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}/discipline-plans/summary`,
    );
    expect(screen.getByText("Review draft revision")).toBeTruthy();
    expect(screen.getByText("No action until a volunteer is assigned")).toBeTruthy();
    expect(screen.getByText("Not assigned")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open MSW Plan" }).getAttribute("href")).toBe(
      `/patients/${PATIENT}/discipline-plans/msw-plan`,
    );
  });

  it("opens an interim revision from the server-owned plan version", async () => {
    renderIndex({
      status: "active",
      version: 7,
      actionSummary: {
        openVersion: null,
        latestSignedVersion: {
          versionId: "version-1",
          sequence: 1,
          signedAt: "2026-10-20T00:00:00.000Z",
        },
        missingSignerRoles: [],
        ownerMembershipIds: [],
        idgDecisionId: null,
      },
    });

    const start = await screen.findByRole("button", { name: "Start revision" });
    fireEvent.click(start);

    await waitFor(() => {
      const calls = (clientUnderTest.POST as unknown as { mock: { calls: unknown[][] } }).mock
        .calls;
      expect(calls[0]?.[0]).toBe("/api/v1/discipline-plans/{planId}/versions");
      expect(calls[0]?.[1]).toMatchObject({
        params: { path: { planId: "plan-msw" }, header: { "If-Match": "7" } },
        body: { kind: "interim_revision" },
      });
    });
  });
});
