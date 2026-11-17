// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Link } from "react-router-dom";
import { type Mock, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllStepUpDrafts,
  markStepUpReturn,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import {
  COMPLETED_NOTE,
  COULD_NOT_CHECK,
  SESSION,
  SIGNED,
  assessment,
  clientFor,
  completeInDialog,
  locationLog,
  ok,
  renderWorkspace,
  review,
  row,
  sfvLookups,
  sfvWorkspace,
  stubProperty,
  useStubbedLocalStorage,
} from "./workspace-test-kit";

// The follow-up card lives in section J. A real admission record opens on section A, in guided mode where only the
// current group renders, so the card is not on screen until the screen moves there: everything that opens, completes
// or reports a visit has to bring section J (and the card's group) with it.

const LINK_PATH = "/hope/assessments/hope-1?completeSfv=1";
const RETURN_PATH = "/hope/assessments/hope-1";
const DRAFT_KEY = stepUpDraftKey(SESSION, "hope.sfv.record", "hope-1") as string;
const RECORDED = "The follow-up visit was recorded.";

const card = () => document.getElementById("hope-item-J2052A");
const cardStatus = () => within(card() as HTMLElement).getByRole("status");
type Mocked = ReturnType<typeof vi.fn>;
const asMock = (fn: unknown) => fn as Mocked;

/** A draft opened on section A, which turns recorded (J2052A = 1) once the SFV POST has succeeded. */
function draftOnSectionA() {
  const client = clientFor({ workspace: sfvWorkspace({ withAdministrative: true }) });
  const get = asMock(client.GET);
  const initial = get.getMockImplementation() as (path: string, init?: unknown) => Promise<unknown>;
  let recorded = false;
  get.mockImplementation(async (path: string, init?: unknown) =>
    recorded && path.endsWith("/workspace")
      ? ok(sfvWorkspace({ withAdministrative: true, recorded: true }))
      : initial(path, init),
  );
  asMock(client.POST).mockImplementation(async () => {
    recorded = true;
    return ok({ id: "rfa-04-1" });
  });
  return client;
}

/** What the clinician must see once the visit is recorded, wherever they started from. */
async function expectRecordedOnTheCard(): Promise<void> {
  expect(await screen.findByRole("button", { name: "View SFV details" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "J. Health Conditions" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(card()));
  expect(cardStatus().textContent).toBe(RECORDED);
}

describe("the follow-up card in a record that opens on section A", () => {
  useStubbedLocalStorage();
  afterEach(() => {
    clearAllStepUpDrafts();
  });

  it("the Complete link opens the dialog over section J, and the result is shown, focused and confirmed there", async () => {
    renderWorkspace(draftOnSectionA(), SESSION, LINK_PATH);
    const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
    // The card the dialog reports to is already on screen behind it.
    expect(card()).not.toBeNull();
    completeInDialog(dialog);
    await expectRecordedOnTheCard();
  });

  it("a return from step-up reopens the dialog over section J, and the result is shown, focused and confirmed there", async () => {
    stashStepUpDraft(DRAFT_KEY, {
      date: "2026-09-01",
      discipline: "RN",
      answers: { J2053A: "1", J2053B: "0" },
    });
    markStepUpReturn(RETURN_PATH);
    renderWorkspace(draftOnSectionA(), SESSION);
    const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
    expect(card()).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Complete SFV" }));
    await expectRecordedOnTheCard();
  });

  describe("under React.StrictMode, which runs every effect twice on mount", () => {
    it("the Complete link opens one dialog and drops the parameter in one navigation", async () => {
      renderWorkspace(draftOnSectionA(), SESSION, LINK_PATH, undefined, { strict: true });
      await screen.findByRole("dialog", { name: "Complete SFV" });
      await waitFor(() =>
        expect(screen.getByTestId("current-location").textContent).toBe(RETURN_PATH),
      );
      // Every dialog in the DOM, whatever its name: a second one, of any kind, is the failure.
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(locationLog).toEqual([LINK_PATH, RETURN_PATH]);
    });

    it("a return from step-up reopens one dialog with the stashed form, and the form can still be sent", async () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1", J2053B: "0" },
      });
      markStepUpReturn(RETURN_PATH);
      const client = draftOnSectionA();
      renderWorkspace(client, SESSION, RETURN_PATH, undefined, { strict: true });
      const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
      // Every dialog in the DOM, whatever its name: a second one, of any kind, is the failure.
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Complete SFV" }));
      await expectRecordedOnTheCard();
      expect(client.POST).toHaveBeenCalledTimes(1);
      expect(locationLog).toEqual([RETURN_PATH]);
    });
  });

  it("completing from section J, reached by hand, shows the result there too", async () => {
    renderWorkspace(draftOnSectionA(), SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /J Health Conditions/ }));
    fireEvent.click(screen.getByRole("button", { name: "Complete SFV" }));
    completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));
    await expectRecordedOnTheCard();
  });

  it("does not take focus back when the card is shown again later (a section switch, or a remount)", async () => {
    renderWorkspace(draftOnSectionA(), SESSION, LINK_PATH);
    completeInDialog(await screen.findByRole("dialog", { name: "Complete SFV" }));
    await expectRecordedOnTheCard();

    const toA = screen.getByRole("button", { name: /A Administrative/ });
    act(() => toA.focus());
    fireEvent.click(toA);
    const toJ = screen.getByRole("button", { name: /J Health Conditions/ });
    act(() => toJ.focus());
    fireEvent.click(toJ);
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(toJ);
  });
});

