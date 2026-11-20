// WF09 WP3 — the late-entry reason input. A note documented more than 1 calendar day after the visit date is refused at finalize with
// 422 LATE_ENTRY_REASON_REQUIRED until it carries the author's own reason (at least 40 characters); no screen had a field for it, so the
// blocker's remedy led nowhere. Synthetic data only.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATE_ENTRY_REASON_FIELD_ID,
  LATE_ENTRY_REASON_MIN,
  LateEntryReasonField,
  focusLateEntryReason,
  lateEntryReasonToSend,
} from "../late-entry-reason-field";

afterEach(cleanup);

const FORTY = "x".repeat(LATE_ENTRY_REASON_MIN);

function Host({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return <LateEntryReasonField value={value} onChange={setValue} disabled={disabled} />;
}

describe("lateEntryReasonToSend", () => {
  it("sends nothing for an empty or too-short reason, so the server's own refusal stays the judge of the rest", () => {
    expect(lateEntryReasonToSend("")).toBeUndefined();
    expect(lateEntryReasonToSend("   ")).toBeUndefined();
    expect(lateEntryReasonToSend("x".repeat(LATE_ENTRY_REASON_MIN - 1))).toBeUndefined();
  });

  it("sends the trimmed reason once it reaches the minimum", () => {
    expect(lateEntryReasonToSend(`  ${FORTY}  `)).toBe(FORTY);
  });
});

describe("the late-entry reason field", () => {
  it("is a labelled field that says when it is required and how long it must be", () => {
    render(<Host />);
    const field = screen.getByLabelText("Late-entry reason");
    expect(field).toHaveAttribute("id", LATE_ENTRY_REASON_FIELD_ID);
    expect(
      screen.getByText(
        /Required when a note is documented more than 1 calendar day after the visit date/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/24 hours/)).toBeNull();
    expect(screen.getByText(/At least 40 characters/)).toBeInTheDocument();
  });

  it("keeps the running count in the hint, and shows no alert while the author is still typing", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.type(screen.getByLabelText("Late-entry reason"), "too short");
    expect(screen.getByText(/At least 40 characters \(9 so far\)\./)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one static alert after the author leaves the field short, and clears it at the minimum", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const field = screen.getByLabelText("Late-entry reason");
    await user.type(field, "too short");
    await user.tab();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Enter at least 40 characters.");
    // The alert's own text never carries the count, so typing more does not announce it again.
    await user.type(field, " and a bit more");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter at least 40 characters.");
    expect(within(screen.getByRole("alert")).queryByText(/so far/)).toBeNull();
    await user.type(field, "y".repeat(31));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("also asks for the reason when the author leaves the field empty", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByLabelText("Late-entry reason"));
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter at least 40 characters.");
  });

  it("can be disabled while a write is in flight", () => {
    render(<Host disabled />);
    expect(screen.getByLabelText("Late-entry reason")).toBeDisabled();
  });

  it("takes focus when a blocker's remedy asks for it", () => {
    render(<Host />);
    expect(focusLateEntryReason()).toBe(true);
    expect(screen.getByLabelText("Late-entry reason")).toHaveFocus();
  });

  it("reports that there is nothing to focus when the field is not on the page", () => {
    expect(focusLateEntryReason()).toBe(false);
  });

  it("has no axe violations, with and without the short-reason message", async () => {
    const user = userEvent.setup();
    const { container } = render(<Host />);
    expect((await axe.run(container)).violations).toEqual([]);
    await user.type(screen.getByLabelText("Late-entry reason"), "short");
    await user.tab();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
