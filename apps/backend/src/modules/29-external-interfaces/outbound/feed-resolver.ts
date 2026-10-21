// apps/backend/src/modules/29-external-interfaces/outbound/feed-resolver.ts — resolves the outbound
// `external_feed` a `m11.order.hl7_orm_requested` dispatches over (M29-T08, F-175/#248; routing + identity
// columns F-181/#248, migration 0262).
//
// ROUTING (F-181). `external_feed.lab_destination_facility_id` — a LOGICAL M40 Facility id — links an outbound
// feed to the lab it delivers to, and the resolver routes `OrmRequestedPayload.labDestinationFacilityId` through
// it. Rules, in order (see `selectOutboundFeed`, pure and unit-tested):
//   1. Candidates = the org's `active` `orm_outbound` feeds inside their operational window that have a host.
//   2. Request names a facility AND exactly one candidate is linked to it → that feed. More than one → refuse
//      `ambiguous_feed` (never silently pick).
//   3. Otherwise the SINGLE-FEED FALLBACK, which exists only so a pre-F-181 tenant with one unlinked feed keeps
//      working: it applies ONLY when exactly one candidate exists AND that candidate's link is genuinely absent
//      (null). A single feed that IS linked to a different facility never receives another destination's order
//      (`no_feed_for_destination`), and a request with no facility never rides a feed that is linked elsewhere.
//   4. Zero candidates → `no_active_feed`; several with no match → `ambiguous_feed`.
//
// MSH IDENTITY (F-181). MSH-3/4/5/6 come from `msh_sending_application` / `msh_sending_facility` /
// `msh_receiving_application` / `msh_receiving_facility`. The old `displayName` fallback is gone: an operator
// label is not a validated HL7 identifier and reusing one string for three fields is fabrication. MSH-3 alone
// defaults to the fixed platform identity (`OUTBOUND_SENDING_APPLICATION` — WardenX's own name never varies per
// feed, so this is a constant, not a guess). If any of the other three is absent the resolver returns
// `feed_identity_incomplete` naming only the FIELD NAMES (PHI-free) and the worker refuses the send.
//
// The retry sweep resolves by the queued row's OWN feed id (`resolveById`) — the wire was built at queue time,
// so a second feed appearing later must not stall a row that is already bound to a specific feed.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { OrmEndpoint } from "./orm-o01";

const FEED = schema.externalFeed;

/** WardenX's own fixed MSH-3 sending-application identity — never varies per feed or per tenant. */
export const OUTBOUND_SENDING_APPLICATION = "WARDENX";

/** The transport-facing part of a resolved feed (everything a send/retry needs; no MSH identity). */
export interface ResolvedFeedTransport {
  readonly id: string;
  readonly organizationId: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: "mllp_tls" | "mllp_plain";
  readonly channelCertPin: string | null;
  readonly rateLimitMsgPerSec: number;
  /** F-183 — the feed's own `in_flight` lease in seconds; null = the platform default. */
  readonly inFlightLeaseSeconds: number | null;
}

export interface ResolvedOutboundFeed extends ResolvedFeedTransport {
  readonly endpoint: OrmEndpoint;
}

/** The `external_feed` columns the selection reads — a structural subset so the pure selector is testable. */
export interface OutboundFeedCandidateRow {
  readonly id: string;
  readonly organizationId: string;
  readonly host: string | null;
  readonly port: number;
  readonly protocol: "mllp_tls" | "mllp_plain";
  readonly channelCertPin: string | null;
  readonly rateLimitMsgPerSec: number;
  readonly inFlightLeaseSeconds: number | null;
  readonly activeFrom: Date | null;
  readonly activeThrough: Date | null;
  readonly labDestinationFacilityId: string | null;
  readonly mshSendingApplication: string | null;
  readonly mshSendingFacility: string | null;
  readonly mshReceivingApplication: string | null;
  readonly mshReceivingFacility: string | null;
}

export type FeedIdentityField =
  | "mshSendingFacility"
  | "mshReceivingApplication"
  | "mshReceivingFacility";

export type FeedResolutionFailureReason =
  | { readonly reason: "no_active_feed" }
  | { readonly reason: "ambiguous_feed"; readonly candidateFeedIds: readonly string[] }
  | { readonly reason: "no_feed_for_destination"; readonly candidateFeedIds: readonly string[] }
  | {
      readonly reason: "feed_identity_incomplete";
      readonly feedId: string;
      /** Field NAMES only — never a value, never anything PHI-shaped. */
      readonly missingFields: readonly FeedIdentityField[];
    };

export type FeedResolutionResult =
  | { readonly kind: "resolved"; readonly feed: ResolvedOutboundFeed }
  | ({ readonly kind: "unresolved" } & FeedResolutionFailureReason);

