// @wardenx/billing — M23 DDE work-queue item lifecycle (ADR-0052 D4) and note rules (D7). PURE: no DB, no clock, no PHI.
import {
  DDE_ITEM_TYPES,
  DDE_NOTES_MAX_LENGTH,
  DDE_WORK_ITEM_STATES,
  type DdeWorkItemState,
  ddeDeadlineStatus,
  ddeWorkItemMachine,
  validateDdeCodes,
  validateDdeNotes,
} from "@wardenx/billing";
import { describe, expect, it } from "vitest";

const m = ddeWorkItemMachine;
const PRE_SUBMITTED: readonly DdeWorkItemState[] = ["queued", "assigned", "in_progress"];

describe("ddeWorkItemMachine", () => {
  it("walks the happy path queued to closed", () => {
    let s: DdeWorkItemState = "queued";
    for (const ev of ["assign", "start", "submit", "accept", "close"] as const) {
      const r = m.reduce(s, ev);
      expect(r.error).toBeUndefined();
      s = r.state;
    }
    expect(s).toBe("closed");
  });

  it("returned reopens as in_progress and increments the attempt number", () => {
    const returned = m.reduce("submitted", "return", { attemptNumber: 1 });
    expect(returned).toEqual({ state: "returned", attemptNumber: 1 });
    const retried = m.reduce("returned", "retry", { attemptNumber: 1 });
    expect(retried).toEqual({ state: "in_progress", attemptNumber: 2 });
  });

  it("only increments the attempt on retry", () => {
    expect(m.reduce("assigned", "start", { attemptNumber: 3 }).attemptNumber).toBe(3);
  });

  it("allows cancel only before submission", () => {
    for (const s of DDE_WORK_ITEM_STATES) {
      expect(m.canTransition(s, "cancel")).toBe(PRE_SUBMITTED.includes(s));
    }
  });

  it("fails closed on an illegal pair without throwing", () => {
    expect(m.reduce("queued", "accept")).toEqual({
      state: "queued",
      attemptNumber: 1,
      error: "INVALID_TRANSITION",
    });
    expect(m.reduce("accepted", "submit").error).toBe("INVALID_TRANSITION");
  });

  it("has no outbound edge from closed or cancelled", () => {
    expect(m.isTerminal("closed")).toBe(true);
    expect(m.isTerminal("cancelled")).toBe(true);
    expect(m.isTerminal("queued")).toBe(false);
  });

  it("lets a returned item be closed without another attempt", () => {
    expect(m.reduce("returned", "close").state).toBe("closed");
  });

  it("lets an assigned item go back to the queue", () => {
    expect(m.reduce("assigned", "unassign").state).toBe("queued");
  });

  it("every table edge applies", () => {
    for (const t of m.DDE_WORK_ITEM_TRANSITIONS) {
      expect(m.reduce(t.from, t.event).state).toBe(t.to);
    }
  });

  it("lists the seven item types", () => {
    expect([...DDE_ITEM_TYPES]).toEqual([
      "noe",
      "notr",
      "claim_entry",
      "rtp_correction",
      "adjustment",
      "cancel",
      "adr_response",
    ]);
  });
});

describe("validateDdeNotes", () => {
  it("accepts ordinary notes and null/undefined", () => {
    expect(validateDdeNotes("Keyed in option 28, waiting on receipt")).toEqual({ ok: true });
    expect(validateDdeNotes(undefined)).toEqual({ ok: true });
    expect(validateDdeNotes(null)).toEqual({ ok: true });
  });

  it("rejects notes over the cap", () => {
    const r = validateDdeNotes("x".repeat(DDE_NOTES_MAX_LENGTH + 1));
    expect(r).toEqual({ ok: false, reason: "NOTES_TOO_LONG" });
  });

  it.each(["1EG4-TE5-MK73", "1EG4TE5MK73", "see 1eg4-te5-mk73 for the patient", "1EG4 TE5 MK73"])(
    "rejects an MBI-shaped note: %s",
    (note) => {
      expect(validateDdeNotes(note)).toEqual({ ok: false, reason: "NOTES_CONTAIN_MBI" });
    },
  );

  it.each(["DCN 22123456789012345", "ICN: 2024123456789", "RTP code 37001", "NPI 1234567890"])(
    "does not reject a code or number that is not an MBI: %s",
    (note) => {
      expect(validateDdeNotes(note)).toEqual({ ok: true });
    },
  );
});

