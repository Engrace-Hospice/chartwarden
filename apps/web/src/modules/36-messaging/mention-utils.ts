import type { MessageReferenceInput } from "./messaging-types";

export function reconcileReferences(
  previous: string,
  next: string,
  references: readonly MessageReferenceInput[],
): MessageReferenceInput[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const removedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return references.flatMap((reference) => {
    if (reference.end <= prefix) return [reference];
    if (reference.start >= removedEnd) {
      const shifted = { ...reference, start: reference.start + delta, end: reference.end + delta };
      return next.slice(shifted.start, shifted.end) === `@${shifted.displayLabel}` ? [shifted] : [];
    }
    return [];
  });
}

export function activeMentionQuery(
  value: string,
  cursor: number,
  references: readonly MessageReferenceInput[],
): { query: string; start: number } | null {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N} .'-]{0,60})$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = cursor - query.length - 1;
  // A selected token ends mention discovery. Text after its separating space is ordinary prose;
  // without this guard the regex treated the token and every following word as one long search.
  if (references.some((reference) => reference.start === start && cursor >= reference.end)) {
    return null;
  }
  return { query, start };
}
