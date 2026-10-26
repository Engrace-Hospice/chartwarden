// @chartwarden/x12-837-client — which eligibility-only ClearinghouseTransport is bound (#758, ADR-0103).
//
// CLEARINGHOUSE_VENDOR is platform-wide and routes claim submission, so an eligibility-only vendor (episode_alert)
// cannot be bound there (transport-registry omits it). This SEPARATE setting, ELIGIBILITY_VENDOR, binds a transport
// that is used for checkEligibility only. Same fail-closed rules as the clearinghouse registry:
//   - unset            -> every call answers CH_NOT_WIRED;
//   - set, no adapter  -> throws at boot;
//   - in_memory in production, or a submission vendor (stedi, direct_mac) -> refused.
// Credentials stay in the environment and are read by the adapter's factory.
import { NOT_WIRED_TRANSPORT } from "./transport-registry";
import type { ClearinghouseTransport, ClearinghouseVendor } from "./types";

export const ELIGIBILITY_VENDOR_ENV = "ELIGIBILITY_VENDOR";

const VENDORS: readonly ClearinghouseVendor[] = ["in_memory", "episode_alert"];

type EnvMap = Readonly<Record<string, string | undefined>>;
export type EligibilityTransportFactories = Partial<
  Record<ClearinghouseVendor, (env: EnvMap) => ClearinghouseTransport>
>;

export interface EligibilityBinding {
  readonly vendor: ClearinghouseVendor | null;
  readonly transport: ClearinghouseTransport;
}

export function parseEligibilityVendor(
  raw: string | undefined,
  production: boolean,
): ClearinghouseVendor | null {
  const value = raw?.trim();
  if (!value) return null;
  const vendor = VENDORS.find((v) => v === value);
  if (!vendor) {
    throw new Error(`${ELIGIBILITY_VENDOR_ENV} must be one of ${VENDORS.join(", ")} (or unset)`);
  }
  if (vendor === "in_memory" && production) {
    throw new Error(
      `${ELIGIBILITY_VENDOR_ENV}=in_memory is a test double and is refused in production`,
    );
  }
  return vendor;
}

export function bindEligibilityTransport(
  env: EnvMap,
  factories: EligibilityTransportFactories,
): EligibilityBinding {
  const vendor = parseEligibilityVendor(
    env[ELIGIBILITY_VENDOR_ENV],
    env.NODE_ENV === "production",
  );
  if (vendor === null) return { vendor: null, transport: NOT_WIRED_TRANSPORT };
  const factory = factories[vendor];
  if (!factory) {
    throw new Error(
      `${ELIGIBILITY_VENDOR_ENV}=${vendor} but no adapter is registered for it in this build`,
    );
  }
  const transport = factory(env);
  if (transport.vendor !== vendor) {
    throw new Error(
      `${ELIGIBILITY_VENDOR_ENV}=${vendor}: vendor mismatch, the adapter reports ${transport.vendor}`,
    );
  }
  return { vendor, transport };
}
