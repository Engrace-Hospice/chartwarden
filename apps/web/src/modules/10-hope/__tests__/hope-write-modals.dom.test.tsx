// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeActionModal } from "../hope-action-modal";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { HopeRecordModal } from "../hope-record-modal";
import { RecordCmsResultModal } from "../record-cms-result-modal";
import { SESSION, ok, stubProperty } from "./workspace-test-kit";

// A holder of the override permission: the server refuses `adminOverride` (403) from anyone else, so the modal offers the control only to
// a session that is not known to lack it (g1-record-override-permission.dom.test.tsx).
const OVERRIDE_SESSION = { ...SESSION, permissions: ["hope.admin.late_deadline_override"] };

// The two write dialogs the worklists and the patient timeline share (skip / recompute / summary / cancel package, and
// the recording modal). Each must free itself however its request ends, keep keyboard focus inside after a failure, and
// survive a caller whose completion callback throws.

type Mocked = ReturnType<typeof vi.fn>;
const refusal = (status: number, message: string) => ({
  data: undefined,
  error: { error: { code: "CONFLICT", message } },
  response: new Response(null, { status }),
});

function clientWith(post: Mocked): ApiClient {
  return { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
}

function renderAction(
  post: Mocked,
  handlers: { onDone?: () => void; onClose?: () => void; onConflict?: () => void } = {},
) {
  const onClose = handlers.onClose ?? vi.fn();
  render(
    <ApiClientProvider client={clientWith(post)}>
      <HopeActionModal
        open
        action="skip"
        targetId="schedule-1"
        onClose={onClose}
        onDone={handlers.onDone ?? vi.fn()}
        onConflict={handlers.onConflict}
      />
    </ApiClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Skip timepoint window" });
  // A skip is terminal, so the reason is the clinician's own choice: nothing is preselected.
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: "patient_deceased" },
  });
  return { dialog, onClose };
}

/** A scheduled window whose late deadline passed long ago, so a capture now is "past the late deadline". */
const EXPIRED_WINDOW = {
  id: "schedule-9",
  rfaKind: "02_huv1",
  windowOpensAt: "2000-01-01T00:00:00.000Z",
  windowClosesAt: "2000-01-10T00:00:00.000Z",
  lateDeadlineAt: "2000-01-20T00:00:00.000Z",
};

function renderRecord(
  post: Mocked,
  handlers: {
    onDone?: (assessment: unknown) => void;
    onClose?: () => void;
    onOpenExisting?: (assessment: unknown) => void;
    window?: typeof EXPIRED_WINDOW;
  } = {},
) {
  const onClose = handlers.onClose ?? vi.fn();
  render(
    <SessionProvider session={OVERRIDE_SESSION}>
      <ApiClientProvider client={clientWith(post)}>
        <HopeRecordModal
          open
          admissionId="adm-1"
          window={handlers.window ?? null}
          onClose={onClose}
          onDone={handlers.onDone ?? vi.fn()}
          onOpenExisting={handlers.onOpenExisting}
        />
      </ApiClientProvider>
    </SessionProvider>,
  );
  return { dialog: screen.getByRole("dialog", { name: "Record HOPE timepoint" }), onClose };
}

const press = (dialog: HTMLElement, name: string) =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

/** Runs the clock past the request timeout, then hands real timers back so the queries below can poll. */
async function letTheRequestTimeOut(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
  });
  vi.useRealTimers();
}

const restores: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const restore of restores.splice(0).reverse()) restore();
});

