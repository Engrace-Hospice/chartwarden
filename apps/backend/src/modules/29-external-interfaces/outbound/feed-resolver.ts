// apps/backend/src/modules/29-external-interfaces/outbound/feed-resolver.ts — resolves the outbound
// `external_feed` a `m11.order.hl7_orm_requested` dispatches over (M29-T08, F-175/#248).
//
// A DOCUMENTED, NARROW PHASE-1 GAP, NOT A GUESS. `dispatch-planner.ts`'s own `OutboundDispatchInput.feed`
// takes an ALREADY-RESOLVED feed; the spec's own T-29.08 addendum sketch resolves it with
// `eq(externalFeed.destinationFacilityId, labDestinationFacilityId)` — but checked against the REAL,
// migrated schema (`packages/db/src/schema/external-interfaces/feed.ts`, migration 0144), `external_feed`
// carries NO `destination_facility_id` column, and NO other column links a feed row to an M40 facility at
// all: `sendingFacilityAllowlist` is documented INBOUND-only ("the per-feed MSH-4 sender allowlist"). The
// addendum's own reference implementation assumed a column that was never added to the table it edits. This
// is a genuine schema gap, not a wiring gap — building a real `destination_facility_id` column (plus the
// onboarding-flow work to populate it, plus a migration) is new infrastructure and a product decision, the
// same "not a wiring gap this pass fabricates a binding for" posture F-165's `m5-patient-deceased.ts` header
// takes for its own unbuildable half. Reported here, not guessed around.
//
// THE PHASE-1 ASSUMPTION THIS FILE MAKES INSTEAD (explicitly flagged for the coordinator, F-175): resolve
// the org's ONE active `kind='orm_outbound'` feed, ignoring `labDestinationFacilityId` for routing — every
// hospice tenant's Phase-1 lab-order traffic goes to a single contracted reference lab, which the unique
// index `uq_external_feed_org_port_kind (organizationId, port, kind)` PERMITS to be violated (multiple
// `orm_outbound` feeds on different ports ARE structurally legal) but which this resolver refuses to guess
// through: zero active feeds → refuse (nothing to dispatch through); MORE than one active feed → refuse
// (ambiguous routing must never silently pick one) rather than dispatch through an arbitrary row. Both
// refusals are logged/alerted, never silently dropped — see `dispatch-worker.ts`'s `no_feed_resolved` path.
//
// THE SECOND GAP THIS FILE ALSO DOCUMENTS: `orm-o01.ts`'s `OrmEndpoint` (MSH-3/4/5/6 — sendingApplication /
// sendingFacility / receivingApplication / receivingFacility) has no backing columns on `external_feed`
// EITHER (checked — the table has `displayName`/`host`/`port`/`protocol`/`channelCertPin`, nothing else
// identity-shaped). `sendingApplication` is a fixed platform constant (WardenX's own identity never varies
// per feed); `sendingFacility` / `receivingApplication` / `receivingFacility` all fall back to the feed's
// own `displayName` — a real, operator-chosen string, but NOT a validated HL7 application/facility
// identifier, and reusing one string for three different MSH fields is a known, flagged placeholder. A
// correct fix needs new `external_feed` columns (`sending_facility`, `receiving_application`,
// `receiving_facility`) — the same "new infrastructure" category as the routing gap above, not attempted
// here so the rest of the pipeline (BAA gate, envelope encryption, transport, ACK correlation, retry/DLQ,
// idempotency, rate limiting) is not blocked on it.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq } from "drizzle-orm";
import type { OrmEndpoint } from "./orm-o01";

const FEED = schema.externalFeed;

/** WardenX's own fixed MSH-3 sending-application identity — never varies per feed or per tenant. */
export const OUTBOUND_SENDING_APPLICATION = "WARDENX";

export interface ResolvedOutboundFeed {
  readonly id: string;
  readonly organizationId: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: "mllp_tls" | "mllp_plain";
  readonly channelCertPin: string | null;
  readonly rateLimitMsgPerSec: number;
  readonly endpoint: OrmEndpoint;
}

export type FeedResolutionFailureReason =
  | { readonly reason: "no_active_feed" }
  | { readonly reason: "ambiguous_feed"; readonly candidateFeedIds: readonly string[] };

export type FeedResolutionResult =
  | { readonly kind: "resolved"; readonly feed: ResolvedOutboundFeed }
  | ({ readonly kind: "unresolved" } & FeedResolutionFailureReason);

export interface OutboundFeedResolver {
  resolveForOrg(
    tx: DbClient,
    organizationId: string,
    asOf: Date,
  ): Promise<FeedResolutionResult>;
}

export function buildDrizzleOutboundFeedResolver(): OutboundFeedResolver {
  return {
    async resolveForOrg(tx, organizationId, asOf) {
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

      // Re-check the operational window in app code (activeFrom/activeThrough are nullable timestamps;
      // expressing "null means open-ended" as a single SQL predicate is possible but this is a low-volume,
      // per-org read and the explicit filter is easier to verify against the two doc-comment cases above).
      const active = rows.filter((r) => {
        if (r.activeFrom && r.activeFrom > asOf) return false;
        if (r.activeThrough && r.activeThrough < asOf) return false;
        return true;
      });

      if (active.length === 0) {
        return { kind: "unresolved", reason: "no_active_feed" };
      }
      if (active.length > 1) {
        return {
          kind: "unresolved",
          reason: "ambiguous_feed",
          candidateFeedIds: active.map((r) => r.id),
        };
      }

      const row = active[0]!;
      if (!row.host) {
        // `host` is nullable on the schema for an inbound-listener row (WardenX owns the bind address);
        // an `orm_outbound` row with no host is a misconfigured feed, the same refusal shape as no feed.
        return { kind: "unresolved", reason: "no_active_feed" };
      }

      const endpoint: OrmEndpoint = {
        sendingApplication: OUTBOUND_SENDING_APPLICATION,
        sendingFacility: row.displayName,
        receivingApplication: row.displayName,
        receivingFacility: row.displayName,
      };

      return {
        kind: "resolved",
        feed: {
          id: row.id,
          organizationId: row.organizationId,
          host: row.host,
          port: row.port,
          protocol: row.protocol,
          channelCertPin: row.channelCertPin,
          rateLimitMsgPerSec: row.rateLimitMsgPerSec,
          endpoint,
        },
      };
    },
  };
}
