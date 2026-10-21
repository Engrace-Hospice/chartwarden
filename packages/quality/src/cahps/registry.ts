// @wardenx/quality — M30 §4.5 per-org CAHPS adapter registry (pure, in-memory).
//
// At org boot the M30 service reads the active `cahps_vendor_binding` row, maps its `vendor_adapter_id`
// to an adapter CLASS, instantiates it with the decrypted config, calls `validateConfig`, and registers
// the live instance here keyed by `orgId`. Routes R-14/R-15/R-16 resolve the adapter through `resolve`,
// so a cross-tenant invocation is structurally impossible (the registry is keyed by `orgId`, never by
// tenant input). Vendor rotation (R-11) hot-reloads by re-registering the org's instance.
//
// P2a scope: this is the PURE in-memory map plus the resolution-map TYPES. The concrete vendor classes
// live in `@wardenx/cahps-vendors`; the actual map of factories is INJECTED at the composition root in a
// later phase (quality must not import cahps-vendors — that would invert the dependency edge). No I/O.
import { ChartWardenError } from "@wardenx/types";
import type { CahpsVendorAdapter, CahpsVendorAdapterId } from "./adapter";

/**
 * A factory that instantiates a vendor adapter from its decrypted org-level binding config (§4.5: the
 * service "instantiates with the decrypted config"). Concrete factories live in `@wardenx/cahps-vendors`.
 */
export type CahpsAdapterFactory = (config: Record<string, unknown>) => CahpsVendorAdapter;

/**
 * The `vendor_adapter_id → factory` resolution map (§4.5). Injected at the composition root from
 * `@wardenx/cahps-vendors`; total over {@link CahpsVendorAdapterId} so every persistable binding resolves.
 */
export type CahpsAdapterResolutionMap = Readonly<Record<CahpsVendorAdapterId, CahpsAdapterFactory>>;

/**
 * Instantiate the adapter for one binding by looking its `vendorAdapterId` up in the injected resolution
 * map and calling the factory with the decrypted config. Throws `CAHPS_VENDOR_UNKNOWN` if the id has no
 * registered factory (an impossible state if the map is total, but fails closed rather than `undefined`).
 */
export function instantiateAdapter(
  vendorAdapterId: CahpsVendorAdapterId,
  config: Record<string, unknown>,
  resolutionMap: CahpsAdapterResolutionMap,
): CahpsVendorAdapter {
  const factory = resolutionMap[vendorAdapterId];
  if (factory === undefined) {
    throw new ChartWardenError(
      "CAHPS_VENDOR_UNKNOWN",
      `no CAHPS adapter factory registered for vendor '${vendorAdapterId}'`,
      500,
    );
  }
  return factory(config);
}

/**
 * A per-org registry of live CAHPS adapter instances (§4.5). One process-local map; entries are
 * registered at org boot / vendor rotation and resolved per request. Pure in-memory — no DB, no I/O.
 */
export class CahpsAdapterRegistry {
  private readonly byOrg = new Map<string, CahpsVendorAdapter>();

  /** Register (or hot-replace, on R-11 rotation) the live adapter for an org. */
  register(orgId: string, adapter: CahpsVendorAdapter): void {
    this.byOrg.set(orgId, adapter);
  }

  /** Drop the org's adapter (e.g. when its binding is deactivated with no successor). */
  unregister(orgId: string): void {
    this.byOrg.delete(orgId);
  }

  /** Whether the org currently has a live adapter registered. */
  has(orgId: string): boolean {
    return this.byOrg.has(orgId);
  }

  /**
   * Resolve the org's live adapter. Throws `CAHPS_ADAPTER_UNCONFIGURED` (503) when no adapter is
   * registered — the org has no active `cahps_vendor_binding`, so CAHPS routes are degraded, not 404.
   */
  resolve(orgId: string): CahpsVendorAdapter {
    const adapter = this.byOrg.get(orgId);
    if (adapter === undefined) {
      throw new ChartWardenError(
        "CAHPS_ADAPTER_UNCONFIGURED",
        `no active CAHPS vendor adapter is registered for org '${orgId}'`,
        503,
      );
    }
    return adapter;
  }
}
