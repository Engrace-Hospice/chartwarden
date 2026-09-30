// apps/backend/src/modules/29-external-interfaces/outbound/resolve-baa.ts — resolves the D16 BAA gate for
// an outbound ORM dispatch (M29-T08, F-175/#248).
//
// Mirrors `apps/backend/src/modules/22-documents/outbox-consumers/baa-gate.ts`'s `resolveExternalBaaActive`
// EXACTLY (the brief's own named precedent): M29's manifest `dependsOn` excludes 40 (the outbound arm's own
// `feed/baa-gate.ts` header states this directly — "M29's documented stance... is to reach every upstream
// module through a seam/outbox, never a compile-time feature-package import"), so this resolves the
// ALREADY-REGISTERED real `"BaaStatusProvider"` seam OPAQUELY via `getSeam(...)` and casts it to
// `feed/baa-gate.ts`'s own locally-declared `ExternalInterfaceBaaGate` structural interface — never imports
// `@wardenx/mdm`. Per `feed/baa-gate.ts`'s own header, the OUTBOUND arm consults `baaStatusByMdmEntity`
// ("a partner is a resolved M40 facility entity with asOf time-travel").
//
// Fail-CLOSED, exactly like M22's precedent: any seam error / unregistered seam resolves to a result
// `decideBaaGate` reads as inactive/blocked (`status: "missing"`) — never silently proceeds.
import { getSeam } from "../../../bootstrap/index";
import type { ExternalInterfaceBaaGate, ExternalInterfaceBaaResult } from "../feed/baa-gate";

const BAA_GATE_ERROR_RESULT: ExternalInterfaceBaaResult = {
  isActive: false,
  status: "missing",
  expiresOn: null,
};

/**
 * Resolve the D16 BAA status for an outbound ORM's destination facility, `asOf` the actual dispatch moment
 * (§7.10 time-travel). Fail-closed: any seam error / unregistered seam / non-`isActive` result is folded
 * into the SAME closed shape `decideBaaGate` (`feed/baa-gate.ts`) reads as refused.
 */
export async function resolveOutboundBaaResult(input: {
  readonly organizationId: string;
  readonly destinationFacilityId: string | null;
  readonly asOf: Date;
}): Promise<ExternalInterfaceBaaResult> {
  if (!input.destinationFacilityId) {
    // No resolved M40 facility for this order — the same "cannot confirm" closed shape as a seam error;
    // decideBaaGate reads this as `missing_baa`, never as `no_baa_contract` (that reason is reserved for
    // the feed-activation gate, `feed/baa-gate.ts`'s `evaluateFeedActivationBaaGate`).
    return BAA_GATE_ERROR_RESULT;
  }
  try {
    const gate = getSeam("BaaStatusProvider") as ExternalInterfaceBaaGate;
    return await gate.baaStatusByMdmEntity({
      orgId: input.organizationId,
      kind: "facility",
      id: input.destinationFacilityId,
      asOf: input.asOf,
    });
  } catch {
    return BAA_GATE_ERROR_RESULT;
  }
}
