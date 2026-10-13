import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PatientContextAside } from "./thread-header";

// WP 2.11: the patient-context panel is a slide-over (768-1279 px) or sheet (<768 px), so it must take focus when it
// opens, close on Escape, and hand focus back to the control that opened it.
const PATIENT = { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-1" };

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        Patient context
      </button>
      {open ? <PatientContextAside patient={PATIENT} onClose={() => setOpen(false)} /> : null}
    </MemoryRouter>
  );
}

describe("PatientContextAside focus", () => {
  it("moves focus to the close button on open and restores it to the opener on Escape", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Patient context" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "Close patient context" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("complementary", { name: "Patient context" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("complementary", { name: "Patient context" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("restores focus to the opener when closed with the close button", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Patient context" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close patient context" }));
    expect(opener).toHaveFocus();
  });
});
