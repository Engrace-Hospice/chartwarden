import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candidate, Workspace } from "../doclens-api";
import { UNREACHABLE_DECISION_MESSAGE } from "./review-decision-flow";
import {
  CANDIDATE_ID,
  SECOND_CANDIDATE_ID,
  candidateFixture,
  createPanelServer,
  mountSourcePanel,
  savedDecision,
  workspaceFixture,
} from "./review-panel-test-kit";
import type { PanelServer, SourcePanelProps } from "./review-panel-test-kit";
import { NO_VALUE_ACCEPTED_MESSAGE } from "./use-decision-save";

let server: PanelServer;

function mount(workspace: Workspace = workspaceFixture(), props: SourcePanelProps = {}) {
  server = createPanelServer(workspace);
  return mountSourcePanel(server, props);
}

const confirmation = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: /I compared this with the source/ });
const accept = (): HTMLElement => screen.getByRole("button", { name: "Accept extracted value" });
const status = (): HTMLElement => document.querySelector(".wx-unified-status") as HTMLElement;

function readyToDecide(): void {
  fireEvent.load(screen.getByRole("img", { name: /Page 1 of the source document/ }));
  fireEvent.click(confirmation());
}

const VISION_DISAGREED = {
  vision: { status: "disagreed", observedValue: "Salem OR" },
} satisfies Partial<Candidate>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewSourcePanel when a save does not reach the server", () => {
  it("unlocks the panel and says so when the decision request is rejected", async () => {
    const view = mount();
    server.answers.decision = "network";
    readyToDecide();
    accept().focus();

    fireEvent.click(accept());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNREACHABLE_DECISION_MESSAGE);
    expect(accept()).not.toBeDisabled();
    expect(document.activeElement).toBe(accept());
    expect(view.onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(view.onDecisionSaved).not.toHaveBeenCalled();
  });

  it("lets the reviewer retry after a rejected request", async () => {
    mount();
    server.answers.decision = "network";
    readyToDecide();
    fireEvent.click(accept());
    await screen.findByRole("alert");

    server.answers.decision = "ok";
    fireEvent.click(accept());

    expect(await screen.findByText(/Decision saved: accepted Salem/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server's refusal and unlocks the panel", async () => {
    const view = mount();
    server.answers.decision = { status: 409, message: "Decision refused" };
    readyToDecide();

    fireEvent.click(accept());

    expect(await screen.findByRole("alert")).toHaveTextContent("Decision refused");
    expect(accept()).not.toBeDisabled();
    expect(view.onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["resolves to nothing", "null"],
    ["is rejected", "throw"],
  ] as const)("warns, not congratulates, when the workspace refresh %s", async (_label, answer) => {
    const view = mount();
    server.answers.refresh = answer;
    readyToDecide();

    fireEvent.click(accept());

    expect(
      await screen.findByText(/Decision saved, but the workspace could not be refreshed/),
    ).toBeTruthy();
    expect(status().textContent).toMatch(/could not be refreshed/);
    expect(document.querySelector(".wx-unified-decision-success")).toBeNull();
    expect(view.onDecisionSaved).not.toHaveBeenCalled();
    expect(accept()).toBeDisabled();

    server.answers.refresh = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry workspace refresh" }));

    expect(await screen.findByText("Decision saved and workspace refreshed.")).toBeTruthy();
    expect(view.onDecisionSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry workspace refresh" })).toBeNull();
  });

  it("reports busy to the workspace for the retry of a refresh as well", async () => {
    const view = mount();
    server.answers.refresh = "null";
    readyToDecide();
    fireEvent.click(accept());
    await screen.findByRole("button", { name: "Retry workspace refresh" });
    view.onBusyChange.mockClear();

    server.answers.refresh = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry workspace refresh" }));
    await screen.findByText("Decision saved and workspace refreshed.");

    expect(view.onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("announces a saved decision in the always-mounted status region", async () => {
    mount();
    const region = status();
    expect(region.textContent).toBe("");
    readyToDecide();

    fireEvent.click(accept());

    expect(await screen.findByText(/Decision saved: accepted Salem/)).toBeTruthy();
    expect(status()).toBe(region);
    expect(region.textContent).toMatch(/Decision saved: accepted Salem/);
  });
});

describe("ReviewSourcePanel focus", () => {
  it("moves focus to the next issue after a decision is saved when there is one", async () => {
    mount(workspaceFixture(), {
      nextCandidate: candidateFixture(SECOND_CANDIDATE_ID, { fieldPath: "patient.address.state" }),
    });
    readyToDecide();
    accept().focus();

    fireEvent.click(accept());

    const next = await screen.findByRole("button", { name: /Next issue: State/ });
    await waitFor(() => expect(document.activeElement).toBe(next));
  });

  it("moves focus to the status message after a decision is saved when no issue is next", async () => {
    mount();
    readyToDecide();
    accept().focus();

    fireEvent.click(accept());

    await screen.findByText(/Decision saved: accepted Salem/);
    await waitFor(() => expect(document.activeElement).toBe(status()));
  });

  it("puts focus in the corrected value field when Edit is chosen and back on Edit when it is cancelled", () => {
    mount();
    readyToDecide();

    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Corrected value"));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit value" }));
  });

  it("puts focus in the reason field when Reject is chosen and back on Reject when it is cancelled", () => {
    mount();
    readyToDecide();

    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));
    expect(document.activeElement).toBe(screen.getByLabelText(/Rejection reason/));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reject extracted value" }),
    );
  });
});

