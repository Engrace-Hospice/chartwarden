// Workflow 09, WP1 — the scheduled window as one short line, in the reader's own time zone (so the checks do not name an hour).
import { describe, expect, it } from "vitest";
import { visitWindowLabel } from "../visit-window";

describe("visitWindowLabel", () => {
  it("writes a window inside one day as a date, a start and an end", () => {
    const label = visitWindowLabel("2026-08-31T14:00:00.000Z", "2026-08-31T14:45:00.000Z");
    expect(label).toMatch(/^Aug \d{1,2}, \d{1,2}:\d{2} [AP]M - \d{1,2}:\d{2} [AP]M$/);
  });

  it("repeats the date when the window crosses midnight", () => {
    const label = visitWindowLabel("2026-08-31T00:30:00.000Z", "2026-09-02T00:30:00.000Z");
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}, .* - [A-Z][a-z]{2} \d{1,2}, /);
  });

  it("leaves an end off that is missing, unreadable or not after the start", () => {
    const start = "2026-08-31T14:00:00.000Z";
    for (const end of ["", "not a date", "2026-08-31T14:00:00.000Z", "2026-08-31T13:00:00.000Z"]) {
      expect(visitWindowLabel(start, end)).not.toContain(" - ");
    }
  });

  it("answers nothing when the start is not a date", () => {
    expect(visitWindowLabel("", "2026-08-31T14:00:00.000Z")).toBeNull();
    expect(visitWindowLabel("soon", "2026-08-31T14:00:00.000Z")).toBeNull();
  });
});
