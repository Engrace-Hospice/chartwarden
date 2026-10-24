// apps/backend/src/modules/22-documents/outbox-consumers/recipient-resolver.ts — §4.12 recipient resolution.
//
// A disclosure / survey-export presign names its out-of-network recipient as an M40 entity (kind + id).
// The BAA gate (`baa-gate.ts`) only answers "is a BAA active for this id": for a kind that needs no BAA
// (dme_vendor, funeral_home) or an id nobody owns it can answer "n_a" and let the presign through, so the
// recipient must first be proven to be a live entity of THIS org. M22 does not depend on M40, so the
// provider is read opaquely from the M1 registry (the `baa-gate.ts` precedent) through the structural
// minimum below. Fail-CLOSED: any error / unregistered seam / unknown or non-active entity ⇒ null.
import { getSeam } from "../../../bootstrap/index";
import type { ExternalRecipientRef } from "./decide-document-request";

type ResolveOne = (orgId: string, id: string) => Promise<{ id: string; status: string } | null>;

/** The M22-side structural projection of M40's `MdmEntityProvider` (only the BAA-gated kinds' resolvers). */
export interface RecipientEntityProviderPort {
  resolveFacility: ResolveOne;
  resolvePayer: ResolveOne;
  resolveReferralSource: ResolveOne;
  resolveDmeVendor: ResolveOne;
  resolveFuneralHome: ResolveOne;
}

const RESOLVER_BY_KIND: Readonly<
  Record<ExternalRecipientRef["kind"], keyof RecipientEntityProviderPort>
> = {
  facility: "resolveFacility",
  payer: "resolvePayer",
  referral_source: "resolveReferralSource",
  dme_vendor: "resolveDmeVendor",
  funeral_home: "resolveFuneralHome",
};

/** The recipient a disclosure request names (`recipientKind` + `recipientEntityId` on the wire). */
export interface NamedRecipient {
  readonly kind: ExternalRecipientRef["kind"];
  readonly entityId: string;
}

export type DisclosureRecipientResolver = (args: {
  organizationId: string;
  recipient: NamedRecipient;
}) => Promise<ExternalRecipientRef | null>;

/**
 * Resolve the named recipient to the survivor M40 entity (a merged id is chased by the provider, so the
 * BAA is checked against the live row), or null when it is not an active entity of this org.
 */
export const resolveDisclosureRecipient: DisclosureRecipientResolver = async ({
  organizationId,
  recipient,
}) => {
  try {
    const provider = getSeam("MdmEntityProvider") as RecipientEntityProviderPort;
    const resolved = await provider[RESOLVER_BY_KIND[recipient.kind]](
      organizationId,
      recipient.entityId,
    );
    if (!resolved || resolved.status !== "active") return null;
    return { kind: recipient.kind, mdmEntityId: resolved.id };
  } catch {
    return null; // fail-closed — an unresolvable recipient cannot be BAA-checked
  }
};