describe("ddeDeadlineStatus", () => {
  const base = { deadlineAt: "2026-10-10", macAcceptedOn: null } as const;

  it("has no status without a deadline", () => {
    expect(
      ddeDeadlineStatus({ state: "queued", deadlineAt: null, macAcceptedOn: null }, "2026-10-01"),
    ).toBe("none");
  });

  it("is on track while the deadline is far away", () => {
    expect(ddeDeadlineStatus({ ...base, state: "queued" }, "2026-10-01")).toBe("on_track");
  });

  it("is at risk within two days of the deadline", () => {
    expect(ddeDeadlineStatus({ ...base, state: "in_progress" }, "2026-10-08")).toBe("at_risk");
    expect(ddeDeadlineStatus({ ...base, state: "in_progress" }, "2026-10-10")).toBe("at_risk");
  });

  it("keeps a submitted item with no acceptance date at risk, however early", () => {
    expect(ddeDeadlineStatus({ ...base, state: "submitted" }, "2026-10-01")).toBe("at_risk");
  });

  it("is overdue once an open item passes the deadline", () => {
    expect(ddeDeadlineStatus({ ...base, state: "submitted" }, "2026-10-11")).toBe("overdue");
    expect(ddeDeadlineStatus({ ...base, state: "returned" }, "2026-10-11")).toBe("overdue");
  });

  it("is met only by a MAC acceptance date on or before the deadline", () => {
    expect(
      ddeDeadlineStatus({ ...base, state: "accepted", macAcceptedOn: "2026-10-10" }, "2026-10-20"),
    ).toBe("met");
    expect(
      ddeDeadlineStatus({ ...base, state: "closed", macAcceptedOn: "2026-10-09" }, "2026-10-20"),
    ).toBe("met");
  });

  it("is missed when the MAC accepted after the deadline", () => {
    expect(
      ddeDeadlineStatus({ ...base, state: "accepted", macAcceptedOn: "2026-10-11" }, "2026-10-20"),
    ).toBe("missed");
  });

  it("has no status for a cancelled item", () => {
    expect(ddeDeadlineStatus({ ...base, state: "cancelled" }, "2026-10-20")).toBe("none");
  });
});

describe("validateDdeNotes hardening", () => {
  it.each([
    ["a glued prefix", "ID1EG4-TE5-MK73"],
    ["a glued suffix", "1EG4TE5MK73XYZ"],
    ["doubled spaces", "1EG4  TE5   MK73"],
    ["tabs", "1EG4\tTE5\tMK73"],
    ["NBSP", "1EG4\u00a0TE5\u00a0MK73"],
    ["dots", "1.E.G.4.T.E.5.M.K.7.3"],
    ["full-width digits", "\uff11EG\uff14TE\uff15MK\uff17\uff13"],
    ["zero-width characters", "1EG4\u200bTE5\u200bMK73"],
  ])("rejects an MBI hidden by %s", (_n, note) => {
    expect(validateDdeNotes(note)).toEqual({ ok: false, reason: "NOTES_CONTAIN_MBI" });
  });

  it("still accepts ordinary notes with numbers", () => {
    expect(validateDdeNotes("called MAC 05/12, ref 4471, waiting on receipt")).toEqual({
      ok: true,
    });
  });
});

describe("validateDdeCodes", () => {
  it("accepts a real DCN and an RTP code", () => {
    expect(
      validateDdeCodes({ dcn: "2212345678901", rtpReasonCode: "37001", outcomeCode: "rtp" }),
    ).toEqual({ ok: true });
  });
  it("refuses an 11-character DCN (an MBI's length)", () => {
    expect(validateDdeCodes({ dcn: "1EG4TE5MK73" })).toMatchObject({ ok: false, field: "dcn" });
  });
  it("refuses an MBI-bearing DCN, RTP code or outcome code", () => {
    expect(validateDdeCodes({ dcn: "X1EG4TE5MK73ZZ" })).toMatchObject({
      ok: false,
      reason: "CODE_LOOKS_LIKE_MBI",
    });
    expect(validateDdeCodes({ outcomeCode: "1EG4TE5MK73" })).toMatchObject({
      ok: false,
      field: "outcomeCode",
    });
    expect(validateDdeCodes({ rtpReasonCode: "1EG4TE5MK73" })).toMatchObject({
      ok: false,
      field: "rtpReasonCode",
    });
  });
});