describe.each([
  ["the action modal", renderAction, "Skip window", "Cancel"],
  ["the recording modal", renderRecord, "Record draft", "Cancel"],
] as const)("%s", (_name, renderModal, submit, cancel) => {
  it("moves focus to the refusal, so Escape and Tab keep working inside the dialog", async () => {
    const post = vi.fn(async () => refusal(409, "This window is already complete."));
    const { dialog, onClose } = renderModal(post);
    const button = within(dialog).getByRole("button", { name: submit });
    button.focus();
    fireEvent.click(button);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("This window is already complete.");
    expect(document.activeElement).toBe(alert);
    fireEvent.keyDown(alert, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is freed after the wait when the request is never answered, and says it could not confirm", async () => {
    const post = vi.fn(() => new Promise(() => undefined));
    const { dialog, onClose } = renderModal(post);
    vi.useFakeTimers();
    fireEvent.click(within(dialog).getByRole("button", { name: submit }));
    expect(
      (within(dialog).getByRole("button", { name: /^(Working…|Recording…)$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await letTheRequestTimeOut();
    expect(within(dialog).getByRole("alert").textContent).toContain("Could not confirm that");
    const cancelButton = within(dialog).getByRole("button", { name: cancel }) as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);
    fireEvent.click(cancelButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still closes when the caller's completion callback throws, and reports the throw instead of leaving it unhandled", async () => {
    const reportError = vi.fn();
    restores.push(stubProperty(globalThis, "reportError", reportError));
    const boom = new Error("caller bug");
    const post = vi.fn(async () => ok({ id: "created-1" }));
    const { dialog, onClose } = renderModal(post, {
      onDone: () => {
        throw boom;
      },
    });
    press(dialog, submit);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(reportError).toHaveBeenCalledWith(boom);
  });
});

describe("the action modal's skip dialog", () => {
  it("offers no free-text note: the server records only the reason code, so a note would be silently dropped", async () => {
    const post = vi.fn(async () => ok({ id: "schedule-1" }));
    const { dialog } = renderAction(post);
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    press(dialog, "Skip window");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({ reasonCode: "patient_deceased" });
  });
});

describe("a caller whose conflict handler throws", () => {
  /** A 409 the dialog answers by calling `onConflict`, which throws: reported, never an unhandled rejection. */
  const boom = new Error("caller bug");

  it("is reported by the action modal, which still shows the refusal and stays usable", async () => {
    const reportError = vi.fn();
    restores.push(stubProperty(globalThis, "reportError", reportError));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    restores.push(() => void process.off("unhandledRejection", unhandled));
    const post = vi.fn(async () => refusal(409, "This window is already complete."));
    const { dialog } = renderAction(post, {
      onConflict: () => {
        throw boom;
      },
    });
    press(dialog, "Skip window");
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "This window is already complete.",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportError).toHaveBeenCalledWith(boom);
    expect(unhandled).not.toHaveBeenCalled();
    expect(
      (within(dialog).getByRole("button", { name: "Skip window" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  describe("the CMS result modal", () => {
    const ITEMS = [{ assessmentId: "a-1", label: "Lovelace, Ada — Admission" }];
    function renderResult(post: Mocked, onConflict: () => void) {
      render(
        <ApiClientProvider client={clientWith(post)}>
          <RecordCmsResultModal
            open
            submissionId="sub-1"
            items={ITEMS}
            onClose={vi.fn()}
            onDone={vi.fn()}
            onConflict={onConflict}
          />
        </ApiClientProvider>,
      );
      const dialog = screen.getByRole("dialog", { name: "Record CMS result" });
      fireEvent.change(
        within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 1"),
        {
          target: { value: "accepted" },
        },
      );
      press(dialog, "Review and record");
      press(dialog, "Confirm and record");
      return dialog;
    }

    it.each([
      ["a 409 refusal", async () => refusal(409, "Result already recorded.")],
      ["a rejected request", async () => Promise.reject(new TypeError("network down"))],
    ])("is reported, not left unhandled, on %s", async (_name, answer) => {
      const reportError = vi.fn();
      restores.push(stubProperty(globalThis, "reportError", reportError));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      restores.push(() => void process.off("unhandledRejection", unhandled));
      const dialog = renderResult(vi.fn(answer), () => {
        throw boom;
      });
      await within(dialog).findByRole("alert");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reportError).toHaveBeenCalledWith(boom);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});

describe("the recording modal", () => {
  it("sends the acting user's own discipline (never a role key) with the capture", async () => {
    const post = vi.fn(async () => ok({ id: "created-2" }));
    const { dialog } = renderRecord(post);
    press(dialog, "Record draft");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(path).toBe("/api/v1/admissions/{admissionId}/hope/timepoints");
    expect(init.body.authorDiscipline).toBe("RN");
  });
});

describe("the recording modal past the late deadline", () => {
  const override = () =>
    screen.getByRole("checkbox", { name: "Record with administrative override" });
  const justification = () =>
    screen.getByRole("textbox", { name: /Justification for the override/ });

  it("sends the justification the server requires with the override, and not before there is one", async () => {
    const post = vi.fn(async () => ok({ id: "created-3" }));
    const { dialog } = renderRecord(post, { window: EXPIRED_WINDOW });
    fireEvent.click(override());
    const record = within(dialog).getByRole("button", {
      name: "Record draft",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);

    fireEvent.change(justification(), { target: { value: "too short" } });
    expect(record.disabled).toBe(true);
    fireEvent.change(justification(), {
      target: { value: "  Visit was completed on time; the entry was delayed by an outage.  " },
    });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body.adminOverride).toBe(true);
    expect(init.body.adminOverrideJustification).toBe(
      "Visit was completed on time; the entry was delayed by an outage.",
    );
  });

  it("tells the admin the bounds, that the justification goes into the audit trail for good, and that it must not name a patient", () => {
    const { dialog } = renderRecord(
      vi.fn(async () => ok({ id: "created-hint" })),
      {
        window: EXPIRED_WINDOW,
      },
    );
    fireEvent.click(override());

    const hint = within(dialog).getByText(/do not enter a patient's name or a Social Security/i);
    expect(hint.textContent).toContain("Between 20 and 1000 characters");
    expect(hint.textContent).toContain("cannot be changed later");
  });

  it("sends neither without the override ticked", async () => {
    const post = vi.fn(async () => ok({ id: "created-4" }));
    const { dialog } = renderRecord(post, { window: EXPIRED_WINDOW });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record draft" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body).not.toHaveProperty("adminOverride");
    expect(init.body).not.toHaveProperty("adminOverrideJustification");
  });
});

// What the dialog asks for follows the server's capture gate: a visit is judged at the later of its date and now.
describe("the recording modal's late and expired controls", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const pad = (n: number) => String(n).padStart(2, "0");
  /** A `datetime-local` value (local time, minute precision) for the instant `ms`. */
  const localInput = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  /** A window whose edges are `opens`, `closes` and `late` days from now (negative: in the past). */
  const windowAt = (opens: number, closes: number, late: number) => {
    const now = Date.now();
    return {
      id: "schedule-5",
      rfaKind: "02_huv1",
      windowOpensAt: new Date(now + opens * DAY).toISOString(),
      windowClosesAt: new Date(now + closes * DAY).toISOString(),
      lateDeadlineAt: new Date(now + late * DAY).toISOString(),
    };
  };
  const visitDatedDaysAgo = (days: number) =>
    fireEvent.change(screen.getByLabelText("Visit date & time"), {
      target: { value: localInput(Date.now() - days * DAY) },
    });

  it("asks for a late reason, and sends it, for a visit dated inside the window but entered after it closed", async () => {
    const post = vi.fn(async () => ok({ id: "created-5" }));
    const { dialog } = renderRecord(post, { window: windowAt(-10, -3, 10) });
    visitDatedDaysAgo(5); // inside the window by its own date; now is 3 days past the close
    expect(within(dialog).getByText("Late completion")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Late completion reason"), {
      target: { value: "hospitalization" },
    });
    press(dialog, "Record draft");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body.lateCompletionReasonCode).toBe("hospitalization");
  });

  it("offers the administrative override for a visit dated inside the window but entered after the late deadline", () => {
    const { dialog } = renderRecord(vi.fn(), { window: windowAt(-30, -20, -10) });
    visitDatedDaysAgo(25);
    expect(within(dialog).getByText("Past the late deadline")).toBeTruthy();
    expect(
      within(dialog).getByRole("checkbox", { name: "Record with administrative override" }),
    ).toBeTruthy();
  });

  it("asks for nothing when the visit is dated, and entered, inside the window", () => {
    const { dialog } = renderRecord(vi.fn(), { window: windowAt(-1, 2, 5) });
    visitDatedDaysAgo(0);
    expect(within(dialog).queryByText("Late completion")).toBeNull();
    expect(within(dialog).queryByText("Past the late deadline")).toBeNull();
  });

  it("judges a visit dated before the window opens on its own date, however late it is entered", () => {
    const { dialog } = renderRecord(vi.fn(), { window: windowAt(-1, 2, 5) });
    visitDatedDaysAgo(5);
    expect(within(dialog).getByText(/before the window opens/)).toBeTruthy();
    expect(within(dialog).queryByText("Late completion")).toBeNull();
  });
});

describe("the recording modal's free-text limits", () => {
  it("stops the entry at the server's bounds, so an over-long one never reaches it", () => {
    const { dialog } = renderRecord(vi.fn());
    expect(within(dialog).queryByLabelText("Other symptom — label")).toBeNull(); // until "Other" has a severity
    fireEvent.change(within(dialog).getByLabelText("Other"), { target: { value: "mild" } });
    expect(
      (within(dialog).getByLabelText("Other symptom — label") as HTMLInputElement).maxLength,
    ).toBe(100);
    fireEvent.click(within(dialog).getByLabelText("Opioid prescribed for pain"));
    expect(
      (within(dialog).getByLabelText("Bowel regimen contraindication") as HTMLInputElement)
        .maxLength,
    ).toBe(500);
  });
});

describe("the recording modal when the server answers with a draft that was already there", () => {
  const sentTarget = (post: Mocked) =>
    (post.mock.calls[0] as unknown as [string, { body: { targetDate: string } }])[1].body
      .targetDate;

  it("says what was entered was not saved, and only then lets the clinician open that draft", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const onOpenExisting = vi.fn();
    const draft = { id: "draft-0", targetDate: "2020-01-01T00:00:00.000Z" };
    const post = vi.fn(async () => ok(draft));
    const { dialog } = renderRecord(post, { onDone, onClose, onOpenExisting });
    press(dialog, "Record draft");

    expect((await within(dialog).findByRole("status")).textContent).toContain(
      "already exists, so what you entered here was not saved",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Record draft" })).toBeNull();

    press(dialog, "Open existing draft");
    expect(onOpenExisting).toHaveBeenCalledWith(draft);
    expect(onDone).toHaveBeenCalledWith(draft);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without opening it, but still tells the caller to refresh, on Close", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const onOpenExisting = vi.fn();
    const post = vi.fn(async () => ok({ id: "draft-0", targetDate: "2020-01-01T00:00:00.000Z" }));
    const { dialog } = renderRecord(post, { onDone, onClose, onOpenExisting });
    press(dialog, "Record draft");
    await within(dialog).findByRole("status");
    press(dialog, "Close");
    expect(onOpenExisting).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once, with no notice, when the draft it got back is the one it just created", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const post = vi.fn(async (_path: string, init?: { body?: { targetDate?: string } }) =>
      ok({ id: "created-6", targetDate: init?.body?.targetDate }),
    );
    const { dialog } = renderRecord(post, { onDone, onClose });
    press(dialog, "Record draft");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(sentTarget(post)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
