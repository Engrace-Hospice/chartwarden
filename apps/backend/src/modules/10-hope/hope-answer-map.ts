import type { HopeAnswerSnapshot } from "./spec/applicability";

interface CodedHopeItem {
  readonly itemCode: string;
}

/** Build the canonical item-code keyed answer projection used by every M10 rule engine. */
export function hopeAnswerMapByCode(input: {
  readonly itemsById: ReadonlyMap<string, CodedHopeItem>;
  readonly answersByItem: ReadonlyMap<string, HopeAnswerSnapshot>;
  readonly candidateAnswers?: ReadonlyMap<string, HopeAnswerSnapshot>;
}): Map<string, HopeAnswerSnapshot> {
  const out = new Map<string, HopeAnswerSnapshot>();
  for (const [itemId, answer] of input.answersByItem) {
    const item = input.itemsById.get(itemId);
    if (item) out.set(item.itemCode, { state: answer.state, value: answer.value });
  }
  for (const [itemCode, answer] of input.candidateAnswers ?? []) out.set(itemCode, answer);
  return out;
}
