import { describe, expect, it } from "vitest";
import {
  CHART_PROMOTION_TARGETS,
  allowedPromotionActions,
  applyPromotionOutcome,
  decidePromotionRequest,
  isChartPromotionTarget,
  promotionActorRole,
} from "./promotion-rules";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const at = (ms: number) => new Date(1_700_000_000_000 + ms);
const row = (status: string, sha = SHA_A, ms = 0) =>
  ({ status, sourceBodySha256: sha, requestedAt: at(ms) }) as never;

describe("promotion targets", () => {
  it("names exactly the two chart targets and nothing that reaches an order", () => {
    expect(CHART_PROMOTION_TARGETS.map((t) => `${t.module}/${t.kind}`)).toEqual([
      "m8/encounter_addendum",
      "m14/idg_agenda_item",
    ]);
    expect(isChartPromotionTarget("m8", "encounter_addendum")).toBe(true);
    expect(isChartPromotionTarget("m8", "idg_agenda_item")).toBe(false);
    expect(isChartPromotionTarget("m11", "order")).toBe(false);
  });
});

describe("decidePromotionRequest", () => {
  it("inserts when nothing exists", () => {
    expect(decidePromotionRequest([], SHA_A)).toEqual({ kind: "insert" });
  });
  it("replays an identical proposed request", () => {
    expect(decidePromotionRequest([row("proposed")], SHA_A)).toEqual({ kind: "replay", index: 0 });
  });
  it("supersedes a proposed request when the message body changed", () => {
    expect(decidePromotionRequest([row("proposed", SHA_A)], SHA_B)).toEqual({
      kind: "supersede",
      index: 0,
    });
  });
  it("replays the latest accepted request for the same body", () => {
    const rows = [row("accepted", SHA_A, 1), row("accepted", SHA_A, 9), row("rejected", SHA_A, 20)];
    expect(decidePromotionRequest(rows, SHA_A)).toEqual({ kind: "replay", index: 1 });
  });
  it("inserts a new request when the accepted one was for an older body", () => {
    expect(decidePromotionRequest([row("accepted", SHA_A)], SHA_B)).toEqual({ kind: "insert" });
  });
  it.each(["rejected", "withdrawn", "superseded"])("a %s request does not block a new one", (s) => {
    expect(decidePromotionRequest([row(s)], SHA_A)).toEqual({ kind: "insert" });
  });
});

describe("applyPromotionOutcome", () => {
  const owned = { targetModule: "m8", resultRef: null };
  const accepted = {
    ownerModule: "m8",
    outcome: "accepted",
    resultRef: "R1",
    reasonCode: null,
  } as const;
  it("accepts a proposed request", () => {
    expect(applyPromotionOutcome({ status: "proposed", ...owned }, accepted)).toEqual({
      kind: "accept",
      resultRef: "R1",
    });
  });
  it.each(["withdrawn", "superseded"] as const)(
    "accepts a %s request (the signed record wins)",
    (status) => {
      expect(applyPromotionOutcome({ status, ...owned }, accepted)).toEqual({
        kind: "accept",
        resultRef: "R1",
      });
    },
  );
  it("is a no-op when the same result arrives again", () => {
    expect(
      applyPromotionOutcome({ status: "accepted", targetModule: "m8", resultRef: "R1" }, accepted),
    ).toEqual({ kind: "noop" });
  });
  it("flags a different result on an accepted request and changes nothing", () => {
    expect(
      applyPromotionOutcome({ status: "accepted", targetModule: "m8", resultRef: "R0" }, accepted),
    ).toEqual({ kind: "conflict" });
  });
  it("ignores an event from a module that does not own the target", () => {
    expect(
      applyPromotionOutcome({ status: "proposed", targetModule: "m14", resultRef: null }, accepted),
    ).toEqual({ kind: "ignore" });
  });
  it("ignores an acceptance without a result", () => {
    expect(
      applyPromotionOutcome({ status: "proposed", ...owned }, { ...accepted, resultRef: null }),
    ).toEqual({ kind: "ignore" });
  });
  it("rejects a proposed request with the given reason", () => {
    const ev = {
      ownerModule: "m8",
      outcome: "rejected",
      resultRef: null,
      reasonCode: "duplicate",
    } as const;
    expect(applyPromotionOutcome({ status: "proposed", ...owned }, ev)).toEqual({
      kind: "reject",
      reasonCode: "duplicate",
    });
  });
  it("records an unknown or system reason as other", () => {
    const ev = {
      ownerModule: "m8",
      outcome: "rejected",
      resultRef: null,
      reasonCode: "requester",
    } as const;
    expect(applyPromotionOutcome({ status: "proposed", ...owned }, ev)).toEqual({
      kind: "reject",
      reasonCode: "other",
    });
  });
  it.each(["accepted", "rejected", "withdrawn", "superseded"] as const)(
    "a rejection on a %s request is a no-op",
    (status) => {
      const ev = {
        ownerModule: "m8",
        outcome: "rejected",
        resultRef: null,
        reasonCode: "other",
      } as const;
      expect(
        applyPromotionOutcome(
          { status, targetModule: "m8", resultRef: status === "accepted" ? "R1" : null },
          ev,
        ),
      ).toEqual({ kind: "noop" });
    },
  );
});

describe("allowedPromotionActions", () => {
  it("lets only the requester withdraw, and only while proposed", () => {
    expect(allowedPromotionActions({ status: "proposed" }, "requester")).toEqual(["withdraw"]);
    expect(allowedPromotionActions({ status: "proposed" }, "other")).toEqual([]);
    expect(allowedPromotionActions({ status: "accepted" }, "requester")).toEqual([]);
  });
  it("names the requester by user id", () => {
    expect(promotionActorRole({ requestedByUserId: "u1" }, "u1")).toBe("requester");
    expect(promotionActorRole({ requestedByUserId: "u1" }, "u2")).toBe("other");
  });
});
