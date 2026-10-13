// WP 2.7a: the line a search result shows - a window of the message around the first hit, with every hit marked.
// Pure and case-insensitive; the match is on the text the server already returned, nothing is sent anywhere.

export interface SnippetSegment {
  readonly text: string;
  readonly hit: boolean;
}

const WINDOW_BEFORE = 40;
const WINDOW_AFTER = 110;

/** The search words as the user typed them: lower-cased, whitespace-split, de-duplicated. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

export function snippetSegments(body: string, words: readonly string[]): SnippetSegment[] {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat === "") return [];
  const lower = flat.toLowerCase();
  // Case folding can change a string's length (rare scripts): then offsets do not line up, so show it unmarked.
  const aligned = lower.length === flat.length;
  const first = aligned
    ? words.reduce((best, word) => {
        const at = lower.indexOf(word);
        return at >= 0 && (best < 0 || at < best) ? at : best;
      }, -1)
    : -1;
  const start = Math.max(0, first - WINDOW_BEFORE);
  const end = Math.min(flat.length, Math.max(start + WINDOW_AFTER, first + WINDOW_AFTER));
  const windowText = flat.slice(start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  if (!aligned || first < 0) return [{ text: `${prefix}${windowText}${suffix}`, hit: false }];

  const lowerWindow = lower.slice(start, end);
  const marked = new Array<boolean>(windowText.length).fill(false);
  for (const word of words) {
    for (let at = lowerWindow.indexOf(word); at >= 0; at = lowerWindow.indexOf(word, at + 1)) {
      marked.fill(true, at, at + word.length);
    }
  }
  const segments: SnippetSegment[] = [];
  let from = 0;
  for (let i = 1; i <= windowText.length; i += 1) {
    if (i === windowText.length || marked[i] !== marked[from]) {
      segments.push({ text: windowText.slice(from, i), hit: marked[from]! });
      from = i;
    }
  }
  if (prefix) segments.unshift({ text: prefix, hit: false });
  if (suffix) segments.push({ text: suffix, hit: false });
  return segments;
}
