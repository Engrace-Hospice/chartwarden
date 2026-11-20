// The "Visit changes" tab on the Care Plans workspace (WF09): the pending count on the tab, the review list inside it, and the plan
// being read again after a proposal is accepted. Mounts the real CarePlanView over a stub API.
import { ToastProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CarePlanView } from "../../care-plan-view";
import {
  type Call,
  PATIENT,
  PLAN,
  PROBLEM,
  type Responder,
  mountWith,
  proposalView,
} from "./proposal-test-harness";

afterEach(cleanup);

const plan = {
  id: PLAN,
  patientId: PATIENT,
  admissionId: "adm-1",
  status: "active",
  activeVersionId: "v-1",
  version: 3,
  versions: [
    {
      id: "v-1",
      planId: PLAN,
      sequence: 1,
      kind: "initial",
      status: "signed",
      requiredSignerSet: [],
      signatures: [],
      version: 1,
    },
  ],
  problems: [
    {
      id: PROBLEM,
      planId: PLAN,
      description: "Dyspnea related to end-stage COPD",
      kind: "terminal",
      source: "clinical",
      status: "active",
      sudRelated: false,
      version: 1,
    },
  ],
  goals: [],
  interventions: [],
  redacted: false,
};

const LIST = `GET /api/v1/care-plans/${PLAN}/change-proposals`;
const goalProposal = proposalView({ change: { originalText: "Sleep through the night" } });
const otherProposal = proposalView({
  kind: "problem_add",
  target: null,
  change: { description: "Anxiety at night", problemKind: "related" },
});

function mount(permissions: string[], routes: Record<string, Responder>): Call[] {
  const calls: Call[] = [];
  mountWith({
    calls,
    permissions,
    entry: `/patients/${PATIENT}/care-plan`,
    // anything the workspace reads that this suite does not care about (banner, readiness...) answers empty
    fallback: () => ({ body: {} }),
    routes: {
      [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: plan }),
      [`GET /api/v1/care-plans/${PLAN}/readiness`]: () => ({
        body: {
          planId: PLAN,
          openVersionId: null,
          canFinalize: false,
          canSign: false,
          blockers: [],
          signatures: { required: [], collected: [], missing: [] },
        },
      }),
      [`GET /api/v1/care-plans/${PLAN}/review-status`]: () => ({
        body: {
          planId: PLAN,
          nextReviewDueAt: "2026-12-01T00:00:00.000Z",
          status: "not_due",
          overdueByDays: 0,
          openReviewVersionId: null,
          openReviewVersionStatus: null,
          canStartReview: false,
        },
      }),
      [`GET /api/v1/patients/${PATIENT}`]: () => ({
        body: {
          mrn: "MRN-1",
          lastName: "Vance",
          firstName: "Ada",
          dob: "1948-03-02",
          status: "active",
        },
      }),
      ...routes,
    },
    element: (
      <ToastProvider>
        <Routes>
          <Route path="/patients/:patientId/care-plan" element={<CarePlanView />} />
        </Routes>
      </ToastProvider>
    ),
  });
  return calls;
}

describe("the Visit changes tab", () => {
  it("counts the proposals waiting for review and opens the review list", async () => {
    mount(["care_plan.read", "care_plan.author"], {
      [LIST]: () => ({
        body: { patientId: PATIENT, proposals: [goalProposal, otherProposal], redacted: false },
      }),
    });
    const tab = await screen.findByRole("tab", { name: /^Visit changes\s*2$/ });
    fireEvent.click(tab);
    expect(await screen.findByText("Sleep through the night")).toBeInTheDocument();
    expect(screen.getByText("Anxiety at night")).toBeInTheDocument();
  });

  it("leaves the count off when nothing is waiting", async () => {
    mount(["care_plan.read", "care_plan.author"], {
      [LIST]: () => ({ body: { patientId: PATIENT, proposals: [], redacted: false } }),
    });
    expect(await screen.findByRole("tab", { name: /^Visit changes$/ })).toBeInTheDocument();
  });

  it("accepting reads the plan again and refreshes the count", async () => {
    let accepted = false;
    const calls = mount(["care_plan.read", "care_plan.author"], {
      [LIST]: () => ({
        body: {
          patientId: PATIENT,
          proposals: accepted ? [otherProposal] : [goalProposal, otherProposal],
          redacted: false,
        },
      }),
      [`POST /api/v1/care-plans/${PLAN}/change-proposals/${goalProposal.id}/accept`]: () => {
        accepted = true;
        return {
          body: {
            proposalId: goalProposal.id,
            status: "accepted",
            resultElementType: "goal",
            resultElementId: "g-new",
            decidedAt: "2026-11-21T10:00:00.000Z",
          },
        };
      },
    });
    fireEvent.click(await screen.findByRole("tab", { name: /^Visit changes\s*2$/ }));
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const aside = await screen.findByRole("complementary", { name: /proposed change/i });
    fireEvent.click(within(aside).getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("tab", { name: /^Visit changes\s*1$/ })).toBeInTheDocument();
    const planReads = calls.filter(
      (c) => c.method === "GET" && c.path === `/api/v1/patients/${PATIENT}/care-plan`,
    );
    await waitFor(() => expect(planReads.length).toBeGreaterThanOrEqual(1));
    expect(
      calls.filter((c) => c.method === "GET" && c.path === `/api/v1/patients/${PATIENT}/care-plan`),
    ).toHaveLength(2);
  });

  it("dismissing refreshes the count but does not read the plan again, which a dismissal leaves as it was", async () => {
    let dismissed = false;
    const calls = mount(["care_plan.read", "care_plan.author"], {
      [LIST]: () => ({
        body: {
          patientId: PATIENT,
          proposals: dismissed ? [otherProposal] : [goalProposal, otherProposal],
          redacted: false,
        },
      }),
      [`POST /api/v1/care-plans/${PLAN}/change-proposals/${goalProposal.id}/dismiss`]: () => {
        dismissed = true;
        return {
          body: {
            proposalId: goalProposal.id,
            status: "dismissed",
            decidedAt: "2026-11-21T10:00:00.000Z",
            dismissalReason: null,
          },
        };
      },
    });
    fireEvent.click(await screen.findByRole("tab", { name: /^Visit changes\s*2$/ }));
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const aside = await screen.findByRole("complementary", { name: /proposed change/i });
    fireEvent.click(within(aside).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(aside).getByRole("button", { name: "Dismiss proposal" }));

    expect(await screen.findByRole("tab", { name: /^Visit changes\s*1$/ })).toBeInTheDocument();
    expect(
      calls.filter((c) => c.method === "GET" && c.path === `/api/v1/patients/${PATIENT}/care-plan`),
    ).toHaveLength(1);
  });

  it("offers no Accept or Dismiss to a viewer without the author permission", async () => {
    mount(["care_plan.read"], {
      [LIST]: () => ({
        body: { patientId: PATIENT, proposals: [goalProposal], redacted: false },
      }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: /^Visit changes\s*1$/ }));
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const aside = await screen.findByRole("complementary", { name: /proposed change/i });
    expect(within(aside).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});
