// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";
import type { HopeAction } from "../hope-action-modal";

// Group g1: a 409 M10_RECORD_BUSY is a lock wait that timed out and the step was NOT applied, so the page behind the dialog is not
// stale and must not be re-read (a failed re-read would put a second, false alert behind the dialog). Any other 409 still is.

afterEach(cleanup);

const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";

const refusal409 = (code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status: 409 }),
});

const SETUP: Record<"skip" | "cancel-package", { name: string; submit: string; reason: string }> = {
  skip: { name: "Skip timepoint window", submit: "Skip window", reason: "patient_deceased" },
  "cancel-package": {
    name: "Cancel HOPE package",
    submit: "Cancel package",
    reason: "uploaded_in_error",
  },
};

function renderAction(action: "skip" | "cancel-package", answer: () => unknown) {
  const post = vi.fn(async () => answer());
  const onConflict = vi.fn();
  render(
    <ApiClientProvider client={{ GET: vi.fn(), POST: post } as unknown as ApiClient}>
      <HopeActionModal
        open
        action={action as HopeAction}
        targetId="target-1"
        onClose={vi.fn()}
        onDone={vi.fn()}
        onConflict={onConflict}
      />
    </ApiClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: SETUP[action].name });
  const select = within(dialog).getByLabelText(/Reason/) as HTMLSelectElement;
  const reason =
    action === "cancel-package"
      ? ((select.querySelectorAll("option")[1] as HTMLOptionElement).value ?? "")
      : SETUP[action].reason;
  fireEvent.change(select, { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole("button", { name: SETUP[action].submit }));
  return { dialog, onConflict, post };
}

describe.each(["skip", "cancel-package"] as const)("the %s dialog on a 409", (action) => {
  it("shows the server's words and does not re-read the page for M10_RECORD_BUSY", async () => {
    const { dialog, onConflict, post } = renderAction(action, () =>
      refusal409("M10_RECORD_BUSY", BUSY_MESSAGE),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain(BUSY_MESSAGE);
    expect(post).toHaveBeenCalledTimes(1);
    expect(onConflict).not.toHaveBeenCalled();
    // The step was not applied, so the same request may be sent again from the same dialog.
    expect(
      (within(dialog).getByRole("button", { name: SETUP[action].submit }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("still re-reads the page for a 409 that says the record changed", async () => {
    const { dialog, onConflict } = renderAction(action, () =>
      refusal409("M10_SUBMISSION_CANCELLED", "The package was already cancelled."),
    );
    await within(dialog).findByRole("alert");
    expect(onConflict).toHaveBeenCalledTimes(1);
  });
});
