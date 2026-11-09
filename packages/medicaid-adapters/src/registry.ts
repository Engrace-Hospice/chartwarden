// @chartwarden/medicaid-adapters — the per-state adapter registry (D1, §4.5). Built at boot from the M40
// state-program catalog; selection is per-claim by the patient's state (asOf service-date). Always
// registers the Oregon reference adapter + the WA/ID/CA/NV Phase-1 deny-stubs, then validates that every
// ACTIVE M40 catalog entry references a registered adapter vendor (fail-closed at boot). PURE: no I/O.
import type { StateCode } from "./contracts";
import {
  californiaMedicaidAdapter,
  idahoMedicaidAdapter,
  nevadaMedicaidAdapter,
  washingtonMedicaidAdapter,
} from "./deny-stub-states";
import { MedicaidAdapterError } from "./errors";
import type { MedicaidAdapter } from "./interface";
import { OregonMedicaidAdapter } from "./oregon";
import type { OregonGatewayPort } from "./oregon/launch-gateway";

/** One ACTIVE-state row from the M40 `state_medicaid_program` catalog the registry validates against. */
export interface MedicaidStateProgramConfig {
  readonly stateCode: StateCode;
  readonly active: boolean;
  readonly adapterVendor: string;
  readonly operatingModel: "ffs_only" | "mco_only" | "hybrid";
}

export class MedicaidAdapterRegistry {
  private readonly byState = new Map<StateCode, MedicaidAdapter>();
  private readonly byVendor = new Map<string, MedicaidAdapter>();

  constructor(
    mdmStatePrograms: ReadonlyArray<MedicaidStateProgramConfig> = [],
    oregonGateway: OregonGatewayPort | null = null,
  ) {
    this.register(new OregonMedicaidAdapter(oregonGateway));
    this.register(washingtonMedicaidAdapter);
    this.register(idahoMedicaidAdapter);
    this.register(californiaMedicaidAdapter);
    this.register(nevadaMedicaidAdapter);

    for (const cfg of mdmStatePrograms.filter((c) => c.active)) {
      if (!this.byVendor.has(cfg.adapterVendor)) {
        throw new Error(
          `M40 catalog references active adapter vendor "${cfg.adapterVendor}" for state ${cfg.stateCode} but no such adapter is registered. Either disable the state in M40 or implement/register the adapter.`,
        );
      }
    }
  }

  private register(a: MedicaidAdapter): void {
    this.byVendor.set(a.vendor, a);
    this.byState.set(a.state, a);
  }

  /** Resolve the adapter for a state, or null if none is registered. */
  adapterForState(stateCode: StateCode): MedicaidAdapter | null {
    return this.byState.get(stateCode) ?? null;
  }

  /** Resolve the adapter for a state, throwing UNSUPPORTED_STATE if none is registered (route guard). */
  requireAdapterForState(stateCode: StateCode): MedicaidAdapter {
    const a = this.byState.get(stateCode);
    if (!a) {
      throw new MedicaidAdapterError(
        "UNSUPPORTED_STATE",
        stateCode,
        `No Medicaid adapter is registered for state ${stateCode}.`,
        `Out-of-state Medicaid is out of Phase-1 scope; handle ${stateCode} manually or add the adapter.`,
      );
    }
    return a;
  }

  /** True iff the state's adapter is a Phase-1 deny-stub (or absent). */
  isPhaseOneDenyStub(stateCode: StateCode): boolean {
    const a = this.byState.get(stateCode);
    if (!a) return true;
    return a.vendor.endsWith("-deny-stub");
  }

  /** All registered adapters (ops dashboard). */
  all(): readonly MedicaidAdapter[] {
    return [...this.byVendor.values()];
  }
}

/** Stable fail-closed code for a submit attempt without a verified state/program transport. */
export const MEDICAID_NO_ELECTRONIC_GATEWAY_CODE = "MEDICAID_STATE_NO_ELECTRONIC_GATEWAY";

