// @vitest-environment jsdom
// An editor opening takes focus to its heading; closing gives it back to the control that opened it, or, when that control is gone, to
// the control now carrying the same `data-editor-return` name.
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { useEditorFocus } from "./use-editor-focus";

function Harness({ triggerGoesAway = false }: { triggerGoesAway?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const heading = useEditorFocus(open, "thing");
  return (
    <div>
      {!(triggerGoesAway && added) ? (
        <button type="button" data-editor-return="thing" onClick={() => setOpen(true)}>
          Open
        </button>
      ) : (
        <button type="button" data-editor-return="thing">
          Replace
        </button>
      )}
      {open ? (
        <form>
          <h3 ref={heading} tabIndex={-1}>
            Editor
          </h3>
          <button
            type="button"
            onClick={() => {
              setAdded(true);
              setOpen(false);
            }}
          >
            Save
          </button>
        </form>
      ) : null}
    </div>
  );
}

describe("useEditorFocus", () => {
  it("moves focus to the heading on open and back to the opener on close", () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Open" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("finds the control again by its name when the opener unmounted while the editor was open", () => {
    render(<Harness triggerGoesAway />);
    screen.getByRole("button", { name: "Open" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace" }));
  });
});
