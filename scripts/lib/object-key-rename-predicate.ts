// The catalog predicate migration 1546 ends with and docs/runbooks/object-key-column-rename-deployment.md has the
// operator run before the window. Both files carry the same text between these markers; the tests read it from here.
const BEGIN = "-- predicate:begin";
const END = "-- predicate:end";

/** The SQL between the markers, as written (comments and line breaks kept, so it can be executed). */
export function extractCatalogPredicate(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error(`missing ${BEGIN} / ${END} markers`);
  return text.slice(start + BEGIN.length, end);
}

/** The same predicate with whitespace collapsed, for comparing the two copies. */
export function normalizeCatalogPredicate(text: string): string {
  return extractCatalogPredicate(text).replace(/\s+/g, " ").trim();
}
