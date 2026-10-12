// M36 WP 2.1 - applying a format shortcut to a real textarea (jsdom): native undo path and the fallback.
import { describe, expect, it, vi } from "vitest";
import { applyTextEdit, toggleWrap } from "./composer-format";

describe("applyTextEdit", () => {
  it("applyTextEdit prefers execCommand (native undo) and falls back to setRangeText plus an input event", () => {
    const edit = toggleWrap("say hello now", 4, 9, "**");
    const area = document.createElement("textarea");
    area.value = "say hello now";
    document.body.appendChild(area);
    const doc = document as unknown as { execCommand?: unknown };
    const seen: Array<[number, number]> = [];
    doc.execCommand = vi.fn(() => {
      seen.push([area.selectionStart, area.selectionEnd]);
      return true;
    });
    applyTextEdit(area, edit);
    expect(doc.execCommand).toHaveBeenCalledWith("insertText", false, "**hello**");
    expect(seen).toEqual([[4, 9]]);

    doc.execCommand = undefined;
    const onInput = vi.fn();
    area.addEventListener("input", onInput);
    applyTextEdit(area, edit);
    expect(area.value).toBe("say **hello** now");
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);
    expect(onInput).toHaveBeenCalledTimes(1);
    area.remove();
  });
});
