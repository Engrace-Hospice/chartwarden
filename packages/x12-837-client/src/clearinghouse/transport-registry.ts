// @chartwarden/x12-837-client — which ClearinghouseTransport is bound (ADR-0053 D3, amended 2026-11-06).
//
// The vendor is chosen PER TENANT (stedi | claimmd | outside, `tenant_clearinghouse_config`, M23); the backend builds a
// per-organization binding on top of this module (`ClearinghouseBinding.forOrg`, `bindingForOrg`). The platform-wide
// `CLEARINGHOUSE_VENDOR` binding below remains for the organizations an operator names explicitly
// (`CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS`); it needs no migration. Binding fails closed:
//   - unset            -> a transport whose every call answers CH_NOT_WIRED (nothing is sent);
//   - set, no adapter  -> throws at boot, so a misconfigured deployment refuses to start instead of silently
//                         behaving as "unset";
//   - in_memory in production is refused (it is a test double).
// Platform credentials stay in the environment and are read by the adapter's factory; a tenant's own credential is
// sealed in its config row and handed to the adapter by the backend resolver.
import { type X12WorkerResult, degraded } from "../types";
import { CH, type ClearinghouseTransport, type ClearinghouseVendor } from "./types";

export const CLEARINGHOUSE_VENDOR_ENV = "CLEARINGHOUSE_VENDOR";

// episode_alert is deliberately absent: it is eligibility-only, so binding it platform-wide would stop submission (#758).
const VENDORS: readonly ClearinghouseVendor[] = ["in_memory", "direct_mac", "stedi", "claimmd"];
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

/**
 * Why an organization has no usable clearinghouse (nothing is sent for it either way; the reason decides what a worker does):
 * `not_chosen` (nothing chosen yet) and `not_active` (a draft / verified config) HOLD work until the tenant finishes setup;
 * `outside` (the tenant bills outside ChartWarden) never transmits at all.
 */
export type UnboundReason = "not_chosen" | "not_active" | "outside";

export interface ClearinghouseBinding {
  /** The configured vendor, or null when the platform has not bound one. */
  readonly vendor: ClearinghouseVendor | null;
  readonly transport: ClearinghouseTransport;
  /** Set on an UNBOUND per-organization binding (`vendor` null): why it is unbound. Absent on a bound one. */
  readonly unboundReason?: UnboundReason;
  /**
   * Per-organization binding (tenant clearinghouse, ADR-0053 amendment 2026-11-06). When present, `vendor` and
   * `transport` above are the UNBOUND platform default and say nothing about any organization: a consumer that acts for
   * an organization MUST resolve its own binding through {@link bindingForOrg}. The resolved binding is a plain one
   * (no `forOrg`): `vendor` null = that organization has no usable clearinghouse (nothing is sent for it).
   */
  readonly forOrg?: (organizationId: string) => Promise<ClearinghouseBinding>;
}

/** The binding to use for `organizationId`: its own when the platform binding is per-organization, else the one binding. */
export async function bindingForOrg<B extends Pick<ClearinghouseBinding, "vendor">>(
  binding: B & { readonly forOrg?: (organizationId: string) => Promise<B> },
  organizationId: string,
): Promise<B> {
  return binding.forOrg ? binding.forOrg(organizationId) : binding;
}

/** True when {@link bindingForOrg} resolves a different binding per organization (the top-level vendor then means nothing). */
export const isPerOrgBinding = (binding: { readonly forOrg?: unknown }): boolean =>
  binding.forOrg !== undefined;

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

const unbound = (unboundReason: UnboundReason): ClearinghouseBinding =>
  Object.freeze({ vendor: null, transport: NOT_WIRED_TRANSPORT, unboundReason });

/** The binding of an organization that has chosen nothing: nothing is sent, every call answers CH_NOT_WIRED. */
export const UNBOUND_NOT_CHOSEN: ClearinghouseBinding = unbound("not_chosen");
/** The binding of an organization whose config is a draft or verified (not live yet). */
export const UNBOUND_NOT_ACTIVE: ClearinghouseBinding = unbound("not_active");
/** The binding of an organization that bills outside ChartWarden. */
export const UNBOUND_OUTSIDE: ClearinghouseBinding = unbound("outside");
/** The generic unbound binding (= nothing chosen). */
export const UNBOUND_BINDING: ClearinghouseBinding = UNBOUND_NOT_CHOSEN;

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
