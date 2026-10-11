// apps/backend/src/modules/23-billing-medicare/clearinghouse-binding.ts — which clearinghouse the platform is bound to
// (ADR-0053 D3). Platform configuration: `CLEARINGHOUSE_VENDOR` unset | `stedi` | `direct_mac` (`in_memory` is a
// test double, refused in production). Unset is the logged, unbound state (every call answers CH_NOT_WIRED). A vendor
// with no adapter in this build, a vendor whose credential is missing, or a vendor named with no durable attempt store
// all throw at boot — a deployment never silently behaves as "unset" while believing it is bound.
// The binding is created and logged at boot but NOT yet injected into any M23/M24/M25 caller; wiring consumers is a
// later step, which should also assert a consumer receives it. Read `binding.vendor`, not `binding.transport.vendor`,
// to know whether a clearinghouse is bound.
import {
  type ClearinghouseBinding,
  type ClearinghouseTransportFactories,
  type StediAnomaly,
  type SubmissionAttemptStore,
  bindClearinghouseTransport,
  createStediTransportFromEnv,
} from "@wardenx/x12-837-client";

export interface ClearinghouseBindingDeps {
  /** The durable, tenant-scoped attempt store, or null when this process has no database. */
  readonly attempts: SubmissionAttemptStore | null;
  /** PHI-free signals (a send that could not be recorded, a stale reservation) for the log / the reconciler. */
  readonly onAnomaly?: (anomaly: StediAnomaly) => void;
}

/** Vendor adapters compiled into this build. Add a factory here when an adapter passes its conformance suite. */
export function buildClearinghouseFactories(
  deps: ClearinghouseBindingDeps,
): ClearinghouseTransportFactories {
  const { attempts, onAnomaly } = deps;
  return {
    stedi: (env) => {
      // The port promises durable idempotency; refuse to bind an adapter that would only keep it in memory.
      if (!attempts) {
        throw new Error(
          "CLEARINGHOUSE_VENDOR=stedi needs the durable attempt store, which needs a database; none is configured",
        );
      }
      return createStediTransportFromEnv(env, attempts, onAnomaly ? { onAnomaly } : {});
    },
  };
}

export function bindPlatformClearinghouse(
  env: Readonly<Record<string, string | undefined>>,
  deps: ClearinghouseBindingDeps,
): ClearinghouseBinding {
  return bindClearinghouseTransport(env, buildClearinghouseFactories(deps));
}

/** The boot log line `check:boot:platform` asserts; PHI-free and secret-free. */
export const CLEARINGHOUSE_BOUND_LOG = "Clearinghouse binding";
export function describeClearinghouseBinding(binding: ClearinghouseBinding): string {
  return binding.vendor === null
    ? `${CLEARINGHOUSE_BOUND_LOG}: unbound (CH_NOT_WIRED)`
    : `${CLEARINGHOUSE_BOUND_LOG}: ${binding.vendor}`;
}
