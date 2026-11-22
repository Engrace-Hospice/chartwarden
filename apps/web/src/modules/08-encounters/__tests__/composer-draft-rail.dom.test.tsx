// @vitest-environment jsdom
// The composer's right rail (ADR-0114 S4b, VN-D63): a social-work or chaplain visit shows the plan picker beside the score trend and the care-plan list,
// and any other visit never asks for a discipline plan at all. The rail keeps showing the picker when every goal has been left out (the draft's own
// sections are then empty, so the draft alone could not say it is a plan visit). Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerDraftRail } from "../composer-draft-chrome";
import type { DraftView } from "../draft-api";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOAL = "dddddddd-4444-4444-8444-dddddddddd01";
const PLAN_URL = `/api/v1/encounters/${ENC}/discipline-plan-elements`;

let calls: Call[];
beforeEach(() => {
  calls = [];
});
afterEach(cleanup);

const DRAFT = {
  encounterId: ENC,
  patientId: PATIENT,
  templateKey: "msw_followup:msw",
  asOf: "2026-11-18T20:00:00.000Z",
  // every goal left out: the draft's sections are empty and name no origin
  sections: [{ sectionId: "plan", state: "not_drafted", origins: [] }],
} as unknown as DraftView;

function mount(
  discipline: string,
  encounterType: string,
  over: Record<string, Responder> = {},
  draft: DraftView | null = DRAFT,
) {
  const routes: Record<string, Responder> = {
    [`GET ${PLAN_URL}`]: () => ({
      body: {
        patientId: PATIENT,
        elements: [{ elementId: GOAL, kind: "goal", text: "Name two ways to cope", kept: false }],
      },
    }),
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  return render(
    <ApiClientProvider client={client}>
      <ComposerDraftRail
        encounter={{
          id: ENC,
          patientId: PATIENT,
          admissionId: "adm-1",
          encounterType,
          discipline,
          serviceDate: "2026-11-18",
        }}
        editable
        drafted={draft}
        carePlanRevision={0}
        onLinksChanged={() => undefined}
      />
    </ApiClientProvider>,
  );
}

describe("the composer rail", () => {
  it.each([
    ["msw", "msw_followup", "Social work plan for this visit"],
    ["chaplain", "chaplain_visit", "Spiritual care plan for this visit"],
  ])(
    "shows a %s visit's plan picker, even when every goal is left out",
    async (discipline, type, title) => {
      mount(discipline, type);
      const goal = await screen.findByRole("checkbox", { name: /Name two ways to cope/ });
      expect(goal).not.toBeChecked();
      expect(screen.getByRole("group", { name: title })).toBeInTheDocument();
    },
  );

  it.each([
    ["rn", "routine_visit"],
    ["chha", "chha_visit"],
    ["lpn", "routine_visit"],
    ["md", "face_to_face"],
  ])("never asks a %s visit for a discipline plan", async (discipline, type) => {
    mount(discipline, type);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.path === PLAN_URL)).toBe(false);
    expect(screen.queryByText(/plan for this visit/)).not.toBeInTheDocument();
  });

  it.each([
    ["msw", "msw_followup"],
    ["chaplain", "chaplain_visit"],
  ])(
    "shows a %s visit's plan picker with no draft at all, and nothing else (the score trend and the care-plan list are the draft's)",
    async (discipline, type) => {
      mount(discipline, type, {}, null);
      expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Scores and trend" })).not.toBeInTheDocument();
      expect(screen.queryByText("Care plan for this visit")).not.toBeInTheDocument();
      expect(calls.some((c) => c.path.includes("/scales/"))).toBe(false);
      expect(calls.some((c) => c.path.includes("relevant-elements"))).toBe(false);
    },
  );

  it("shows a rail with no draft only to a social-work or chaplain visit", async () => {
    const { container } = mount("rn", "routine_visit", {}, null);
    await waitFor(() => expect(container.querySelector(".wx-draft-rail")).toBeNull());
    expect(calls).toEqual([]);
  });

  it("does not say confirming a section links care-plan items on a plan visit, even when every goal is left out and the draft names no origin", async () => {
    mount("msw", "msw_followup", {
      "GET /api/v1/internal/care-plan/relevant-elements": () => ({
        body: {
          planId: "plan-1",
          patientId: PATIENT,
          problems: [],
          goals: [
            {
              goalId: "dddddddd-4444-4444-8444-dddddddddd02",
              problemId: "prob-1",
              text: "Keep the patient comfortable at rest",
              source: "clinical",
              status: "in_progress",
            },
          ],
          interventions: [],
          redacted: false,
        },
      }),
      [`GET /api/v1/encounters/${ENC}/care-plan-links`]: () => ({ body: { links: [] } }),
    });
    await screen.findByRole("checkbox", { name: /Keep the patient comfortable at rest/ });
    expect(screen.queryByText(/links its goals and interventions here/)).not.toBeInTheDocument();
  });
});
