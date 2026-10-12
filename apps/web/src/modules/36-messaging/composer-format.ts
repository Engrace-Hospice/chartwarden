// M36 WP 2.1 - composer keyboard shortcuts that edit the draft text (the markdown the user would otherwise type).
// Ctrl+B bold, Ctrl+I italic, Ctrl+E code (Cmd on macOS). The edit is computed purely (`toggleWrap`) and applied to
// the textarea through the browser's own editing command where it exists, so the browser's undo stack keeps it.

export interface TextEdit {
  /** The whole draft after the edit. */
  readonly value: string;
  /** Selection after the edit. */
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** The range of the OLD text that `replacement` takes the place of (what an insertText command overwrites). */
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly replacement: string;
}

interface ShortcutEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

interface PlatformSource {
  readonly platform?: string;
  readonly userAgentData?: { readonly platform?: string };
}

// By physical key (event.code), so Cyrillic, Greek, Hebrew ... layouts keep the same shortcuts.
const MARKERS: Readonly<Record<string, string>> = { KeyB: "**", KeyI: "*", KeyE: "`" };

/** True on macOS/iOS, where the command key (not control) is the shortcut modifier. */
export function isMacPlatform(source: PlatformSource | undefined): boolean {
  const name = source?.userAgentData?.platform || source?.platform || "";
  return /mac|iphone|ipad|ipod/i.test(name);
}

/** The running browser's answer (kept apart from `isMacPlatform` so the latter is testable). */
export const detectMac = (): boolean =>
  isMacPlatform(typeof navigator === "undefined" ? undefined : navigator);

/** The markdown marker a format shortcut inserts, or null when the key press is not a format shortcut. */
export function formatShortcutMarker(event: ShortcutEvent, mac: boolean): string | null {
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey) return null;
  return MARKERS[event.code] ?? null;
}

/** Wrap the selection in `marker`, or unwrap it when it is already wrapped. An empty selection inserts a pair. */
export function toggleWrap(value: string, start: number, end: number, marker: string): TextEdit {
  const selected = value.slice(start, end);
  const length = marker.length;
  const around =
    value.slice(start - length, start) === marker &&
    value.slice(end, end + length) === marker &&
    // A lone `*` is not the italic marker when it is half of a bold `**`.
    !(marker === "*" && (value[start - 2] === "*" || value[end + 1] === "*"));
  if (around) {
    return {
      value: value.slice(0, start - length) + selected + value.slice(end + length),
      selectionStart: start - length,
      selectionEnd: end - length,
      replaceStart: start - length,
      replaceEnd: end + length,
      replacement: selected,
    };
  }
  const inside =
    selected.length >= length * 2 && selected.startsWith(marker) && selected.endsWith(marker);
  if (inside) {
    const unwrapped = selected.slice(length, selected.length - length);
    return {
      value: value.slice(0, start) + unwrapped + value.slice(end),
      selectionStart: start,
      selectionEnd: start + unwrapped.length,
      replaceStart: start,
      replaceEnd: end,
      replacement: unwrapped,
    };
  }
  return {
    value: value.slice(0, start) + marker + selected + marker + value.slice(end),
    selectionStart: start + length,
    selectionEnd: end + length,
    replaceStart: start,
    replaceEnd: end,
    replacement: marker + selected + marker,
  };
}

/**
 * Apply an edit to a textarea so that (1) the browser's undo stack records it, (2) React's onChange runs, and
 * (3) the selection is correct before this function returns (no animation-frame hop).
 * `execCommand("insertText")` does (1) and (2) natively. Where it is missing or refuses, `setRangeText` plus a
 * dispatched `input` event does (2); undo then falls back to the browser's default behaviour for programmatic edits.
 */
export function applyTextEdit(textarea: HTMLTextAreaElement, edit: TextEdit): void {
  const before = textarea.value;
  textarea.focus();
  textarea.setSelectionRange(edit.replaceStart, edit.replaceEnd);
  const execCommand = (document as { execCommand?: (...args: unknown[]) => boolean }).execCommand;
  try {
    execCommand?.call(document, "insertText", false, edit.replacement);
  } catch {
    // fall through: the value check below decides whether the command did the job
  }
  // A command that is missing, throws, returns false, or "succeeds" without producing the text (an empty insertText
  // is the usual case) is caught here by comparing the value, and the edit is applied directly.
  if (textarea.value !== edit.value) {
    // Apply it ourselves only when the command left the text untouched. Any other result is the browser's own
    // (and it already fired its own input event): overwriting it would fight the user's undo stack.
    if (textarea.value === before) {
      textarea.setRangeText(edit.replacement, edit.replaceStart, edit.replaceEnd, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}
