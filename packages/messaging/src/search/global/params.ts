// WP 2.7b (ADR-0058, Accepted) - the initial, tunable parameter values of the global blind-token index, and the T
// arithmetic of "Parameter values and the T arithmetic". Every value here is a Decided-2026-10-13 INITIAL value that the
// design review must re-validate by measurement; nothing here enables search anywhere.

export const MIN_TOKEN_LENGTH = 3;
export const MAX_TOKEN_LENGTH = 40;
/** The shortest typed prefix a query may use; equal to the shortest prefix tag. */
export const MIN_QUERY_PREFIX_LENGTH = 3;
/**
 * Prefix tags exist ONLY at these lengths (sparse, ADR-0058 2026-10-13 desk review; a dense 3..12 chain leaked word length
 * and shared-prefix structure through tag-cluster size). A word shorter than a listed length contributes only the lengths
 * <= its length.
 */
export const PREFIX_TAG_LENGTHS = [3, 5, 8, 12] as const;
export const MAX_PREFIX_TAG_LENGTH = 12;

/** The largest prefix tag length <= `typedLength` (a typed prefix is queried at this length, then verified after decrypt). */
export function prefixTagLengthFor(typedLength: number): number {
  let best = PREFIX_TAG_LENGTHS[0] as number;
  for (const length of PREFIX_TAG_LENGTHS) if (length <= typedLength) best = length;
  return best;
}

/** HMAC tag width T (bits). The single most leakage-relevant knob; the reviewers must confirm it. */
export const DEFAULT_TAG_BITS = 19;
export const MIN_TAG_BITS = 12;
/** The `message_search_token.tag` CHECK allows 0 <= tag < 2^20. */
export const MAX_TAG_BITS = 20;
/** Rows per bucket the per-tenant sizing rule aims for (security review H2: sized on STORED ROWS, not on distinct tags). */
export const TARGET_ROWS_PER_BUCKET = 150;
/** A stored T is rebuilt only when the rule's T differs from it by at least this many bits (4x the rows): hysteresis, so a 1-bit rounding wobble never takes search down. */
export const TAG_BITS_REBUILD_DELTA = 2;
/**
 * Most channels one query searches (per-channel keys: every channel costs one tag per term). Above it the most recently active
 * channels are searched and the response says the scan was capped (never silent).
 */
export const MAX_QUERY_CHANNELS = 300;
/** Most (channel, tag) head pairs recorded per index state; the largest buckets win. */
export const MAX_HEAD_PAIRS = 2000;

export const PADDING_FLOOR = 16;

export const CANDIDATE_CAP = 500;
export const DECRYPT_BUDGET = 200;
export const DECRYPT_TIMEOUT_MS = 3000;
export const STATEMENT_TIMEOUT_MS = 5000;
export const HEAD_BUCKET_ROWS = 5000;
export const MAX_PAGES_PER_QUERY = 5;
export const RATE_LIMIT_PER_USER_PER_MINUTE = 30;
export const RATE_LIMIT_PER_ORG_PER_MINUTE = 300;

/**
 * The per-tenant sizing rule (security review H2): T = clamp(round(log2(totalRows / 150)), 12, 20), where totalRows is the number of
 * stored token rows (real + dummy) of the (org, key version); 19 when it is not yet known. This is the ADR table's "rows per
 * bucket ~ 150" row: the reference tenant (8 x 10^7 rows) gives 19.
 */
export function tagBitsForTotalRows(totalRows: number | null | undefined): number {
  if (totalRows === null || totalRows === undefined || !(totalRows > 0)) return DEFAULT_TAG_BITS;
  const raw = Math.round(Math.log2(totalRows / TARGET_ROWS_PER_BUCKET));
  return Math.min(MAX_TAG_BITS, Math.max(MIN_TAG_BITS, raw));
}

/** True when the stored width is far enough from the rule's width (for the current row count) to justify a rebuild. */
export function shouldResizeTagBits(currentBits: number, totalRows: number): boolean {
  if (!(totalRows > 0)) return false; // an empty index has no row count to size on (the rule's "unknown" answer is the default 19)
  return Math.abs(tagBitsForTotalRows(totalRows) - currentBits) >= TAG_BITS_REBUILD_DELTA;
}

export function assertTagBits(tagBits: number): number {
  if (!Number.isInteger(tagBits) || tagBits < MIN_TAG_BITS || tagBits > MAX_TAG_BITS) {
    throw new RangeError(
      `search tag width must be an integer in [${MIN_TAG_BITS}, ${MAX_TAG_BITS}] (got ${tagBits})`,
    );
  }
  return tagBits;
}

export interface TagArithmetic {
  readonly buckets: number;
  /** D / B: distinct tag values per bucket. */
  readonly tagsPerBucket: number;
  /** 1 - e^(-D/B): the share of tags that share a bucket with another. */
  readonly shareSharingBucket: number;
  /** Total rows / B: rows an observer sees per bucket. */
  readonly rowsPerBucket: number;
}

/** The ADR's T arithmetic for D distinct tag values and `totalRows` stored rows. */
export function tagArithmetic(
  tagBits: number,
  distinctTags: number,
  totalRows: number,
): TagArithmetic {
  const buckets = 2 ** tagBits;
  const tagsPerBucket = distinctTags / buckets;
  return {
    buckets,
    tagsPerBucket,
    shareSharingBucket: 1 - Math.exp(-tagsPerBucket),
    rowsPerBucket: totalRows / buckets,
  };
}

/** P(a bucket holds at least one of `headTags` heavy tags) = 1 - e^(-H/B): the tail-bound row of the ADR. */
export function headBucketProbability(tagBits: number, headTags: number): number {
  return 1 - Math.exp(-headTags / 2 ** tagBits);
}

/** About `bucketRows / (m + bucketRows)` of a single-word query's candidates are false (dropped after decrypt). */
export function falseCandidateRate(trueMatches: number, bucketRows: number): number {
  return bucketRows / (trueMatches + bucketRows);
}
