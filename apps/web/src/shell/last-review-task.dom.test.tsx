// The id of the review task a reviewer last opened is kept for the browser session only, and sign-out (and an
// expired session) forget it with every other draft (`clearAllDrafts`). The idle screen lock keeps drafts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts } from "./ceremony-drafts";
import {
  clearAllLastReviewTasks,
  forgetLastReviewTask,
  recallLastReviewTask,
  rememberLastReviewTask,
} from "./last-review-task";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_BATCH = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TASK = "candidate:cccccccc-3333-4333-8333-cccccccccccc";

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
    expect(window.sessionStorage.length).toBe(0);
    expect(recallLastReviewTask(BATCH)).toBeNull();

    window.sessionStorage.setItem(`wx.unified-review-task:${BATCH}`, "<script>alert(1)</script>");
    expect(recallLastReviewTask(BATCH)).toBeNull();
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

    expect(() => window.sessionStorage.getItem("x")).toThrow();
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

  it("is part of what sign-out forgets", () => {
    rememberLastReviewTask(BATCH, TASK);

    clearAllDrafts();

    expect(recallLastReviewTask(BATCH)).toBeNull();
  });
});
