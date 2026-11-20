// Workflow 09, WP1 — a link to `#visit-complete` lands on the anchor once per arrival. The record reloads the encounter after a save, a
// finalize or a sign and shows its spinner while it does; the hash is still in the address, and that must not pull the user back.
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { COMPLETE_ANCHOR_ID, REVIEW_ANCHOR_ID } from "../jump-to-anchor";
import { useHashAnchor } from "../use-hash-anchor";

function Screen({ startReady }: { readonly startReady: boolean }): JSX.Element {
  const [ready, setReady] = useState(startReady);
  useHashAnchor(ready);
  return (
    <>
      <button type="button" onClick={() => setReady((value) => !value)}>
        reload
      </button>
      <Link to={`/x#${REVIEW_ANCHOR_ID}`}>to review</Link>
      <Link to={`/x#${COMPLETE_ANCHOR_ID}`}>to complete</Link>
      <input aria-label="note text" />
      <section id={REVIEW_ANCHOR_ID} tabIndex={-1} aria-label="Review target" />
      <section id={COMPLETE_ANCHOR_ID} tabIndex={-1} aria-label="Complete target" />
    </>
  );
}

function mount(path: string, startReady = true): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Screen startReady={startReady} />
    </MemoryRouter>,
  );
}

describe("useHashAnchor", () => {
  it("lands on the anchor the address names, once the screen is ready", () => {
    mount(`/x#${COMPLETE_ANCHOR_ID}`);
    expect(document.activeElement).toBe(screen.getByLabelText("Complete target"));
  });

  it("does not take focus back after an in-place reload, a save or a sign", () => {
    mount(`/x#${COMPLETE_ANCHOR_ID}`);
    const note = screen.getByLabelText("note text");
    note.focus();

    // The record shows its spinner while it reads again, then the screen is ready once more: same arrival, same hash.
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));

    expect(document.activeElement).toBe(note);
  });

  it("lands again when the user follows a link to an anchor, even the one they were already on", () => {
    mount(`/x#${COMPLETE_ANCHOR_ID}`);
    screen.getByLabelText("note text").focus();

    fireEvent.click(screen.getByRole("link", { name: "to complete" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Complete target"));

    fireEvent.click(screen.getByRole("link", { name: "to review" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Review target"));
  });

  it("waits for the screen to be ready, lands when it is, and does not land again after a reload", () => {
    mount(`/x#${REVIEW_ANCHOR_ID}`, false);
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Review target"));

    const note = screen.getByLabelText("note text");
    note.focus();
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(document.activeElement).toBe(note);
  });

  it("leaves a hash that is not a workflow anchor alone", () => {
    mount("/x#addendum-cosign-a1");
    expect(document.activeElement).toBe(document.body);
  });
});
