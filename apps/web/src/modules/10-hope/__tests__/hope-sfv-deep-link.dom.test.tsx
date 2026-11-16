// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import {
  clearAllStepUpDrafts,
  markStepUpReturn,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import { useSfvDeepLink } from "../hope-sfv-deep-link";
import type { SfvLookup } from "../hope-sfv-lookup";
import { SESSION } from "./workspace-test-kit";

// Two ways back to an SFV the clinician was about to complete: the queue's Complete link (?completeSfv=1) and a return
// from /step-up with an answered-but-unsent form. Either opens the dialog once the screen can say it is offerable.

const DRAFT_KEY = stepUpDraftKey(SESSION, "hope.sfv.record", "hope-1") as string;
const IDLE: SfvLookup = { state: "idle" };
const LOADING: SfvLookup = { state: "loading" };
const FAILED: SfvLookup = { state: "failed" };
const NONE: SfvLookup = { state: "none" };
const found = (status: "open" | "overdue" | "completed" | "missed" | "withdrawn"): SfvLookup => ({
  state: "found",
  status,
  completingAssessmentId: null,
});

interface Inputs {
  readonly routeId?: string;
  readonly status?: string;
  readonly assessmentId?: string | null;
  readonly workspaceLoaded?: boolean;
  /** A draft whose follow-up is required and not yet recorded. */
  readonly draftOffer?: boolean;
  readonly lookupWanted?: boolean;
  readonly lookup?: SfvLookup;
}

function Probe(props: Inputs & { show: () => void }): JSX.Element {
  const { pathname, search } = useLocation();
  const navigationType = useNavigationType();
  const assessmentId = props.assessmentId === undefined ? "hope-1" : props.assessmentId;
  useSfvDeepLink({
    routeId: props.routeId ?? "hope-1",
    assessment:
      assessmentId === null ? null : { id: assessmentId, status: props.status ?? "draft" },
    workspaceLoaded: props.workspaceLoaded ?? true,
    draftOffer: props.draftOffer ?? true,
    lookupWanted: props.lookupWanted ?? false,
    lookup: props.lookup ?? IDLE,
    show: props.show,
  });
  return (
    <>
      <span data-testid="where">{`${pathname}${search}`}</span>
      <span data-testid="how">{navigationType}</span>
    </>
  );
}

function renderProbe(path: string, inputs: Inputs = {}) {
  const show = vi.fn();
  const view = (next: Inputs) => (
    <SessionProvider session={SESSION}>
      <MemoryRouter initialEntries={[path]}>
        <Probe {...next} show={show} />
      </MemoryRouter>
    </SessionProvider>
  );
  const { rerender } = render(view(inputs));
  return { show, update: (next: Inputs) => rerender(view(next)) };
}

const LINK = "/hope/assessments/hope-1?completeSfv=1";
const where = () => screen.getByTestId("where").textContent;

afterEach(() => {
  clearAllStepUpDrafts();
});

describe("useSfvDeepLink: the Complete link", () => {
  it("opens the dialog for a draft whose follow-up is required, then drops the parameter by replacing the entry", async () => {
    const { show } = renderProbe(LINK);
    await waitFor(() => expect(where()).toBe("/hope/assessments/hope-1"));
    expect(show).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("how").textContent).toBe("REPLACE");
  });

  it("opens nothing for a draft with no follow-up to complete, and still drops the parameter", async () => {
    const { show } = renderProbe(LINK, { draftOffer: false });
    await waitFor(() => expect(where()).toBe("/hope/assessments/hope-1"));
    expect(show).not.toHaveBeenCalled();
  });

  it("does nothing without the parameter", async () => {
    const { show } = renderProbe("/hope/assessments/hope-1");
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it.each(["signed", "superseded"])(
    "waits for the lookup on a %s record, then opens when the follow-up is open",
    async (status) => {
      const { show, update } = renderProbe(LINK, { status, lookupWanted: true, lookup: LOADING });
      await Promise.resolve();
      expect(show).not.toHaveBeenCalled();
      expect(where()).toBe(LINK);

      update({ status, lookupWanted: true, lookup: found("overdue") });
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      expect(where()).toBe("/hope/assessments/hope-1");
    },
  );

  it.each([
    ["completed", found("completed")],
    ["withdrawn", found("withdrawn")],
    ["missed", found("missed")],
    ["no row", NONE],
  ])(
    "does not offer a superseded record's dialog when the lookup says %s, even though it is not a draft",
    async (_name, lookup) => {
      const { show } = renderProbe(LINK, {
        status: "superseded",
        lookupWanted: true,
        lookup,
        draftOffer: true,
      });
      await waitFor(() => expect(where()).toBe("/hope/assessments/hope-1"));
      expect(show).not.toHaveBeenCalled();
    },
  );

  it("keeps the parameter through a failed lookup, and opens the dialog when Retry then finds the visit open", async () => {
    const { show, update } = renderProbe(LINK, {
      status: "signed",
      lookupWanted: true,
      lookup: FAILED,
    });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(where()).toBe(LINK);

    update({ status: "signed", lookupWanted: true, lookup: LOADING });
    update({ status: "signed", lookupWanted: true, lookup: found("open") });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(where()).toBe("/hope/assessments/hope-1");
  });

  it("keeps the parameter until the workspace has loaded, so a failed load that is retried still opens it", async () => {
    const { show, update } = renderProbe(LINK, { workspaceLoaded: false });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(where()).toBe(LINK);
    update({ workspaceLoaded: true });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });

  it("does not act on the previous record's data while the route is already on another record", async () => {
    const { show, update } = renderProbe("/hope/assessments/hope-2?completeSfv=1", {
      routeId: "hope-2",
      assessmentId: "hope-1",
    });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(where()).toBe("/hope/assessments/hope-2?completeSfv=1");
    update({ routeId: "hope-2", assessmentId: "hope-2" });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });
});

describe("useSfvDeepLink: a return from step-up", () => {
  it("reopens the dialog when the clinician comes back with an unsent form", async () => {
    stashStepUpDraft(DRAFT_KEY, { date: "2026-09-01", discipline: "RN", answers: { J2053A: "1" } });
    markStepUpReturn("/hope/assessments/hope-1");
    const { show } = renderProbe("/hope/assessments/hope-1");
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });

  it("opens nothing when there is no stashed form, and nothing on an ordinary visit", async () => {
    markStepUpReturn("/hope/assessments/hope-1");
    const returned = renderProbe("/hope/assessments/hope-1");
    await Promise.resolve();
    expect(returned.show).not.toHaveBeenCalled();
  });

  it("opens one dialog, not two, when the visit is both a return and the Complete link", async () => {
    stashStepUpDraft(DRAFT_KEY, { date: "2026-09-01", discipline: "RN", answers: { J2053A: "1" } });
    markStepUpReturn(LINK);
    const { show } = renderProbe(LINK);
    await waitFor(() => expect(where()).toBe("/hope/assessments/hope-1"));
    expect(show).toHaveBeenCalledTimes(1);
  });
});
