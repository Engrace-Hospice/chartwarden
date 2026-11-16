// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HopeAction, HopeActionModal } from "../hope-action-modal";
import { ok } from "./workspace-test-kit";

// Group g3: a 404 inside any of the four action dialogs (skip, cancel package, create missing windows, request summary) is the record
// being gone (or no longer readable by this user). The dialog says so in one fixed sentence, never the server's text (which carries the
// record's id and doubles "not found"), and the page behind it is read again so the row stops offering the action. Any other 4xx
// refusal says nothing changed, so the page is left alone.

afterEach(cleanup);

const GONE = "That HOPE record is no longer available to you.";
const UUID = "cccccccc-3333-4333-8333-cccccccccccc";
const NOT_FOUND = {
  data: undefined,
  error: { error: { code: "NOT_FOUND", message: `HOPE schedule ${UUID} not found not found` } },
  response: new Response(null, { status: 404 }),
};

/** What each ceremony asks before its button works, and what that button says. */
const CASES: ReadonlyArray<readonly [HopeAction, string, string | null]> = [
  ["skip", "Skip window", "patient_deceased"],
  ["cancel-package", "Cancel package", "other"],
  ["regenerate", "Create missing windows", null],
  ["summary-pdf", "Request summary", null],
];

function mount(action: HopeAction, post: ReturnType<typeof vi.fn>) {
  const onConflict = vi.fn();
  const onDone = vi.fn();
  const onClose = vi.fn();
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <HopeActionModal
        open
        action={action}
        targetId={UUID}
        onClose={onClose}
        onDone={onDone}
        onConflict={onConflict}
      />
    </ApiClientProvider>,
  );
  return { dialog: screen.getByRole("dialog"), onConflict, onDone, onClose };
}

describe.each(CASES)("the %s dialog", (action, submitName, reason) => {
  function press(dialog: HTMLElement): void {
    if (reason !== null) {
      fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
    }
    fireEvent.click(within(dialog).getByRole("button", { name: submitName }));
  }

  it("says the record is no longer available, in a fixed sentence, and re-reads the page behind it (404)", async () => {
    const { dialog, onConflict, onDone, onClose } = mount(
      action,
      vi.fn(async () => NOT_FOUND),
    );

    press(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe(GONE);
    expect(dialog.textContent).not.toContain(UUID);
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-reads for a 404 that carries no body too (the dialog then says the server gave no reason)", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: undefined,
      response: new Response(null, { status: 404 }),
    }));
    const { dialog, onConflict } = mount(action, post);

    press(dialog);

    await within(dialog).findByRole("alert");
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
  });

  it("does not re-read the page for a refusal that says nothing changed (403)", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "FORBIDDEN", message: "server words for that" } },
      response: new Response(null, { status: 403 }),
    }));
    const { dialog, onConflict } = mount(action, post);

    press(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "server words for that",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConflict).not.toHaveBeenCalled();
  });
});