describe("when the dialog is closed without recording anything", () => {
  useStubbedLocalStorage();

  it("gives focus back to the follow-up card when the deep-linked dialog is cancelled (there is no trigger to return to)", async () => {
    renderWorkspace(draftOnSectionA(), SESSION, LINK_PATH);
    const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card()));
  });

  it("leaves focus on the button that opened the dialog when there is one", async () => {
    renderWorkspace(draftOnSectionA(), SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /J Health Conditions/ }));
    const opener = screen.getByRole("button", { name: "Complete SFV" });
    act(() => opener.focus());
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("opening the dialog in show-all mode", () => {
  useStubbedLocalStorage();
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
  });

  /** Gives the card and the workspace pane the geometry jsdom does not compute (everything else measures zero). */
  function layout(card: { top: number; bottom: number }, pane: { height: number }): Mock {
    const scrollTo = vi.fn();
    restores.push(stubProperty(Element.prototype, "scrollTo", scrollTo));
    const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this.id === "hope-item-J2052A")
        return { ...zero, ...card, height: card.bottom - card.top } as DOMRect;
      if (this.classList.contains("wx-patient-workspace-body"))
        return { ...zero, bottom: pane.height, height: pane.height } as DOMRect;
      return zero as DOMRect;
    });
    return scrollTo;
  }

  async function openInShowAll(): Promise<void> {
    localStorage.setItem("wx.hope.navMode", "all");
    renderWorkspace(draftOnSectionA(), SESSION, LINK_PATH);
    await screen.findByRole("dialog", { name: "Complete SFV" });
    // The mode in force is show-all: were the storage key to drift, this would run in guided mode and say nothing.
    expect((screen.getByRole("switch", { name: /Show all/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  }

  it("brings the follow-up card out from under the sticky jump bar, through the workspace pane's own scroll", async () => {
    const scrollTo = layout({ top: 20, bottom: 120 }, { height: 600 });
    await openInShowAll();
    // 20px below the pane's top edge, 52px short of clearing the 72px jump bar.
    expect(scrollTo).toHaveBeenCalledWith({ top: -52, behavior: "smooth" });
    const pane = scrollTo.mock.contexts[0] as HTMLElement;
    expect(pane.classList.contains("wx-patient-workspace-body")).toBe(true);
  });

  it("leaves a card that is already fully in view where it is", async () => {
    const scrollTo = layout({ top: 300, bottom: 400 }, { height: 600 });
    await openInShowAll();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("the follow-up card's announcements and name", () => {
  useStubbedLocalStorage();

  it("has an accessible name, so focusing it says where focus is", async () => {
    renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION);
    const region = await screen.findByRole("region", { name: "Symptom Follow-Up Visit" });
    expect(region).toBe(card());
  });

  it("announces a result through one live region that was already mounted, empty, before it changed", async () => {
    const rows = [row("open")];
    const client = clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: rows });
    asMock(client.POST).mockImplementation(async () => {
      rows[0] = row("completed");
      return ok({ id: "rfa-04-1" });
    });
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    const before = cardStatus();
    expect(before.textContent).toBe("");

    completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));
    await waitFor(() => expect(cardStatus().textContent).toBe(COMPLETED_NOTE));
    expect(cardStatus()).toBe(before);
  });

  it("says a failed lookup in the same live region", async () => {
    renderWorkspace(
      clientFor({
        workspace: sfvWorkspace(),
        assessment: SIGNED,
        sfvs: [row("open")],
        sfvLookupFailures: Number.POSITIVE_INFINITY,
      }),
      SESSION,
    );
    await waitFor(() => expect(cardStatus().textContent).toBe(COULD_NOT_CHECK));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("waits to move focus until the follow-up's new status has been read, so the card never takes it still saying Required", async () => {
    const rows = [row("open")];
    const client = clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: rows });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterCompletion = false;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (path === "/api/v1/hope/sfv" && afterCompletion) await gate;
      return initial(path, init);
    });
    asMock(client.POST).mockImplementation(async () => {
      afterCompletion = true;
      rows[0] = row("completed");
      return ok({ id: "rfa-04-1" });
    });
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));

    await waitFor(() => expect(sfvLookups(client)).toHaveLength(2));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(document.activeElement).not.toBe(card());

    release();
    await waitFor(() => expect(document.activeElement).toBe(card()));
    expect(cardStatus().textContent).toBe(COMPLETED_NOTE);
  });
});

