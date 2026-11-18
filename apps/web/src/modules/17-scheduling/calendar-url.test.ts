import { describe, expect, it } from "vitest";
import { calendarFilterStateFromParams, withCalendarParams } from "./calendar-page";

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

  it("drops a filter value that is an inherited object property, not a real purpose, setting or status", () => {
    expect(
      calendarFilterStateFromParams(
        new URLSearchParams("purpose=constructor&setting=toString&status=__proto__"),
      ),
    ).toMatchObject({ purpose: "", setting: "", status: "" });
  });

  it("reads shareable non-PHI filters and density from the URL", () => {
    expect(
      calendarFilterStateFromParams(
        new URLSearchParams(
          "staff=membership-1&purpose=routine_visit&setting=patient_home&status=published&inactive=1&density=compact",
        ),
      ),
    ).toEqual({
      staff: "membership-1",
      purpose: "routine_visit",
      setting: "patient_home",
      status: "published",
      showInactive: true,
      density: "compact",
    });
  });

  it("uses safe defaults for absent or unsupported filter values", () => {
    expect(
      calendarFilterStateFromParams(
        new URLSearchParams("purpose=unknown&setting=unknown&status=unknown&density=huge"),
      ),
    ).toEqual({
      staff: "",
      purpose: "",
      setting: "",
      status: "",
      showInactive: false,
      density: "comfortable",
    });
  });
});
