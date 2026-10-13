// WP 2.7b (ADR-0058, Accepted) - the initial, tunable parameter values of the global blind-token index, and the T
// arithmetic of "Parameter values and the T arithmetic". Every value here is a Decided-2026-10-13 INITIAL value that the
// design review must re-validate by measurement; nothing here enables search anywhere.

export const MIN_TOKEN_LENGTH = 3;
export const MAX_TOKEN_LENGTH = 40;
/** The shortest typed prefix a query may use; equal to the shortest prefix tag. */
export const MIN_QUERY_PREFIX_LENGTH = 3;
/** Prefix tags exist for lengths MIN_QUERY_PREFIX_LENGTH..min(len, MAX_PREFIX_TAG_LENGTH). */
export const MAX_PREFIX_TAG_LENGTH = 12;

/** HMAC tag width T (bits). The single most leakage-relevant knob; the reviewers must confirm it. */
export const DEFAULT_TAG_BITS = 19;
export const MIN_TAG_BITS = 12;
/** The `message_search_token.tag` CHECK allows 0 <= tag < 2^20. */
export const MAX_TAG_BITS = 20;
/** `D_org / B` the per-tenant sizing rule aims for. */
export const TARGET_TAGS_PER_BUCKET = 0.75;

export const PADDING_FLOOR = 16;

export const CANDIDATE_CAP = 500;
export const DECRYPT_BUDGET = 200;
export const DECRYPT_TIMEOUT_MS = 3000;
export const STATEMENT_TIMEOUT_MS = 5000;
export const HEAD_BUCKET_ROWS = 5000;
export const MAX_PAGES_PER_QUERY = 5;
export const RATE_LIMIT_PER_USER_PER_MINUTE = 30;
export const RATE_LIMIT_PER_ORG_PER_MINUTE = 300;

/** The per-tenant sizing rule: T = clamp(round(log2(D_org / 0.75)), 12, 20); 19 when D_org is not yet known. */
export function tagBitsForDistinctTags(distinctTags: number | null | undefined): number {
  if (distinctTags === null || distinctTags === undefined || !(distinctTags > 0)) {
    return DEFAULT_TAG_BITS;
  }
  const raw = Math.round(Math.log2(distinctTags / TARGET_TAGS_PER_BUCKET));
  return Math.min(MAX_TAG_BITS, Math.max(MIN_TAG_BITS, raw));
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
