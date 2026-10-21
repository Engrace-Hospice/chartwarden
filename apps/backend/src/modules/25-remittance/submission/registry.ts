// M25 milestone 6a - resolves which adapter serves a (org, channel). The manual adapter is the default and the
// fallback: an electronic adapter that is not bound for the org makes the attempt `needs_manual` with the adapter's
// own operator-facing reason, never `queued`.
import type { SubmissionChannel } from "../domain";
import type { AdapterAvailability, FilingChannelAdapter } from "./channel-adapter";
import { ESMD_ADAPTER_SHELL } from "./esmd-adapter";
import { FAX_ADAPTER_SHELL } from "./fax-adapter";
import { MANUAL_ADAPTER } from "./manual-adapter";

export interface AdapterRegistry {
  readonly manual: FilingChannelAdapter;
  readonly electronic: readonly FilingChannelAdapter[];
}

/** The 6a registry: manual bound, esMD and fax shells unbound. */
export const DEFAULT_ADAPTER_REGISTRY: AdapterRegistry = {
  manual: MANUAL_ADAPTER,
  electronic: [ESMD_ADAPTER_SHELL, FAX_ADAPTER_SHELL],
};

export type AttemptPlan =
  | { readonly adapter: "manual"; readonly status: "needs_manual"; readonly reason: string }
  | { readonly adapter: "manual"; readonly status: "prepared"; readonly reason: null };

/**
 * Decide how a new attempt starts. 6a never queues: even when an electronic adapter reports bound (impossible with the
 * shells), the attempt stays `prepared` for the human approval step. An unbound electronic adapter falls back to
 * `needs_manual`.
 */
export function planAttempt(
  registry: AdapterRegistry,
  organizationId: string,
  channel: SubmissionChannel | null,
): AttemptPlan {
  const electronic = channel
    ? registry.electronic.find((a) => a.channels.includes(channel))
    : undefined;
  if (!electronic) {
    return {
      adapter: "manual",
      status: "needs_manual",
      reason: "Filed outside ChartWarden. Record the receipt from the channel.",
    };
  }
  const avail = electronic.availability(organizationId);
  if (!avail.bound) return { adapter: "manual", status: "needs_manual", reason: avail.reason };
  return { adapter: "manual", status: "prepared", reason: null };
}

/** What the screen shows per electronic adapter: the honest "not configured" line. */
export function adapterStatuses(
  registry: AdapterRegistry,
  organizationId: string,
): readonly ({ readonly kind: string; readonly mode: string } & AdapterAvailability)[] {
  return [registry.manual, ...registry.electronic].map((a) => ({
    kind: a.kind,
    mode: a.mode,
    ...a.availability(organizationId),
  }));
}
