// The web's rules for the sign ceremony's "how and when was this visit delivered" step. The server is
// authoritative (422 MODALITY_CONFIRMATION_REQUIRED / VISIT_TIME_INVALID); these rules keep a clinician from
// being bounced and, above all, never put a delivery mode or a time in the body that the clinician did not give.
//
// A `datetime-local` value is read in the DEVICE time zone, so the instant tests pin TZ (before any Date is built)
// and assert LITERAL ISO strings: an expectation computed with `new Date(...)` is the implementation's own
// expression and could never catch a time-zone bug.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/New_York";

import { ENCOUNTER_VISIT_MODALITIES, MODALITY_CONFIRMATION_DISCIPLINES } from "@chartwarden/types";
import { afterAll, describe, expect, it } from "vitest";
import {
  MODALITY_OPTIONS,
  deliveryBody,
  deliveryProblem,
  initialDelivery,
  parseLocalInstant,
  requiresModality,
  timeProblem,
  unconfirmedSeed,
} from "../visit-delivery";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

const noEvv = { discipline: "rn", evvBracketPresent: false } as const;
const draft = (over: Partial<ReturnType<typeof initialDelivery>> = {}) => ({
  ...initialDelivery(null),
  ...over,
});

// A clock long after every time typed below, so "in the future" never trips by accident.
const LATER = Date.parse("2026-12-01T00:00:00.000Z");

