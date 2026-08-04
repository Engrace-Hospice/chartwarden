import { SandataAdapter } from "./adapters/sandata-adapter";
// @wardenx/evv-aggregators — the per-state adapter selector (M18-T06, §4.5 D1).
//
// The registry resolves the `EvvAggregatorAdapter` per `stateCode` from M40 master-data state configs (the
// "state-vendor selection from M40"): each config names the state's aggregator vendor + operating model. The
// Sandata + open-model adapters register by default (Phase-1 launch set); a state whose config names a vendor
// with no registered adapter fails registry-build LOUDLY (rather than silently dropping submissions) — UNLESS
// the state is `open_no_aggregator`, where no adapter is expected and submissions short-circuit per D7.
//
// The M18 backend depends ONLY on this selector + the `EvvAggregatorAdapter` interface (the §25.14 adapter
// mandate): it never names a vendor SDK or hits a vendor URL directly.
import type { EvvAggregatorAdapter } from "./interface";
import { OpenModelAdapter } from "./open-model";

/** A per-state aggregator config sourced from M40 master data (the §4.5 registry input). `operatingModel`
 * distinguishes a single-vendor mandate state from an open-model state (alt-EVV allowed) and the
 * no-aggregator open-model case (no central submission target). */
export interface StateAggregatorConfig {
  readonly stateCode: string;
  readonly aggregatorVendor: string;
  readonly operatingModel: "closed_single_vendor" | "open_alt_evv" | "open_no_aggregator";
}

/** Build-time options: inject extra adapters (e.g. a Phase-2 vendor going live, or a test double) on top of the
 * Phase-1 defaults, and/or override the default Sandata/open-model adapters wholesale. */
export interface StateAggregatorRegistryOptions {
  readonly extraAdapters?: readonly EvvAggregatorAdapter[];
  readonly defaultAdapters?: readonly EvvAggregatorAdapter[];
}

/** §4.5 — the per-(state, vendor) adapter registry. Resolves an adapter for a state code, or reports the
 * open-model no-aggregator short-circuit. */
export class StateAggregatorRegistry {
  private readonly byVendor = new Map<string, EvvAggregatorAdapter>();
  private readonly byState = new Map<string, EvvAggregatorAdapter>();
  private readonly openNoAggregatorStates = new Set<string>();

  constructor(
    stateConfigs: readonly StateAggregatorConfig[],
    opts: StateAggregatorRegistryOptions = {},
  ) {
    const defaults = opts.defaultAdapters ?? [new SandataAdapter(), new OpenModelAdapter()];
    for (const adapter of [...defaults, ...(opts.extraAdapters ?? [])]) this.register(adapter);

    for (const cfg of stateConfigs) {
      if (cfg.operatingModel === "open_no_aggregator") {
        // No adapter expected — submissions short-circuit (D7). Record the state so callers can branch.
        this.openNoAggregatorStates.add(cfg.stateCode);
        continue;
      }
      const adapter = this.byVendor.get(cfg.aggregatorVendor) ?? null;
      if (!adapter) {
        throw new Error(
          `No adapter for vendor '${cfg.aggregatorVendor}' required by state '${cfg.stateCode}' (operatingModel='${cfg.operatingModel}').`,
        );
      }
      this.byState.set(cfg.stateCode, adapter);
    }
  }

  private register(a: EvvAggregatorAdapter): void {
    this.byVendor.set(a.vendor, a);
    for (const s of a.states) {
      if (s !== "__ALL_OPEN_MODEL__") this.byState.set(s, a);
    }
  }

  /** The adapter that serves `stateCode`, or null when the state is open-model-no-aggregator (or unknown). */
  adapterForState(stateCode: string): EvvAggregatorAdapter | null {
    return this.byState.get(stateCode) ?? null;
  }

  /** True when the state is configured as open-model-no-aggregator — submissions short-circuit (D7). */
  isOpenModelNoAggregator(stateCode: string): boolean {
    return this.openNoAggregatorStates.has(stateCode);
  }

  /** The adapter for a vendor id (ops dashboards / health probes), or null. */
  adapterForVendor(vendor: string): EvvAggregatorAdapter | null {
    return this.byVendor.get(vendor) ?? null;
  }

  /** Every registered adapter (ops health-probe sweep). */
  allAdapters(): readonly EvvAggregatorAdapter[] {
    return [...new Set(this.byVendor.values())];
  }
}
