// @chartwarden/x12-837-client — which DdeAccessProvider is bound (ADR-0103 D2).
//
// Same shape as ../clearinghouse/transport-registry. Binding is platform configuration (the DDE_PROVIDER env var):
//   - unset, blank or `manual` -> a provider whose every call answers DDE_NOT_WIRED (nothing is sent; ADR-0052's
//                                 human queue is the only path);
//   - set, no adapter          -> throws at boot, so a misconfigured deployment refuses to start;
//   - in_memory in production  -> refused (it is a test double).
// Credentials stay in the environment and are read by the adapter's factory, never stored per tenant.
import { type X12WorkerResult, degraded } from "../types";
import { DDE, type DdeAccessProvider, type DdeProviderVendor } from "./types";

export const DDE_PROVIDER_ENV = "DDE_PROVIDER";
const MANUAL = "manual";

const VENDORS: readonly DdeProviderVendor[] = ["in_memory", "episode_alert"];
/** The providers configurable in production (everything but the in_memory test double). */
export const PRODUCTION_DDE_PROVIDERS: readonly DdeProviderVendor[] = VENDORS.filter(
  (v) => v !== "in_memory",
);

type EnvMap = Readonly<Record<string, string | undefined>>;

/** Builds an adapter from the platform environment (the adapter reads its own credentials from it). */
export type DdeProviderFactory = (env: EnvMap) => DdeAccessProvider;
export type DdeProviderFactories = Partial<Record<DdeProviderVendor, DdeProviderFactory>>;

export interface DdeProviderBinding {
  /** The configured vendor, or null for manual keying. */
  readonly vendor: DdeProviderVendor | null;
  readonly provider: DdeAccessProvider;
}

/** Returns the configured vendor, null when unset/blank/`manual`; throws on an unknown value or in_memory in production. */
export function parseDdeProvider(
  raw: string | undefined,
  production: boolean,
): DdeProviderVendor | null {
  const value = raw?.trim();
  if (!value || value === MANUAL) return null;
  const vendor = VENDORS.find((v) => v === value);
  if (!vendor) {
    throw new Error(
      `${DDE_PROVIDER_ENV} must be one of ${MANUAL}, ${VENDORS.join(", ")} (or unset)`,
    );
  }
  if (vendor === "in_memory" && production) {
    throw new Error(`${DDE_PROVIDER_ENV}=in_memory is a test double and is refused in production`);
  }
  return vendor;
}

const NOT_WIRED_REASON = `no DDE provider is bound (set ${DDE_PROVIDER_ENV}); key the item manually`;
const notWired = <T>(): Promise<X12WorkerResult<T>> =>
  Promise.resolve(degraded<T>(DDE.NOT_WIRED, NOT_WIRED_REASON));

/** The unbound provider: fails closed on every operation, so no caller can reach a vendor by accident. */
export const NOT_WIRED_DDE_PROVIDER: DdeAccessProvider = {
  vendor: "not_wired",
  submitOperation: notWired,
  fetchOutcomes: notWired,
  fetchOperationStatus: notWired,
};

export function bindDdeProvider(env: EnvMap, factories: DdeProviderFactories): DdeProviderBinding {
  const vendor = parseDdeProvider(env[DDE_PROVIDER_ENV], env.NODE_ENV === "production");
  if (vendor === null) return { vendor: null, provider: NOT_WIRED_DDE_PROVIDER };
  const factory = factories[vendor];
  if (!factory) {
    throw new Error(
      `${DDE_PROVIDER_ENV}=${vendor} but no adapter is registered for it in this build`,
    );
  }
  const provider = factory(env);
  if (provider.vendor !== vendor) {
    throw new Error(
      `${DDE_PROVIDER_ENV}=${vendor}: vendor mismatch, the adapter reports ${provider.vendor}`,
    );
  }
  return { vendor, provider };
}
