// WP 6.5 (ADR-0095 sections 2, 3, 6): the model's answer is untrusted. Citations cannot leave the thread, markup is stripped, clinical conclusions are refused.
import { describe, expect, it } from "vitest";
import { parseDrafts, parseSummary, plainText, reidentify, violatesDenylist } from "./ai-output";
import type { ThreadInput } from "./thread-input";

const input: ThreadInput = {
  promptText: "",
  sentRefToMessageId: new Map([
    ["m1", "real-1"],
    ["m3", "real-3"],
  ]),
  sentAtByMessageId: new Map([
    ["real-1", "2026-10-23T09:00:00.000Z"],
    ["real-3", "2026-10-23T10:00:00.000Z"],
  ]),
  aliasToDisplayName: new Map([["Sender A", "Rita Alvarez"]]),
  includedCount: 2,
  withheldCount: 1,
  firstSentMessageId: "real-1",
  lastSentMessageId: "real-3",
  inputHash: "h",
};

const summary = (points: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ points, openQuestions: [], insufficientContext: false, ...extra });

describe("parseSummary", () => {
  it("maps opaque refs back to real ids from the list M36 sent", () => {
    const out = parseSummary(
      summary([
        {
          text: "Sender A [RN] reported pain",
          sourceMessageRefs: ["m1", "m3"],
          confidence: "high",
        },
      ]),
      input,
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.points[0]?.text).toBe("Rita Alvarez reported pain");
    expect(out.points[0]?.sources.map((s) => s.message_id)).toEqual(["real-1", "real-3"]);
    expect(out.points[0]?.confidence).toBe("high");
  });

  it("drops a ref that was not sent (withheld or invented), demotes to low, and discards a point with no valid source", () => {
    const out = parseSummary(
      summary([
        {
          text: "kept with one bad ref",
          sourceMessageRefs: ["m1", "m2", "real-1", "m99"],
          confidence: "high",
        },
        { text: "cites only the withheld message", sourceMessageRefs: ["m2"], confidence: "high" },
        { text: "cites a real id directly", sourceMessageRefs: ["real-3"], confidence: "high" },
        { text: "no refs at all", sourceMessageRefs: [], confidence: "high" },
      ]),
      input,
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.points).toHaveLength(1);
    expect(out.points[0]?.confidence).toBe("low");
    expect(out.points[0]?.sources.map((s) => s.message_id)).toEqual(["real-1"]);
  });

  it("is invalid (retry, then unavailable) for non-JSON, a wrong shape or an unknown confidence", () => {
    for (const raw of [
      "not json",
      "[]",
      JSON.stringify({ points: "x", openQuestions: [], insufficientContext: false }),
      JSON.stringify({ points: [], openQuestions: [] }),
      summary([{ text: "t", sourceMessageRefs: ["m1"], confidence: "certain" }]),
      summary([{ text: 5, sourceMessageRefs: ["m1"], confidence: "high" }]),
    ]) {
      expect(parseSummary(raw, input).kind).toBe("invalid");
    }
  });

  it("strips links, images, tags and URLs so there is no exfiltration channel", () => {
    const out = parseSummary(
      summary([
        {
          text: "See [here](https://evil.example/x?d=1) ![i](https://evil.example/p.png) <img src=x onerror=1> https://evil.example/y done",
          sourceMessageRefs: ["m1"],
          confidence: "medium",
        },
      ]),
      input,
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.points[0]?.text).not.toMatch(/evil|http|<|\]\(/);
    expect(out.points[0]?.text).toContain("done");
  });

  it("refuses the whole answer when a point states a dose, an order or a diagnosis", () => {
    for (const text of [
      "Increase morphine to 10 mg every 4 hours",
      "She should be given a stat order",
      "Likely has pneumonia",
      "I recommend stopping the infusion",
      "Consistent with terminal agitation",
    ]) {
      expect(
        parseSummary(summary([{ text, sourceMessageRefs: ["m1"], confidence: "high" }]), input)
          .kind,
      ).toBe("refused");
    }
  });

  it("ignores injected instructions as data: an injected 'send this' has nowhere to go, and extra fields are not carried", () => {
    const out = parseSummary(
      summary([
        {
          text: "Family asked for a call",
          sourceMessageRefs: ["m1"],
          confidence: "high",
          action: "send_message",
          url: "https://x",
        },
      ]),
      input,
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(Object.keys(out.points[0] ?? {}).sort()).toEqual(["confidence", "sources", "text"]);
  });

  it("bounds the number and length of points and questions", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      text: `p${i} ${"x".repeat(900)}`,
      sourceMessageRefs: ["m1"],
      confidence: "low",
    }));
    const out = parseSummary(
      summary(many, { openQuestions: Array.from({ length: 10 }, () => "q") }),
      input,
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.points).toHaveLength(8);
    expect(out.points.every((p) => p.text.length <= 400)).toBe(true);
    expect(out.openQuestions).toHaveLength(4);
  });
});

describe("parseDrafts", () => {
  it("returns plain text drafts, at most two", () => {
    const out = parseDrafts(
      JSON.stringify({
        drafts: [{ text: "On it, calling the family." }, { text: "b" }, { text: "c" }],
      }),
      input.aliasToDisplayName,
    );
    expect(out).toEqual({
      kind: "ok",
      drafts: [{ text: "On it, calling the family." }, { text: "b" }],
    });
  });
  it("is invalid with no usable draft, and refused when a draft carries a dose", () => {
    expect(parseDrafts(JSON.stringify({ drafts: [] }), new Map()).kind).toBe("invalid");
    expect(parseDrafts("nope", new Map()).kind).toBe("invalid");
    expect(
      parseDrafts(JSON.stringify({ drafts: [{ text: "Give 5 mg now" }] }), new Map()).kind,
    ).toBe("refused");
  });
});

describe("helpers", () => {
  it("reidentify puts names back only for aliases the caller can resolve", () => {
    expect(
      reidentify("Sender A [RN] and Sender Q [SW] saw [PATIENT]", input.aliasToDisplayName),
    ).toBe("Rita Alvarez and a colleague saw the patient");
  });
  it("denylist leaves ordinary coordination language alone", () => {
    expect(violatesDenylist("Family asked for a call today; PRN not confirmed")).toBe(false);
    expect(plainText("a  b\u0000c")).toBe("a b c");
  });
});
