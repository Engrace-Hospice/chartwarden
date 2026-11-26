// The schedule-against-ordered-frequency logic of the Plan and Next Visit section: what the plan of care orders for the note's
// discipline, which of the patient's scheduled visits count toward it, and when the section flags that nothing is scheduled or the
// schedule falls short. Synthetic ids and dates only. The machine form of a frequency and the purpose-to-discipline table are owned by
// packages/scheduling (apps/web does not depend on it), so the copies here are checked against that source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PlanIntervention,
  type UpcomingVisit,
  assessSchedule,
  noteDisciplineGroup,
  orderedVisitFrequency,
  parseVisitFrequency,
  scheduleNextVisitHref,
  visitByOf,
} from "../next-visit-model";

const NOW = new Date("2026-12-01T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number, hours = 0): string =>
  new Date(NOW.getTime() + days * DAY + hours * 60 * 60 * 1000).toISOString();

const intervention = (over: Partial<PlanIntervention> = {}): PlanIntervention => ({
  discipline: "rn",
  frequencyText: "2 visits/week",
  frequencyValue: "2:visit:week",
  status: "active",
  ...over,
});

const visit = (over: Partial<UpcomingVisit> & Pick<UpcomingVisit, "id">): UpcomingVisit => ({
  status: "published",
  visitPurpose: "routine_visit",
  scheduledStartedAt: at(3),
  serviceDate: at(3).slice(0, 10),
  ...over,
});

describe("parseVisitFrequency", () => {
  it("reads the cadence of a visit-unit frequency in the machine form", () => {
    expect(parseVisitFrequency("2:visit:week")).toEqual({
      count: 2,
      period: "week",
      periodDays: 7,
    });
    expect(parseVisitFrequency("1:visit:day")).toEqual({ count: 1, period: "day", periodDays: 1 });
    expect(parseVisitFrequency(" 1:visit:month ")).toEqual({
      count: 1,
      period: "month",
      periodDays: 30,
    });
  });

  it.each([
    "1:visit:episode",
    "1:prn:prn",
    "1:continuous:day",
    "2:day:week",
    "0:visit:week",
    "two visits a week",
    "",
  ])("makes no claim about %j", (raw) => {
    expect(parseVisitFrequency(raw)).toBeNull();
  });

  it("uses the grammar and the period spans packages/scheduling publishes", () => {
    const source = readFileSync(
      join(__dirname, "../../../../../../../packages/scheduling/src/frequency.ts"),
      "utf8",
    );
    expect(source).toContain(
      "/^([0-9]+):(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$/",
    );
    expect(source).toMatch(/day: 1,\s*\n\s*week: 7,\s*\n\s*month: 30,/);
  });
});

describe("noteDisciplineGroup", () => {
  it("treats RN and LPN as one nursing group and MD, NP and the plan's md_np as one physician group", () => {
    expect(noteDisciplineGroup("rn")).toBe("nursing");
    expect(noteDisciplineGroup("lpn")).toBe("nursing");
    expect(noteDisciplineGroup("md")).toBe("physician");
    expect(noteDisciplineGroup("np")).toBe("physician");
    expect(noteDisciplineGroup("md_np")).toBe("physician");
  });

  it("keeps every other discipline apart, naming speech therapy the way the plan does", () => {
    expect(noteDisciplineGroup("chha")).toBe("chha");
    expect(noteDisciplineGroup("msw")).toBe("msw");
    expect(noteDisciplineGroup("slp")).toBe("st");
    expect(noteDisciplineGroup("st")).toBe("st");
  });
});

describe("orderedVisitFrequency", () => {
  it("takes the most frequent active visit order of the note's discipline", () => {
    const result = orderedVisitFrequency(
      [
        intervention({ frequencyText: "1 visit/week", frequencyValue: "1:visit:week" }),
        intervention({ frequencyText: "3 visits/week", frequencyValue: "3:visit:week" }),
        intervention({ frequencyText: "1 visit/day", frequencyValue: "1:visit:day" }),
      ],
      "rn",
    );
    expect(result.ordered).toEqual({
      count: 1,
      period: "day",
      periodDays: 1,
      frequencyText: "1 visit/day",
    });
  });

  it("ignores discontinued and completed orders and other disciplines", () => {
    const result = orderedVisitFrequency(
      [
        intervention({ status: "discontinued" }),
        intervention({ status: "completed" }),
        intervention({
          discipline: "msw",
          frequencyText: "1 visit/week",
          frequencyValue: "1:visit:week",
        }),
      ],
      "rn",
    );
    expect(result.ordered).toBeNull();
    expect(result.otherOrders).toEqual([]);
  });

  it("lists, verbatim, an active order it cannot read as a visit cadence, and makes no count of it", () => {
    const result = orderedVisitFrequency(
      [
        intervention({ frequencyText: "As needed for pain", frequencyValue: "1:prn:prn" }),
        intervention({ frequencyText: "Weekly if stable", frequencyValue: "weekly" }),
      ],
      "rn",
    );
    expect(result.ordered).toBeNull();
    expect(result.otherOrders).toEqual(["As needed for pain", "Weekly if stable"]);
  });

  it("lets an LPN note see the nursing order, and a nurse practitioner note the physician order", () => {
    expect(orderedVisitFrequency([intervention({ discipline: "rn" })], "lpn").ordered?.count).toBe(
      2,
    );
    expect(
      orderedVisitFrequency([intervention({ discipline: "md_np" })], "np").ordered?.count,
    ).toBe(2);
  });
});

describe("assessSchedule", () => {
  const ordered = orderedVisitFrequency([intervention()], "rn").ordered;

  it("says nothing is scheduled when no upcoming visit of the discipline is on the books", () => {
    expect(
      assessSchedule({ now: NOW, discipline: "rn", ordered, visits: [], currentVisitId: null }),
    ).toEqual({ kind: "nothing_scheduled" });
  });

  it("does not count another discipline's visit toward this discipline's frequency", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered,
      visits: [visit({ id: "v1", visitPurpose: "msw_followup" })],
      currentVisitId: null,
    });
    expect(result.kind).toBe("nothing_scheduled");
  });

  it("does not count past, cancelled, in-flight, proposed or this note's own visit", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered,
      visits: [
        visit({ id: "past", scheduledStartedAt: at(-1) }),
        visit({ id: "cancelled", status: "cancelled" }),
        visit({ id: "in-visit", status: "in_visit" }),
        visit({ id: "proposed", status: "proposed" }),
        visit({ id: "own", status: "published" }),
      ],
      currentVisitId: "own",
    });
    expect(result.kind).toBe("nothing_scheduled");
  });

  it("reports a shortfall when fewer visits are scheduled in the ordered period than the plan orders", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered,
      visits: [
        visit({ id: "v1", scheduledStartedAt: at(3) }),
        visit({ id: "later", scheduledStartedAt: at(9) }),
      ],
      currentVisitId: null,
    });
    expect(result).toEqual({
      kind: "short_of_frequency",
      scheduled: 1,
      expected: 2,
      windowDays: 7,
      nextVisitId: "v1",
    });
  });

  it("is met when the ordered count is scheduled inside the period, the last day included", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered,
      visits: [
        visit({ id: "v1", scheduledStartedAt: at(3) }),
        visit({ id: "v2", scheduledStartedAt: at(7) }),
      ],
      currentVisitId: null,
    });
    expect(result).toEqual({ kind: "meets_frequency", nextVisitId: "v1" });
  });

  it("counts a daily order as seven visits over the next seven days", () => {
    const daily = orderedVisitFrequency(
      [intervention({ frequencyText: "1 visit/day", frequencyValue: "1:visit:day" })],
      "rn",
    ).ordered;
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered: daily,
      visits: [1, 2, 3].map((d) => visit({ id: `d${d}`, scheduledStartedAt: at(d) })),
      currentVisitId: null,
    });
    expect(result).toMatchObject({
      kind: "short_of_frequency",
      scheduled: 3,
      expected: 7,
      windowDays: 7,
    });
  });

  it("looks thirty days ahead for a monthly order", () => {
    const monthly = orderedVisitFrequency(
      [intervention({ frequencyText: "1 visit/month", frequencyValue: "1:visit:month" })],
      "rn",
    ).ordered;
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered: monthly,
      visits: [visit({ id: "v1", scheduledStartedAt: at(20) })],
      currentVisitId: null,
    });
    expect(result).toEqual({ kind: "meets_frequency", nextVisitId: "v1" });
  });

  it("states the next visit without judging a count when the plan orders no readable visit frequency", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "rn",
      ordered: null,
      visits: [visit({ id: "v1" })],
      currentVisitId: null,
    });
    expect(result).toEqual({ kind: "scheduled_without_order", nextVisitId: "v1" });
  });

  it.each(["pt", "ot", "slp"])(
    "makes no claim for a %s note, since no visit purpose is scheduled for that discipline",
    (discipline) => {
      const therapyOrder = orderedVisitFrequency(
        [intervention({ discipline })],
        discipline,
      ).ordered;
      expect(
        assessSchedule({
          now: NOW,
          discipline,
          ordered: therapyOrder,
          visits: [],
          currentVisitId: null,
        }),
      ).toEqual({ kind: "not_comparable" });
      expect(
        assessSchedule({
          now: NOW,
          discipline,
          ordered: null,
          visits: [visit({ id: "v1" })],
          currentVisitId: null,
        }),
      ).toEqual({ kind: "not_comparable" });
    },
  );

  it("still judges every discipline a visit purpose is scheduled for", () => {
    for (const discipline of ["rn", "lpn", "chha", "msw", "chaplain", "volunteer", "md", "np"]) {
      const result = assessSchedule({
        now: NOW,
        discipline,
        ordered: null,
        visits: [],
        currentVisitId: null,
      });
      expect(result.kind, discipline).toBe("nothing_scheduled");
    }
  });

  it("treats a physician-group note's f2f visit as a physician visit", () => {
    const result = assessSchedule({
      now: NOW,
      discipline: "np",
      ordered: null,
      visits: [visit({ id: "f", visitPurpose: "f2f" })],
      currentVisitId: null,
    });
    expect(result.kind).toBe("scheduled_without_order");
  });
});

