import { describe, expect, it } from "vitest";
import { moveWindowToDay, newVisitPrefillFromParams } from "./new-visit-prefill";

describe("New Visit prefill from the URL", () => {
  it("reads the visit purpose and the date a caller such as the visit note asks for", () => {
    expect(
      newVisitPrefillFromParams(
        new URLSearchParams(
          "patient=p1&newVisit=1&newVisitPurpose=routine_visit&newVisitDate=2026-12-05",
        ),
      ),
    ).toEqual({ purpose: "routine_visit", date: "2026-12-05" });
  });

  it("offers nothing when the URL carries nothing", () => {
    expect(newVisitPrefillFromParams(new URLSearchParams("patient=p1&newVisit=1"))).toEqual({
      purpose: null,
      date: null,
    });
  });

  it.each(["constructor", "toString", "__proto__", "made_up", ""])(
    "drops %j as a purpose: only a purpose the scheduler knows is offered",
    (purpose) => {
      expect(
        newVisitPrefillFromParams(new URLSearchParams({ newVisitPurpose: purpose })).purpose,
      ).toBeNull();
    },
  );

  it.each(["2026-12-5", "12/05/2026", "2026-13-01", "2026-02-30", "tomorrow", ""])(
    "drops %j as a date: only a real calendar date is offered",
    (date) => {
      expect(
        newVisitPrefillFromParams(new URLSearchParams({ newVisitDate: date })).date,
      ).toBeNull();
    },
  );

  it("moves a window to the offered day keeping the time of day and the length", () => {
    expect(
      moveWindowToDay({ start: "2026-12-01T09:30", end: "2026-12-01T10:30" }, "2026-12-05"),
    ).toEqual({ start: "2026-12-05T09:30", end: "2026-12-05T10:30" });
  });

  it("keeps a window that crosses midnight ending after it starts", () => {
    expect(
      moveWindowToDay({ start: "2026-12-01T23:15", end: "2026-12-02T00:15" }, "2026-12-05"),
    ).toEqual({ start: "2026-12-05T23:15", end: "2026-12-06T00:15" });
  });

  it("moves a window back as well as forward", () => {
    expect(
      moveWindowToDay({ start: "2026-12-10T09:00", end: "2026-12-10T10:00" }, "2026-12-08"),
    ).toEqual({ start: "2026-12-08T09:00", end: "2026-12-08T10:00" });
  });

  it("leaves a window that is not a local date-time untouched", () => {
    expect(moveWindowToDay({ start: "", end: "" }, "2026-12-05")).toEqual({ start: "", end: "" });
  });
});
