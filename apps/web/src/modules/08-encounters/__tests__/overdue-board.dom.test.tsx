// The supervisor overdue-notes board (ADR-0113): the rows the server's clock decided, error / empty / read-only states, and the
// grant-override drawer (validation, the 40-character reason, the idempotency key, the step-up round trip, revoke, self-grant).
// Synthetic data only.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markStepUpReturn, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { OVERDUE_BOARD_REFRESH_MS, OverdueBoard } from "../overdue-board";
import {
  CLINICIAN_A_ID,
  CLINICIAN_B_ID,
  type Call,
  NOTE_A_ID,
  NOTE_B_ID,
  NOTE_OWN_ID,
  OVERRIDE_ID,
  PATIENT_A_ID,
  PATIENT_B_ID,
  type Responder,
  SUPERVISOR_MEMBERSHIP_ID,
  boardBody,
  hoursFromNow,
  mountScreen,
  noteRow,
  overrideView,
  patientRoute,
  refusal,
  writes,
} from "./closure-test-harness";

const PATH = "/work/overdue-notes";
const BOARD = "GET /api/v1/encounters/overdue-notes";
const GRANT = "POST /api/v1/encounters/closure-overrides";
const REVOKE = `POST /api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`;
const LONG_REASON = "Needs to document the on-call hospice admission before charting more.";
const SHORT_REASON = "too short";

const atRiskNote = noteRow({
  encounterId: NOTE_B_ID,
  authoredByMembershipId: CLINICIAN_B_ID,
  patientId: PATIENT_B_ID,
  encounterType: "admission_visit",
  discipline: "msw",
  status: "finalized",
  stage: "at_risk",
  hoursOverdue: 0,
  deadlineAt: hoursFromNow(3.5),
});

interface Opts {
  board?: Responder;
  staff?: Responder;
  grant?: Responder;
  revoke?: Responder;
  entry?: string;
  calls?: Call[];
}

function mount(opts: Opts = {}): Call[] {
  const calls = opts.calls ?? [];
  mountScreen({
    calls,
    routePath: PATH,
    entry: opts.entry ?? PATH,
    permissions: ["encounter.closure_override"],
    element: <OverdueBoard />,
    routes: {
      [BOARD]: opts.board ?? (() => ({ body: boardBody([noteRow(), atRiskNote]) })),
      "GET /api/v1/orgs/org-1/care-team-staff":
        opts.staff ??
        (() => ({
          body: {
            staff: [
              {
                userId: "u-a",
                membershipId: CLINICIAN_A_ID,
                displayName: "Rowan Test",
                roleLabels: ["RN"],
              },
              {
                userId: "u-b",
                membershipId: CLINICIAN_B_ID,
                displayName: "Sage Example",
                roleLabels: ["MSW"],
              },
            ],
          },
        })),
      [`GET /api/v1/patients/${PATIENT_A_ID}`]: patientRoute("Ada", "Vance"),
      [`GET /api/v1/patients/${PATIENT_B_ID}`]: patientRoute("Bo", "Quill"),
      [GRANT]: opts.grant ?? (() => ({ status: 201, body: overrideView() })),
      [REVOKE]: opts.revoke ?? (() => ({ body: overrideView({ revokedAt: hoursFromNow(0) }) })),
    },
  });
  return calls;
}

const region = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Overdue visit notes" });
const drawerFor = (name: string): Promise<HTMLElement> =>
  screen.findByRole("complementary", { name: `Override for ${name}` });

async function openDrawer(name = "Rowan Test"): Promise<HTMLElement> {
  const table = await region();
  await within(table).findByText("Vance, Ada");
  fireEvent.click(
    within(table).getByRole("button", { name: new RegExp(`^Grant override for ${name}`) }),
  );
  return drawerFor(name);
}

const typeReason = (drawer: HTMLElement, value: string): void => {
  fireEvent.change(within(drawer).getByLabelText(/^Reason/), { target: { value } });
};
const typeHours = (drawer: HTMLElement, value: string): void => {
  fireEvent.change(within(drawer).getByLabelText(/^Hours/), { target: { value } });
};
const submitGrant = (drawer: HTMLElement): void => {
  fireEvent.click(within(drawer).getByRole("button", { name: "Grant override" }));
};
const idempotencyKey = (call: Call | undefined): string | null =>
  call?.headers.get("idempotency-key") ?? null;

