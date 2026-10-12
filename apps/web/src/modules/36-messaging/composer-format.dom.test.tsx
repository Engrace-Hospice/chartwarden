// M36 WP 2.1 - applying a format shortcut to a real textarea (jsdom): native undo path and the fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTextEdit, toggleWrap } from "./composer-format";

const doc = document as unknown as { execCommand?: unknown };

function mountArea(value: string): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  area.value = value;
  document.body.appendChild(area);
  return area;
}

afterEach(() => {
  doc.execCommand = undefined;
  document.body.innerHTML = "";
});

describe("applyTextEdit", () => {
  it("prefers execCommand(insertText) with the replaced range selected, so the browser records undo", () => {
    const edit = toggleWrap("say hello now", 4, 9, "**");
    const area = mountArea("say hello now");
    const seen: Array<[number, number]> = [];
    doc.execCommand = vi.fn((_command: string, _ui: boolean, text: string) => {
      seen.push([area.selectionStart, area.selectionEnd]);
      area.setRangeText(text, area.selectionStart, area.selectionEnd, "end"); // what the browser does
      return true;
    });
    const onInput = vi.fn();
    area.addEventListener("input", onInput);
    applyTextEdit(area, edit);
    expect(doc.execCommand).toHaveBeenCalledWith("insertText", false, "**hello**");
    expect(seen).toEqual([[4, 9]]);
    expect(area.value).toBe("say **hello** now");
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);
    expect(onInput).not.toHaveBeenCalled(); // the browser fires it itself; we must not fire a second one
  });

  it("falls back to setRangeText plus one input event when execCommand is missing", () => {
    const edit = toggleWrap("say hello now", 4, 9, "**");
    const area = mountArea("say hello now");
    const onInput = vi.fn();
    area.addEventListener("input", onInput);
    applyTextEdit(area, edit);
    expect(area.value).toBe("say **hello** now");
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("L3: an unwrap (empty-ish or no-op insertText) that changed nothing is applied by the fallback", () => {
    const edit = toggleWrap("**hello**", 0, 9, "**");
    expect(edit.replacement).toBe("hello");
    const area = mountArea("**hello**");
    // Some browsers report success for insertText but leave the value alone (empty text, read-only quirks).
    doc.execCommand = vi.fn(() => true);
    const onInput = vi.fn();
    area.addEventListener("input", onInput);
    applyTextEdit(area, edit);
    expect(area.value).toBe("hello");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("L3: a pure deletion (empty replacement) is applied even when the command does nothing", () => {
    const area = mountArea("say **x** now");
    const edit = {
      value: "say  now",
      selectionStart: 4,
      selectionEnd: 4,
      replaceStart: 4,
      replaceEnd: 9,
      replacement: "",
    };
    doc.execCommand = vi.fn(() => true);
    applyTextEdit(area, edit);
    expect(area.value).toBe("say  now");
    expect([area.selectionStart, area.selectionEnd]).toEqual([4, 4]);
  });

  it("a command that throws or returns false is also covered by the fallback", () => {
    const edit = toggleWrap("ab", 1, 1, "*");
    for (const behaviour of [
      () => {
        throw new Error("not allowed");
      },
      () => false,
    ]) {
      const area = mountArea("ab");
      doc.execCommand = vi.fn(behaviour);
      applyTextEdit(area, edit);
      expect(area.value).toBe("a**b");
    }
  });
});
