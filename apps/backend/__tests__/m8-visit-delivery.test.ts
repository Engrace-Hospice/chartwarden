// M8 sign-time visit delivery: the modality the clinician confirms and the documented start/end they enter.
// HARD PRINCIPLE under test: documented time is never fabricated, defaulted or padded, EVV always wins, and a
// modality is never backfilled to in_person.
import type { LocalDate } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import {
  MAX_CLINICIAN_VISIT_MINUTES,
  type SignDeliveryContext,
  type SignDeliveryRow,
  assertModalityFitsVisitType,
  confirmedModalityColumns,
  deliveryViewFields,
  evvTimesAtSign,
  planDeliveryAtSign,
} from "../src/modules/08-encounters/visit-delivery";

const NOW = new Date("2026-05-05T20:00:00.000Z");
const SIGNER = "55555555-5555-4555-8555-555555555555";
const SERVICE_DATE = "2026-05-05" as LocalDate;

// Org-local = UTC-4 (America/New_York in May): the UTC date of (instant - 4h).
const localDateOf = (instant: Date): LocalDate =>
  new Date(instant.getTime() - 4 * 3_600_000).toISOString().slice(0, 10) as LocalDate;

const row = (over: Partial<SignDeliveryRow> = {}): SignDeliveryRow => ({
  discipline: "rn",
  encounterType: "routine_visit",
  serviceDate: SERVICE_DATE,
  visitModalityConfirmedAt: null,
  ...over,
});

const ctx = (over: Partial<SignDeliveryContext> = {}): SignDeliveryContext => ({
  signerMembershipId: SIGNER,
  now: NOW,
  localDateOf,
  evvTimes: null,
  ...over,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof EncounterStateError ? e.code : `non-M8:${String(e)}`;
  }
  return undefined;
};

describe("planDeliveryAtSign: modality", () => {
  it("refuses an RN who supplies no modality and has none confirmed (422 MODALITY_CONFIRMATION_REQUIRED)", () => {
    expect(codeOf(() => planDeliveryAtSign({}, row(), ctx()))).toBe(
      "MODALITY_CONFIRMATION_REQUIRED",
    );
  });

  it.each(["rn", "lpn", "chha", "msw", "pt", "ot", "slp"] as const)(
    "%s must confirm a modality explicitly",
    (discipline) => {
      expect(codeOf(() => planDeliveryAtSign({}, row({ discipline }), ctx()))).toBe(
        "MODALITY_CONFIRMATION_REQUIRED",
      );
    },
  );

  it.each(["md", "np", "chaplain", "volunteer"] as const)(
    "%s is not asked: no SIA / visit-line modality is derived from it",
    (discipline) => {
      expect(planDeliveryAtSign({}, row({ discipline }), ctx())).toEqual({});
    },
  );

  it("writes the three confirmation columns when the clinician supplies a modality", () => {
    const out = planDeliveryAtSign({ visitModality: "in_person" }, row(), ctx());
    expect(out).toEqual({
      visitModality: "in_person",
      visitModalityConfirmedAt: NOW,
      visitModalityConfirmedBy: SIGNER,
    });
  });

  it("lets the clinician override a seeded modality (the seed is only a pre-selection)", () => {
    const out = planDeliveryAtSign({ visitModality: "video" }, row(), ctx());
    expect(out.visitModality).toBe("video");
    expect(out.visitModalityConfirmedBy).toBe(SIGNER);
  });

  it("writes nothing when the row already carries a confirmed modality and none is supplied", () => {
    const confirmed = row({ visitModalityConfirmedAt: new Date("2026-05-05T15:00:00.000Z") });
    expect(planDeliveryAtSign({}, confirmed, ctx())).toEqual({});
  });

  it.each(["in_person", "video"] as const)(
    "refuses %s on a telephonic encounter type (422 MODALITY_CONFLICTS_WITH_VISIT_TYPE)",
    (visitModality) => {
      const telephonic = row({ encounterType: "telephonic" });
      expect(codeOf(() => planDeliveryAtSign({ visitModality }, telephonic, ctx()))).toBe(
        "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
      );
    },
  );

  it("always allows telephonic, on a telephonic or any other encounter type", () => {
    expect(
      planDeliveryAtSign(
        { visitModality: "telephonic" },
        row({ encounterType: "telephonic" }),
        ctx(),
      ).visitModality,
    ).toBe("telephonic");
    expect(planDeliveryAtSign({ visitModality: "telephonic" }, row(), ctx()).visitModality).toBe(
      "telephonic",
    );
  });
});