describe("a record that has been superseded", () => {
  useStubbedLocalStorage();
  const SUPERSEDED = { ...assessment, status: "superseded" };

  it("asks the SFV queue about it, like a signed one, instead of offering Complete SFV from its own answers", async () => {
    const client = clientFor({
      workspace: sfvWorkspace(),
      assessment: SUPERSEDED,
      sfvs: [row("completed")],
    });
    renderWorkspace(client, SESSION);
    expect(await screen.findByText(COMPLETED_NOTE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Complete SFV" })).toBeNull();
    expect(sfvLookups(client)).toHaveLength(1);
  });

  it.each([["completed"], ["withdrawn"]])(
    "does not open the dialog from the Complete link when the follow-up is %s",
    async (status) => {
      renderWorkspace(
        clientFor({ workspace: sfvWorkspace(), assessment: SUPERSEDED, sfvs: [row(status)] }),
        SESSION,
        LINK_PATH,
      );
      await waitFor(() =>
        expect(screen.getByTestId("current-location").textContent).toBe(RETURN_PATH),
      );
      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
    },
  );

  it("opens the dialog from the Complete link when the queue says the follow-up is open", async () => {
    renderWorkspace(
      clientFor({ workspace: sfvWorkspace(), assessment: SUPERSEDED, sfvs: [row("open")] }),
      SESSION,
      LINK_PATH,
    );
    expect(await screen.findByRole("dialog", { name: "Complete SFV" })).toBeTruthy();
  });
});

describe("the deep link through a failed lookup or a failed load", () => {
  useStubbedLocalStorage();

  it("opens the dialog once Retry finds the follow-up open, and only then drops the parameter", async () => {
    const client = clientFor({
      workspace: sfvWorkspace(),
      assessment: SIGNED,
      sfvs: [row("open")],
      sfvLookupFailures: 1,
    });
    renderWorkspace(client, SESSION, LINK_PATH);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("dialog", { name: "Complete SFV" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("current-location").textContent).toBe(RETURN_PATH),
    );
  });

  it("keeps the parameter through a failed load, and opens the dialog when Try again loads the record", async () => {
    const client = clientFor({ workspace: sfvWorkspace() });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let failures = 1;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (path === "/api/v1/hope/assessments/{id}" && failures-- > 0)
        throw new TypeError("offline");
      return initial(path, init);
    });
    renderWorkspace(client, SESSION, LINK_PATH);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("dialog", { name: "Complete SFV" })).toBeTruthy();
  });
});