describe("visit delivery model", () => {
  it("runs under the pinned time zone, so the literal instants below mean something", () => {
    // EDT in August (UTC-4), EST in January (UTC-5).
    expect(new Date(2026, 7, 31, 10, 0).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 0, 15, 10, 0).getTimezoneOffset()).toBe(300);
  });

  it("offers exactly the server's modalities, in the order a clinician expects", () => {
    expect(MODALITY_OPTIONS.map((o) => o.value)).toEqual([...ENCOUNTER_VISIT_MODALITIES]);
    expect(MODALITY_OPTIONS.map((o) => o.label)).toEqual(["In person", "Telephonic", "Video"]);
  });

  it("asks exactly the disciplines the server asks", () => {
    for (const discipline of MODALITY_CONFIRMATION_DISCIPLINES) {
      expect(requiresModality(discipline)).toBe(true);
    }
    for (const discipline of ["md", "np", "chaplain", "volunteer"]) {
      expect(requiresModality(discipline)).toBe(false);
    }
  });

  describe("a seeded modality is a guess, not a confirmation", () => {
    it("does not select an unconfirmed seed", () => {
      expect(initialDelivery("telephonic")).toEqual({ modality: null, startedAt: "", endedAt: "" });
      expect(initialDelivery("in_person", false).modality).toBeNull();
    });

    it("selects a seed only once a clinician confirmed it", () => {
      expect(initialDelivery("telephonic", true)).toEqual({
        modality: "telephonic",
        startedAt: "",
        endedAt: "",
      });
    });

    it("selects nothing when there is no seed, confirmed or not", () => {
      expect(initialDelivery(null, true).modality).toBeNull();
      expect(initialDelivery(undefined).modality).toBeNull();
    });

    it("hands back the scheduler's guess as a hint only while it is unconfirmed", () => {
      expect(unconfirmedSeed("in_person", false)).toBe("in_person");
      expect(unconfirmedSeed("in_person", true)).toBeNull();
      expect(unconfirmedSeed(null, false)).toBeNull();
      expect(unconfirmedSeed(undefined, false)).toBeNull();
    });
  });

  describe("parseLocalInstant", () => {
    it("reads a wall-clock time in the device zone as the exact instant", () => {
      expect(new Date(parseLocalInstant("2026-08-31T10:00") as number).toISOString()).toBe(
        "2026-08-31T14:00:00.000Z",
      );
      expect(new Date(parseLocalInstant("2026-01-15T10:00") as number).toISOString()).toBe(
        "2026-01-15T15:00:00.000Z",
      );
    });

    it("keeps seconds when the control supplies them", () => {
      expect(new Date(parseLocalInstant("2026-08-31T10:00:30") as number).toISOString()).toBe(
        "2026-08-31T14:00:30.000Z",
      );
    });

    it.each(["2026-02-30T10:00", "2026-08-31T24:00", "2026-13-01T10:00", "not-a-date", ""])(
      "refuses %j instead of moving it to another time",
      (value) => {
        expect(parseLocalInstant(value)).toBeNull();
      },
    );

    it("refuses a time the clocks skip on the spring-forward night", () => {
      // 02:00 -> 03:00 on 2026-03-08 in New York: 02:30 never happens.
      expect(parseLocalInstant("2026-03-08T02:30")).toBeNull();
      // Either side of the gap is a real time.
      expect(new Date(parseLocalInstant("2026-03-08T01:59") as number).toISOString()).toBe(
        "2026-03-08T06:59:00.000Z",
      );
      expect(new Date(parseLocalInstant("2026-03-08T03:00") as number).toISOString()).toBe(
        "2026-03-08T07:00:00.000Z",
      );
    });

    it("refuses a time the clocks pass through twice on the fall-back night, rather than guessing which one", () => {
      // 02:00 EDT -> 01:00 EST on 2026-11-01 in New York: 01:30 happens twice (05:30Z and 06:30Z) and a
      // datetime-local value cannot say which, so `Date`'s silent choice of the first would be a guess.
      expect(parseLocalInstant("2026-11-01T01:30")).toBeNull();
      expect(parseLocalInstant("2026-11-01T01:00")).toBeNull();
      // The hours either side occur exactly once.
      expect(new Date(parseLocalInstant("2026-11-01T00:59") as number).toISOString()).toBe(
        "2026-11-01T04:59:00.000Z",
      );
      expect(new Date(parseLocalInstant("2026-11-01T02:00") as number).toISOString()).toBe(
        "2026-11-01T07:00:00.000Z",
      );
    });
  });

  describe("deliveryProblem", () => {
    it("blocks a countable discipline with no modality chosen", () => {
      expect(deliveryProblem(draft(), noEvv, LATER)).toMatch(/how this visit was delivered/i);
    });

    it("blocks a countable discipline whose seed was never confirmed", () => {
      expect(deliveryProblem(initialDelivery("in_person"), noEvv, LATER)).toMatch(
        /how this visit was delivered/i,
      );
    });

    it("does not ask a discipline the server does not ask", () => {
      expect(deliveryProblem(draft(), { ...noEvv, discipline: "md" }, LATER)).toBeNull();
    });

    it("accepts a chosen modality with no times (times are optional)", () => {
      expect(deliveryProblem(draft({ modality: "in_person" }), noEvv, LATER)).toBeNull();
    });

    it("blocks a half-entered time bracket", () => {
      const d = draft({ modality: "in_person", startedAt: "2026-05-05T10:00" });
      expect(deliveryProblem(d, noEvv, LATER)).toMatch(/both/i);
    });

    it("blocks an end that is not after the start", () => {
      const d = draft({
        modality: "in_person",
        startedAt: "2026-05-05T10:00",
        endedAt: "2026-05-05T10:00",
      });
      expect(deliveryProblem(d, noEvv, LATER)).toMatch(/after the start/i);
    });

    it("blocks an end time in the future, but not one at or before now", () => {
      const d = draft({
        modality: "in_person",
        startedAt: "2026-08-31T10:00",
        endedAt: "2026-08-31T10:50",
      });
      const endsAt = Date.parse("2026-08-31T14:50:00.000Z");
      expect(deliveryProblem(d, noEvv, endsAt - 60_000)).toMatch(/cannot be in the future/i);
      expect(deliveryProblem(d, noEvv, endsAt)).toBeNull();
      expect(deliveryProblem(d, noEvv, endsAt + 60_000)).toBeNull();
    });

    it("blocks a time that is not a real wall-clock time, without producing NaN", () => {
      const impossible = draft({
        modality: "in_person",
        startedAt: "2026-02-30T10:00",
        endedAt: "2026-02-30T10:50",
      });
      expect(timeProblem(impossible, noEvv, LATER)).toMatch(/real start and end time/i);
      expect(timeProblem(impossible, noEvv, LATER)).not.toMatch(/NaN/);
    });

    it("blocks a time the clocks skip on the spring-forward night", () => {
      const skipped = draft({
        modality: "in_person",
        startedAt: "2026-03-08T02:30",
        endedAt: "2026-03-08T03:30",
      });
      expect(deliveryProblem(skipped, noEvv, LATER)).toMatch(/daylight-saving/i);
    });

    it("ignores typed times once an EVV bracket exists (EVV wins)", () => {
      const d = draft({ modality: "in_person", startedAt: "2026-05-05T10:00" });
      expect(deliveryProblem(d, { ...noEvv, evvBracketPresent: true }, LATER)).toBeNull();
    });
  });

  describe("deliveryBody", () => {
    it("sends the chosen modality for a countable discipline: the explicit confirmation", () => {
      expect(deliveryBody(draft({ modality: "video" }), noEvv)).toEqual({ visitModality: "video" });
    });

    it("sends no modality for a discipline the server does not ask (a seed is not a confirmation)", () => {
      expect(
        deliveryBody(draft({ modality: "in_person" }), { ...noEvv, discipline: "md" }),
      ).toEqual({});
    });

    it("sends the typed times as the exact UTC instants of the device-zone wall clock", () => {
      expect(
        deliveryBody(
          draft({
            modality: "in_person",
            startedAt: "2026-08-31T10:00",
            endedAt: "2026-08-31T10:50",
          }),
          noEvv,
        ),
      ).toEqual({
        visitModality: "in_person",
        startedAt: "2026-08-31T14:00:00.000Z",
        endedAt: "2026-08-31T14:50:00.000Z",
      });
      expect(
        deliveryBody(
          draft({
            modality: "in_person",
            startedAt: "2026-01-15T10:00",
            endedAt: "2026-01-15T10:50",
          }),
          noEvv,
        ),
      ).toEqual({
        visitModality: "in_person",
        startedAt: "2026-01-15T15:00:00.000Z",
        endedAt: "2026-01-15T15:50:00.000Z",
      });
    });

    it("never sends a time that was not typed", () => {
      const body = deliveryBody(draft({ modality: "in_person" }), noEvv);
      expect(body).not.toHaveProperty("startedAt");
      expect(body).not.toHaveProperty("endedAt");
    });

    it("never sends a half-entered or unreal pair", () => {
      const half = deliveryBody(
        draft({ modality: "in_person", startedAt: "2026-08-31T10:00" }),
        noEvv,
      );
      expect(half).toEqual({ visitModality: "in_person" });
      const skipped = deliveryBody(
        draft({
          modality: "in_person",
          startedAt: "2026-03-08T02:30",
          endedAt: "2026-03-08T03:30",
        }),
        noEvv,
      );
      expect(skipped).toEqual({ visitModality: "in_person" });
    });

    it("sends no times when an EVV bracket exists, even if some were typed earlier", () => {
      const d = draft({
        modality: "in_person",
        startedAt: "2026-05-05T10:00",
        endedAt: "2026-05-05T10:50",
      });
      expect(deliveryBody(d, { ...noEvv, evvBracketPresent: true })).toEqual({
        visitModality: "in_person",
      });
    });
  });
});
