// @vitest-environment jsdom
// One row of the Clinical tab's recent notes: the status beside a note's summary that says what a retry found is never stale (S1 React
// review). Synthetic data only.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { NoteRow } from "./clinical-note-cell";
import type { NoteSummary } from "./clinical-note-summary";

afterEach(cleanup);

const row = (summary: NoteSummary, onRetry: () => Promise<boolean>) => (
  <MemoryRouter>
    <table>
      <tbody>
        <NoteRow
          href="/patients/p1/encounters/e1"
          date="2026-10-03"
          typeLabel="SN Visit"
          author="Ana Reyes"
          summary={summary}
          onRetry={onRetry}
        />
      </tbody>
    </table>
  </MemoryRouter>
);

describe("a note row's retry status", () => {
  it("says the note was read again, and says nothing of it once the note cannot be shown again", async () => {
    const user = userEvent.setup();
    const onRetry = async () => true;
    const { rerender } = render(row({ kind: "unavailable" }, onRetry));
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    // The tab's data now holds the note it read again.
    rerender(row({ kind: "text", text: "Pain controlled.", someWithheld: false }, onRetry));
    await waitFor(() => expect(status).toHaveTextContent(/The note was read again/));
    expect(screen.getByRole("status")).toBe(status);

    // A later read of the tab finds the note undecidable again: the old outcome must not sit beside the new failure.
    rerender(row({ kind: "unavailable" }, onRetry));
    expect(status).toBeEmptyDOMElement();
  });
});