describe("the board", () => {
  it("lists each note with the server's stage, timing and resolved names", async () => {
    mount();
    const table = await region();
    expect(await within(table).findByText("Vance, Ada")).toBeTruthy();
    expect(within(table).getByText("Quill, Bo")).toBeTruthy();
    expect(within(table).getByText("Rowan Test")).toBeTruthy();
    expect(within(table).getByText("Sage Example")).toBeTruthy();
    expect(within(table).getByText("6h overdue")).toBeTruthy();
    expect(within(table).getByText("Due in 3h")).toBeTruthy();
    expect(within(table).getByText("Overdue")).toBeTruthy();
    expect(within(table).getByText("At risk")).toBeTruthy();
    expect(within(table).getByText("Finalized")).toBeTruthy();
  });

  it("falls back to a short id when a clinician's name cannot be read", async () => {
    mount({ staff: refusal(403, "FORBIDDEN") });
    const table = await region();
    expect(await within(table).findByText(`Clinician ${CLINICIAN_A_ID.slice(0, 8)}`)).toBeTruthy();
  });

  it("counts the stages in the summary", async () => {
    mount({
      board: () => ({
        body: boardBody([
          noteRow({ stage: "escalated" }),
          noteRow({ encounterId: "x2" }),
          atRiskNote,
        ]),
      }),
    });
    await region();
    const summary = screen.getByLabelText("Overdue note summary");
    expect(within(summary).getByText("Escalated").nextSibling?.textContent).toBe("1");
    expect(within(summary).getByText("Overdue").nextSibling?.textContent).toBe("1");
    expect(within(summary).getByText("At risk").nextSibling?.textContent).toBe("1");
  });

  it("says when more notes matched than the board shows", async () => {
    mount({ board: () => ({ body: boardBody([noteRow()], { truncated: true }) }) });
    expect(await screen.findByText(/Showing the oldest 1 notes/)).toBeTruthy();
  });

  it("shows an empty state, not a table, when nothing needs attention", async () => {
    mount({ board: () => ({ body: boardBody([]) }) });
    expect(await screen.findByText("No notes need attention")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Overdue visit notes" })).toBeNull();
  });

  it("shows an error with a retry, never an empty board, when the read fails", async () => {
    let attempts = 0;
    mount({
      board: () => {
        attempts += 1;
        return attempts === 1
          ? { status: 500, body: { error: { code: "INTERNAL" } } }
          : { body: boardBody([noteRow()]) };
      },
    });
    expect(await screen.findByText("Overdue notes unavailable")).toBeTruthy();
    expect(screen.queryByText("No notes need attention")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await within(await region()).findByText("Vance, Ada")).toBeTruthy();
  });

  it("says plainly that the board is not available when the server refuses it", async () => {
    mount({ board: refusal(403, "FORBIDDEN") });
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("is read-only in warn mode and explains why there is nothing to override", async () => {
    mount({ board: () => ({ body: boardBody([noteRow()], { mode: "warn" }) }) });
    const table = await region();
    await within(table).findByText("Vance, Ada");
    expect(within(table).queryByRole("button", { name: /Grant override/ })).toBeNull();
    expect(screen.getByText(/set to warn only/)).toBeTruthy();
  });

  it("says closure is off, and lists nothing, when the tenant switched it off", async () => {
    mount({ board: () => ({ body: boardBody([], { mode: "off" }) }) });
    expect(await screen.findByText(/closure is off for your organization/i)).toBeTruthy();
    expect(screen.getByText("Note closure is switched off for your organization.")).toBeTruthy();
  });

  it("offers no override on the viewer's own note", async () => {
    mount({
      board: () => ({
        body: boardBody([
          noteRow({ encounterId: NOTE_OWN_ID, authoredByMembershipId: SUPERVISOR_MEMBERSHIP_ID }),
          noteRow(),
        ]),
      }),
    });
    const table = await region();
    await within(table).findAllByText("Vance, Ada");
    expect(within(table).getByText(/Your own note/)).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: /^Grant override for/ })).toHaveLength(1);
  });

  it("does not open a drawer for the viewer's own note even from a deep link", async () => {
    mount({
      entry: `${PATH}?note=${NOTE_OWN_ID}`,
      board: () => ({
        body: boardBody([
          noteRow({ encounterId: NOTE_OWN_ID, authoredByMembershipId: SUPERVISOR_MEMBERSHIP_ID }),
        ]),
      }),
    });
    await region();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("asks for the oldest notes up to the server's cap", async () => {
    const calls = mount();
    await region();
    const read = calls.find((call) => `${call.method} ${call.path}` === BOARD);
    expect(read?.query.get("limit")).toBe("200");
  });
});

describe("granting an override", () => {
  it("sends the clinician, the trimmed reason and the hours under an Idempotency-Key, then offers Revoke", async () => {
    const calls = mount();
    const drawer = await openDrawer();
    typeReason(drawer, `  ${LONG_REASON}  `);
    submitGrant(drawer);
    expect(await within(drawer).findByText(/is not blocked until/)).toBeTruthy();

    const [grant] = writes(calls);
    expect(grant?.path).toBe("/api/v1/encounters/closure-overrides");
    expect(grant?.body).toEqual({
      subjectMembershipId: CLINICIAN_A_ID,
      reason: LONG_REASON,
      hours: 4,
    });
    expect(idempotencyKey(grant)).toBeTruthy();
    expect(within(await region()).getByText("Override active")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Revoke override" })).toBeTruthy();
  });

  it("revokes the grant it just made and offers the form again", async () => {
    const calls = mount();
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    typeHours(drawer, "2");
    submitGrant(drawer);
    fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke override" }));
    expect(await within(drawer).findByText(/Override revoked/)).toBeTruthy();
    expect(within(drawer).getByLabelText(/^Reason/)).toBeTruthy();

    const [grant, revoke] = writes(calls);
    expect((grant?.body as { hours: number }).hours).toBe(2);
    expect(revoke?.path).toBe(`/api/v1/encounters/closure-overrides/${OVERRIDE_ID}/revoke`);
    expect(idempotencyKey(revoke)).toBeTruthy();
  });

  it("explains the consequence before anything is sent", async () => {
    mount();
    const drawer = await openDrawer();
    expect(
      within(drawer).getByText(/The note stays open: its alerts and deadline do not change/),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/Your name and the reason are recorded in the audit trail/),
    ).toBeTruthy();
  });

  it("refuses a reason under 40 characters without sending anything", async () => {
    const calls = mount();
    const drawer = await openDrawer();
    typeReason(drawer, SHORT_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText(/Enter at least 40 characters/)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it("counts the characters still needed and says when the reason is long enough", async () => {
    mount();
    const drawer = await openDrawer();
    expect(within(drawer).getByText(/40 more characters needed/)).toBeTruthy();
    typeReason(drawer, "x".repeat(10));
    expect(within(drawer).getByText(/30 more characters needed/)).toBeTruthy();
    typeReason(drawer, `   ${"x".repeat(40)}   `);
    expect(within(drawer).getByText(/Long enough/)).toBeTruthy();
  });

  it.each(["0", "25", "2.5", ""])("refuses %j hours without sending anything", async (hours) => {
    const calls = mount();
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    typeHours(drawer, hours);
    submitGrant(drawer);
    expect(
      await within(drawer).findByText("Enter a whole number of hours from 1 to 24."),
    ).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it("surfaces the server's refusal of a self-grant in our own words and keeps the form", async () => {
    mount({ grant: refusal(403, "FORBIDDEN") });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText(/You cannot override your own note/)).toBeTruthy();
    expect(within(drawer).getByLabelText(/^Reason/)).toBeTruthy();
  });

  it("shows the server's field error beside the field", async () => {
    mount({
      grant: refusal(422, "VALIDATION_FAILED", [
        { field: "reason", code: "INVALID", message: "reason must be at least 40 characters" },
      ]),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText("reason must be at least 40 characters")).toBeTruthy();
  });

  it("keeps the Idempotency-Key across a retry after a lost reply, and renews it after an answer", async () => {
    const calls: Call[] = [];
    let attempts = 0;
    const grant: Responder = () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      if (attempts === 2) return { status: 403, body: { error: { code: "FORBIDDEN" } } };
      return { status: 201, body: overrideView() };
    };
    mount({ calls, grant });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText(/Could not reach the server/)).toBeTruthy();
    submitGrant(drawer);
    await within(drawer).findByText(/You cannot override your own note/);
    submitGrant(drawer);
    await within(drawer).findByText(/is not blocked until/);

    const [first, second, third] = writes(calls).map(idempotencyKey);
    expect(first).toBeTruthy();
    expect(second).toBe(first); // no answer: the retry of the SAME attempt keeps the key
    expect(third).not.toBe(second); // an answer (the refusal) renewed it
  });

  it("does not send twice when the form is submitted again while the first is in flight", async () => {
    const calls = mount({
      grant: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 201, body: overrideView() }), 20),
        ),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    const form = drawer.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await within(drawer).findByText(/is not blocked until/);
    expect(writes(calls)).toHaveLength(1);
  });

  it("closes the drawer from its close button", async () => {
    mount();
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole("button", { name: "Close override panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });
});

describe("step-up", () => {
  const entry = `${PATH}?note=${NOTE_A_ID}`;

  it("round-trips through step-up: the edit is restored on return and nothing is re-sent for the user", async () => {
    const calls: Call[] = [];
    let ceremonyDone = false;
    const grant: Responder = () =>
      ceremonyDone
        ? { status: 201, body: overrideView() }
        : { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
    mount({ calls, entry, grant });
    const first = await drawerFor("Rowan Test");
    typeReason(first, LONG_REASON);
    typeHours(first, "6");
    submitGrant(first);
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(entry)}`);
    expect(writes(calls)).toHaveLength(1);
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    ceremonyDone = true;
    markStepUpReturn(entry);
    mount({ calls, entry, grant });
    const back = await drawerFor("Rowan Test");
    expect((within(back).getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe(LONG_REASON);
    expect((within(back).getByLabelText(/^Hours/) as HTMLInputElement).value).toBe("6");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes(calls)).toHaveLength(1);
    submitGrant(back);
    await within(back).findByText(/is not blocked until/);
    expect(writes(calls)).toHaveLength(2);
    expect((writes(calls)[1]?.body as { hours: number }).hours).toBe(6);
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("discards an abandoned draft on an ordinary visit (no step-up return marker)", async () => {
    const grant: Responder = () => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } });
    mount({ entry, grant });
    const first = await drawerFor("Rowan Test");
    typeReason(first, LONG_REASON);
    submitGrant(first);
    await screen.findByText("elsewhere");
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    mount({ entry });
    const fresh = await drawerFor("Rowan Test");
    expect((within(fresh).getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe("");
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("sends a revoke that needs a fresh sign-in to step-up as well", async () => {
    const revoke: Responder = () => ({
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED" } },
    });
    mount({ revoke });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke override" }));
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toContain("/step-up?returnTo=");
  });

  describe("after a revoke's round trip", () => {
    let ceremonyDone = false;
    const revoke: Responder = () =>
      ceremonyDone
        ? { body: overrideView({ revokedAt: hoursFromNow(0) }) }
        : { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };

    /** Grant, press Revoke, get sent to step-up, and leave the board (it unmounts, and its held grants with it). */
    async function revokeSentToStepUp(): Promise<void> {
      ceremonyDone = false;
      mount({ revoke });
      const drawer = await openDrawer();
      typeReason(drawer, LONG_REASON);
      submitGrant(drawer);
      fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke override" }));
      await screen.findByText("elsewhere");
      expect(stepUpDraftKeys().length).toBe(1);
      cleanup();
    }

    it("still offers Revoke for the grant, and the revoke goes through", async () => {
      await revokeSentToStepUp();
      ceremonyDone = true;
      markStepUpReturn(entry);
      mount({ entry, revoke });
      const back = await drawerFor("Rowan Test");
      fireEvent.click(await within(back).findByRole("button", { name: "Revoke override" }));
      await within(back).findByText(/Override revoked/);
      expect(within(back).queryByRole("button", { name: "Revoke override" })).toBeNull();
      expect(stepUpDraftKeys().length).toBe(0);
    });

    it("does not bring the grant back on an ordinary visit, and forgets it", async () => {
      await revokeSentToStepUp();
      mount({ entry, revoke });
      const fresh = await drawerFor("Rowan Test");
      expect(within(fresh).queryByRole("button", { name: "Revoke override" })).toBeNull();
      expect(reasonBox(fresh).value).toBe("");
      expect(stepUpDraftKeys().length).toBe(0);
    });

    it("keeps every grant the board held, not only the one being revoked", async () => {
      const entryB = `${PATH}?note=${NOTE_B_ID}`;
      const grant: Responder = (call) => ({
        status: 201,
        body: overrideView({
          subjectMembershipId: (call.body as { subjectMembershipId: string }).subjectMembershipId,
        }),
      });
      ceremonyDone = false;
      mount({ grant, revoke });
      const first = await openDrawer("Rowan Test");
      typeReason(first, LONG_REASON);
      submitGrant(first);
      await within(first).findByRole("button", { name: "Revoke override" });
      fireEvent.click(
        within(await region()).getByRole("button", { name: /^Grant override for Sage Example/ }),
      );
      const second = await drawerFor("Sage Example");
      typeReason(second, LONG_REASON);
      submitGrant(second);
      fireEvent.click(await within(second).findByRole("button", { name: "Revoke override" }));
      await screen.findByText("elsewhere");
      cleanup();

      ceremonyDone = true;
      markStepUpReturn(entryB);
      mount({ entry: entryB, grant, revoke });
      const back = await drawerFor("Sage Example");
      expect(within(back).getByRole("button", { name: "Revoke override" })).toBeTruthy();
      fireEvent.click(
        within(await region()).getByRole("button", { name: /^Manage override for Rowan Test/ }),
      );
      const other = await drawerFor("Rowan Test");
      expect(within(other).getByRole("button", { name: "Revoke override" })).toBeTruthy();
    });

    it("forgets the stashed grants when the supervisor closes the drawer", async () => {
      await revokeSentToStepUp();
      ceremonyDone = true;
      markStepUpReturn(entry);
      mount({ entry, revoke });
      const back = await drawerFor("Rowan Test");
      expect(stepUpDraftKeys().length).toBe(1);
      fireEvent.click(within(back).getByRole("button", { name: "Close override panel" }));
      expect(stepUpDraftKeys().length).toBe(0);
    });

    it("forgets the stashed grants when the board is refused", async () => {
      await revokeSentToStepUp();
      ceremonyDone = true;
      markStepUpReturn(entry);
      let reads = 0;
      const board: Responder = () => {
        reads += 1;
        return reads === 1
          ? { body: boardBody([noteRow(), atRiskNote]) }
          : { status: 403, body: { error: { code: "FORBIDDEN" } } };
      };
      mount({ entry, board, revoke });
      await drawerFor("Rowan Test");
      expect(stepUpDraftKeys().length).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByText("Not available")).toBeTruthy();
      expect(stepUpDraftKeys().length).toBe(0);
    });
  });
});

const heading = (drawer: HTMLElement): HTMLElement =>
  within(drawer).getByRole("heading", { name: "Grant override", level: 2 });
const reasonBox = (drawer: HTMLElement): HTMLTextAreaElement =>
  within(drawer).getByLabelText(/^Reason/) as HTMLTextAreaElement;

describe("a refresh that does not go to plan", () => {
  it("keeps the rows, the open drawer and what was typed in it, and says so, when a refresh fails", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return reads === 1
          ? { body: boardBody([noteRow(), atRiskNote]) }
          : { status: 500, body: { error: { code: "INTERNAL" } } };
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(/The board could not be refreshed/)).toBeTruthy();
    expect(within(await region()).getByText("Vance, Ada")).toBeTruthy();
    expect(screen.queryByText("Overdue notes unavailable")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Override for Rowan Test" })).toBe(drawer);
    expect(reasonBox(drawer).value).toBe(LONG_REASON);
  });

  it("clears that notice once a later refresh succeeds", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return reads === 2
          ? { status: 500, body: { error: { code: "INTERNAL" } } }
          : { body: boardBody([noteRow(), atRiskNote]) };
      },
    });
    await region();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/The board could not be refreshed/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText(/The board could not be refreshed/)).toBeNull());
  });

  it("keeps the drawer open, with what was typed, when a refresh no longer lists its note, and says why", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return { body: boardBody(reads === 1 ? [noteRow(), atRiskNote] : [atRiskNote]) };
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await within(drawer).findByText(/no longer on the board/)).toBeTruthy();
    expect(within(await region()).queryByText("Vance, Ada")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Override for Rowan Test" })).toBe(drawer);
    expect(reasonBox(drawer).value).toBe(LONG_REASON);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close override panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });
});

describe("what a screen reader hears", () => {
  it("does not make the table a live region, and keeps one status line that says what the board holds", async () => {
    mount();
    const table = await region();
    await within(table).findByText("Vance, Ada");
    expect(table.closest("[aria-live]")).toBeNull();
    const line = screen.getByText("2 notes on the board: 0 escalated, 1 overdue, 1 at risk.");
    expect(line.closest("output")).toBeTruthy();
    expect(table.contains(line)).toBe(false);
  });

  it("announces a grant and a revoke through the status line the drawer already had, and moves focus to its heading", async () => {
    mount();
    const drawer = await openDrawer();
    const [line] = within(drawer).getAllByRole("status");
    expect(within(drawer).getAllByRole("status")).toHaveLength(1);
    expect(line?.textContent).toBe("");

    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    await within(drawer).findByText(/is not blocked until/);
    expect(within(drawer).getByRole("status")).toBe(line); // the same element: it was in the drawer before the grant landed
    expect(line?.textContent).toMatch(/is not blocked until/);
    expect(document.activeElement).toBe(heading(drawer));

    fireEvent.click(within(drawer).getByRole("button", { name: "Revoke override" }));
    await within(drawer).findByText(/Override revoked/);
    expect(within(drawer).getByRole("status")).toBe(line);
    expect(line?.textContent).toMatch(/Override revoked\. Rowan Test is limited again/);
    expect(document.activeElement).toBe(heading(drawer));
  });

  it("says another override is still in force when a revoke leaves one, and does not claim the clinician is limited", async () => {
    mount({
      revoke: () => ({
        body: overrideView({ revokedAt: hoursFromNow(0), remainingActiveUntil: hoursFromNow(2) }),
      }),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke override" }));
    const line = await within(drawer).findByText(
      /Another override for this clinician is still active until /,
    );
    expect(line.closest("output")).toBeTruthy();
    expect(within(drawer).queryByText(/limited again/)).toBeNull();
  });
});

describe("closing the drawer", () => {
  const entry = `${PATH}?note=${NOTE_A_ID}`;
  const stepUpNeeded: Responder = () => ({
    status: 403,
    body: { error: { code: "STEP_UP_REQUIRED" } },
  });

  it("abandons the stashed step-up draft on Escape, as Close does, so it cannot resurface", async () => {
    mount({ entry, grant: stepUpNeeded });
    const first = await drawerFor("Rowan Test");
    typeReason(first, LONG_REASON);
    submitGrant(first);
    await screen.findByText("elsewhere");
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    markStepUpReturn(entry);
    mount({ entry });
    const back = await drawerFor("Rowan Test");
    expect(reasonBox(back).value).toBe(LONG_REASON); // restored for this visit
    fireEvent.keyDown(back, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("closes on Escape again after a grant (the typed reason is gone, so the half-filled-form latch resets)", async () => {
    mount();
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    fireEvent.input(reasonBox(drawer)); // typing latches Escape off while a form is half filled
    submitGrant(drawer);
    await within(drawer).findByText(/is not blocked until/);

    fireEvent.keyDown(drawer, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });

  it("does nothing for a drawer that was closed while its answer was in flight: no step-up, no stashed draft", async () => {
    delete document.body.dataset.where;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount({
      grant: async () => {
        await gate;
        return { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close override panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());

    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(document.body.dataset.where).toBeUndefined();
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("still records a grant that landed after the drawer was closed, so the board shows it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount({
      grant: async () => {
        await gate;
        return { status: 201, body: overrideView() };
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close override panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());

    release();

    expect(await within(await region()).findByText("Override active")).toBeTruthy();
  });
});

describe("a field error and the fix", () => {
  it("retires the error and aria-invalid on a field as soon as it is edited", async () => {
    mount({
      grant: refusal(422, "VALIDATION_FAILED", [
        { field: "hours", code: "INVALID", message: "hours must be a whole number" },
      ]),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText("hours must be a whole number")).toBeTruthy();
    const hours = within(drawer).getByLabelText(/^Hours/);
    expect(hours.getAttribute("aria-invalid")).toBe("true");

    typeHours(drawer, "3");

    expect(within(drawer).queryByText("hours must be a whole number")).toBeNull();
    expect(hours.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("drops a too-short reason's error the moment the reason is long enough", async () => {
    mount();
    const drawer = await openDrawer();
    typeReason(drawer, SHORT_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText(/Enter at least 40 characters/)).toBeTruthy();

    typeReason(drawer, LONG_REASON);

    expect(within(drawer).queryByText(/Enter at least 40 characters/)).toBeNull();
    expect(within(drawer).getByText(/Long enough/)).toBeTruthy();
  });
});

describe("what a refused grant says", () => {
  it("tells a supervisor who is blocked on their own notes to close those first", async () => {
    mount({
      grant: refusal(403, "NOTE_CLOSURE_GRANTOR_BLOCKED", [
        { field: "x", code: "X", message: "raw server text" },
      ]),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(
      await within(drawer).findByText(
        "Close your own overdue notes before releasing someone else.",
      ),
    ).toBeTruthy();
    expect(within(drawer).queryByText("raw server text")).toBeNull();
    expect(reasonBox(drawer).value).toBe(LONG_REASON);
  });

  it("says there is nothing to lift for a clinician who is no longer blocked, and re-reads the board", async () => {
    const calls: Call[] = [];
    mount({ calls, grant: refusal(409, "NOTE_CLOSURE_SUBJECT_NOT_BLOCKED") });
    const drawer = await openDrawer();
    const boardReads = (): number =>
      calls.filter((c) => `${c.method} ${c.path}` === "GET /api/v1/encounters/overdue-notes")
        .length;
    expect(boardReads()).toBe(1);
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(
      await within(drawer).findByText(
        "There is nothing for you to lift for this clinician right now.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(boardReads()).toBe(2));
  });

  it("says who may revoke an override when a site-scoped supervisor tries to revoke another's (the one place this refusal is still sent)", async () => {
    mount({ revoke: refusal(403, "NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE") });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke override" }));
    expect(
      await within(drawer).findByText(
        "Only the supervisor who granted this override, or one who covers every site, can revoke it.",
      ),
    ).toBeTruthy();
    expect(within(drawer).queryByText("That clinician's note is outside your sites.")).toBeNull();
  });

  it("puts an identifier-shaped reason's refusal under the reason box in our own words", async () => {
    mount({
      grant: refusal(422, "VALIDATION_FAILED", [
        {
          field: "reason",
          code: "EVIDENCE_LOOKS_LIKE_PHI",
          message: "reason looks like it contains a patient identifier",
        },
      ]),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(
      await within(drawer).findByText("Remove names, SSNs and other identifiers from the reason."),
    ).toBeTruthy();
    expect(reasonBox(drawer).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the reason box", () => {
  it("stops at the server's 500 characters", async () => {
    mount();
    const drawer = await openDrawer();
    expect(reasonBox(drawer).maxLength).toBe(500);
  });

  it("keeps the server's own sentence for a reason error that is not the identifier refusal", async () => {
    mount({
      grant: refusal(422, "VALIDATION_FAILED", [
        { field: "reason", code: "INVALID", message: "reason must be at least 40 characters" },
      ]),
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);
    submitGrant(drawer);
    expect(await within(drawer).findByText("reason must be at least 40 characters")).toBeTruthy();
    expect(within(drawer).queryByText(/Remove names, SSNs/)).toBeNull();
  });
});

describe("a refresh that is refused", () => {
  const entry = `${PATH}?note=${NOTE_A_ID}`;
  const stepUpNeeded: Responder = () => ({
    status: 403,
    body: { error: { code: "STEP_UP_REQUIRED" } },
  });

  it("drops to Not available on a 403: no rows, no drawer, and the stashed step-up draft is discarded", async () => {
    let reads = 0;
    const board: Responder = () => {
      reads += 1;
      return reads <= 2
        ? { body: boardBody([noteRow(), atRiskNote]) }
        : { status: 403, body: { error: { code: "FORBIDDEN" } } };
    };
    // A first visit stashes a draft at step-up; coming back restores it (and keeps it stashed until it is spent or abandoned).
    mount({ entry, board, grant: stepUpNeeded });
    const first = await drawerFor("Rowan Test");
    typeReason(first, LONG_REASON);
    submitGrant(first);
    await screen.findByText("elsewhere");
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    markStepUpReturn(entry);
    mount({ entry, board });
    const back = await drawerFor("Rowan Test");
    expect(reasonBox(back).value).toBe(LONG_REASON);
    expect(stepUpDraftKeys().length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Overdue visit notes" })).toBeNull();
    expect(screen.queryByText("Vance, Ada")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(stepUpDraftKeys().length).toBe(0);
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
  });

  it("keeps the rows and the drawer when the refresh gets no answer at all (a network failure), like a 5xx", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        if (reads === 1) return { body: boardBody([noteRow(), atRiskNote]) };
        throw new Error("offline");
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(/The board could not be refreshed/)).toBeTruthy();
    expect(within(await region()).getByText("Vance, Ada")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Override for Rowan Test" })).toBe(drawer);
    expect(reasonBox(drawer).value).toBe(LONG_REASON);
  });
});

describe("the board reads itself again", () => {
  afterEach(() => vi.useRealTimers());
  const stageOfRow = (name: string): string =>
    within(
      within(screen.getByRole("region", { name: "Overdue visit notes" }))
        .getByText(name)
        .closest("tr") as HTMLElement,
    ).getAllByRole("cell")[7]?.textContent ?? "";

  it("re-reads on its refresh tick (OVERDUE_BOARD_REFRESH_MS, five minutes), quietly and in the background, so a row moves from At risk to Overdue and the counts follow", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls: Call[] = [];
    let reads = 0;
    mount({
      calls,
      board: () => {
        reads += 1;
        return {
          body: boardBody([
            reads === 1
              ? atRiskNote
              : {
                  ...atRiskNote,
                  stage: "overdue",
                  hoursOverdue: 0.4,
                  deadlineAt: hoursFromNow(-0.4),
                },
          ]),
        };
      },
    });
    await region();
    await within(await region()).findByText("Quill, Bo");
    expect(stageOfRow("Quill, Bo")).toContain("At risk");
    const boardCalls = (): Call[] =>
      calls.filter((c) => c.path === "/api/v1/encounters/overdue-notes");
    expect(boardCalls()).toHaveLength(1);
    expect(boardCalls()[0]?.headers.get("x-chartwarden-background")).toBeNull(); // the first read is the person's

    await act(async () => {
      vi.advanceTimersByTime(OVERDUE_BOARD_REFRESH_MS);
    });

    await waitFor(() => expect(boardCalls()).toHaveLength(2));
    expect(boardCalls()[1]?.headers.get("x-chartwarden-background")).toBe("1"); // a timer's read never counts as activity
    await waitFor(() => expect(stageOfRow("Quill, Bo")).toContain("Overdue"));
    const summary = screen.getByLabelText("Overdue note summary");
    expect(within(summary).getByText("Overdue").nextSibling?.textContent).toBe("1");
    expect(within(summary).getByText("At risk").nextSibling?.textContent).toBe("0");
  });

  it("polls every five minutes, not every minute: each read audits one event per patient on the page, so a minute poll of a full board was up to 200 audit rows a minute", async () => {
    expect(OVERDUE_BOARD_REFRESH_MS).toBe(5 * 60_000);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls: Call[] = [];
    mount({ calls });
    await region();
    const boardCalls = (): Call[] =>
      calls.filter((c) => c.path === "/api/v1/encounters/overdue-notes");
    expect(boardCalls()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(OVERDUE_BOARD_REFRESH_MS - 1);
    });
    expect(boardCalls()).toHaveLength(1); // not at one, two, three or four minutes: the countdowns tick on the client instead
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await waitFor(() => expect(boardCalls()).toHaveLength(2));
  });

  it("does not read on the tick while the tab is hidden, and the Refresh button stays a normal request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls: Call[] = [];
    mount({ calls });
    await region();
    const boardCalls = (): Call[] =>
      calls.filter((c) => c.path === "/api/v1/encounters/overdue-notes");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    await act(async () => {
      vi.advanceTimersByTime(OVERDUE_BOARD_REFRESH_MS * 2);
    });
    expect(boardCalls()).toHaveLength(1);

    hidden.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(boardCalls()).toHaveLength(2));
    expect(boardCalls()[1]?.headers.get("x-chartwarden-background")).toBeNull();
    hidden.mockRestore();
  });

  it("never starts a second background read while one is still in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const calls: Call[] = [];
    let release: () => void = () => undefined;
    let reads = 0;
    mount({
      calls,
      board: async () => {
        reads += 1;
        if (reads === 2)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { body: boardBody([noteRow(), atRiskNote]) };
      },
    });
    await region();
    const boardCalls = (): Call[] =>
      calls.filter((c) => c.path === "/api/v1/encounters/overdue-notes");

    await act(async () => {
      vi.advanceTimersByTime(OVERDUE_BOARD_REFRESH_MS * 3);
    });
    await waitFor(() => expect(boardCalls()).toHaveLength(2)); // the second is stuck; the later ticks did not pile on
    expect(boardCalls()).toHaveLength(2);
    release();
  });
});

describe("a refresh is announced afresh", () => {
  it("announces a second failure again (the error is not left mounted between them) and an unchanged answer again", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return reads === 2 || reads === 3
          ? { status: 500, body: { error: { code: "INTERNAL" } } }
          : { body: boardBody([noteRow(), atRiskNote]) };
      },
    });
    await region();
    const line = (): HTMLElement =>
      screen.getByText(/notes on the board: 0 escalated, 1 overdue, 1 at risk\./) as HTMLElement;
    const statusLine = line().closest("output") as HTMLElement;
    expect(statusLine.textContent).toMatch(/2 notes on the board/);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const firstError = await screen.findByText(/The board could not be refreshed/);
    expect(statusLine.textContent).toBe(""); // cleared when the refresh started: the next answer will be spoken afresh

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText(/The board could not be refreshed/)).toBeNull()); // gone while it re-reads
    const secondError = await screen.findByText(/The board could not be refreshed/);
    expect(secondError).not.toBe(firstError); // a new alert was inserted, so it is announced again

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(statusLine.textContent).toMatch(/2 notes on the board/));
  });
});

describe("what the drawer says when the board no longer needs it", () => {
  it("is an info notice, not the green of a success, when the note drops off the board", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return { body: boardBody(reads === 1 ? [noteRow(), atRiskNote] : [atRiskNote]) };
      },
    });
    const drawer = await openDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const notice = await within(drawer).findByText(/no longer on the board/);
    expect(notice.getAttribute("style")).not.toMatch(/success/);
    expect(notice.getAttribute("style")).toMatch(/on-surface-variant/);

    // ...and the same line for a real grant IS the success tone, so the distinction is the tone, not an accident.
  });

  it("keeps the drawer, with the typed reason, when a refresh says the organization no longer blocks, and says why", async () => {
    let reads = 0;
    mount({
      board: () => {
        reads += 1;
        return {
          body: boardBody([noteRow(), atRiskNote], { mode: reads === 1 ? "block" : "warn" }),
        };
      },
    });
    const drawer = await openDrawer();
    typeReason(drawer, LONG_REASON);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await within(drawer).findByText(/no longer blocks clinicians for overdue notes/),
    ).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Override for Rowan Test" })).toBe(drawer);
    expect(reasonBox(drawer).value).toBe(LONG_REASON);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close override panel" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });

  it("never opens a drawer from a deep link while the organization does not block", async () => {
    mount({
      entry: `${PATH}?note=${NOTE_A_ID}`,
      board: () => ({ body: boardBody([noteRow(), atRiskNote], { mode: "warn" }) }),
    });
    await region();
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("the first load", () => {
  it("does not nest one live region in another while it loads (the spinner is itself the status)", async () => {
    mount({ board: () => new Promise(() => undefined) });
    const spinner = await screen.findByLabelText("Loading");
    expect(spinner.parentElement?.closest("output")).toBeNull();
  });
});