describe("loading and signing when the network fails", () => {
  useStubbedLocalStorage();

  it("shows an error with Try again, not an endless spinner, when the record cannot be loaded", async () => {
    const client = clientFor({});
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    get.mockImplementationOnce(async () => {
      throw new TypeError("offline");
    });
    get.mockImplementation(initial);
    renderWorkspace(client, SESSION);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this HOPE assessment.");
    expect(screen.queryByText("Loading HOPE workspace...")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Admission Workspace" })).toBeTruthy();
  });

  it("keeps the keyboard user's place through Try again: the loading state takes focus, and so does the error if it fails again", async () => {
    const client = clientFor({});
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (path !== "/api/v1/hope/assessments/{id}") return initial(path, init);
      reads += 1;
      if (reads === 2) await held; // the first retry hangs for a moment, then fails again
      if (reads <= 2) throw new TypeError("offline");
      return initial(path, init);
    });
    renderWorkspace(client, SESSION);

    const tryAgain = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    const loading = await screen.findByRole("region", { name: "Loading HOPE workspace..." });
    expect(document.activeElement).toBe(loading);

    await act(async () => release());
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert.parentElement);

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Admission Workspace" })).toBeTruthy();
  });

  it("says the record was signed, and keeps the page, when the re-read after signing fails", async () => {
    const readyReview = review({
      validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
      readiness: { readyToSign: true, blockers: [] },
    });
    const client = clientFor({ review: readyReview });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let signed = false;
    get.mockImplementation(async (path: string, init?: unknown) => {
      if (signed && path === "/api/v1/hope/assessments/{id}") throw new TypeError("offline");
      return initial(path, init);
    });
    asMock(client.POST).mockImplementation(async () => {
      signed = true;
      return ok({ assessmentId: "hope-1", status: "signed" });
    });
    renderWorkspace(client, SESSION);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const notice = await screen.findByText(
      "The record was signed, but this page could not refresh. Reload to see it.",
    );
    expect(notice.getAttribute("role")).toBe("alert");
    expect(screen.queryByText("Loading HOPE workspace...")).toBeNull();
    expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy();
  });
});

