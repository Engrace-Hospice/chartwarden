// The Care Plans tab's review list of plan changes proposed from visit notes (WF09): grouping by visit, the redacted note, the empty
// state, Accept and Dismiss (exact request, then the list is read again), history with who decided, and every refusal in plain words.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingChangeProposals } from "../pending-change-proposals";
import type { ChangeProposal } from "../proposal-types";
import {
  type Call,
  PATIENT,
  PLAN,
  type Reply,
  type Responder,
  VISIT_A,
  VISIT_B,
  mountWith,
  proposalView,
  refusal,
} from "./proposal-test-harness";

afterEach(cleanup);

const LIST = `GET /api/v1/care-plans/${PLAN}/change-proposals`;
const ACCEPT = (id: string): string =>
  `POST /api/v1/care-plans/${PLAN}/change-proposals/${id}/accept`;
const DISMISS = (id: string): string =>
  `POST /api/v1/care-plans/${PLAN}/change-proposals/${id}/dismiss`;

const newProblem = proposalView({
  kind: "problem_add",
  target: null,
  change: {
    description: "Anxiety at night",
    problemKind: "related",
    problemSource: "clinical",
    icd10Code: "F41.9",
  },
});
const goalUnderIt = proposalView({
  kind: "goal_add",
  parentProposalId: newProblem.id,
  target: { type: "problem", id: null, label: null },
  proposedAt: "2026-11-18T15:05:00.000Z",
  change: { originalText: "Sleep through the night", goalSource: "patient_stated" },
});
const discontinue = proposalView({
  kind: "intervention_discontinue",
  sourceEncounterId: VISIT_B,
  proposedAt: "2026-11-20T15:00:00.000Z",
  proposedBy: { membershipId: "m-lpn", displayName: "Lena Practical" },
  target: { type: "intervention", id: "iv-1", label: "Oxygen 2 L by cannula" },
  change: { reason: "Patient no longer uses oxygen" },
});
const pending: ChangeProposal[] = [goalUnderIt, discontinue, newProblem];

function listOf(proposals: ChangeProposal[], redacted = false): Responder {
  return () => ({ body: { patientId: PATIENT, proposals, redacted } });
}

function mount(
  routes: Record<string, Responder>,
  calls: Call[] = [],
  props: { canDecide?: boolean; onDecided?: (o: "accepted" | "dismissed") => void } = {},
): Call[] {
  mountWith({
    routes,
    calls,
    element: (
      <PendingChangeProposals
        planId={PLAN}
        patientId={PATIENT}
        canDecide={props.canDecide ?? true}
        onDecided={props.onDecided}
      />
    ),
  });
  return calls;
}

const writes = (calls: Call[]): string[] =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);

