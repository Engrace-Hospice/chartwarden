// apps/backend/src/modules/11-orders/orm-request/ports.ts — the default binding of the ports M11's outbound
// lab-ORM producer reads through (F-181, #248). It joins THREE modules: M40 (physician + facility — M11's
// manifest `dependsOn` includes 40, so this file imports its seam directly), and M5 (patient facts) + M29 (the
// outbound feed resolver), neither of which M11 may import — those two arrive as INJECTED deps that the
// composition root (apps/backend/src/index.ts, the only place allowed to see all three) supplies.
//
// THE DESTINATION IS THE ONE PORT WITH A KNOWN GAP. `labDestinationFacilityId` has to be an M40 FACILITY id:
// M29's D16 BAA gate runs on it (`BaaStatusProvider.baaStatusByMdmEntity({kind:'facility', id})`) and
// `hl7_message_outbound.destination_facility_id` is a `uuid`. The order carries it as the optional
// `data.routingLabId`. What does NOT exist yet is the link from an `external_feed` row to a facility, so M29
// still routes to "the org's ONE active `orm_outbound` feed" and ignores the id (`feed-resolver.ts` header).
// This binding therefore requires BOTH — a resolvable, ACTIVE M40 facility AND exactly one active outbound
// feed — and refuses otherwise, so an unroutable order is refused at sign time with an alert to the ordering
// provider rather than published into an event M29 would only alert on and drop. When the feed↔facility link
// lands, only the feed half of `destination` changes; the port shape does not.
import type { DbClient } from "@wardenx/db";
import { getMdmEntityProvider } from "../../40-mdm/seams";
import type {
  OrmDestinationResult,
  OrmOutboundEvidencePort,
  OrmPatientFacts,
  OrmPhysicianFacts,
  OrmRequestedPorts,
} from "./orm-requested";

/** The slice of M40's `MdmEntityProvider` this binding reads. */
export interface OrmMdmReader {
  resolvePhysician(
    orgId: string,
    id: string,
  ): Promise<{
    readonly canonical: {
      readonly identifierType: string;
      readonly identifierValue: string | null;
      readonly firstName: string;
      readonly lastName: string;
    };
    readonly status: "active" | "deactivated" | "provisional";
  } | null>;
  resolveFacility(
    orgId: string,
    id: string,
  ): Promise<{
    readonly id: string;
    readonly status: "active" | "deactivated" | "provisional";
  } | null>;
}

export interface OrmFeedResolverLike {
  resolveForOrg(
    tx: DbClient,
    organizationId: string,
    asOf: Date,
    /** F-181 — the resolved M40 lab facility; M29 routes to the feed linked to it. */
    labDestinationFacilityId?: string | null,
  ): Promise<
    | { readonly kind: "resolved" }
    | {
        readonly kind: "unresolved";
        readonly reason:
          | "no_active_feed"
          | "ambiguous_feed"
          | "no_feed_for_destination"
          | "feed_identity_incomplete";
      }
  >;
}

export interface M11OrmRequestPortDeps {
  readonly mdm?: () => OrmMdmReader;
  /** M29's `buildDrizzleOutboundFeedResolver()` — injected (M11 has no `dependsOn` edge to 29). */
  readonly feeds: OrmFeedResolverLike;
  /** M5's `hl7OrmDemographicsInTx` — injected (M11 has no `dependsOn` edge to 5). */
  readonly patient: (
    tx: DbClient,
    organizationId: string,
    patientId: string,
  ) => Promise<OrmPatientFacts | null>;
  readonly now?: () => Date;
  /** M29's `ormOutboundEvidenceForOrder` — injected (M11 has no `dependsOn` edge to 29). F-188. */
  readonly outboundEvidence?: OrmOutboundEvidencePort;
}

const NPI = /^[0-9]{10}$/;

export function buildM11OrmRequestedPorts(deps: M11OrmRequestPortDeps): OrmRequestedPorts {
  // M40's provider is a registered M1-registry seam: resolve it lazily per call (never at module load — it is
  // registered during boot, after this module is imported), the `buildM23TerminologyAdapter` shape.
  const mdm = deps.mdm ?? (() => getMdmEntityProvider() as unknown as OrmMdmReader);
  const feeds = deps.feeds;
  const now = deps.now ?? (() => new Date());

  return {
    patient: deps.patient,
    ...(deps.outboundEvidence !== undefined ? { outboundEvidence: deps.outboundEvidence } : {}),

    async physician(organizationId, mdmId): Promise<OrmPhysicianFacts | null> {
      const resolved = await mdm().resolvePhysician(organizationId, mdmId);
      if (resolved === null) return null;
      const c = resolved.canonical;
      return {
        status: resolved.status,
        // Only an NPI-anchored canonical with a well-formed 10-digit value is an NPI. `null` for a provisional
        // canonical (no confirmed NPPES match) — the emitter refuses that as `physician_npi_unconfirmed`.
        npi:
          c.identifierType === "npi" && c.identifierValue !== null && NPI.test(c.identifierValue)
            ? c.identifierValue
            : null,
        firstName: c.firstName,
        lastName: c.lastName,
      };
    },

    async destination(tx, organizationId, { routingLabId }): Promise<OrmDestinationResult> {
      if (routingLabId === null) return { ok: false, reason: "no_routing_lab" };
      const facility = await mdm().resolveFacility(organizationId, routingLabId);
      if (facility === null || facility.status !== "active") {
        return { ok: false, reason: "lab_facility_unresolved" };
      }
      const feed = await feeds.resolveForOrg(tx, organizationId, now(), facility.id);
      if (feed.kind === "unresolved") return { ok: false, reason: feed.reason };
      // The survivor id (post-M40-redirect), not the id the order happened to store.
      return { ok: true, facilityId: facility.id };
    },
  };
}
