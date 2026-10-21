// apps/backend/src/modules/22-documents/outbox-consumers/baa-gate.ts — M22-T06 the §4.12 external-URL gate.
//
// Before presigning ANY URL — or rendering any disclosure artifact — that targets an out-of-network partner
// (a partner lab feed, a referral source, a payer, …), M22's signed-URL service consults M40's REAL
// `BaaStatusProvider` seam with `asOf: new Date()` (the §7.10 time-travel guarantee: a BAA active when the
// job was queued but expired at transmit-time gates CLOSED). M22 `dependsOn` is `[1, 5]` — it does NOT depend
// on M40, so it MUST NOT import `@chartwarden/mdm` (that would create a dependency-cruiser edge). It resolves the
// already-registered real seam OPAQUELY via `getSeam("BaaStatusProvider")` and casts to the locally-declared
// structural minimum {@link BaaStatusProviderPort} (only the `baaStatusByMdmEntity` arm M22 needs).
//
// Fail-CLOSED: any seam error / unregistered seam / `isActive !== true` returns `false` → the decider blocks
// the presign per §4.12 (`baa_inactive`). The pure refusal decision is {@link decideDocumentRequest} reading
// `facts.externalBaaActive`; this helper is the impure resolver that produces that fact in the live consumer.
import { getSeam } from "../../../bootstrap/index";
import type { ExternalRecipientRef } from "./decide-document-request";

/** The M22-side structural projection of M40's `BaaStatusProvider.baaStatusByMdmEntity` (the only arm M22
 * consumes). The real contract lives in @chartwarden/mdm; M22 reads it opaquely from the M1 registry. */
export interface BaaStatusProviderPort {
  baaStatusByMdmEntity(input: {
    orgId: string;
    kind: ExternalRecipientRef["kind"];
    id: string;
    asOf: Date;
  }): Promise<{ isActive: boolean; status: string }>;
}

/**
 * Resolve `facts.externalBaaActive` for an external-disclosure render/presign (§4.12). Consults M40's real
 * `BaaStatusProvider` via the opaque M1 registry with `asOf` = the actual disclosure moment; fail-CLOSED on
 * any error / missing seam / inactive gate.
 */
export async function resolveExternalBaaActive(input: {
  organizationId: string;
  recipient: ExternalRecipientRef;
  asOf?: Date;
}): Promise<boolean> {
  try {
    const provider = getSeam("BaaStatusProvider") as BaaStatusProviderPort;
    const res = await provider.baaStatusByMdmEntity({
      orgId: input.organizationId,
      kind: input.recipient.kind,
      id: input.recipient.mdmEntityId,
      asOf: input.asOf ?? new Date(), // §7.10 time-travel: gate as-of the transmit moment
    });
    return res.isActive === true;
  } catch {
    return false; // fail-closed — BAA gate unconfirmable ⇒ block the presign
  }
}
