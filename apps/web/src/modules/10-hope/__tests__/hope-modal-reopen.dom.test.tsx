// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";
import { RecordCmsResultModal } from "../record-cms-result-modal";

// Two dialogs stay mounted while shut (the submission page keeps them for the batch it shows) and keep their state between uses.
// What the last use left (an error, a discard question) must not paint for a frame when the dialog is opened again, before an effect
// on open clears it. Such a frame is gone by the time a test looks, so the page's changes are recorded while the dialog opens: a stale
// element that was painted and then cleared shows up as a REMOVAL (an added node is a live reference, so a later removal of something
// inside it no longer shows through it).

afterEach(cleanup);

/** Starts recording; calling the result gives every element the page gained or lost since, a frame that came and went included. */
function recordChanges(): () => Element[] {
  const touched: Element[] = [];
  const observer = new MutationObserver(() => undefined);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    for (const record of observer.takeRecords())
      for (const node of [...record.addedNodes, ...record.removedNodes])
        if (node instanceof Element) touched.push(node);
    observer.disconnect();
    return touched;
  };
}
const holds = (nodes: Element[], selector: string): boolean =>
  nodes.some((node) => node.matches(selector) || node.querySelector(selector) !== null);

const refused = {
  data: undefined,
  error: { error: { code: "VALIDATION_FAILED", message: "server words" } },
  response: new Response(null, { status: 422 }),
};
const client = { GET: vi.fn(), POST: vi.fn(async () => refused) } as unknown as ApiClient;

describe("the action dialog, opened again after a refusal", () => {
  function Host(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <ApiClientProvider client={client}>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <HopeActionModal
          open={open}
          action="cancel-package"
          targetId="submission-1"
          onClose={() => setOpen(false)}
          onDone={vi.fn()}
        />
      </ApiClientProvider>
    );
  }

  it("never paints the last refusal, nor keeps the reason that was chosen", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    let dialog = screen.getByRole("dialog", { name: "Cancel HOPE package" });
    const reason = within(dialog).getByLabelText(/Reason/) as HTMLSelectElement;
    fireEvent.change(reason, {
      target: { value: (reason.querySelectorAll("option")[1] as HTMLOptionElement).value },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel package" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("server words");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep package" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    const changes = recordChanges();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    });

    expect(holds(changes(), "[role=alert]")).toBe(false);
    dialog = screen.getByRole("dialog", { name: "Cancel HOPE package" });
    expect((within(dialog).getByLabelText(/Reason/) as HTMLSelectElement).value).toBe("");
  });
});

describe("the CMS result dialog, opened again after a discard", () => {
  const ITEMS = [{ assessmentId: "a-1", label: "Admission, Ada Lovelace" }];
  function Host(): JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <ApiClientProvider client={client}>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <RecordCmsResultModal
          open={open}
          submissionId="submission-1"
          items={ITEMS}
          onClose={() => setOpen(false)}
          onDone={vi.fn()}
        />
      </ApiClientProvider>
    );
  }

  it("never paints the discard question, and starts from a blank form", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    let dialog = screen.getByRole("dialog", { name: "Record CMS result" });
    fireEvent.change(within(dialog).getByLabelText("Report reference (optional)"), {
      target: { value: "FVR-2026-09" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).getByRole("heading", { name: "Discard changes?" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    const changes = recordChanges();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    });

    expect(holds(changes(), "h3")).toBe(false);
    dialog = screen.getByRole("dialog", { name: "Record CMS result" });
    expect(within(dialog).queryByRole("heading", { name: "Discard changes?" })).toBeNull();
    expect(
      (within(dialog).getByLabelText("Report reference (optional)") as HTMLInputElement).value,
    ).toBe("");
  });
});