describe("scheduleNextVisitHref", () => {
  it("opens the New Visit form for the patient and carries nothing else", () => {
    expect(scheduleNextVisitHref("p-1")).toBe("/calendar?patient=p-1&newVisit=1");
  });

  it("encodes the id rather than trusting it", () => {
    expect(scheduleNextVisitHref("a&b=c")).toBe("/calendar?patient=a%26b%3Dc&newVisit=1");
  });
});

describe("visitByOf", () => {
  it("names the discipline of a visit whose purpose only one discipline makes, the physician or NP as the plan entry names it", () => {
    expect(visitByOf("recert")).toBe("rn");
    expect(visitByOf("aide_poc")).toBe("chha");
    expect(visitByOf("f2f")).toBe("md_np");
    expect(visitByOf("future_purpose")).toBe("");
  });

  it("leaves the discipline unstated when the purpose is one several disciplines make (a routine visit may be the LPN's)", () => {
    for (const purpose of ["routine_visit", "prn", "pronouncement", "huv1", "huv2", "sfv"]) {
      expect(visitByOf(purpose), purpose).toBe("");
    }
  });

  it("agrees, for every purpose packages/scheduling schedules, with the disciplines it accepts: named when they are one choice, unstated otherwise", () => {
    const source = readFileSync(
      join(__dirname, "../../../../../../../packages/scheduling/src/policy.ts"),
      "utf8",
    );
    const block = source.match(
      /export const VISIT_PURPOSE_DISCIPLINES[^=]*=\s*\{([\s\S]*?)\n\} as const;/,
    )?.[1];
    const entries = [...(block ?? "").matchAll(/^ {2}(\w+): \[([^\]]*)\]/gm)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, purpose, list] of entries) {
      const choices = new Set(
        [...(list as string).matchAll(/"([a-z]+)"/g)].map(([, d]) =>
          d === "md" || d === "np" ? "md_np" : (d as string),
        ),
      );
      expect(visitByOf(purpose as string), purpose).toBe(choices.size === 1 ? [...choices][0] : "");
    }
  });
});
