import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the IDG revision review shows the SAME patient header as the
// other discipline-plan tabs (shared banner + Patient Summary rail + chart module rail), not a bare page title.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { IdgRevisionReview } from "../idg-revision-review";

const PATIENT = "patient-1";
const PLAN = "plan-1";
const VERSION = "version-1";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.idg_revise"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

describe("discipline IDG revision review — patient workspace", () => {
  it("shows the patient banner, Patient Summary rail and chart rail around the review", async () => {
    const row = {
      planId: PLAN,
      patientId: PATIENT,
      admissionId: "admission-1",
      kind: "msw_plan",
      status: "draft_revising",
    };
    const plan = {
      ...row,
      goals: [],
      interventions: [],
      assessments: [],
      supervisoryVisits: [],
      volunteerAssignments: [],
      versions: [],
      supervisoryCadence: null,
      redacted_categories: [],
      actionSummary: {
        openVersion: null,
        latestSignedVersion: null,
        missingSignerRoles: [],
        ownerMembershipIds: [],
        idgDecisionId: null,
      },
    };
    const version = {
      versionId: VERSION,
      planId: PLAN,
      sequence: 2,
      status: "draft",
      kind: "idg_revision",
      idgMeetingId: null,
      finalizedAt: null,
      signedAt: null,
      supersededAt: null,
      version: 1,
      stateSnapshot: {},
      requiredSignerSet: [],
      signatures: [],
    };
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/discipline-plans")
          return ok({ data: [row], next_cursor: null, has_more: false });
        if (path === "/api/v1/discipline-plans/{planId}") return ok(plan);
        if (path === "/api/v1/discipline-plans/{planId}/versions/{versionId}") return ok(version);
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

    render(
      <MemoryRouter
        initialEntries={[`/patients/${PATIENT}/discipline-plans/msw_plan/idg-revisions/${VERSION}`]}
      >
        <ApiClientProvider client={client}>
          <ToastProvider>
            <SessionProvider session={session}>
              <Routes>
                <Route
                  path="/patients/:patientId/discipline-plans/:kind/idg-revisions/:versionId"
                  element={<IdgRevisionReview />}
                />
              </Routes>
            </SessionProvider>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "MSW Plan — IDG revision review" })).toBeTruthy(),
    );
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Patient chart" })).toBeTruthy();
  });
});
