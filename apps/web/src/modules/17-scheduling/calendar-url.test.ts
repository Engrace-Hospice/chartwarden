import { describe, expect, it } from "vitest";
import { withCalendarParams } from "./calendar-page";

describe("calendar URL state", () => {
  const base = () => new URLSearchParams("view=week&date=2026-10-04&patient=patient-1");
  it("opens and closes a visit without losing calendar context", () => {
    const opened = withCalendarParams(base(), { visit: "visit-1" });
    expect(opened.toString()).toBe("view=week&date=2026-10-04&patient=patient-1&visit=visit-1");
    expect(withCalendarParams(opened, { visit: null }).toString()).toBe(
      "view=week&date=2026-10-04&patient=patient-1",
    );
  });
  it("opens and closes New Visit without losing patient, view, or date", () => {
    const opened = withCalendarParams(base(), { newVisit: "1" });
    expect(opened.get("newVisit")).toBe("1");
    expect(withCalendarParams(opened, { newVisit: null }).toString()).toBe(
      "view=week&date=2026-10-04&patient=patient-1",
    );
  });
  it("can replace modal state with the created visit while staying on calendar context", () => {
    const afterCreate = withCalendarParams(
      new URLSearchParams("view=week&date=2026-10-04&patient=patient-1&newVisit=1"),
      { newVisit: null, visit: "visit-2", date: "2026-10-05" },
    );
    expect(afterCreate.toString()).toBe(
      "view=week&date=2026-10-05&patient=patient-1&visit=visit-2",
    );
  });
});
