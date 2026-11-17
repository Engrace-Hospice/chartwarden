import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, type vi } from "vitest";
import {
  clearAllStepUpDrafts,
  markStepUpReturn,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
  stepUpDraftKeys,
} from "../../../shell/step-up-redirect";
import {
  COMPLETED_NOTE,
  COULD_NOT_CHECK,
  SESSION,
  SESSION_RN_NP,
  SFV_QUEUE,
  SIGNED,
  SIGNED_NOTE,
  STEP_UP_REFUSAL,
  assessment,
  clientFor,
  completeInDialog,
  completeSfvButton,
  item,
  ok,
  renderWorkspace,
  row,
  sfvLookups,
  sfvWorkspace,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

// Completing a Symptom Follow-Up Visit from the assessment workspace: the dialog, the step-up round trip that keeps
// what was typed, and a signed record whose follow-up is still outstanding.
describe("Admission HOPE workspace — Symptom Follow-Up Visit", () => {
  useStubbedLocalStorage();

  it("steps through the SFV reassessment one question at a time", async () => {
    const client = clientFor({ workspace: sfvWorkspace() });
    renderWorkspace(client, SESSION);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
    const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
    expect(within(dialog).getByText("Question 1 of 2")).toBeTruthy();
    expect(within(dialog).queryByText("Impact of shortness of breath")).toBeNull();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Slight" }));
    await waitFor(() => expect(within(dialog).getByText("Question 2 of 2")).toBeTruthy());
    expect(within(dialog).getByText("Impact of shortness of breath")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
    expect(within(dialog).getByText("Impact of pain")).toBeTruthy();
    expect(within(dialog).getByText("Impact of shortness of breath")).toBeTruthy();
  });

  describe("completing the SFV is a signed-record action (R-05)", () => {
    /** Open the Complete SFV dialog and answer every J2053 question ("Show all" so each is on screen). */
    async function openAnsweredSfvDialog(client: ApiClient): Promise<HTMLElement> {
      renderWorkspace(client, SESSION);
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
      for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" })) {
        fireEvent.click(none);
      }
      return dialog;
    }
    const completeButton = (dialog: HTMLElement) =>
      within(dialog).getByRole("button", { name: "Complete SFV" }) as HTMLButtonElement;
    const attestSfv = (dialog: HTMLElement) =>
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));

    it("stays disabled until the attestation is ticked, then sends it", async () => {
      const client = clientFor({ workspace: sfvWorkspace() });
      const dialog = await openAnsweredSfvDialog(client);
      expect(completeButton(dialog).disabled).toBe(true);
      expect(client.POST).not.toHaveBeenCalled();
      attestSfv(dialog);
      expect(completeButton(dialog).disabled).toBe(false);
      fireEvent.click(completeButton(dialog));

      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/admissions/{admissionId}/hope/sfv",
          expect.objectContaining({
            body: expect.objectContaining({
              triggeringAssessmentId: "hope-1",
              attestationConfirmed: true,
            }),
          }),
        ),
      );
    });

    it("says a signed record cannot complete its follow-up visit, instead of leaving an unexplained gap", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        assessment: { ...assessment, status: "signed", signedAt: "2026-09-08T14:00:00.000Z" },
      });
      renderWorkspace(client, SESSION);

      expect(
        await screen.findByText(
          "This record is signed; the follow-up visit cannot be completed from it.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Complete SFV" })).toBeNull();
    });

    it("does not say so while the record is still a draft", async () => {
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION);
      await screen.findByRole("button", { name: "Complete SFV" });
      expect(screen.queryByText(/follow-up visit cannot be completed from it/)).toBeNull();
    });

    it("redirects a stale step-up to /step-up with this record as returnTo", async () => {
      const client = clientFor({ workspace: sfvWorkspace(), postError: STEP_UP_REFUSAL });
      const dialog = await openAnsweredSfvDialog(client);
      attestSfv(dialog);
      fireEvent.click(completeButton(dialog));

      const where = await screen.findByLabelText("step-up location");
      expect(where.textContent).toBe(
        `/step-up?returnTo=${encodeURIComponent("/hope/assessments/hope-1")}`,
      );
    });

    it("shows any other refusal in the dialog", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        postError: { error: { code: "CONFLICT", message: "This SFV was already completed." } },
      });
      const dialog = await openAnsweredSfvDialog(client);
      attestSfv(dialog);
      fireEvent.click(completeButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain("This SFV was already completed.");
      expect(screen.queryByLabelText("step-up location")).toBeNull();
    });
  });
  describe("an open SFV stays completable after its triggering record is signed", () => {
    it("offers Complete SFV for an open follow-up, and shows it completed once it is", async () => {
      const rows = [row("open")];
      const client = clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: rows });
      (client.POST as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        rows[0] = row("completed");
        return ok({ id: "rfa-04-assessment" });
      });
      renderWorkspace(client, SESSION);

      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      expect(screen.queryByText(SIGNED_NOTE)).toBeNull();
      const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
      for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" })) {
        fireEvent.click(none);
      }
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Complete SFV" }));

      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/admissions/{admissionId}/hope/sfv",
          expect.objectContaining({
            body: expect.objectContaining({
              triggeringAssessmentId: "hope-1",
              authorDiscipline: "RN",
              attestationConfirmed: true,
            }),
          }),
        ),
      );
      expect(await screen.findByText(COMPLETED_NOTE)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
      expect(completeSfvButton()).toBeNull();
      // The signed record's own J2052/J2053 stay as signed: nothing offers to show populated answers.
      expect(screen.queryByRole("button", { name: "View SFV details" })).toBeNull();
    });

    it("offers Complete SFV for an overdue follow-up too", async () => {
      renderWorkspace(
        clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: [row("overdue")] }),
        SESSION,
      );
      expect(await screen.findByRole("button", { name: "Complete SFV" })).toBeTruthy();
    });

    it.each([
      ["completed", COMPLETED_NOTE],
      ["missed", "The follow-up visit window has passed."],
      ["withdrawn", "The follow-up visit was withdrawn."],
    ])("says so, with no button, when the follow-up is %s", async (status, sentence) => {
      renderWorkspace(
        clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: [row(status)] }),
        SESSION,
      );
      expect(await screen.findByText(sentence)).toBeTruthy();
      expect(screen.queryByText(SIGNED_NOTE)).toBeNull();
      expect(completeSfvButton()).toBeNull();
    });

    it("says the status could not be checked, offers no Complete SFV, and Retry asks again", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        assessment: SIGNED,
        sfvs: [row("open")],
        sfvLookupFailures: 1,
      });
      renderWorkspace(client, SESSION);

      expect(await screen.findByText(COULD_NOT_CHECK)).toBeTruthy();
      expect(screen.queryByText(SIGNED_NOTE)).toBeNull();
      expect(completeSfvButton()).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByRole("button", { name: "Complete SFV" })).toBeTruthy();
      expect(screen.queryByText(COULD_NOT_CHECK)).toBeNull();
      expect(sfvLookups(client)).toHaveLength(2);
    });

    it("links to the assessment that recorded a follow-up completed after signing, when it is known", async () => {
      renderWorkspace(
        clientFor({
          workspace: sfvWorkspace(),
          assessment: SIGNED,
          sfvs: [row("completed", "hope-1", "rfa-04-9")],
        }),
        SESSION,
      );
      const link = await screen.findByRole("link", { name: "Open the recorded follow-up visit" });
      expect(link.getAttribute("href")).toBe("/hope/assessments/rfa-04-9");
    });

    it("offers no link to the recorded visit when the queue does not say which assessment it is", async () => {
      renderWorkspace(
        clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: [row("completed")] }),
        SESSION,
      );
      await screen.findByText(COMPLETED_NOTE);
      expect(screen.queryByRole("link", { name: "Open the recorded follow-up visit" })).toBeNull();
    });

    it("asks the server for this record's follow-up only, never the unfiltered worklist", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        assessment: SIGNED,
        sfvs: [row("completed", "hope-2"), row("open")],
      });
      renderWorkspace(client, SESSION);
      expect(await screen.findByRole("button", { name: "Complete SFV" })).toBeTruthy();
      expect(sfvLookups(client)).toEqual([
        [
          SFV_QUEUE,
          {
            params: { query: { triggeringAssessmentId: "hope-1" } },
            signal: expect.any(AbortSignal),
          },
        ],
      ]);
    });

    it("reads the queue once for the page, not again each time the follow-up group is shown", async () => {
      const withAdministrative = workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({ itemCode: "A0500A", label: "First name", state: "answered", value: "Ada" }),
            ],
          },
          ...(sfvWorkspace().sections as unknown[]),
        ],
      });
      const client = clientFor({
        workspace: withAdministrative,
        assessment: SIGNED,
        sfvs: [row("open")],
      });
      renderWorkspace(client, SESSION);
      await screen.findByRole("button", { name: /J Health Conditions/ });
      for (const section of [
        /J Health Conditions/,
        /A Administrative/,
        /J Health Conditions/,
        /A Administrative/,
        /J Health Conditions/,
      ]) {
        fireEvent.click(screen.getByRole("button", { name: section }));
      }
      expect(await screen.findByRole("button", { name: "Complete SFV" })).toBeTruthy();
      expect(sfvLookups(client)).toHaveLength(1);
    });

    it.each([
      ["no row for this record", [row("open", "hope-2")]],
      ["no rows at all", []],
      ["a status it does not know", [row("reopened")]],
    ])("keeps the signed-record sentence and no button when there is %s", async (_name, rows) => {
      renderWorkspace(
        clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: rows }),
        SESSION,
      );
      expect(await screen.findByText(SIGNED_NOTE)).toBeTruthy();
      expect(completeSfvButton()).toBeNull();
    });

    it("shows nothing actionable, and no sentence yet, while the lookup is pending", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        assessment: SIGNED,
        sfvs: [row("open")],
      });
      const answer = client.GET as unknown as ReturnType<typeof vi.fn>;
      const normal = answer.getMockImplementation() as (path: string) => Promise<unknown>;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      answer.mockImplementation(async (path: string) => {
        if (path === SFV_QUEUE) await gate;
        return normal(path);
      });
      renderWorkspace(client, SESSION);
      await screen.findByRole("heading", { name: "Symptom Follow-Up Visit" });
      await waitFor(() => expect(sfvLookups(client)).toHaveLength(1));
      expect(completeSfvButton()).toBeNull();
      expect(screen.queryByText(SIGNED_NOTE)).toBeNull();

      release();
      expect(await screen.findByRole("button", { name: "Complete SFV" })).toBeTruthy();
    });

    it("makes no lookup for a draft record", async () => {
      const client = clientFor({ workspace: sfvWorkspace(), sfvs: [row("open")] });
      renderWorkspace(client, SESSION);
      await screen.findByRole("button", { name: "Complete SFV" });
      expect(sfvLookups(client)).toHaveLength(0);
    });

    it("makes no lookup for a signed record whose follow-up is not required", async () => {
      const notRequired = workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              item({
                itemCode: "J2052A",
                label: "SFV completed",
                section: "J",
                group: "Symptom Follow-Up Visit",
                applicability: "not_applicable",
              }),
            ],
          },
        ],
      });
      const client = clientFor({ workspace: notRequired, assessment: SIGNED, sfvs: [row("open")] });
      renderWorkspace(client, SESSION);
      await screen.findByRole("heading", { name: "Symptom Follow-Up Visit" });
      expect(sfvLookups(client)).toHaveLength(0);
      expect(completeSfvButton()).toBeNull();
    });
  });

  describe("the SFV queue's Complete link opens the dialog where the action is", () => {
    const LINK_PATH = "/hope/assessments/hope-1?completeSfv=1";
    const location = () => screen.getByTestId("current-location").textContent;
    const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const DRAFT_KEY = stepUpDraftKey(SESSION, "hope.sfv.record", "hope-1") as string;

    afterEach(() => {
      clearAllStepUpDrafts();
    });

    it("opens the dialog for a draft whose follow-up is required, then drops the parameter", async () => {
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION, LINK_PATH);
      expect(await screen.findByRole("dialog", { name: "Complete SFV" })).toBeTruthy();
      await waitFor(() => expect(location()).toBe("/hope/assessments/hope-1"));
    });

    it.each(["open", "overdue"])(
      "waits for the lookup on a signed record, then opens the dialog when the follow-up is %s",
      async (status) => {
        const client = clientFor({
          workspace: sfvWorkspace(),
          assessment: SIGNED,
          sfvs: [row(status)],
        });
        renderWorkspace(client, SESSION, LINK_PATH);
        expect(await screen.findByRole("dialog", { name: "Complete SFV" })).toBeTruthy();
        await waitFor(() => expect(location()).toBe("/hope/assessments/hope-1"));
        expect(sfvLookups(client)).toHaveLength(1);
      },
    );

    it.each([
      ["a signed record whose follow-up is completed", SIGNED, [row("completed")]],
      ["a signed record whose follow-up is missed", SIGNED, [row("missed")]],
      ["a signed record whose follow-up is withdrawn", SIGNED, [row("withdrawn")]],
      ["a signed record with no follow-up row", SIGNED, []],
    ])(
      "does nothing visible for %s, and still drops the parameter",
      async (_name, record, rows) => {
        renderWorkspace(
          clientFor({ workspace: sfvWorkspace(), assessment: record, sfvs: rows }),
          SESSION,
          LINK_PATH,
        );
        await waitFor(() => expect(location()).toBe("/hope/assessments/hope-1"));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
      },
    );

    it("opens nothing while the lookup has failed, and keeps the parameter so Retry can still open the dialog", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        assessment: SIGNED,
        sfvLookupFailures: Number.POSITIVE_INFINITY,
      });
      renderWorkspace(client, SESSION, LINK_PATH);
      expect(await screen.findByText(COULD_NOT_CHECK)).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(location()).toBe(LINK_PATH);
    });

    it("does nothing visible for a record that needs no follow-up, and still drops the parameter", async () => {
      const notRequired = workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              item({
                itemCode: "J2052A",
                label: "SFV completed",
                section: "J",
                group: "Symptom Follow-Up Visit",
                applicability: "not_applicable",
              }),
            ],
          },
        ],
      });
      renderWorkspace(clientFor({ workspace: notRequired }), SESSION, LINK_PATH);
      await waitFor(() => expect(location()).toBe("/hope/assessments/hope-1"));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens one dialog, not two, when the visit is also a return from step-up, and does not reopen it", async () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1" },
      });
      markStepUpReturn(LINK_PATH);
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION, LINK_PATH);

      const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
      await waitFor(() => expect(location()).toBe("/hope/assessments/hope-1"));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect((within(dialog).getByLabelText("SFV date") as HTMLInputElement).value).toBe(
        "2026-09-01",
      );

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("does not open anything without the parameter", async () => {
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION);
      await screen.findByRole("button", { name: "Complete SFV" });
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("after the SFV is recorded", () => {
    const recordedWorkspace = () =>
      workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              item({
                itemCode: "J2052A",
                label: "SFV completed",
                section: "J",
                group: "Symptom Follow-Up Visit",
                state: "answered",
                value: "1",
              }),
              item({
                itemCode: "J2053A",
                label: "Impact of pain",
                section: "J",
                group: "Symptom Follow-Up Visit",
              }),
              item({
                itemCode: "J2053B",
                label: "Impact of shortness of breath",
                section: "J",
                group: "Symptom Follow-Up Visit",
              }),
            ],
          },
        ],
      });
    const sectionCard = () => document.getElementById("hope-item-J2052A");

    /** Answers GET /workspace with the recorded state from the moment the SFV POST succeeds. */
    function recordOnPost(client: ApiClient, afterRecorded: (path: string) => unknown): void {
      const get = client.GET as unknown as ReturnType<typeof vi.fn>;
      const loadInitial = get.getMockImplementation() as (path: string) => Promise<unknown>;
      let recorded = false;
      get.mockImplementation(async (path: string) =>
        recorded ? afterRecorded(path) : loadInitial(path),
      );
      (client.POST as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        recorded = true;
        return ok({ id: "rfa-04-1" });
      });
    }

    it("puts focus on the follow-up card of a draft once it shows the recorded visit", async () => {
      const client = clientFor({ workspace: sfvWorkspace() });
      const loadInitial = (
        client.GET as unknown as ReturnType<typeof vi.fn>
      ).getMockImplementation() as (path: string) => Promise<unknown>;
      recordOnPost(client, (path) =>
        path.includes("/workspace") ? ok(recordedWorkspace()) : loadInitial(path),
      );
      renderWorkspace(client, SESSION);

      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));

      expect(await screen.findByRole("button", { name: "View SFV details" })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(sectionCard()));
    });

    it("puts focus on the follow-up card of a signed record once it shows the completed visit", async () => {
      const rows = [row("open")];
      const client = clientFor({ workspace: sfvWorkspace(), assessment: SIGNED, sfvs: rows });
      (client.POST as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        rows[0] = row("completed");
        return ok({ id: "rfa-04-1" });
      });
      renderWorkspace(client, SESSION);

      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));

      expect(await screen.findByText(COMPLETED_NOTE)).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(sectionCard()));
    });

    it("says so, without an unhandled rejection, when the page cannot refresh afterwards", async () => {
      const client = clientFor({ workspace: sfvWorkspace() });
      recordOnPost(client, (path) => {
        if (path.includes("/workspace")) return Promise.reject(new TypeError("offline"));
        return ok({});
      });
      renderWorkspace(client, SESSION);

      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      completeInDialog(screen.getByRole("dialog", { name: "Complete SFV" }));

      const notice = await screen.findByText(
        "The follow-up visit was recorded, but this page could not refresh. Reload to see it.",
      );
      expect(notice.getAttribute("role")).toBe("alert");
      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
    });
  });

  describe("a stale step-up keeps what the clinician typed in the SFV", () => {
    const DRAFT_KEY = stepUpDraftKey(SESSION, "hope.sfv.record", "hope-1") as string;
    const RETURN_PATH = "/hope/assessments/hope-1";
    const attestBox = (dialog: HTMLElement) =>
      within(dialog).getByRole("checkbox", { name: /I attest/ }) as HTMLInputElement;
    const completeButton = (dialog: HTMLElement) =>
      within(dialog).getByRole("button", { name: "Complete SFV" }) as HTMLButtonElement;

    afterEach(() => {
      clearAllStepUpDrafts();
    });

    it("stashes the date, discipline and answers (never the attestation) before redirecting", async () => {
      const client = clientFor({ workspace: sfvWorkspace(), postError: STEP_UP_REFUSAL });
      renderWorkspace(client, SESSION_RN_NP);
      await screen.findByRole("heading", { name: "Admission Workspace" });
      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
      fireEvent.change(within(dialog).getByLabelText("SFV date"), {
        target: { value: "2026-09-01" },
      });
      fireEvent.change(within(dialog).getByLabelText("Author discipline"), {
        target: { value: "NP" },
      });
      fireEvent.click(within(dialog).getAllByRole("radio", { name: "Slight" })[0] as HTMLElement);
      fireEvent.click(
        within(dialog).getAllByRole("radio", { name: "Not at all" })[1] as HTMLElement,
      );
      fireEvent.click(attestBox(dialog));
      fireEvent.click(completeButton(dialog));

      const where = await screen.findByLabelText("step-up location");
      expect(where.textContent).toBe(`/step-up?returnTo=${encodeURIComponent(RETURN_PATH)}`);
      expect(stepUpDraftKeys()).toEqual([DRAFT_KEY]);
      const draft = peekStepUpDraft<Record<string, unknown>>(DRAFT_KEY);
      expect(draft).toEqual({
        date: "2026-09-01",
        discipline: "NP",
        answers: { J2053A: "1", J2053B: "0" },
      });
      // The signer must re-attest after the re-verification: the tick is never carried over.
      expect(draft).not.toHaveProperty("attested");
    });

    it("on return from step-up, reopens the dialog with the typed values and the attestation unticked", async () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "NP",
        answers: { J2053A: "1", J2053B: "0" },
      });
      markStepUpReturn(RETURN_PATH);
      const client = clientFor({ workspace: sfvWorkspace() });
      renderWorkspace(client, SESSION_RN_NP);

      const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
      expect((within(dialog).getByLabelText("SFV date") as HTMLInputElement).value).toBe(
        "2026-09-01",
      );
      expect((within(dialog).getByLabelText("Author discipline") as HTMLSelectElement).value).toBe(
        "NP",
      );
      expect(within(dialog).getByText("2/2 completed")).toBeTruthy();
      expect(attestBox(dialog).checked).toBe(false);
      expect(completeButton(dialog).disabled).toBe(true);

      // Re-attest and complete: the restored answers are what is sent, and the draft is spent.
      fireEvent.click(attestBox(dialog));
      fireEvent.click(completeButton(dialog));
      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/admissions/{admissionId}/hope/sfv",
          expect.objectContaining({
            body: expect.objectContaining({
              targetDate: "2026-09-01T12:00:00.000Z",
              authorDiscipline: "NP",
              attestationConfirmed: true,
              data: { J: { J2053: { J2053A: "1", J2053B: "0" } } },
            }),
          }),
        ),
      );
      await waitFor(() => expect(stepUpDraftKeys()).toEqual([]));
    });

    it("does not reopen the dialog, and drops the draft, when the user did not come back from step-up", async () => {
      stashStepUpDraft(DRAFT_KEY, { date: "2026-09-01", discipline: "NP", answers: {} });
      const client = clientFor({ workspace: sfvWorkspace() });
      renderWorkspace(client, SESSION);
      await screen.findByRole("heading", { name: "Admission Workspace" });

      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
      await waitFor(() => expect(stepUpDraftKeys()).toEqual([]));
    });

    it("Discarding after a return from step-up drops the restored draft", async () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1", J2053B: "0" },
      });
      markStepUpReturn(RETURN_PATH);
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION);

      const dialog = await screen.findByRole("dialog", { name: "Complete SFV" });
      expect(within(dialog).getByText("2/2 completed")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      // Restored answers are entered answers: closing asks before throwing them away.
      expect(stepUpDraftKeys()).toEqual([DRAFT_KEY]);
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));

      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
      expect(stepUpDraftKeys()).toEqual([]);
    });

    it("does not reopen the dialog for a draft that was stashed for another assessment", async () => {
      const otherKey = stepUpDraftKey(SESSION, "hope.sfv.record", "hope-2") as string;
      stashStepUpDraft(otherKey, { date: "2026-09-01", discipline: "RN", answers: {} });
      markStepUpReturn(RETURN_PATH);
      renderWorkspace(clientFor({ workspace: sfvWorkspace() }), SESSION);
      await screen.findByRole("heading", { name: "Admission Workspace" });

      expect(screen.queryByRole("dialog", { name: "Complete SFV" })).toBeNull();
      // Nobody abandoned that draft, so it is left for the assessment it belongs to.
      expect(stepUpDraftKeys()).toEqual([otherKey]);
    });

    it("keeps no draft and does not redirect on any other refusal", async () => {
      const client = clientFor({
        workspace: sfvWorkspace(),
        postError: { error: { code: "CONFLICT", message: "This SFV was already completed." } },
      });
      renderWorkspace(client, SESSION);
      await screen.findByRole("heading", { name: "Admission Workspace" });
      fireEvent.click(await screen.findByRole("button", { name: "Complete SFV" }));
      const dialog = screen.getByRole("dialog", { name: "Complete SFV" });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
      for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" })) {
        fireEvent.click(none);
      }
      fireEvent.click(attestBox(dialog));
      fireEvent.click(completeButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain("This SFV was already completed.");
      expect(screen.queryByLabelText("step-up location")).toBeNull();
      expect(stepUpDraftKeys()).toEqual([]);
    });
  });
});