describe("ReviewSourcePanel typed reasons", () => {
  it("does not carry an accept reason into the Reject form", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, VISION_DISAGREED)]));
    readyToDecide();
    fireEvent.change(screen.getByLabelText("Reason for accepting despite the page reading"), {
      target: { value: "The page is smudged" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Reject extracted value" }));

    expect(screen.getByLabelText(/Rejection reason/)).toHaveValue("");
  });

  it("clears the accept reason once the decision is saved, so changing it needs a new one", async () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, VISION_DISAGREED)]));
    readyToDecide();
    fireEvent.change(screen.getByLabelText("Reason for accepting despite the page reading"), {
      target: { value: "The page is smudged" },
    });
    fireEvent.click(accept());
    await screen.findByText(/Decision saved: accepted Salem/);
    expect(server.requests.decisions[0]).toMatchObject({ reason: "The page is smudged" });

    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));
    fireEvent.click(confirmation());

    expect(screen.getByLabelText("Reason for accepting despite the page reading")).toHaveValue("");
    expect(accept()).toBeDisabled();
  });

  it("offers no reason field for a decided disagreement until Change decision is chosen", () => {
    mount(
      workspaceFixture([
        candidateFixture(CANDIDATE_ID, { ...VISION_DISAGREED, decision: savedDecision("approve") }),
      ]),
    );

    expect(screen.queryByLabelText("Reason for accepting despite the page reading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));

    expect(screen.getByLabelText("Reason for accepting despite the page reading")).toBeTruthy();
  });

  it("describes the vision reading as the field's description, not its name", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, VISION_DISAGREED)]));

    const field = screen.getByLabelText("Reason for accepting despite the page reading");

    expect(field).toHaveAccessibleDescription(/The vision check read “Salem OR”/);
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
  });
});

describe("ReviewSourcePanel unlock hints", () => {
  it("says what unlocks the decision buttons, step by step", () => {
    mount();
    const sourceHint = /unlock once the source page has loaded/;
    expect(screen.getByText(sourceHint)).toBeTruthy();
    expect(accept()).toHaveAccessibleDescription(sourceHint);
    expect(confirmation()).toHaveAccessibleDescription(sourceHint);

    fireEvent.load(screen.getByRole("img", { name: /Page 1 of the source document/ }));
    expect(accept()).toHaveAccessibleDescription(/Select “I compared this with the source”/);

    fireEvent.click(confirmation());
    expect(screen.queryByText(/to unlock the decision buttons/)).toBeNull();
    expect(accept()).not.toHaveAccessibleDescription();
  });

  it("says why the buttons are locked once a decision is recorded", () => {
    mount(
      workspaceFixture([candidateFixture(CANDIDATE_ID, { decision: savedDecision("approve") })]),
    );

    expect(accept()).toHaveAccessibleDescription(/A decision is recorded for this observation/);
  });
});

describe("ReviewSourcePanel with no extracted value", () => {
  it("keeps Accept available, says what it does, and does not claim a value was accepted", async () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, { value: "   " })]));
    readyToDecide();

    expect(accept()).not.toBeDisabled();
    expect(accept()).toHaveAccessibleDescription(/No value was extracted/);

    fireEvent.click(accept());

    expect(await screen.findByText(NO_VALUE_ACCEPTED_MESSAGE)).toBeTruthy();
    expect(server.requests.decisions[0]).toMatchObject({ decision: "approve" });
  });
});
