// @vitest-environment jsdom
// The clinical detail drawers share useDrawerA11y: focus moves in on open, Escape closes, focus returns to the opener.
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthorityDrawer } from "../physician-authority-ui";

function Harness({ onClose }: { onClose: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open drawer
      </button>
      {open ? (
        <AuthorityDrawer
          icon="close"
          title="Authority"
          subtitle="Details"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <input aria-label="Note" />
        </AuthorityDrawer>
      ) : null}
    </div>
  );
}

describe("clinical drawer keyboard and focus behaviour", () => {
  it("moves focus into the drawer when it opens", () => {
    render(<Harness onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Authority"));
  });

  it("closes on Escape and returns focus to the opener", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open drawer" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByLabelText("Authority"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Authority")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("ignores Escape pressed inside a text field", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    fireEvent.keyDown(screen.getByLabelText("Note"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