export type RetryFeedResolutionResult =
  | { readonly kind: "resolved"; readonly feed: ResolvedFeedTransport }
  | { readonly kind: "unresolved"; readonly reason: "feed_not_active" };

export interface OutboundFeedResolver {
  /** Route a NEW dispatch. `labDestinationFacilityId` is `OrmRequestedPayload.labDestinationFacilityId`. */
  resolveForOrg(
    tx: DbClient,
    organizationId: string,
    asOf: Date,
    labDestinationFacilityId?: string | null,
  ): Promise<FeedResolutionResult>;
  /** Re-resolve the feed an already-queued row is bound to (retry sweep). */
  resolveById(
    tx: DbClient,
    organizationId: string,
    feedId: string,
    asOf: Date,
  ): Promise<RetryFeedResolutionResult>;
}

function inWindow(r: OutboundFeedCandidateRow, asOf: Date): boolean {
  if (r.activeFrom && r.activeFrom > asOf) return false;
  if (r.activeThrough && r.activeThrough < asOf) return false;
  return true;
}

/** PURE — the routing rules in this file's header. `rows` are the org's `active` `orm_outbound` feeds. */
export function selectOutboundFeed(
  rows: readonly OutboundFeedCandidateRow[],
  asOf: Date,
  labDestinationFacilityId: string | null | undefined,
): FeedResolutionResult {
  // A row with no host is a misconfigured outbound feed (host is nullable for an inbound listener).
  const candidates = rows.filter((r) => inWindow(r, asOf) && r.host);
  if (candidates.length === 0) return { kind: "unresolved", reason: "no_active_feed" };

  let picked: OutboundFeedCandidateRow | undefined;
  if (labDestinationFacilityId) {
    const linked = candidates.filter(
      (r) => r.labDestinationFacilityId === labDestinationFacilityId,
    );
    if (linked.length > 1) {
      return {
        kind: "unresolved",
        reason: "ambiguous_feed",
        candidateFeedIds: linked.map((r) => r.id),
      };
    }
    picked = linked[0];
  }
  if (!picked) {
    // SINGLE-FEED FALLBACK — only for exactly one candidate whose link is genuinely absent.
    if (candidates.length === 1 && candidates[0]!.labDestinationFacilityId === null) {
      picked = candidates[0];
    } else {
      const candidateFeedIds = candidates.map((r) => r.id);
      return {
        kind: "unresolved",
        reason: candidates.length > 1 ? "ambiguous_feed" : "no_feed_for_destination",
        candidateFeedIds,
      };
    }
  }

  const row = picked!;
  const missingFields: FeedIdentityField[] = [];
  if (!row.mshSendingFacility) missingFields.push("mshSendingFacility");
  if (!row.mshReceivingApplication) missingFields.push("mshReceivingApplication");
  if (!row.mshReceivingFacility) missingFields.push("mshReceivingFacility");
  if (missingFields.length > 0) {
    return {
      kind: "unresolved",
      reason: "feed_identity_incomplete",
      feedId: row.id,
      missingFields,
    };
  }
  return {
    kind: "resolved",
    feed: {
      ...toTransport(row),
      endpoint: {
        sendingApplication: row.mshSendingApplication ?? OUTBOUND_SENDING_APPLICATION,
        sendingFacility: row.mshSendingFacility!,
        receivingApplication: row.mshReceivingApplication!,
        receivingFacility: row.mshReceivingFacility!,
      },
    },
  };
}

function toTransport(row: OutboundFeedCandidateRow): ResolvedFeedTransport {
  return {
    id: row.id,
    organizationId: row.organizationId,
    host: row.host!,
    port: row.port,
    protocol: row.protocol,
    channelCertPin: row.channelCertPin,
    rateLimitMsgPerSec: row.rateLimitMsgPerSec,
    inFlightLeaseSeconds: row.inFlightLeaseSeconds,
  };
}

export function buildDrizzleOutboundFeedResolver(): OutboundFeedResolver {
  return {
    async resolveForOrg(tx, organizationId, asOf, labDestinationFacilityId) {
      const rows = await tx
        .select()
        .from(FEED)
        .where(
          and(
            eq(FEED.organizationId, organizationId),
            eq(FEED.kind, "orm_outbound"),
            eq(FEED.status, "active"),
          ),
        );
      return selectOutboundFeed(rows, asOf, labDestinationFacilityId);
    },
    async resolveById(tx, organizationId, feedId, asOf) {
      const [row] = await tx
        .select()
        .from(FEED)
        .where(
          and(
            eq(FEED.organizationId, organizationId),
            eq(FEED.id, feedId),
            eq(FEED.kind, "orm_outbound"),
            eq(FEED.status, "active"),
          ),
        )
        .limit(1);
      if (!row || !row.host || !inWindow(row, asOf)) {
        return { kind: "unresolved", reason: "feed_not_active" };
      }
      return { kind: "resolved", feed: toTransport(row) };
    },
  };
}