export type MedicaidProgramKind = "managed_care" | "unresolved";
export type MedicaidRouteReadinessStatus =
  | "transport_unconfigured"
  | "certification_pending"
  | "unsupported_program_route"
  | "unsupported_state_program";

/** Safe, server-derived capability summary. `gatewayBound` describes configuration only; it is never
 * evidence of state approval, trading-partner certification, or a compatible wire contract. */
export interface MedicaidClaimRouteReadiness {
  readonly serviceState: string;
  readonly programKind: MedicaidProgramKind;
  readonly programAssignmentVerified: false;
  readonly requestedChannel: "cco_clearinghouse" | null;
  readonly localPreparationAvailable: true;
  /** Configuration signal only. Never means the route is approved or certified. */
  readonly transportConfigured: boolean;
  readonly providerEnrollmentVerified: false;
  readonly tradingPartnerCertificationVerified: false;
  readonly outboundFormat: "unverified";
  readonly submissionAvailable: false;
  readonly status: MedicaidRouteReadinessStatus;
  readonly reasonCode: string;
  readonly message: string;
}

/** State/program capability for an already-owned M24 claim. The current OR adapter builds a local JSON
 * reference envelope and is not a verified OHA/CCO wire implementation. WA/ID/CA/NV are explicit deny
 * stubs. A bound gateway is configuration, not certification, so no route is currently sendable. */
export function medicaidClaimRouteReadiness(
  serviceState: string,
  mcoId: string | null,
  gatewayBound = false,
): MedicaidClaimRouteReadiness {
  const programKind: MedicaidProgramKind = mcoId === null ? "unresolved" : "managed_care";
  const requestedChannel: "cco_clearinghouse" | null = mcoId === null ? null : "cco_clearinghouse";
  const base = {
    serviceState,
    programKind,
    programAssignmentVerified: false as const,
    requestedChannel,
    localPreparationAvailable: true as const,
    transportConfigured: serviceState === "OR" && gatewayBound,
    providerEnrollmentVerified: false as const,
    tradingPartnerCertificationVerified: false as const,
    outboundFormat: "unverified" as const,
    submissionAvailable: false as const,
  };
  if (mcoId === null) {
    return {
      ...base,
      status: "unsupported_program_route",
      reasonCode: "MEDICAID_PROGRAM_UNRESOLVED",
      message: `WardenX cannot verify whether this ${serviceState} coverage is fee-for-service or a managed-care plan. The M40 state Medicaid MCO catalog and a coverage-to-program mapping are not available, so no destination is inferred from a missing MCO value.`,
    };
  }
  if (serviceState === "OR" && programKind === "managed_care") {
    return {
      ...base,
      status: "unsupported_program_route",
      reasonCode: "MEDICAID_MCO_ROUTE_UNVERIFIED",
      message:
        "This managed-care route is not configured or certified for electronic submission. The Oregon reference adapter currently renders a local preparation envelope only; it does not establish a CCO transmission route.",
    };
  }
  const explicitStub = ["WA", "ID", "CA", "NV"].includes(serviceState);
  return {
    ...base,
    status: "unsupported_state_program",
    reasonCode: explicitStub
      ? "MEDICAID_STATE_ADAPTER_UNSUPPORTED"
      : "MEDICAID_STATE_PROGRAM_UNSUPPORTED",
    message: explicitStub
      ? `Electronic Medicaid submission for ${serviceState} is not implemented in WardenX. Claim preparation and local validation remain available. Follow only the state/program's approved submission procedure; this screen cannot transmit or record an external submission.`
      : `No verified Medicaid state/program route is available for ${serviceState}. Claim preparation may continue, but electronic submission is blocked.`,
  };
}

/** Compatibility wrapper for existing submit call sites; all present state/program routes fail closed. */
export function electronicSubmissionRefusal(
  state: string,
  gatewayBound = true,
  mcoId: string | null = null,
): { readonly code: string; readonly message: string } | null {
  const readiness = medicaidClaimRouteReadiness(state, mcoId, gatewayBound);
  return { code: MEDICAID_NO_ELECTRONIC_GATEWAY_CODE, message: readiness.message };
}