describe("moving from one record to another", () => {
  useStubbedLocalStorage();
  afterEach(() => {
    clearAllStepUpDrafts();
  });

  /** Serves each record its own assessment and workspace; record A's re-read after recording fails. */
  function twoRecords() {
    const client = clientFor({ workspace: sfvWorkspace({ withAdministrative: true }) });
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    let recorded = false;
    get.mockImplementation(async (path: string, init?: { params?: { path?: { id?: string } } }) => {
      const id = init?.params?.path?.id;
      if (path === "/api/v1/hope/assessments/{id}") return ok({ ...assessment, id });
      if (path.endsWith("/workspace") && id === "hope-1" && recorded)
        throw new TypeError("offline");
      return initial(path, init);
    });
    asMock(client.POST).mockImplementation(async () => {
      recorded = true;
      return ok({ id: "rfa-04-1" });
    });
    return client;
  }
  const GO_TO_B = <Link to="/hope/assessments/hope-2?completeSfv=1">Go to record B</Link>;

  it.each([
    ["", false],
    [", under React.StrictMode", true],
  ])(
    "carries nothing over%s: no stale notice, and the Complete link aimed at the new record is honoured once",
    async (_label, strict) => {
      const client = twoRecords();
      renderWorkspace(client, SESSION, RETURN_PATH, GO_TO_B, { strict });
      fireEvent.click(await screen.findByRole("button", { name: /J Health Conditions/ }));
      fireEvent.click(screen.getByRole("button", { name: "Complete SFV" }));
      completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));
      expect(
        await screen.findByText(
          "The follow-up visit was recorded, but this page could not refresh. Reload to see it.",
        ),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("link", { name: "Go to record B" }));

      const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
      expect(screen.queryByText(/could not refresh/)).toBeNull();
      // Every dialog in the DOM, whatever its name: a second one, of any kind, is the failure.
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      completeInDialog(dialog);
      await waitFor(() =>
        expect(client.POST).toHaveBeenLastCalledWith(
          "/api/v1/admissions/{admissionId}/hope/sfv",
          expect.objectContaining({
            body: expect.objectContaining({ triggeringAssessmentId: "hope-2" }),
          }),
        ),
      );
      expect(client.POST).toHaveBeenCalledTimes(2);
      // The Complete link was consumed by exactly one navigation.
      expect(locationLog).toEqual([
        RETURN_PATH,
        "/hope/assessments/hope-2?completeSfv=1",
        "/hope/assessments/hope-2",
      ]);
    },
  );
});

describe("an out-of-date attestation wording is one fact about the page", () => {
  useStubbedLocalStorage();
  const STALE = {
    error: {
      code: "M10_ATTESTATION_STALE",
      message: "Attestation version 2020-01-01.1 is not current.",
    },
  };
  const WORDING = "The attestation wording has changed. Reload the page and review it again.";
  const readyReview = review({
    validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
    readiness: { readyToSign: true, blockers: [] },
  });

  it("still refuses a reopened SFV dialog after it was refused, with Complete SFV disabled", async () => {
    renderWorkspace(clientFor({ workspace: sfvWorkspace(), postError: STALE }), SESSION);
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));
    const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain(WORDING);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));

    const reopened = screen.getByRole("dialog", { name: "Complete SFV" });
    expect(within(reopened).getByRole("alert").textContent).toContain(WORDING);
    expect(
      (within(reopened).getByRole("button", { name: "Complete SFV" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("refuses the Sign dialog too once the SFV dialog was refused for it", async () => {
    renderWorkspace(
      clientFor({ workspace: sfvWorkspace(), review: readyReview, postError: STALE }),
      SESSION,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));
    await within(screen.getByRole("dialog", { name: "Complete SFV" })).findByRole("alert");
    const sfvDialog = screen.getByRole("dialog", { name: "Complete SFV" });
    fireEvent.click(within(sfvDialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(sfvDialog).getByRole("button", { name: "Discard" }));

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const signDialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    expect(within(signDialog).getByRole("alert").textContent).toBe(WORDING);
    fireEvent.click(within(signDialog).getByRole("checkbox", { name: /I attest/ }));
    expect(
      (within(signDialog).getByRole("button", { name: "Sign & complete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("refuses the SFV dialog too once the Sign dialog was refused for it", async () => {
    renderWorkspace(
      clientFor({ workspace: sfvWorkspace(), review: readyReview, postError: STALE }),
      SESSION,
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Sign & complete" }))[0] as HTMLElement,
    );
    const signDialog = await screen.findByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(signDialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(signDialog).getByRole("button", { name: "Sign & complete" }));
    await within(signDialog).findByRole("alert");
    fireEvent.click(within(signDialog).getByRole("button", { name: "Cancel" }));

    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
    expect(within(dialog).getByRole("alert").textContent).toContain(WORDING);
  });
});