describe("assertModalityFitsVisitType", () => {
  it("refuses a non-telephonic modality on a telephonic type, nothing else", () => {
    expect(codeOf(() => assertModalityFitsVisitType("telephonic", "in_person"))).toBe(
      "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
    );
    expect(codeOf(() => assertModalityFitsVisitType("telephonic", "video"))).toBe(
      "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
    );
    expect(codeOf(() => assertModalityFitsVisitType("telephonic", "telephonic"))).toBeUndefined();
    expect(codeOf(() => assertModalityFitsVisitType("routine_visit", "in_person"))).toBeUndefined();
    expect(codeOf(() => assertModalityFitsVisitType("routine_visit", "video"))).toBeUndefined();
  });
});

describe("planDeliveryAtSign: documented time", () => {
  const confirm = { visitModality: "in_person" as const };

  it("records clinician times with time_source 'clinician' when there is no EVV bracket", () => {
    const out = planDeliveryAtSign(
      { ...confirm, startedAt: "2026-05-05T14:00:00.000Z", endedAt: "2026-05-05T14:50:00.000Z" },
      row(),
      ctx(),
    );
    expect(out.startedAt).toEqual(new Date("2026-05-05T14:00:00.000Z"));
    expect(out.endedAt).toEqual(new Date("2026-05-05T14:50:00.000Z"));
    expect(out.timeSource).toBe("clinician");
  });

  it("never invents a time: no input, no EVV => no time columns at all", () => {
    const out = planDeliveryAtSign(confirm, row(), ctx());
    expect(out).not.toHaveProperty("startedAt");
    expect(out).not.toHaveProperty("endedAt");
    expect(out).not.toHaveProperty("timeSource");
  });

  it("EVV always wins: clinician times are dropped and time_source is 'evv'", () => {
    const evvTimes = {
      startedAt: new Date("2026-05-05T13:00:00.000Z"),
      endedAt: new Date("2026-05-05T13:40:00.000Z"),
    };
    const out = planDeliveryAtSign(
      { ...confirm, startedAt: "2026-05-05T14:00:00.000Z", endedAt: "2026-05-05T15:00:00.000Z" },
      row(),
      ctx({ evvTimes }),
    );
    expect(out.timeSource).toBe("evv");
    expect(out).not.toHaveProperty("startedAt");
    expect(out).not.toHaveProperty("endedAt");
  });

  it("does not stamp an 'evv' source on an EVV bracket that carries no complete times", () => {
    const out = planDeliveryAtSign(
      confirm,
      row(),
      ctx({ evvTimes: { startedAt: new Date("2026-05-05T13:00:00.000Z"), endedAt: null } }),
    );
    expect(out).not.toHaveProperty("timeSource");
  });

  const invalid = (startedAt?: string, endedAt?: string): string | undefined =>
    codeOf(() => planDeliveryAtSign({ ...confirm, startedAt, endedAt }, row(), ctx()));

  it("rejects an end that is not after the start", () => {
    expect(invalid("2026-05-05T14:00:00.000Z", "2026-05-05T14:00:00.000Z")).toBe(
      "VISIT_TIME_INVALID",
    );
    expect(invalid("2026-05-05T14:30:00.000Z", "2026-05-05T14:00:00.000Z")).toBe(
      "VISIT_TIME_INVALID",
    );
  });

  it("rejects a half-entered bracket (both times, or neither)", () => {
    expect(invalid("2026-05-05T14:00:00.000Z", undefined)).toBe("VISIT_TIME_INVALID");
    expect(invalid(undefined, "2026-05-05T14:00:00.000Z")).toBe("VISIT_TIME_INVALID");
  });

  it("rejects an unparseable instant", () => {
    expect(invalid("not-a-time", "2026-05-05T14:00:00.000Z")).toBe("VISIT_TIME_INVALID");
  });

  it.each([
    ["an offset-less local date-time", "2026-05-05T14:00:00"],
    ["a date only", "2026-05-05"],
    ["a space-separated date-time", "2026-05-05 14:00:00Z"],
    ["a non-ISO string", "May 5, 2026 2:00 PM"],
    ["an epoch number string", "1777989600000"],
    ["an offset without minutes", "2026-05-05T14:00:00+04"],
    ["an offset without a colon", "2026-05-05T14:00:00-0400"],
    ["an impossible time of day", "2026-05-05T25:00:00Z"],
    // `Date` rolls these forward to a different instant (Feb 31 -> Mar 3), i.e. a time the clinician never typed.
    ["an impossible calendar date (Feb 31)", "2026-02-31T09:00:00-05:00"],
    ["an impossible calendar date (Apr 31)", "2026-04-31T10:00:00Z"],
    ["a Feb 29 in a non-leap year", "2026-02-29T10:00:00Z"],
    ["hour 24 (the next midnight)", "2026-05-05T24:00:00Z"],
  ])("rejects %s: an explicit UTC offset is required", (_name, raw) => {
    expect(invalid(raw, "2026-05-05T15:00:00.000Z")).toBe("VISIT_TIME_INVALID");
    expect(invalid("2026-05-05T14:00:00.000Z", raw)).toBe("VISIT_TIME_INVALID");
  });

  it("accepts a Z instant and a +hh:mm / -hh:mm offset, normalised to the same instant", () => {
    const out = planDeliveryAtSign(
      { ...confirm, startedAt: "2026-05-05T10:00:00-04:00", endedAt: "2026-05-05T20:50:00+06:00" },
      row(),
      ctx(),
    );
    expect(out.startedAt).toEqual(new Date("2026-05-05T14:00:00.000Z"));
    expect(out.endedAt).toEqual(new Date("2026-05-05T14:50:00.000Z"));
  });

  it("caps a clinician-entered visit at 8 hours: exactly 8h is allowed, a minute more is refused", () => {
    expect(MAX_CLINICIAN_VISIT_MINUTES).toBe(8 * 60);
    // End = NOW (20:00Z), so the end is not in the future.
    const exactly = planDeliveryAtSign(
      { ...confirm, startedAt: "2026-05-05T12:00:00.000Z", endedAt: "2026-05-05T20:00:00.000Z" },
      row(),
      ctx(),
    );
    expect(exactly.timeSource).toBe("clinician");
    expect(invalid("2026-05-05T11:59:00.000Z", "2026-05-05T20:00:00.000Z")).toBe(
      "VISIT_TIME_INVALID",
    );
    expect(() =>
      planDeliveryAtSign(
        { ...confirm, startedAt: "2026-05-05T11:59:00.000Z", endedAt: "2026-05-05T20:00:00.000Z" },
        row(),
        ctx(),
      ),
    ).toThrow(/8 hours/);
  });

  it("does not apply the 8h cap or the offset rule to EVV times (EVV always wins)", () => {
    const evvTimes = {
      startedAt: new Date("2026-05-05T01:00:00.000Z"),
      endedAt: new Date("2026-05-05T19:00:00.000Z"),
    };
    const out = planDeliveryAtSign(
      { ...confirm, startedAt: "no-offset", endedAt: "garbage" },
      row(),
      ctx({ evvTimes }),
    );
    expect(out.timeSource).toBe("evv");
  });

  it("rejects a time in the future", () => {
    expect(invalid("2026-05-05T19:30:00.000Z", "2026-05-05T20:30:00.000Z")).toBe(
      "VISIT_TIME_INVALID",
    );
  });

  it("rejects a visit that starts on a different org-local day than the service date", () => {
    // 2026-05-04T14:00Z is 10:00 local on the 4th.
    expect(invalid("2026-05-04T14:00:00.000Z", "2026-05-04T15:00:00.000Z")).toBe(
      "VISIT_TIME_INVALID",
    );
  });

  it("allows a visit that crosses local midnight into the next day", () => {
    const crossing = row({ serviceDate: "2026-05-04" as LocalDate });
    // 23:30 local on the 4th (03:30Z on the 5th) to 00:20 local on the 5th (04:20Z).
    const out = planDeliveryAtSign(
      { ...confirm, startedAt: "2026-05-05T03:30:00.000Z", endedAt: "2026-05-05T04:20:00.000Z" },
      crossing,
      ctx(),
    );
    expect(out.timeSource).toBe("clinician");
  });

  it("rejects an end more than one local day after the service date", () => {
    const early = row({ serviceDate: "2026-05-03" as LocalDate });
    expect(
      codeOf(() =>
        planDeliveryAtSign(
          {
            ...confirm,
            startedAt: "2026-05-03T14:00:00.000Z",
            endedAt: "2026-05-05T14:00:00.000Z",
          },
          early,
          ctx(),
        ),
      ),
    ).toBe("VISIT_TIME_INVALID");
  });
});

