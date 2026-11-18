// The tenant note-closure policy screen (ADR-0113): the effective values, the three modes in plain language, the deadline bounds, the
// confirm step before blocking can start limiting clinicians, and the step-up round trip. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { markStepUpReturn, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { ClosurePolicy } from "../closure-policy";
import {
  type Call,
  type Responder,
  hoursFromNow,
  mountScreen,
  policyBody,
  refusal,
  writes,
} from "./closure-test-harness";

const PATH = "/admin/closure-policy";
const POLICY = "/api/v1/encounters/closure-policy";

interface Opts {
  read?: Responder;
  write?: Responder;
  calls?: Call[];
}

function mount(opts: Opts = {}): Call[] {
  const calls = opts.calls ?? [];
  mountScreen({
    calls,
    routePath: PATH,
    entry: PATH,
    permissions: ["encounter.closure_policy_admin"],
    element: <ClosurePolicy />,
    routes: {
      [`GET ${POLICY}`]: opts.read ?? (() => ({ body: policyBody() })),
      [`PUT ${POLICY}`]:
        opts.write ?? ((call) => ({ body: policyBody(call.body as Record<string, unknown>) })),
    },
  });
  return calls;
}

const modeRadio = (name: string): HTMLInputElement =>
  screen.getByRole("radio", { name }) as HTMLInputElement;
const deadlineInput = (): HTMLInputElement =>
  screen.getByLabelText(/^Deadline \(hours\)/) as HTMLInputElement;
const save = (): HTMLElement => screen.getByRole("button", { name: "Save policy" });
const ready = (): Promise<unknown> => screen.findByRole("radio", { name: "Warn only" });
const inForce = (): HTMLElement =>
  screen.getByText("In force now").closest("section") as HTMLElement;
const setDeadline = (value: string): void => {
  fireEvent.change(deadlineInput(), { target: { value } });
};

