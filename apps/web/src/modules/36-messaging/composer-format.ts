// M36 WP 2.1 - composer keyboard shortcuts that edit the draft text (the markdown the user would otherwise type).
// Pure: the thread applies the returned edit to the textarea. Ctrl/Cmd+B bold, Ctrl/Cmd+I italic, Ctrl/Cmd+E code.

export interface TextEdit {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface ShortcutEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const MARKERS: Readonly<Record<string, string>> = { b: "**", i: "*", e: "`" };

/** The markdown marker a format shortcut inserts, or null when the key press is not a format shortcut. */
export function formatShortcutMarker(event: ShortcutEvent): string | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return null;
  return MARKERS[event.key.toLowerCase()] ?? null;
}

/** Wrap the selection in `marker`, or unwrap it when it is already wrapped. An empty selection inserts a pair. */
export function toggleWrap(value: string, start: number, end: number, marker: string): TextEdit {
  const selected = value.slice(start, end);
  const length = marker.length;
  const around =
    value.slice(start - length, start) === marker && value.slice(end, end + length) === marker;
  if (around) {
    return {
      value: value.slice(0, start - length) + selected + value.slice(end + length),
      selectionStart: start - length,
      selectionEnd: end - length,
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
    };
  }
  return {
    value: value.slice(0, start) + marker + selected + marker + value.slice(end),
    selectionStart: start + length,
    selectionEnd: end + length,
  };
}
