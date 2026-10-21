import type {
  ExternalTriageVendorAdapter,
  VendorMinimizationProfile,
} from "@wardenx/triage-vendors";
// apps/backend/src/modules/19-oncall/vendor/registry.ts — M19-T07 (§8.5, architecture §25.14).
//
// THE ADAPTER MANDATE, made operational. `@wardenx/triage-vendors` owns the `ExternalTriageVendorAdapter`
// interface and is the ONLY package permitted to name a vendor endpoint or SDK; this file is the M19-side
// REGISTRY that resolves `external_triage_vendor.adapter_key` → an adapter instance. The backend calls the
// interface and nothing else, which is what makes a vendor swap "a new adapter behind the same interface"
// rather than a change to the triage lifecycle.
//
// THE REGISTRY IS EMPTY IN PHASE 1, AND THAT IS THE CORRECT SHIPPED STATE — not an oversight. D3 keeps
// `hybrid` / `centralized` structurally complete but feature-flagged OFF until a signed BAA and a
// Compliance-approved minimization profile exist for a named vendor, and ADR-013 (vendor selection) is
// still Proposed. §8.5 is explicit that a new vendor needs Compliance-Officer + Tech-Lead sign-off in the
// M4 BAA registry BEFORE its adapter is enabled at runtime. Shipping a named adapter now would ship the
// half of a feature whose other half is a contract nobody has signed.
//
// SO THE FAILURE MODE MATTERS MORE THAN THE HAPPY PATH. An unresolvable adapter key raises
// {@link TriageVendorAdapterUnavailableError} (409), and the §7.5 handoff path treats that as "keep the
// call in-agency" — never as "transmit anyway with a default adapter", and never as a silent no-op that
// would leave a caller on hold while M19 believed a vendor had them. There is no fallback adapter and
// there is no default; a registry miss is a refusal with the key in the message.
import { ChartWardenError } from "@wardenx/types";

/** Raised when a tenant's configured `adapter_key` resolves to no registered adapter (§8.5). */
export class TriageVendorAdapterUnavailableError extends ChartWardenError {
  constructor(adapterKey: string) {
    super(
      "TRIAGE_VENDOR_ADAPTER_UNAVAILABLE",
      `no external triage vendor adapter is registered for adapter_key '${adapterKey}'; the call stays in-agency (§8.5 adapter mandate)`,
      409,
    );
    this.name = "TriageVendorAdapterUnavailableError";
  }
}

/** Raised when two adapters claim the same key — a boot wiring bug, caught at registration. */
export class TriageVendorAdapterConflictError extends Error {
  constructor(adapterKey: string) {
    super(`external triage vendor adapter '${adapterKey}' is already registered (single-owner)`);
    this.name = "TriageVendorAdapterConflictError";
  }
}

/** The §8.5 adapter registry. */
export interface TriageVendorAdapterRegistry {
  /** Register an adapter under its own `adapterKey`. Throws on a duplicate key. */
  register(adapter: ExternalTriageVendorAdapter): void;
  /** The adapter for a key, or `null` when none is registered. */
  find(adapterKey: string): ExternalTriageVendorAdapter | null;
  /** The adapter for a key, or throw {@link TriageVendorAdapterUnavailableError}. */
  require(adapterKey: string): ExternalTriageVendorAdapter;
  /** The registered keys (ops dashboard / the §12 sign-off evidence). */
  keys(): readonly string[];
  /** Does this adapter support the profile the tenant's binding declares? */
  supportsProfile(adapterKey: string, profile: VendorMinimizationProfile): boolean;
}

/** Build a fresh registry (the shared one is {@link triageVendorAdapters}; tests build their own). */
export function createTriageVendorAdapterRegistry(
  seed: readonly ExternalTriageVendorAdapter[] = [],
): TriageVendorAdapterRegistry {
  const adapters = new Map<string, ExternalTriageVendorAdapter>();

  const registry: TriageVendorAdapterRegistry = {
    register(adapter) {
      if (adapters.has(adapter.adapterKey)) {
        throw new TriageVendorAdapterConflictError(adapter.adapterKey);
      }
      adapters.set(adapter.adapterKey, adapter);
    },
    find(adapterKey) {
      return adapters.get(adapterKey) ?? null;
    },
    require(adapterKey) {
      const adapter = adapters.get(adapterKey);
      if (!adapter) throw new TriageVendorAdapterUnavailableError(adapterKey);
      return adapter;
    },
    keys() {
      return [...adapters.keys()].sort();
    },
    supportsProfile(adapterKey, profile) {
      return registry.find(adapterKey)?.supportedProfiles.includes(profile) ?? false;
    },
  };

  for (const adapter of seed) registry.register(adapter);
  return registry;
}

/**
 * The process-wide registry the composition root populates and the §7.5 handoff resolves through.
 *
 * Deliberately EMPTY at import. Phase 1 ships no concrete adapter (see the module header), so every
 * `require()` refuses and every `hybrid`/`centralized` handoff falls back to the in-agency path — which is
 * the same outcome the D3 feature flag produces, reached without a second switch that could disagree with
 * this one.
 */
export const triageVendorAdapters: TriageVendorAdapterRegistry =
  createTriageVendorAdapterRegistry();
