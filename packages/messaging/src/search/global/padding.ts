// ADR-0058 decision 4 - padding: a message with n real tags is stored with N = max(16, 2^ceil(log2 n)) rows (16 when n = 0).
// Dummies are uniform T-bit values from the CSPRNG, NOT derived from the message id, the key or the content, and are drawn
// fresh on every call (every replace and every rebuild), so a rebuild neither reproduces nor links a prior dummy set.
import { randomInt } from "node:crypto";
import { PADDING_FLOOR, assertTagBits } from "./params";

export function paddedSize(realTagCount: number): number {
  if (realTagCount <= PADDING_FLOOR) return PADDING_FLOOR;
  return 2 ** Math.ceil(Math.log2(realTagCount));
}

/** A uniform integer in [0, 2^tagBits) from the CSPRNG (rejection-sampled by node:crypto). */
export function randomTag(tagBits: number): number {
  return randomInt(0, 2 ** assertTagBits(tagBits));
}

/** Real tags plus dummies up to `paddedSize`, shuffled with the CSPRNG so row order carries no meaning. */
export function padTags(realTags: readonly number[], tagBits: number): number[] {
  const padded = [...realTags];
  const target = paddedSize(realTags.length);
  while (padded.length < target) padded.push(randomTag(tagBits));
  for (let i = padded.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [padded[i], padded[j]] = [padded[j] as number, padded[i] as number];
  }
  return padded;
}
