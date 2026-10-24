// apps/backend/src/modules/22-documents/outbox-consumers/recipient-resolver.ts — §4.12 recipient resolution.
//
// A disclosure / survey-export presign names its out-of-network recipient as an M40 entity (kind + id).
// The canonical facility / payer registry is GLOBAL (org-less rows), so "active" here only means the entity
// exists and is live in the registry; it says nothing about this org. The tie to the org is the org-scoped
// BAA record, which the signed-URL service requires to be `executed` (not `n_a`). Only the kinds with a
// canonical table (facility, payer) can resolve today; the other M40 kinds always resolve null. M22 does not depend on M40, so the
// provider is read opaquely from the M1 registry (the `baa-gate.ts` precedent) through the structural
// minimum below. Fail-CLOSED: any error / unregistered seam / unknown or non-active entity ⇒ null.
import { getSeam } from "../../../bootstrap/index";
import type { ExternalRecipientRef } from "./decide-document-request";

type ResolveOne = (orgId: string, id: string) => Promise<{ id: string; status: string } | null>;

/** The M22-side structural projection of M40's `MdmEntityProvider` (only the BAA-gated kinds' resolvers). */
export interface RecipientEntityProviderPort {
  resolveFacility: ResolveOne;
  resolvePayer: ResolveOne;
}

/** The recipient kinds that have a canonical M40 table today. */
type DisclosureRecipientKind = Extract<ExternalRecipientRef["kind"], "facility" | "payer">;

const RESOLVER_BY_KIND: Readonly<Record<DisclosureRecipientKind, keyof RecipientEntityProviderPort>> =
  { facility: "resolveFacility", payer: "resolvePayer" };

/** The recipient a disclosure request names (`recipientKind` + `recipientEntityId` on the wire). */
export interface NamedRecipient {
  readonly kind: DisclosureRecipientKind;
  readonly entityId: string;
}

export type DisclosureRecipientResolver = (args: {
  organizationId: string;
  recipient: NamedRecipient;
}) => Promise<ExternalRecipientRef | null>;

/**
 * Resolve the named recipient to the survivor M40 entity (a merged id is chased by the provider, so the
 * BAA is checked against the live row), or null when it is unknown or not active in the registry.
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
    return null; // fail-closed (a seam outage reads as a 403, same as baa-gate.ts) — an unresolvable recipient cannot be BAA-checked
  }
};