describe("confirmedModalityColumns", () => {
  it("stamps the confirming membership and instant", () => {
    expect(confirmedModalityColumns("telephonic", SIGNER, NOW)).toEqual({
      visitModality: "telephonic",
      visitModalityConfirmedAt: NOW,
      visitModalityConfirmedBy: SIGNER,
    });
  });
});

describe("deliveryViewFields", () => {
  it("reads a seeded, unconfirmed modality as exactly that: present but not confirmed", () => {
    expect(
      deliveryViewFields({
        visitModality: "in_person",
        visitModalityConfirmedAt: null,
        timeSource: null,
      }),
    ).toEqual({ visitModality: "in_person", visitModalityConfirmed: false, timeSource: null });
  });

  it("reports confirmed once a confirmation instant exists (Date or ISO string)", () => {
    expect(
      deliveryViewFields({
        visitModality: "video",
        visitModalityConfirmedAt: NOW,
        timeSource: "evv",
      }),
    ).toEqual({ visitModality: "video", visitModalityConfirmed: true, timeSource: "evv" });
    expect(
      deliveryViewFields({
        visitModality: "video",
        visitModalityConfirmedAt: NOW.toISOString(),
        timeSource: "clinician",
      }).visitModalityConfirmed,
    ).toBe(true);
  });

  it("never reads an unknown modality as in person, and drops an unrecognised time source", () => {
    expect(
      deliveryViewFields({
        visitModality: null,
        visitModalityConfirmedAt: null,
        timeSource: "magic",
      }),
    ).toEqual({ visitModality: null, visitModalityConfirmed: false, timeSource: null });
  });
});

describe("evvTimesAtSign", () => {
  const stored = {
    startedAt: new Date("2026-05-05T13:00:00.000Z"),
    endedAt: new Date("2026-05-05T13:40:00.000Z"),
  };

  it("is null when the EVV state at sign is not evv_present", () => {
    expect(evvTimesAtSign(stored, { state: "evv_missing_documented", persist: null })).toBeNull();
  });

  it("uses the bracket sign just resolved (the one it is about to persist)", () => {
    const persist = {
      evvBracketState: "evv_present" as const,
      evvCheckInEventId: null,
      evvCheckOutEventId: null,
      startedAt: new Date("2026-05-05T12:00:00.000Z"),
      endedAt: new Date("2026-05-05T12:30:00.000Z"),
    };
    expect(evvTimesAtSign(stored, { state: "evv_present", persist })).toEqual({
      startedAt: persist.startedAt,
      endedAt: persist.endedAt,
    });
  });

  it("uses the times already on the row when the bracket was resolved earlier", () => {
    expect(evvTimesAtSign(stored, { state: "evv_present", persist: null })).toEqual(stored);
  });
});
