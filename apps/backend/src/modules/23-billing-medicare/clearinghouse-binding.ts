// apps/backend/src/modules/23-billing-medicare/clearinghouse-binding.ts — which clearinghouse the platform is bound to
// (ADR-0053 D3). Platform configuration: `CLEARINGHOUSE_VENDOR` unset | `stedi` | `direct_mac` (`in_memory` is a
// test double, refused in production). No adapter is registered yet, so naming a vendor throws at boot until its
// adapter lands — a deployment never silently behaves as "unset" while believing it is bound.
import {
  type ClearinghouseBinding,
  type ClearinghouseTransportFactories,
  bindClearinghouseTransport,
} from "@wardenx/x12-837-client";

/** Vendor adapters compiled into this build. Add a factory here when an adapter passes its conformance suite. */
export const CLEARINGHOUSE_FACTORIES: ClearinghouseTransportFactories = {};

export function bindPlatformClearinghouse(
  env: Readonly<Record<string, string | undefined>>,
  factories: ClearinghouseTransportFactories = CLEARINGHOUSE_FACTORIES,
): ClearinghouseBinding {
  return bindClearinghouseTransport(env, factories);
}

/** The boot log line `check:boot:platform` asserts; PHI-free and secret-free. */
export const CLEARINGHOUSE_BOUND_LOG = "Clearinghouse binding";
export function describeClearinghouseBinding(binding: ClearinghouseBinding): string {
  return binding.vendor === null
    ? `${CLEARINGHOUSE_BOUND_LOG}: unbound (CH_NOT_WIRED)`
    : `${CLEARINGHOUSE_BOUND_LOG}: ${binding.vendor}`;
}
