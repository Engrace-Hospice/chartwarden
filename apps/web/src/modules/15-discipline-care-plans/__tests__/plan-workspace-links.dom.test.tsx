import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the version chain links the two screens that had NO inbound
// route: the Aide POC editor (`/aide-poc/:versionId/edit`, `discipline_plan.author`) and the IDG revision
// review (`/:kind/idg-revisions/:versionId`, `discipline_plan.idg_revise`). Each link must appear for the
// right version and only for an actor holding the permission its `screens.ts` entry declares.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import {
  AIDE_POC_EDIT_PERMISSION,
  IDG_REVISION_REVIEW_PERMISSION,
  versionRowActions,
} from "../discipline-status";
import { DisciplinePlanWorkspace } from "../plan-workspace";
import { disciplinePlanScreens } from "../screens";

const PATIENT = "patient-1";
const PLAN = "plan-1";

const baseSession: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read"],
};
const sessionWith = (...permissions: string[]): Session => ({
  ...baseSession,
  permissions: ["discipline_plan.read", ...permissions],
});

const version = (over: Record<string, unknown>) => ({
  versionId: "v-x",
  planId: PLAN,
  sequence: 1,
  status: "signed",
  kind: "initial",
  idgMeetingId: null,
  finalizedAt: null,
  signedAt: null,
  supersededAt: null,
  version: 1,
  ...over,
});

function planDetail(kind: string, versions: unknown[]) {
  return {
    planId: PLAN,
    patientId: PATIENT,
    admissionId: "adm-1",
    providerEntityId: "pe-1",
    locationId: "loc-1",
    kind,
    status: "draft_revising",
    nextSupervisoryDueAt: null,
    initialAssessmentClockStartedAt: "2026-01-01T00:00:00.000Z",
    initialAssessmentSignedAt: null,
    spiritualCareDeclinedAt: null,
    updatedAt: "2026-01-02T00:00:00.000Z",
    version: 4,
    aideMembershipId: null,
    supervisingRnMembershipId: null,
    supervisoryCadenceDaysOverride: null,
    spiritualCareDeclined: null,
    goals: [],
    interventions: [],
    assessments: [],
    supervisoryVisits: [],
    volunteerAssignments: [],
    versions,
    supervisoryCadence: null,
    redacted_categories: [],
  };
}

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function renderWorkspace(kind: string, versions: unknown[], session: Session): void {
  const detail = planDetail(kind, versions);
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/discipline-plans") return ok({ data: [detail], nextCursor: null });
      if (path === "/api/v1/discipline-plans/{planId}") return ok(detail);
      if (path === "/api/v1/patients/{id}")
        return ok({
          mrn: "MRN-7",
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
    <MemoryRouter initialEntries={[`/patients/${PATIENT}/discipline-plans/x`]}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path="/patients/:patientId/discipline-plans/x"
                element={<DisciplinePlanWorkspace kind={kind} />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const aideDraft = version({
  versionId: "v-aide-draft",
  sequence: 2,
  status: "draft",
  kind: "interim_revision",
});
const idgDraft = version({
  versionId: "v-idg-draft",
  sequence: 3,
  status: "draft",
  kind: "idg_review",
  idgMeetingId: "meeting-1",
});
const signed = version({
  versionId: "v-signed",
  sequence: 1,
  signedAt: "2026-01-02T00:00:00.000Z",
});

const hrefOf = (name: RegExp): string | null =>
  screen.queryByRole("link", { name })?.getAttribute("href") ?? null;

describe("plan workspace — links to the Aide POC editor and the IDG revision review", () => {
  it("links an open draft Aide POC version to its editor for an author", async () => {
    renderWorkspace("aide_poc", [signed, aideDraft], sessionWith(AIDE_POC_EDIT_PERMISSION));
    await waitFor(() => expect(screen.getByRole("link", { name: "Edit v2" })).toBeTruthy());
    expect(hrefOf(/^Edit v2$/)).toBe(
      `/patients/${PATIENT}/discipline-plans/aide-poc/v-aide-draft/edit`,
    );
    expect(screen.queryByRole("link", { name: "Edit v1" })).toBeNull(); // the signed version has no editor link
    expect(screen.queryByRole("link", { name: /^Review/ })).toBeNull();
  });

  it("links a draft post-IDG revision to its review for an actor with idg_revise", async () => {
    renderWorkspace("msw_plan", [signed, idgDraft], sessionWith(IDG_REVISION_REVIEW_PERMISSION));
    await waitFor(() => expect(screen.getByRole("link", { name: "Review v3" })).toBeTruthy());
    expect(hrefOf(/^Review v3$/)).toBe(
      `/patients/${PATIENT}/discipline-plans/msw_plan/idg-revisions/v-idg-draft`,
    );
    expect(screen.queryByRole("link", { name: /^Edit v\d/ })).toBeNull(); // not an aide plan
  });

  it("shows neither link without the permission the screen declares", async () => {
    renderWorkspace("aide_poc", [signed, aideDraft, idgDraft], baseSession);
    await waitFor(() => expect(screen.getByText("v3")).toBeTruthy());
    expect(screen.queryByRole("link", { name: /^Edit v\d/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Review/ })).toBeNull();
  });

  it("offers no link for a revision that is already sealed or signed", async () => {
    const sealed = { ...idgDraft, status: "in_review" };
    renderWorkspace(
      "aide_poc",
      [signed, sealed],
      sessionWith(AIDE_POC_EDIT_PERMISSION, IDG_REVISION_REVIEW_PERMISSION),
    );
    await waitFor(() => expect(screen.getByText("v3")).toBeTruthy());
    expect(screen.queryByRole("link", { name: /^(Edit|Review) v\d/ })).toBeNull();
  });
});

describe("versionRowActions", () => {
  it("fails closed when the permission set is unknown", () => {
    expect(
      versionRowActions("aide_poc", { kind: "idg_review", status: "draft" }, undefined),
    ).toEqual({
      edit: false,
      review: false,
    });
  });

  it("uses the permissions the screens.ts entries declare", () => {
    const required = (id: string) =>
      disciplinePlanScreens.screens.find((s) => s.id === id)?.requiredPermission;
    expect(required("discipline-plan.aide-poc.edit")).toBe(AIDE_POC_EDIT_PERMISSION);
    expect(required("discipline-plan.idg-revision")).toBe(IDG_REVISION_REVIEW_PERMISSION);
  });
});
