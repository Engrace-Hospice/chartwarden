import { describe, expect, it } from "vitest";
import {
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_QUESTION_LENGTH,
  checkPollInput,
  normalisePollText,
} from "../src/messaging-polls";

const check = (question: string, options: string[]) => checkPollInput({ question, options });

describe("normalisePollText", () => {
  it("collapses whitespace and control characters to single spaces", () => {
    expect(normalisePollText("  Fri \n\t lunch\u0000? ")).toBe("Fri lunch ?");
  });
});

describe("checkPollInput", () => {
  it("accepts a normal poll and returns the cleaned values", () => {
    expect(check("  Lunch? ", [" Pizza ", "Salad"])).toEqual({
      ok: true,
      question: "Lunch?",
      options: ["Pizza", "Salad"],
    });
  });

  it("rejects fewer than 2 and more than 10 options", () => {
    expect(check("Q", ["only"]).ok).toBe(false);
    const eleven = Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`);
    expect(check("Q", eleven).ok).toBe(false);
    const ten = Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => `o${i}`);
    expect(check("Q", ten).ok).toBe(true);
  });

  it("rejects blank, over-long and markup text", () => {
    expect(check("   ", ["a", "b"]).ok).toBe(false);
    expect(check("x".repeat(POLL_MAX_QUESTION_LENGTH + 1), ["a", "b"]).ok).toBe(false);
    expect(check("Q", ["a", "x".repeat(POLL_MAX_OPTION_LENGTH + 1)]).ok).toBe(false);
    expect(check("Q", ["<script>alert(1)</script>", "b"]).ok).toBe(false);
    expect(check("Q", ["<img src=x onerror=alert(1)>", "b"]).ok).toBe(false);
  });

  it("keeps a bare less-than comparison", () => {
    expect(check("Is 3 < 5?", ["yes", "no"]).ok).toBe(true);
  });

  it("rejects duplicate options case-insensitively after normalising", () => {
    expect(check("Q", ["Pizza", " pizza "])).toEqual({
      ok: false,
      problems: [{ field: "options", problem: "duplicate" }],
    });
  });
});
