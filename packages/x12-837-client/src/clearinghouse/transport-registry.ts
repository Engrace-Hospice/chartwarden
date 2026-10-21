// @chartwarden/x12-837-client — which ClearinghouseTransport is bound (ADR-0053 D3).
//
// ChartWarden resells ONE clearinghouse, so the binding is platform configuration (the CLEARINGHOUSE_VENDOR env var),
// not a tenant or ProviderEntity setting, and it needs no migration. Binding fails closed:
//   - unset            -> a transport whose every call answers CH_NOT_WIRED (nothing is sent);
//   - set, no adapter  -> throws at boot, so a misconfigured deployment refuses to start instead of silently
//                         behaving as "unset";
//   - in_memory in production is refused (it is a test double).
// Credentials stay in the environment and are read by the adapter's factory, never stored per tenant.
import { type X12WorkerResult, degraded } from "../types";
import { CH, type ClearinghouseTransport, type ClearinghouseVendor } from "./types";

export const CLEARINGHOUSE_VENDOR_ENV = "CLEARINGHOUSE_VENDOR";

const VENDORS: readonly ClearinghouseVendor[] = ["in_memory", "direct_mac", "stedi"];
/** The vendors configurable in production (everything but the in_memory test double). */
export const PRODUCTION_CLEARINGHOUSE_VENDORS: readonly ClearinghouseVendor[] = VENDORS.filter(
  (v) => v !== "in_memory",
);

type EnvMap = Readonly<Record<string, string | undefined>>;

/** Builds an adapter from the platform environment (the adapter reads its own credentials from it). */
export type ClearinghouseTransportFactory = (env: EnvMap) => ClearinghouseTransport;
export type ClearinghouseTransportFactories = Partial<
  Record<ClearinghouseVendor, ClearinghouseTransportFactory>
>;

export interface ClearinghouseBinding {
  /** The configured vendor, or null when the platform has not bound one. */
  readonly vendor: ClearinghouseVendor | null;
  readonly transport: ClearinghouseTransport;
}

/** Returns the configured vendor, null when unset/blank; throws on an unknown value or in_memory in production. */
export function parseClearinghouseVendor(
  raw: string | undefined,
  production: boolean,
): ClearinghouseVendor | null {
  const value = raw?.trim();
  if (!value) return null;
  const vendor = VENDORS.find((v) => v === value);
  if (!vendor) {
    throw new Error(`${CLEARINGHOUSE_VENDOR_ENV} must be one of ${VENDORS.join(", ")} (or unset)`);
  }
  if (vendor === "in_memory" && production) {
    throw new Error(
      `${CLEARINGHOUSE_VENDOR_ENV}=in_memory is a test double and is refused in production`,
    );
  }
  return vendor;
}

const NOT_WIRED_REASON = `no clearinghouse is bound (set ${CLEARINGHOUSE_VENDOR_ENV})`;
const notWired = <T>(): Promise<X12WorkerResult<T>> =>
  Promise.resolve(degraded<T>(CH.NOT_WIRED, NOT_WIRED_REASON));

/** The unbound transport: fails closed on every operation, so no caller can reach a vendor by accident. */
export const NOT_WIRED_TRANSPORT: ClearinghouseTransport = {
  vendor: "not_wired",
  checkEligibility: notWired,
  validateOnly: notWired,
  submitNotice: notWired,
  submitClaim: notWired,
  fetchAcknowledgments: notWired,
  fetchRemittances: notWired,
  fetchClaimStatus: notWired,
  verifyAndParseEvent: notWired,
};

export function bindClearinghouseTransport(
  env: EnvMap,
  factories: ClearinghouseTransportFactories,
): ClearinghouseBinding {
  const vendor = parseClearinghouseVendor(
    env[CLEARINGHOUSE_VENDOR_ENV],
    env.NODE_ENV === "production",
  );
  if (vendor === null) return { vendor: null, transport: NOT_WIRED_TRANSPORT };
  const factory = factories[vendor];
  if (!factory) {
    throw new Error(
      `${CLEARINGHOUSE_VENDOR_ENV}=${vendor} but no adapter is registered for it in this build`,
    );
  }
  const transport = factory(env);
  if (transport.vendor !== vendor) {
    throw new Error(
      `${CLEARINGHOUSE_VENDOR_ENV}=${vendor}: vendor mismatch, the adapter reports ${transport.vendor}`,
    );
  }
  return { vendor, transport };
}
