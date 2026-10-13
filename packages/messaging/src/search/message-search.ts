// WP 2.7a - in-conversation search, option A of 02 section 6: decrypt-and-filter over an authorised, channel-bounded
// candidate set. There is NO index of any kind: the query is matched in memory against bodies opened under the tenant
// DEK, and nothing derived from a body (token, hash, n-gram) is stored. A numeric or id-like token therefore has no
// special handling here; D10's "not indexed" rule binds the future global index (2.7b), which must not reuse this.
import { WardenXError } from "@wardenx/types";
import type { ResolvedMessage } from "../interfaces/provider";

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 100;
export const SEARCH_MAX_TERMS = 5;
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 50;
/**
 * The honest performance ceiling of option A: one request opens at most this many bodies. A channel with more
 * history than this answers with a continuation cursor (`scanCapped`) instead of a longer wait.
 */
export const SEARCH_MAX_SCAN_PER_REQUEST = 5000;

export interface MessageSearchInput {
  readonly userId: string;
  readonly channelId: string;
  /** Free text; optional only when at least one filter is given. */
  readonly query?: string;
  readonly senderUserId?: string;
  /** Inclusive lower / exclusive upper bound on created_at (ISO 8601). */
  readonly from?: string;
  readonly to?: string;
  /** True: only messages that show the caller an attachment. */
  readonly hasAttachment?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MessageSearchResult {
  /** Newest first. Live messages only: a tombstone never matches. */
  readonly results: readonly ResolvedMessage[];
  /** Present when older history remains to be examined (page full, or the scan cap was hit). */
  readonly nextCursor?: string;
  /** How many message bodies this request examined (bounded by SEARCH_MAX_SCAN_PER_REQUEST). */
  readonly scanned: number;
  /** True when the scan cap, not the page size, ended this request: more history may hold more matches. */
  readonly scanCapped: boolean;
  /** The care_team channel's patient, for read-audit attribution; null for other kinds. */
  readonly patientId: string | null;
}

const INVISIBLES = /[​-‏⁠﻿­]/g;

/** NFKC, invisibles stripped, lower-cased, whitespace collapsed: the one comparison form for query and body. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLES, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function invalidQuery(message: string): WardenXError {
  return new WardenXError("INVALID_SEARCH_QUERY", message, 422);
}

/** The distinct normalised terms of a query; throws a 422 that never echoes the query. */
export function parseSearchQuery(raw: string): string[] {
  const normalised = normalizeSearchText(raw);
  if (normalised.length < SEARCH_MIN_QUERY_LENGTH) {
    throw invalidQuery(`search needs at least ${SEARCH_MIN_QUERY_LENGTH} characters`);
  }
  if (normalised.length > SEARCH_MAX_QUERY_LENGTH) {
    throw invalidQuery(`search is limited to ${SEARCH_MAX_QUERY_LENGTH} characters`);
  }
  const terms = [...new Set(normalised.split(" "))];
  if (terms.length > SEARCH_MAX_TERMS) {
    throw invalidQuery(`search is limited to ${SEARCH_MAX_TERMS} words`);
  }
  return terms;
}

/** Every term is a substring of the (already normalised) body. */
export function bodyMatchesTerms(normalisedBody: string, terms: readonly string[]): boolean {
  if (normalisedBody.length === 0) return false;
  return terms.every((term) => normalisedBody.includes(term));
}

/** Clamp a requested page size into [1, SEARCH_MAX_PAGE_SIZE]. */
export function searchPageSize(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? SEARCH_DEFAULT_PAGE_SIZE, 1), SEARCH_MAX_PAGE_SIZE);
}

/** A search needs a query or at least one filter; an empty one would just be the channel history. */
export function assertSearchHasCriteria(input: MessageSearchInput): string[] {
  const hasFilter =
    input.senderUserId !== undefined ||
    input.from !== undefined ||
    input.to !== undefined ||
    input.hasAttachment === true;
  if (input.query === undefined || input.query.trim() === "") {
    if (!hasFilter) throw invalidQuery("enter a search term or choose a filter");
    return [];
  }
  return parseSearchQuery(input.query);
}

export interface MessageSearchService {
  /**
   * Search ONE channel the caller can currently view. 404 (the random-id 404, no oracle) for a non-member, a removed
   * member, a Part 2 gated channel or another organisation; 410 CHANNEL_ARCHIVED on an archived channel; 422
   * INVALID_SEARCH_QUERY for a bad query. Searches the CURRENT body of live messages only.
   */
  searchMessages(orgId: string, input: MessageSearchInput): Promise<MessageSearchResult>;
}
