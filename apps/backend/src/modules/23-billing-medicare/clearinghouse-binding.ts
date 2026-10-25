// apps/backend/src/modules/23-billing-medicare/clearinghouse-binding.ts — which clearinghouse the platform is bound to
// (ADR-0053 D3). Platform configuration: `CLEARINGHOUSE_VENDOR` unset | `stedi` | `direct_mac` (`in_memory` is a
// test double, refused in production). Unset is the logged, unbound state (every call answers CH_NOT_WIRED). A vendor
// with no adapter in this build, a vendor whose credential is missing, or a vendor named with no durable attempt store
// all throw at boot — a deployment never silently behaves as "unset" while believing it is bound.
// The binding is created and logged at boot and INJECTED into the M23 submit/retry workers and ack crons
// (`buildM23WorkerDeps({ transport })`, #707); `registerM23LaunchWorkers` refuses to build them without it while a vendor is
// configured. M24 (Medicaid) deliberately does not use it: Oregon stays a state-direct adapter (ADR-0053 D10). M25
// remittance consumption is bound separately (#717: M25 `remittance-pull`). Read `binding.vendor`, not `binding.transport.vendor`, to know whether a
// clearinghouse is bound.
import {
  type ClearinghouseBinding,
  type ClearinghouseTransportFactories,
  type DirectMacGateway,
  DirectMacTransport,
  type StediAnomaly,
  type SubmissionAttemptStore,
  bindClearinghouseTransport,
  createStediTransportFromEnv,
} from "@chartwarden/x12-837-client";

export interface ClearinghouseBindingDeps {
  /** The durable, tenant-scoped attempt store, or null when this process has no database. */
  readonly attempts: SubmissionAttemptStore | null;
  /** The launch gateway composed as a port (absent when the M23 launch gateway is not configured). */
  readonly directMacGateway?: DirectMacGateway | null;
  /** PHI-free signals (a send that could not be recorded, a stale reservation) for the log / the reconciler. */
  readonly onAnomaly?: (anomaly: StediAnomaly) => void;
}

/** Vendor adapters compiled into this build. Add a factory here when an adapter passes its conformance suite. */
export function buildClearinghouseFactories(
  deps: ClearinghouseBindingDeps,
): ClearinghouseTransportFactories {
  const { attempts, onAnomaly, directMacGateway } = deps;
  return {
    direct_mac: () => {
      if (!attempts) {
        throw new Error(
          "CLEARINGHOUSE_VENDOR=direct_mac needs the durable attempt store, which needs a database; none is configured",
        );
      }
      if (!directMacGateway) {
        throw new Error(
          "CLEARINGHOUSE_VENDOR=direct_mac needs the M23 launch gateway (M23_MAC_GATEWAY_* / M23_X12_GATEWAY_*), which is not configured",
        );
      }
      return new DirectMacTransport({
        attempts,
        gateway: directMacGateway,
        ...(onAnomaly ? { onAnomaly } : {}),
      });
    },
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
