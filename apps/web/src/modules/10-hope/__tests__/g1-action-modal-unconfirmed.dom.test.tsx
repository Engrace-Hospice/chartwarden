// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";
import type { HopeAction } from "../hope-action-modal";

// Group g1: a write whose outcome could not be confirmed (no answer, a timeout, an empty or faulting 5xx) may still have been applied, and
// its words tell the clinician to check the record. The page behind the dialog is therefore re-read (`onConflict`), for every action
// (the summary request and the recompute send a fresh key each time, so a second press is a NEW request). A refusal that was answered
// (a 4xx) applied nothing, so it is shown and nothing is re-read.

afterEach(cleanup);

const SETUP: Record<HopeAction, { name: string; submit: string; needsReason: boolean }> = {
  skip: { name: "Skip timepoint window", submit: "Skip window", needsReason: true },
  "summary-pdf": { name: "Request HOPE summary", submit: "Request summary", needsReason: false },
  regenerate: {
    name: "Create missing timepoint windows",
    submit: "Create missing windows",
    needsReason: false,
  },
  "cancel-package": { name: "Cancel HOPE package", submit: "Cancel package", needsReason: true },
};

const empty = (status: number) => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});
const withBody = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});

function renderAction(action: HopeAction, answer: () => unknown) {
  const post = vi.fn(async () => answer());
  const onConflict = vi.fn();
  const onDone = vi.fn();
  render(
    <ApiClientProvider client={{ GET: vi.fn(), POST: post } as unknown as ApiClient}>
      <HopeActionModal
        open
        action={action}
        targetId="target-1"
        onClose={vi.fn()}
        onDone={onDone}
        onConflict={onConflict}
      />
    </ApiClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: SETUP[action].name });
  if (SETUP[action].needsReason) {
    const select = within(dialog).getByLabelText(/Reason/) as HTMLSelectElement;
    fireEvent.change(select, {
      target: { value: (select.querySelectorAll("option")[1] as HTMLOptionElement).value },
    });
  }
  const submit = () => within(dialog).getByRole("button", { name: SETUP[action].submit });
  return { dialog, post, onConflict, onDone, submit };
}

describe.each(Object.keys(SETUP) as HopeAction[])("the %s dialog", (action) => {
  it("re-reads the page after a request that got no answer, and frees the dialog", async () => {
    const { dialog, post, onConflict, onDone, submit } = renderAction(action, () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(submit());
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Could not confirm");
    expect(post).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("re-reads the page after an empty 5xx, which may have been applied", async () => {
    const { dialog, onConflict } = renderAction(action, () => empty(503));
    fireEvent.click(within(dialog).getByRole("button", { name: SETUP[action].submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "could not be confirmed",
    );
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("re-reads the page after a 5xx that carries a body", async () => {
    const { dialog, onConflict } = renderAction(action, () =>
      withBody(500, "INTERNAL", "stack trace that is not for a clinician"),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: SETUP[action].submit }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toContain("stack trace");
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("does not re-read the page for a refusal the server explained (a 4xx applied nothing)", async () => {
    const { dialog, onConflict } = renderAction(action, () =>
      withBody(422, "VALIDATION_FAILED", "That is not allowed."),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: SETUP[action].submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "That is not allowed.",
    );
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("does not re-read the page for a 4xx with no body", async () => {
    const { dialog, onConflict } = renderAction(action, () => empty(400));
    fireEvent.click(within(dialog).getByRole("button", { name: SETUP[action].submit }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("refused");
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("sends one request for a double click, and re-reads once", async () => {
    let release: (reply: unknown) => void = () => undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { dialog, post, onConflict, submit } = renderAction(action, () => held);
    const button = submit(); // the label becomes "Working…" while the request is out, so keep the element
    fireEvent.click(button);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    release(empty(502));
    await within(dialog).findByRole("alert");
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
  });
});
