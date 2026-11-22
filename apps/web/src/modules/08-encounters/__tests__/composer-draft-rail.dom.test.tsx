// @vitest-environment jsdom
// The composer's right rail (ADR-0114 S4b, VN-D63; S5b, VN-D64): a social-work or chaplain visit shows the plan picker beside the score trend and the care-plan
// list, and any other visit never asks for a discipline plan at all. The rail keeps showing the picker when every goal has been left out (the draft's own
// sections are then empty, so the draft alone could not say it is a plan visit). An IDG follow-up visit of any discipline shows the IDG action item picker, with
// or without a draft, and no other visit ever asks for the list. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerDraftRail } from "../composer-draft-chrome";
import type { DraftView } from "../draft-api";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOAL = "dddddddd-4444-4444-8444-dddddddddd01";
const ITEM = "dddddddd-4444-4444-8444-dddddddddd09";
const PLAN_URL = `/api/v1/encounters/${ENC}/discipline-plan-elements`;
const IDG_LIST_URL = `/api/v1/encounters/${ENC}/idg-action-items`;
const IDG_LINK_URL = `/api/v1/encounters/${ENC}/idg-action-item`;
const idgItems = (linked: boolean) => ({
  patientId: PATIENT,
  items: [
    {
      actionItemId: ITEM,
      meetingDate: "2026-11-10",
      decisionKind: "referral",
      decisionLabel: "a referral",
      dueDate: null,
      status: "open",
      linked,
    },
  ],
});

let calls: Call[];
beforeEach(() => {
  calls = [];
});
afterEach(cleanup);

const reads = (path: string): Call[] => calls.filter((c) => c.method === "GET" && c.path === path);

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
  draftReady = true,
  onLinksChanged: () => void = () => undefined,
) {
  const routes: Record<string, Responder> = {
    [`GET ${PLAN_URL}`]: () => ({
      body: {
        patientId: PATIENT,
        elements: [{ elementId: GOAL, kind: "goal", text: "Name two ways to cope", kept: false }],
      },
    }),
    [`GET ${IDG_LIST_URL}`]: () => ({ body: idgItems(false) }),
    ...over,
  };
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const tree = (ready: boolean) => (
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
        draftReady={ready}
        carePlanRevision={0}
        onLinksChanged={onLinksChanged}
      />
    </ApiClientProvider>
  );
  const rendered = render(tree(draftReady));
  return { ...rendered, setDraftReady: (ready: boolean) => rendered.rerender(tree(ready)) };
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

  it.each([
    ["msw", "msw_followup"],
    ["chaplain", "chaplain_visit"],
  ])(
    "asks a %s visit for no plan list, and shows no rail, until the draft was read (the tenant switch off answers it 404 too)",
    async (discipline, type) => {
      const { container } = mount(discipline, type, {}, null, false);
      await waitFor(() => expect(container.querySelector(".wx-draft-rail")).toBeNull());
      expect(calls).toEqual([]);
    },
  );

  it("keeps a plan visit's picker mounted when a later read of the draft fails, so it does not vanish under the box that was pressed", async () => {
    const { setDraftReady } = mount("msw", "msw_followup", {}, null);
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeVisible();
    setDraftReady(false);
    expect(screen.getByRole("checkbox", { name: /Name two ways to cope/ })).toBeVisible();
  });

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

describe("the composer rail for an IDG follow-up visit", () => {
  const IDG_DRAFT = {
    ...DRAFT,
    templateKey: "idg_followup:rn",
    sections: [],
  } as unknown as DraftView;

  it.each(["rn", "lpn", "msw", "chaplain", "md", "np"])(
    "shows a %s IDG follow-up visit's item picker beside the draft",
    async (discipline) => {
      mount(discipline, "idg_followup", {}, IDG_DRAFT);
      expect(await screen.findByRole("radio", { name: /a referral/ })).not.toBeChecked();
      expect(screen.getByRole("radio", { name: "No follow-up item" })).toBeChecked();
      expect(screen.getByRole("group", { name: "IDG follow-up item" })).toBeInTheDocument();
    },
  );

  it("shows the picker with no draft at all (nothing is drafted until an item is chosen), and nothing else", async () => {
    mount("rn", "idg_followup", {}, null);
    expect(await screen.findByRole("radio", { name: /a referral/ })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Scores and trend" })).not.toBeInTheDocument();
    expect(screen.queryByText("Care plan for this visit")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/scales/"))).toBe(false);
    expect(calls.some((c) => c.path === PLAN_URL)).toBe(false);
  });

  it("tells the composer when the choice changes, so the draft is read again", async () => {
    const onLinksChanged = vi.fn();
    mount(
      "rn",
      "idg_followup",
      { [`PUT ${IDG_LINK_URL}`]: () => ({ body: idgItems(true) }) },
      null,
      true,
      onLinksChanged,
    );
    await userEvent.setup().click(await screen.findByRole("radio", { name: /a referral/ }));
    await waitFor(() => expect(onLinksChanged).toHaveBeenCalledOnce());
    expect(screen.getByRole("radio", { name: /a referral/ })).toBeChecked();
  });

  it("shows a social worker's IDG follow-up both the item picker and the discipline's plan picker", async () => {
    mount("msw", "idg_followup", {}, null);
    expect(await screen.findByRole("radio", { name: /a referral/ })).toBeVisible();
    expect(await screen.findByRole("checkbox", { name: /Name two ways to cope/ })).toBeVisible();
  });

  it.each([
    ["rn", "routine_visit"],
    ["lpn", "routine_visit"],
    ["chha", "chha_visit"],
    ["md", "face_to_face"],
    ["msw", "msw_followup"],
    ["chaplain", "chaplain_visit"],
  ])("never asks a %s %s visit for IDG action items", async (discipline, type) => {
    mount(discipline, type);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.path === IDG_LIST_URL)).toBe(false);
    expect(screen.queryByText("IDG follow-up item")).not.toBeInTheDocument();
  });

  it("asks for no list, and shows no rail, until the draft was read (the tenant switch off answers it 404 too)", async () => {
    const { container } = mount("rn", "idg_followup", {}, null, false);
    await waitFor(() => expect(container.querySelector(".wx-draft-rail")).toBeNull());
    expect(calls).toEqual([]);
  });

  it("keeps the picker mounted when a later read of the draft fails, so it does not vanish under the radio that was pressed", async () => {
    const { setDraftReady } = mount("rn", "idg_followup", {}, null);
    expect(await screen.findByRole("radio", { name: /a referral/ })).toBeVisible();
    setDraftReady(false);
    expect(screen.getByRole("radio", { name: /a referral/ })).toBeVisible();
    expect(reads(IDG_LIST_URL)).toHaveLength(1);
  });
});
