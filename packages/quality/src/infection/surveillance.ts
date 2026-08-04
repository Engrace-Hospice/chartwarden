import type { schema } from "@wardenx/db";
// @wardenx/quality — M30 §7.8 / D11: infection-surveillance event normalization (coding helpers).
//
// Each `infection_surveillance_event` row records a per-organism observation (pathogen, body site,
// transmission context) keyed to a provider entity. Outbreak detection (./outbreak_detector) clusters
// these by `(provider_entity, pathogen, body_site)` over a 14-day window, so the pathogen/body-site
// codes MUST normalize to a stable cluster key — otherwise `"MRSA"` and `"mrsa "` would split a real
// cluster across two keys and suppress detection.
//
// PURE DOMAIN (P2a): coding helpers + a normalized projection of a surveillance row. No DB, no I/O, no
// M38 value-set lookup (V-17 validation against the M38 pathogen / body-site value sets is a route-layer
// concern in a LATER phase) — these helpers only canonicalize an already-validated code into the form
// the cluster key compares. Empty/blank codes throw a `WardenXError`.
import { WardenXError } from "@wardenx/types";

/**
 * The minimal surveillance observation the cluster pipeline consumes — a structural subset of the
 * `infection_surveillance_event` row, so a full row (or a synthetic test fixture) projects cleanly.
 */
export interface RawSurveillanceObservation {
  /** The event id (carried through so a detected cluster can cite its triggering events). */
  readonly id: string;
  /** Owning org (canonical app.org_id scope). */
  readonly organizationId: string;
  /** The provider entity the observation belongs to — part of the cluster key (D11). */
  readonly providerEntityId: string;
  /** Pathogen code (M38 value set; V-17) — normalized before keying. */
  readonly pathogen: string;
  /** Body-site code (M38 value set; V-17) — normalized before keying. */
  readonly bodySite: string;
  /** When the organism was observed (the partition key + cluster-window axis). */
  readonly observedAt: Date | string;
}

/** A surveillance observation with canonicalized codes and a precomputed cluster key + epoch-ms. */
export interface NormalizedSurveillanceEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** Canonicalized pathogen code. */
  readonly pathogen: string;
  /** Canonicalized body-site code. */
  readonly bodySite: string;
  /** Observation instant. */
  readonly observedAt: Date;
  /** Observation instant as epoch-ms (cached for the detector's sliding-window arithmetic). */
  readonly observedAtMs: number;
  /** The `(providerEntityId, pathogen, bodySite)` cluster key the 14-day detector groups on (D11). */
  readonly clusterKey: string;
}

/**
 * Canonicalize a surveillance code: trim, collapse internal whitespace, and lowercase so casing /
 * spacing variants of the same M38 code resolve to one cluster key. Throws `WardenXError` on a blank
 * code (a real observation always carries a pathogen + body site — V-17).
 */
function normalizeCode(raw: string, field: string): string {
  const normalized = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.length === 0) {
    throw new WardenXError(
      "infection_surveillance_blank_code",
      `${field} must be a non-empty code`,
      422,
    );
  }
  return normalized;
}

/** Canonicalize a pathogen code for cluster keying (V-17). */
export function normalizePathogen(pathogen: string): string {
  return normalizeCode(pathogen, "pathogen");
}

/** Canonicalize a body-site code for cluster keying (V-17). */
export function normalizeBodySite(bodySite: string): string {
  return normalizeCode(bodySite, "bodySite");
}

/**
 * The §7.8 / D11 cluster key — `(providerEntityId, pathogen, bodySite)`. The two codes are assumed
 * already-normalized (call this with the output of {@link normalizePathogen} / {@link normalizeBodySite}
 * or via {@link normalizeSurveillanceEvent}). The `` separator cannot occur in a code, so the key
 * is injective over the triple.
 */
export function surveillanceClusterKey(
  providerEntityId: string,
  pathogen: string,
  bodySite: string,
): string {
  return `${providerEntityId}${pathogen}${bodySite}`;
}

/** Parse an ISO-8601 instant (or `Date`), throwing `WardenXError` on an invalid value. */
function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new WardenXError(
      "infection_surveillance_invalid_timestamp",
      "observedAt is not a valid ISO-8601 instant",
      422,
    );
  }
  return date;
}

/**
 * Project a raw observation into the normalized, cluster-keyed shape the detector consumes. Pure: all
 * codes are canonicalized and `observedAt` is parsed once.
 */
export function normalizeSurveillanceEvent(
  input: RawSurveillanceObservation,
): NormalizedSurveillanceEvent {
  const pathogen = normalizePathogen(input.pathogen);
  const bodySite = normalizeBodySite(input.bodySite);
  const observedAt = toDate(input.observedAt);
  return {
    id: input.id,
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    pathogen,
    bodySite,
    observedAt,
    observedAtMs: observedAt.getTime(),
    clusterKey: surveillanceClusterKey(input.providerEntityId, pathogen, bodySite),
  };
}

/**
 * Convenience projection of a persisted `infection_surveillance_event` row (the detector's production
 * input). Forwards to {@link normalizeSurveillanceEvent} over the row's surveillance columns.
 */
export function normalizeSurveillanceRow(
  row: schema.InfectionSurveillanceEvent,
): NormalizedSurveillanceEvent {
  return normalizeSurveillanceEvent({
    id: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    pathogen: row.pathogen,
    bodySite: row.bodySite,
    observedAt: row.observedAt,
  });
}