describe("the review list", () => {
  it("reads the pending list and groups proposals by source visit, with kind, target, text and who proposed", async () => {
    const calls = mount({ [LIST]: listOf(pending) });

    // two visits: two sections
    const sections = await screen.findAllByRole("region", { name: /visit recorded/i });
    expect(sections).toHaveLength(2);
    expect(calls.find((c) => c.method === "GET")?.query.get("status")).toBe("pending");

    // the older visit first; inside it a new problem precedes the goal that hangs off it
    const first = within(sections[0] as HTMLElement);
    const rows = first.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("Add problem")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("Anxiety at night")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Add goal")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Sleep through the night")).toBeInTheDocument();
    expect(first.getAllByText("Rita Nurse").length).toBeGreaterThan(0);

    const second = within(sections[1] as HTMLElement);
    expect(second.getByText("Discontinue intervention")).toBeInTheDocument();
    expect(second.getByText("Oxygen 2 L by cannula")).toBeInTheDocument();
    expect(second.getByText("Patient no longer uses oxygen")).toBeInTheDocument();
    expect(second.getAllByText("Lena Practical").length).toBeGreaterThan(0);
  });

  it("links each visit group to its note", async () => {
    mount({ [LIST]: listOf(pending) });
    const links = await screen.findAllByRole("link", { name: "Open the visit note" });
    expect(links.map((l) => l.getAttribute("href")).sort()).toEqual(
      [
        `/patients/${PATIENT}/encounters/${VISIT_A}`,
        `/patients/${PATIENT}/encounters/${VISIT_B}`,
      ].sort(),
    );
  });

  it("says nothing is waiting when the list is empty", async () => {
    mount({ [LIST]: listOf([]) });
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says plainly that restricted proposals were omitted, with rows or without", async () => {
    mount({ [LIST]: listOf([goalUnderIt], true) });
    expect(
      await screen.findByText(
        "Restricted content omitted: some proposed changes are not shown to your role.",
      ),
    ).toBeInTheDocument();
    cleanup();
    mount({ [LIST]: listOf([], true) });
    expect(await screen.findByText(/restricted content omitted/i)).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
  });

  it("shows a read failure with Try again, and the retry reads the list again", async () => {
    let answers = 0;
    const calls = mount({
      [LIST]: () => {
        answers += 1;
        return answers === 1
          ? refusal(500, "INTERNAL", "boom")
          : { body: { patientId: PATIENT, proposals: [goalUnderIt], redacted: false } };
      },
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sleep through the night")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });
});

describe("opening a proposal", () => {
  it("shows its fields as label and value rows in a drawer, with Accept and Dismiss for someone who may decide", async () => {
    mount({ [LIST]: listOf([goalUnderIt, newProblem]) });
    fireEvent.click(await screen.findByText("Sleep through the night"));

    const drawer = await screen.findByRole("complementary", { name: /proposed change: add goal/i });
    expect(within(drawer).getByText("Goal")).toBeInTheDocument();
    expect(within(drawer).getByText("Source")).toBeInTheDocument();
    expect(within(drawer).getByText("Patient's own words")).toBeInTheDocument();
    expect(within(drawer).getByText("Proposed by")).toBeInTheDocument();
    // a goal under a still-waiting new problem says so
    expect(within(drawer).getByText(/accept the problem first/i)).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(within(drawer).getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });

  it("offers no decision to someone without the author permission, and says who can decide", async () => {
    mount({ [LIST]: listOf([goalUnderIt]) }, [], { canDecide: false });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const drawer = await screen.findByRole("complementary");
    expect(within(drawer).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/only a case manager or a supervisor/i)).toBeInTheDocument();
  });
});

describe("Accept", () => {
  it("POSTs the accept with no body, closes the drawer, reads the list again and tells the caller the plan changed", async () => {
    let accepted = false;
    const onDecided = vi.fn();
    const calls = mount(
      {
        [LIST]: () => ({
          body: { patientId: PATIENT, proposals: accepted ? [] : [discontinue], redacted: false },
        }),
        [ACCEPT(discontinue.id)]: () => {
          accepted = true;
          return {
            body: {
              proposalId: discontinue.id,
              status: "accepted",
              resultElementType: "intervention",
              resultElementId: "iv-1",
              decidedAt: "2026-11-21T10:00:00.000Z",
            },
          };
        },
      },
      [],
      { onDecided },
    );
    fireEvent.click(await screen.findByText("Patient no longer uses oxygen"));
    fireEvent.click(
      within(await screen.findByRole("complementary")).getByRole("button", { name: "Accept" }),
    );

    expect(
      await screen.findByText("Change accepted. The plan now includes it."),
    ).toBeInTheDocument();
    expect(writes(calls)).toEqual([ACCEPT(discontinue.id)]);
    expect(calls.find((c) => c.method === "POST")?.body).toBeUndefined();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Nothing to review")).toBeInTheDocument());
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(onDecided).toHaveBeenCalledWith("accepted");
  });

  it.each([
    [
      "VERSION_IN_REVIEW",
      409,
      /a plan version is waiting for signatures, so the plan cannot change right now/i,
    ],
    ["DISCIPLINE_SCOPE_VIOLATION", 403, /outside your discipline/i],
    ["PROPOSAL_TARGET_UNAVAILABLE", 409, /removed or is already finished/i],
    ["PROPOSAL_PARENT_NOT_ACCEPTED", 409, /accept the problem first/i],
    ["CARE_PLAN_CLOSED", 409, /this care plan is closed/i],
    ["PROPOSAL_NOT_PENDING", 409, /someone else already decided this proposed change/i],
  ])(
    "renders %s in plain words and keeps the drawer open for the others",
    async (code, status, words) => {
      const onDecided = vi.fn();
      mount(
        {
          [LIST]: listOf([goalUnderIt]),
          [ACCEPT(goalUnderIt.id)]: () => refusal(status, code, `raw ${code} text`),
        },
        [],
        { onDecided },
      );
      fireEvent.click(await screen.findByText("Sleep through the night"));
      fireEvent.click(
        within(await screen.findByRole("complementary")).getByRole("button", { name: "Accept" }),
      );

      expect(await screen.findByText(words)).toBeInTheDocument();
      expect(screen.queryByText(`raw ${code} text`)).not.toBeInTheDocument();
      expect(onDecided).not.toHaveBeenCalled();
    },
  );

  it("answers a 404 (a draft of someone else, or Part 2 without disclosure) without naming why, and reads the list again", async () => {
    const calls = mount({
      [LIST]: listOf([goalUnderIt]),
      [ACCEPT(goalUnderIt.id)]: () => refusal(404, "NOT_FOUND"),
    });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    fireEvent.click(
      within(await screen.findByRole("complementary")).getByRole("button", { name: "Accept" }),
    );
    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
  });

  it("reads the list again after PROPOSAL_NOT_PENDING and still says what happened once the row is gone", async () => {
    let decided = false;
    const calls = mount({
      [LIST]: () => ({
        body: { patientId: PATIENT, proposals: decided ? [] : [goalUnderIt], redacted: false },
      }),
      [ACCEPT(goalUnderIt.id)]: () => {
        decided = true;
        return refusal(409, "PROPOSAL_NOT_PENDING");
      },
    });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    fireEvent.click(
      within(await screen.findByRole("complementary")).getByRole("button", { name: "Accept" }),
    );
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
    // the drawer is gone with the row, so the message must now be on the page itself
    expect(await screen.findByText(/someone else already decided/i)).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
  });

  it("reports a lost connection without changing the list", async () => {
    mount({
      [LIST]: listOf([goalUnderIt]),
      [ACCEPT(goalUnderIt.id)]: () => {
        throw new TypeError("network down");
      },
    });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    fireEvent.click(
      within(await screen.findByRole("complementary")).getByRole("button", { name: "Accept" }),
    );
    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });
});

describe("Dismiss", () => {
  const dismissed = (reason: string | null): Reply => ({
    body: {
      proposalId: goalUnderIt.id,
      status: "dismissed",
      decidedAt: "2026-11-21T10:00:00.000Z",
      dismissalReason: reason,
    },
  });

  it("sends the coded reason, then reads the list again", async () => {
    const onDecided = vi.fn();
    const calls = mount(
      { [LIST]: listOf([goalUnderIt]), [DISMISS(goalUnderIt.id)]: () => dismissed("duplicate") },
      [],
      { onDecided },
    );
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const drawer = await screen.findByRole("complementary");
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    fireEvent.change(within(drawer).getByLabelText("Reason for dismissing"), {
      target: { value: "duplicate" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss proposal" }));

    expect(await screen.findByText(/proposed change dismissed/i)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(
      `/api/v1/care-plans/${PLAN}/change-proposals/${goalUnderIt.id}/dismiss`,
    );
    expect(post?.body).toEqual({ reason: "duplicate" });
    expect(onDecided).toHaveBeenCalledWith("dismissed");
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
  });

  it("sends an empty body when no reason is chosen, and Back returns to Accept and Dismiss", async () => {
    const calls = mount({
      [LIST]: listOf([goalUnderIt]),
      [DISMISS(goalUnderIt.id)]: () => dismissed(null),
    });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const drawer = await screen.findByRole("complementary");
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Back" }));
    expect(within(drawer).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss proposal" }));
    await screen.findByText(/proposed change dismissed/i);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({});
  });

  it("renders a refusal to dismiss in plain words", async () => {
    mount({
      [LIST]: listOf([goalUnderIt]),
      [DISMISS(goalUnderIt.id)]: () => refusal(403, "DISCIPLINE_SCOPE_VIOLATION"),
    });
    fireEvent.click(await screen.findByText("Sleep through the night"));
    const drawer = await screen.findByRole("complementary");
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss proposal" }));
    expect(await screen.findByText(/outside your discipline/i)).toBeInTheDocument();
  });
});

describe("history", () => {
  it("reads the accepted list and shows who decided, with no decision controls", async () => {
    const accepted = proposalView({
      kind: "goal_update",
      status: "accepted",
      target: { type: "goal", id: "g-1", label: "Walk to the porch" },
      change: { revisedText: "Walk to the mailbox", goalStatus: "revised" },
      decidedBy: { membershipId: "m-cm", displayName: "Carla Manager" },
      decidedAt: "2026-11-19T12:00:00.000Z",
    });
    const calls = mount({
      [LIST]: (call) => ({
        body: {
          patientId: PATIENT,
          proposals: call.query.get("status") === "accepted" ? [accepted] : [],
          redacted: false,
        },
      }),
    });
    await screen.findByText("Nothing to review");
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "accepted" } });

    expect(await screen.findByText("Walk to the mailbox")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET").map((c) => c.query.get("status"))).toEqual([
      "pending",
      "accepted",
    ]);
    expect(screen.getByText("Carla Manager")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Accepted")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Walk to the mailbox"));
    const drawer = await screen.findByRole("complementary");
    expect(within(drawer).getByText("Decided by")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("shows the dismissal reason in words", async () => {
    const dismissedRow = proposalView({
      status: "dismissed",
      change: { originalText: "Eat three meals a day" },
      decidedBy: { membershipId: "m-cm", displayName: "Carla Manager" },
      decidedAt: "2026-11-19T12:00:00.000Z",
      dismissalReason: "already_addressed",
    });
    mount({
      [LIST]: (call) => ({
        body: {
          patientId: PATIENT,
          proposals: call.query.get("status") === "dismissed" ? [dismissedRow] : [],
          redacted: false,
        },
      }),
    });
    await screen.findByText("Nothing to review");
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "dismissed" } });
    expect(await screen.findByText(/already addressed/i)).toBeInTheDocument();
  });
});