describe("reading the policy", () => {
  it("shows the effective values and the plain-language effect of each mode", async () => {
    mount();
    await ready();
    expect(within(inForce()).getByText("Warn only")).toBeTruthy();
    expect(within(inForce()).getByText("24 hours after a visit starts")).toBeTruthy();
    expect(modeRadio("Warn only").checked).toBe(true);
    expect(deadlineInput().value).toBe("24");
    expect(screen.getByText(/can only close notes and use patient-safety routes/)).toBeTruthy();
    expect(screen.getByText(/No alerts are sent and nobody is limited/)).toBeTruthy();
  });

  it("shows when blocking counts from, once the server has stamped it", async () => {
    mount({
      read: () => ({
        body: policyBody({ mode: "block", thresholdHours: 12, enforceFrom: hoursFromNow(-2) }),
      }),
    });
    await screen.findByRole("radio", { name: "Warn, then block" });
    expect(screen.getByText("Blocking counts from")).toBeTruthy();
    expect(modeRadio("Warn, then block").checked).toBe(true);
    expect(deadlineInput().value).toBe("12");
  });

  it("shows an error with a retry, not a form of defaults, when the read fails", async () => {
    let attempts = 0;
    mount({
      read: () => {
        attempts += 1;
        return attempts === 1
          ? { status: 500, body: { error: { code: "INTERNAL" } } }
          : { body: policyBody() };
      },
    });
    expect(await screen.findByText("Closure policy unavailable")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });

  it("says plainly that the screen is not available when the server refuses it", async () => {
    mount({ read: refusal(403, "FORBIDDEN") });
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("saving", () => {
  it("has nothing to save until something changes", async () => {
    mount();
    await ready();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No changes to save.")).toBeTruthy();
    fireEvent.click(modeRadio("Off"));
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["0", "169", "24.5", "", "a day"])(
    "refuses a %j hour deadline without sending",
    async (value) => {
      const calls = mount();
      await ready();
      setDeadline(value);
      fireEvent.click(save());
      expect(await screen.findByText("Enter a whole number of hours from 1 to 168.")).toBeTruthy();
      expect(writes(calls)).toHaveLength(0);
    },
  );

  it("saves a change that limits nobody without a confirm step, and shows the saved values", async () => {
    const calls = mount();
    await ready();
    fireEvent.click(modeRadio("Off"));
    setDeadline("48");
    fireEvent.click(save());
    expect(await screen.findByText(/Policy saved: off, 48-hour deadline/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const [put] = writes(calls);
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({ mode: "off", thresholdHours: 48 });
    expect(put?.headers.get("idempotency-key")).toBeTruthy();
    expect(within(inForce()).getByText("Off")).toBeTruthy();
  });

  it("asks first before blocking: the fresh grace window and the limits are explained, and Cancel sends nothing", async () => {
    const calls = mount();
    await ready();
    fireEvent.click(modeRadio("Warn, then block"));
    fireEvent.click(save());
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on blocking?" });
    expect(within(dialog).getByText(/fresh full window/)).toBeTruthy();
    expect(
      within(dialog).getByText(/can only close notes and use the patient-safety routes/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes(calls)).toHaveLength(0);
  });

  it("saves blocking once confirmed and tells the admin the server stamped a fresh window", async () => {
    const enforceFrom = hoursFromNow(0);
    const calls = mount({
      write: (call) => ({ body: policyBody({ ...(call.body as object), enforceFrom }) }),
    });
    await ready();
    fireEvent.click(modeRadio("Warn, then block"));
    fireEvent.click(save());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on blocking" }));
    expect(await screen.findByText(/Notes already overdue get a fresh window/)).toBeTruthy();
    expect(writes(calls)[0]?.body).toEqual({ mode: "block", thresholdHours: 24 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks again before a shorter deadline while blocking is on, but not before a longer one", async () => {
    const calls = mount({
      read: () => ({
        body: policyBody({ mode: "block", thresholdHours: 24, enforceFrom: hoursFromNow(-5) }),
      }),
    });
    await screen.findByRole("radio", { name: "Warn, then block" });
    setDeadline("48");
    fireEvent.click(save());
    await screen.findByText(/Policy saved/);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    setDeadline("12");
    fireEvent.click(save());
    const dialog = await screen.findByRole("alertdialog", { name: "Shorten the deadline?" });
    expect(
      within(dialog).getByText(/any note older than the new deadline is overdue at once/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Shorten the deadline" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]?.body).toEqual({ mode: "block", thresholdHours: 12 });
  });

  it("shows the server's refusal in words and keeps the edit", async () => {
    mount({
      write: refusal(422, "VALIDATION_ERROR", [
        {
          field: "thresholdHours",
          code: "INVALID",
          message: "thresholdHours must be from 1 to 168",
        },
      ]),
    });
    await ready();
    fireEvent.click(modeRadio("Off"));
    fireEvent.click(save());
    expect(await screen.findByText("thresholdHours must be from 1 to 168")).toBeTruthy();
    expect(modeRadio("Off").checked).toBe(true);
    expect(screen.queryByText(/Policy saved/)).toBeNull();
  });

  it("says it could not save, and shows no success, when the request gets no answer", async () => {
    mount({
      write: () => {
        throw new Error("offline");
      },
    });
    await ready();
    fireEvent.click(modeRadio("Off"));
    fireEvent.click(save());
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    expect(screen.queryByText(/Policy saved/)).toBeNull();
  });

  it("does not send twice when saved again while the first is in flight", async () => {
    const calls = mount({
      write: (call) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ body: policyBody(call.body as Record<string, unknown>) }), 20),
        ),
    });
    await ready();
    fireEvent.click(modeRadio("Off"));
    const form = save().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText(/Policy saved/);
    expect(writes(calls)).toHaveLength(1);
  });
});

describe("step-up", () => {
  it("round-trips through step-up: the edit is restored on return and nothing is re-sent for the admin", async () => {
    const calls: Call[] = [];
    let ceremonyDone = false;
    const write: Responder = (call) =>
      ceremonyDone
        ? { body: policyBody(call.body as Record<string, unknown>) }
        : { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
    mount({ calls, write });
    await ready();
    fireEvent.click(modeRadio("Off"));
    setDeadline("36");
    fireEvent.click(save());
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(PATH)}`);
    expect(writes(calls)).toHaveLength(1);
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    ceremonyDone = true;
    markStepUpReturn(PATH);
    mount({ calls, write });
    await ready();
    expect(modeRadio("Off").checked).toBe(true);
    expect(deadlineInput().value).toBe("36");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes(calls)).toHaveLength(1);
    fireEvent.click(save());
    await screen.findByText(/Policy saved: off, 36-hour deadline/);
    expect(writes(calls)).toHaveLength(2);
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("discards an abandoned draft on an ordinary visit (no step-up return marker)", async () => {
    mount({ write: () => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } }) });
    await ready();
    fireEvent.click(modeRadio("Off"));
    fireEvent.click(save());
    await screen.findByText("elsewhere");
    cleanup();

    mount();
    await ready();
    expect(modeRadio("Warn only").checked).toBe(true);
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("stops at the confirm step first: the step-up refusal comes only after the admin confirmed blocking", async () => {
    const calls = mount({
      write: () => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } }),
    });
    await ready();
    fireEvent.click(modeRadio("Warn, then block"));
    fireEvent.click(save());
    expect(writes(calls)).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on blocking" }));
    await screen.findByText("elsewhere");
    expect(writes(calls)).toHaveLength(1);
  });
});

describe("what a screen reader hears, and where focus goes", () => {
  it("announces a saved policy through a status line the panel already had, and focuses the panel heading", async () => {
    mount();
    await ready();
    const line = within(inForce()).getByRole("status");
    expect(line.textContent).toBe("");

    fireEvent.click(modeRadio("Off"));
    fireEvent.click(save());
    await screen.findByText(/Policy saved: off/);

    expect(within(inForce()).getByRole("status")).toBe(line); // never remounted: the text arrived in a region that was already there
    expect(line.textContent).toMatch(/Policy saved: off/);
    expect(document.activeElement).toBe(screen.getByText("In force now"));
  });

  it("focuses the panel heading, not the Save button that is disabled again, after a confirmed save", async () => {
    mount();
    await ready();
    fireEvent.click(modeRadio("Warn, then block"));
    fireEvent.click(save());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on blocking" }));
    await screen.findByText(/Policy saved: warn, then block/);

    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("In force now")));
  });
});

describe("a restored edit and a retry", () => {
  it("restores the stashed edit once: a Refresh afterwards shows what the server holds, not the old edit", async () => {
    const calls: Call[] = [];
    const write: Responder = () => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } });
    mount({ calls, write });
    await ready();
    fireEvent.click(modeRadio("Off"));
    setDeadline("36");
    fireEvent.click(save());
    await screen.findByText("elsewhere");
    cleanup();

    markStepUpReturn(PATH);
    mount({ calls, write });
    await ready();
    expect(deadlineInput().value).toBe("36"); // restored for this visit
    expect(stepUpDraftKeys().length).toBe(0); // and spent

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await ready();
    expect(deadlineInput().value).toBe("24");
    expect(modeRadio("Warn only").checked).toBe(true);
  });

  it("retires the deadline error as soon as the field is edited", async () => {
    mount();
    await ready();
    setDeadline("0");
    fireEvent.click(save());
    expect(await screen.findByText("Enter a whole number of hours from 1 to 168.")).toBeTruthy();
    expect(deadlineInput().getAttribute("aria-invalid")).toBe("true");

    setDeadline("12");

    expect(screen.queryByText("Enter a whole number of hours from 1 to 168.")).toBeNull();
    expect(deadlineInput().getAttribute("aria-invalid")).not.toBe("true");
  });
});

describe("leaving while a save is in flight", () => {
  it("does not step up, stash a draft or navigate for an admin who already left the screen", async () => {
    delete document.body.dataset.where;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount({
      write: async () => {
        await gate;
        return { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
      },
    });
    await ready();
    fireEvent.click(modeRadio("Off"));
    fireEvent.click(save());
    cleanup(); // the admin leaves while the save is still going

    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stepUpDraftKeys().length).toBe(0);
    expect(document.body.dataset.where).toBeUndefined();
  });
});
