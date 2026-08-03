// apps/backend/src/modules/29-external-interfaces/feed — the M40 BAA gate (D16) M29 runs before it binds
// a listener or dispatches a message (M29-T03, §2.2/§2.3/§4.11.1). PURE decision + the local consumer port.
//
// WHY A LOCAL PORT (M28 precedent). M40's focused `BaaStatusProvider` seam interface lives in
// `@wardenx/mdm` (a feature package). Although M29's manifest `dependsOn` carries 40, M29's documented
// stance (T01) is to reach every upstream module through a seam/outbox, never a compile-time feature-package
// import — so this file declares M29's OWN minimal view of the two BAA-gate contracts it needs, and the T08
// boot wiring resolves the live `getSeam("BaaStatusProvider")` into it (with a structural cast, the M28
// `getFhirBaaStatusProvider` pattern). Keeping the port local also keeps every T03 core IO-free and
// unit-testable against a fake gate.
//
// TWO CASES (§4.6.1 / §7.9-7.10, mirrored from M40's seam):
//   · INBOUND (listener bind): a partner is a free-text MSH-4 `sendingFacility` code with no entity id, so
//     the gate resolves it via `baaStatusBySendingFacility`.
//   · OUTBOUND (ORM dispatch, T06): a partner is a resolved M40 `facility` entity with `asOf` time-travel,
//     via `baaStatusByMdmEntity` — "was the BAA active at the instant we actually transmit?".

/** M29's minimal view of an M40 BAA-gate result (a structural subset of `mdm.BaaStatusResult`). */
export interface ExternalInterfaceBaaResult {
  /** True when disclosure/binding is permitted: an active BAA at `asOf`, OR the kind needs no BAA. */
  readonly isActive: boolean;
  /** `executed` | `pending` | `n_a` | `missing` | `expired` — kept as a string so M29 never imports the
   *  producer's `BaaStatusKind` union; only `missing`/`expired`/`pending` matter to the refuse reason. */
  readonly status: string;
  /** ISO yyyy-mm-dd of the governing record's expiry, or `null`. */
  readonly expiresOn: string | null;
}

/** M29's minimal view of the M40 `BaaStatusProvider` seam — the two methods the HL7 paths consult. */
export interface ExternalInterfaceBaaGate {
  /** Inbound — resolve the free-text MSH-4 sending-facility code and decide the gate as-of the moment. */
  baaStatusBySendingFacility(input: {
    orgId: string;
    sendingFacility: string;
    asOf: Date;
  }): Promise<ExternalInterfaceBaaResult>;
  /** Outbound — resolve an M40 facility entity with `asOf` time-travel (consumed by the T06 dispatcher). */
  baaStatusByMdmEntity(input: {
    orgId: string;
    kind: "facility";
    id: string;
    asOf: Date;
  }): Promise<ExternalInterfaceBaaResult>;
}

/** The typed refuse reason (§2.3 "refuses with `missing_baa`"). `expired` and `missing` are distinct so the
 *  operator alert can name the remediation (refresh the executed BAA vs. execute one at all). */
export type BaaGateRefuseReason = "missing_baa" | "expired_baa" | "pending_baa" | "no_baa_contract";

/** The gate decision: `allowed` binds/dispatches; otherwise a typed refuse reason for the alert + audit. */
export type BaaGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BaaGateRefuseReason; readonly status: string };

/** A typed error the activation/dispatch service throws when the D16 BAA gate refuses. */
export class ExternalFeedBaaRefusedError extends Error {
  readonly reason: BaaGateRefuseReason;
  readonly baaStatus: string;
  constructor(reason: BaaGateRefuseReason, baaStatus: string) {
    super(`external feed BAA gate refused: ${reason} (status=${baaStatus})`);
    this.name = "ExternalFeedBaaRefusedError";
    this.reason = reason;
    this.baaStatus = baaStatus;
  }
}

/**
 * The PURE D16 decision over a resolved M40 BAA result. Fails CLOSED: `isActive:false` never binds. The
 * refuse reason is mapped from the status so `missing`/`expired`/`pending` remediation is distinguishable;
 * an unrecognized inactive status still refuses (as `missing_baa`) rather than admit.
 */
export function decideBaaGate(result: ExternalInterfaceBaaResult): BaaGateDecision {
  if (result.isActive) return { allowed: true };
  const reason: BaaGateRefuseReason =
    result.status === "expired"
      ? "expired_baa"
      : result.status === "pending"
        ? "pending_baa"
        : "missing_baa";
  return { allowed: false, reason, status: result.status };
}

/**
 * The feed-activation gate the listener-binding edges (`pending_approval → active`,
 * `suspended → active`) run BEFORE the row flips to `active` (§4.11.1 step 2). A feed with NO
 * `baaContractRef` refuses immediately (`no_baa_contract`) without a seam round-trip — D16 requires the
 * contract reference present at activation. Otherwise EVERY allowlisted sending facility must have an
 * active BAA; the first refusal short-circuits (fail-closed) so no listener binds for a partner without a
 * signed BAA in force. An empty allowlist with a contract ref is permitted (the per-connection allowlist
 * check in §4.11.2 still gates each sender at runtime).
 */
export async function evaluateFeedActivationBaaGate(input: {
  gate: ExternalInterfaceBaaGate;
  orgId: string;
  baaContractRef: string | null;
  sendingFacilityAllowlist: readonly string[];
  asOf: Date;
}): Promise<BaaGateDecision> {
  if (!input.baaContractRef) {
    return { allowed: false, reason: "no_baa_contract", status: "missing" };
  }
  for (const sendingFacility of input.sendingFacilityAllowlist) {
    const result = await input.gate.baaStatusBySendingFacility({
      orgId: input.orgId,
      sendingFacility,
      asOf: input.asOf,
    });
    const decision = decideBaaGate(result);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}
