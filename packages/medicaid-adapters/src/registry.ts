// @wardenx/medicaid-adapters — the per-state adapter registry (D1, §4.5). Built at boot from the M40
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

  constructor(mdmStatePrograms: ReadonlyArray<MedicaidStateProgramConfig> = []) {
    this.register(new OregonMedicaidAdapter());
    this.register(washingtonMedicaidAdapter);
    this.register(idahoMedicaidAdapter);
    this.register(californiaMedicaidAdapter);
    this.register(nevadaMedicaidAdapter);

    for (const cfg of mdmStatePrograms.filter((c) => c.active)) {
      if (!this.byVendor.has(cfg.adapterVendor)) {
        throw new Error(
          `M40 catalog references active adapter vendor "${cfg.adapterVendor}" for state ${cfg.stateCode} ` +
            `but no such adapter is registered. Either disable the state in M40 or implement/register the adapter.`,
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
