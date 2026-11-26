// The id of the review task a reviewer last opened is kept for the browser session only; sign-out (from
// the lock screen too) and session expiry forget it with every other draft (`clearAllDrafts`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "./ceremony-drafts";
import {
  LAST_REVIEW_TASK_KEY_PREFIX,
  clearAllLastReviewTasks,
  forgetLastReviewTask,
  recallLastReviewTask,
  rememberLastReviewTask,
} from "./last-review-task";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_BATCH = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TASK = "candidate:cccccccc-3333-4333-8333-cccccccccccc";
const MAX_TASK_ID_LENGTH = 100;

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("last opened review task", () => {
  it("recalls the task for the same batch only", () => {
    rememberLastReviewTask(BATCH, TASK);

    expect(recallLastReviewTask(BATCH)).toBe(TASK);
    expect(recallLastReviewTask(OTHER_BATCH)).toBeNull();
  });

  it("keeps the latest task and stores nothing but its id", () => {
    rememberLastReviewTask(BATCH, TASK);
    rememberLastReviewTask(BATCH, "identity:2");

    expect(recallLastReviewTask(BATCH)).toBe("identity:2");
    const stored = Object.keys(window.sessionStorage).map((key) =>
      window.sessionStorage.getItem(key),
    );
    expect(stored).toEqual(["identity:2"]);
  });

  it("refuses anything that is not an opaque task id", () => {
    rememberLastReviewTask(BATCH, "Mobile phone (503) 555-0177");
    expect(recallLastReviewTask(BATCH)).toBeNull();

    window.sessionStorage.setItem(
      `${LAST_REVIEW_TASK_KEY_PREFIX}${BATCH}`,
      "<script>alert(1)</script>",
    );
    expect(recallLastReviewTask(BATCH)).toBeNull();
  });

  it.each([
    ["a social security number", "123-45-6789"],
    ["a date of birth", "1950-01-02"],
    ["a name", "Smith-John"],
    ["a candidate id that is not a uuid", "candidate:123-45-6789"],
    ["an identity page that is not a number", "identity:Smith"],
    ["the Part 2 safeguard", "safeguard:sud"],
  ])("stores and recalls nothing for %s", (_label, taskId) => {
    rememberLastReviewTask(BATCH, taskId);
    expect(Object.keys(window.sessionStorage)).toEqual([]);

    window.sessionStorage.setItem(`${LAST_REVIEW_TASK_KEY_PREFIX}${BATCH}`, taskId);
    expect(recallLastReviewTask(BATCH)).toBeNull();
  });

  it.each([
    ["a 100-character id", `candidate:${"a".repeat(MAX_TASK_ID_LENGTH - "candidate:".length)}`],
    ["a 101-character id", `candidate:${"a".repeat(MAX_TASK_ID_LENGTH + 1 - "candidate:".length)}`],
    ["an identity page of six digits", "identity:123456"],
  ])("refuses %s", (_label, taskId) => {
    rememberLastReviewTask(BATCH, taskId);

    expect(recallLastReviewTask(BATCH)).toBeNull();
    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });

  it("accepts the longest identity task id", () => {
    rememberLastReviewTask(BATCH, "identity:99999");

    expect(recallLastReviewTask(BATCH)).toBe("identity:99999");
  });

  it("forgets one batch without touching another", () => {
    rememberLastReviewTask(BATCH, TASK);
    rememberLastReviewTask(OTHER_BATCH, TASK);

    forgetLastReviewTask(BATCH);

    expect(recallLastReviewTask(BATCH)).toBeNull();
    expect(recallLastReviewTask(OTHER_BATCH)).toBe(TASK);
  });

  it("treats blocked storage as nothing remembered", () => {
    const blocked = (): never => {
      throw new Error("blocked");
    };
    vi.stubGlobal("sessionStorage", {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
      key: blocked,
      length: 1,
    });

    expect(() => rememberLastReviewTask(BATCH, TASK)).not.toThrow();
    expect(() => forgetLastReviewTask(BATCH)).not.toThrow();
    expect(() => clearAllLastReviewTasks()).not.toThrow();
    expect(recallLastReviewTask(BATCH)).toBeNull();
  });
});

describe("clearing the remembered tasks", () => {
  it("drops every batch's task and leaves unrelated storage alone", () => {
    rememberLastReviewTask(BATCH, TASK);
    rememberLastReviewTask(OTHER_BATCH, "identity:2");
    window.sessionStorage.setItem("unrelated", "kept");

    clearAllLastReviewTasks();

    expect(recallLastReviewTask(BATCH)).toBeNull();
    expect(recallLastReviewTask(OTHER_BATCH)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("kept");
  });

  it("is part of what sign-out and session expiry forget; an idle lock keeps it", () => {
    // The idle lock never calls clearAllDrafts (only the lock screen's sign-out link and an expired
    // session do), so the remembered task survives it: asserting clearAllDrafts is what forgets.
    rememberLastReviewTask(BATCH, TASK);
    expect(recallLastReviewTask(BATCH)).toBe(TASK);

    clearAllDrafts();

    expect(recallLastReviewTask(BATCH)).toBeNull();
  });
});
