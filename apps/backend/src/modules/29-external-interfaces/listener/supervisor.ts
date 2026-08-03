// apps/backend/src/modules/29-external-interfaces/listener — the MLLP listener supervisor (M29-T03,
// §4.11.1/§4.11.4). The orchestration: boot every active inbound feed behind the D16 BAA gate, hot-reload on
// feed lifecycle events, and drain gracefully on SIGTERM. Every IO edge is an INJECTED port
// (`SupervisorDeps`) so the orchestration is unit-testable with fakes; the real process entrypoint
// (`listener/index.ts`) wires the DB feed loader, the `getSeam("BaaStatusProvider")` gate, the TLS listener
// factory (§4.11.2) and the M36 alert dispatcher into these ports.
//
// WHY A SEPARATE PROCESS (§4.11). The supervisor runs in a long-lived sibling Node process, NOT the Fastify
// HTTP server — crash isolation is the goal (a route crash never drops a listener; a listener crash never
// drops Fastify). This file is process-agnostic: it manipulates ports, never `process` or the network
// directly, so the same orchestration is driven by the real entrypoint OR a test harness.
import type { ExternalFeedKind, ExternalFeedProtocol, ExternalFeedStatus } from "@wardenx/types";
import {
  type BaaGateRefuseReason,
  type ExternalInterfaceBaaGate,
  evaluateFeedActivationBaaGate,
} from "../feed/baa-gate";

/** The minimal feed shape the supervisor reasons over (a subset of `external_feed`, §3.3). */
export interface SupervisorFeedDescriptor {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: ExternalFeedKind;
  readonly displayName: string;
  readonly port: number;
  readonly protocol: ExternalFeedProtocol;
  readonly status: ExternalFeedStatus;
  readonly baaContractRef: string | null;
  readonly sendingFacilityAllowlist: readonly string[];
}

/** An M36 alert the supervisor dispatches when a feed cannot start (§4.11.1 step 2). */
export interface SupervisorAlert {
  readonly severity: "critical" | "warning";
  readonly channel: "compliance" | "operator_on_call";
  readonly feedId: string;
  readonly organizationId: string;
  readonly title: string;
  readonly body: string;
}

/** The bound-listener registry — one live TLS server per feed id (§4.11.2 `deps.registry.attach`). */
export interface ListenerRegistryPort {
  /** Bind + start the per-feed TLS MLLP listener. Rejects if the port is taken or the cert fails to load. */
  start(feed: SupervisorFeedDescriptor): Promise<void>;
  /** Stop + unbind the listener for a feed id (idempotent — a no-op if not bound). */
  stop(feedId: string, reason: "suspended" | "revoked" | "shutdown"): Promise<void>;
  /** The feed ids currently bound. */
  boundFeedIds(): readonly string[];
}

/** The ports the supervisor drives — every IO edge, injected. */
export interface SupervisorDeps {
  /** Load every ACTIVE inbound (`adt_inbound`/`lab_inbound`) feed across tenants (via `withPlatformContext`
   *  in the real wiring — the supervisor stays tenant-agnostic here). */
  loadActiveInboundFeeds(): Promise<readonly SupervisorFeedDescriptor[]>;
  /** Resolve a single feed by id for hot-reload on `m29.external_feed.activated`. */
  loadFeedById(feedId: string): Promise<SupervisorFeedDescriptor | null>;
  /** The M40 BAA gate (D16). */
  baaGate: ExternalInterfaceBaaGate;
  /** The listener registry (§4.11.2). */
  registry: ListenerRegistryPort;
  /** Dispatch an M36 alert. */
  dispatchAlert(alert: SupervisorAlert): Promise<void>;
  /** In-flight frame drain (§4.11.4 step 2) — resolves when in-flight ACKs complete or the deadline hits. */
  drainInflight(deadlineMs: number): Promise<void>;
  /** Emit the per-feed shutdown audit marker (§4.11.4 step 3). */
  emitShutdownAudit(feedId: string): Promise<void>;
  /** The clock, INJECTED (the BAA gate's `asOf`). */
  now(): Date;
  /** Structured logger. */
  log(level: "info" | "warn", event: string, fields: Record<string, unknown>): void;
}

/** The platform-floor in-flight drain deadline on shutdown (§4.11.4 — 30s, tenants may not loosen). */
export const LISTENER_DRAIN_DEADLINE_MS = 30_000;

/** Only inbound MLLP feeds bind a listener; the outbound ORM feed is a transmitter, not a listener. */
export function feedBindsInboundListener(kind: ExternalFeedKind): boolean {
  return kind === "adt_inbound" || kind === "lab_inbound";
}

/** One feed's boot outcome. */
export type FeedBootOutcome =
  | { readonly feedId: string; readonly started: true }
  | { readonly feedId: string; readonly started: false; readonly reason: BaaGateRefuseReason | "not_inbound" };

/** The boot-sequence summary (§4.11.1). */
export interface SupervisorBootSummary {
  readonly outcomes: readonly FeedBootOutcome[];
  get startedCount(): number;
  get skippedCount(): number;
}

/**
 * §4.11.1 boot: for each active inbound feed, run the D16 BAA gate; start the listener when it passes, else
 * log + alert + skip (never let a partner without a signed BAA in force bind a listener). Returns the
 * per-feed outcomes so the entrypoint (and tests) can assert the boot decisions.
 */
export async function bootFeedListeners(deps: SupervisorDeps): Promise<SupervisorBootSummary> {
  const feeds = await deps.loadActiveInboundFeeds();
  const outcomes: FeedBootOutcome[] = [];
  for (const feed of feeds) {
    const outcome = await startFeedListener(feed, deps);
    outcomes.push(outcome);
  }
  return {
    outcomes,
    get startedCount() {
      return outcomes.filter((o) => o.started).length;
    },
    get skippedCount() {
      return outcomes.filter((o) => !o.started).length;
    },
  };
}

/** Start ONE feed's listener behind the BAA gate (shared by boot + the `activated` hot-reload path). */
export async function startFeedListener(
  feed: SupervisorFeedDescriptor,
  deps: SupervisorDeps,
): Promise<FeedBootOutcome> {
  if (!feedBindsInboundListener(feed.kind)) {
    return { feedId: feed.id, started: false, reason: "not_inbound" };
  }
  const decision = await evaluateFeedActivationBaaGate({
    gate: deps.baaGate,
    orgId: feed.organizationId,
    baaContractRef: feed.baaContractRef,
    sendingFacilityAllowlist: feed.sendingFacilityAllowlist,
    asOf: deps.now(),
  });
  if (!decision.allowed) {
    deps.log("warn", "hl7.listener.baa_refuse", {
      feedId: feed.id,
      organizationId: feed.organizationId,
      reason: decision.reason,
      baaStatus: decision.status,
    });
    await deps.dispatchAlert({
      severity: "critical",
      channel: "compliance",
      feedId: feed.id,
      organizationId: feed.organizationId,
      title: `BAA gate blocked feed ${feed.displayName}`,
      body: `Feed ${feed.id} on org ${feed.organizationId} cannot bind its MLLP listener: BAA gate refused (${decision.reason}, status=${decision.status}).`,
    });
    return { feedId: feed.id, started: false, reason: decision.reason };
  }
  await deps.registry.start(feed);
  deps.log("info", "hl7.listener.started", { feedId: feed.id, port: feed.port });
  return { feedId: feed.id, started: true };
}

/** §4.11.1 step 3 — hot-reload handler for a `m29.external_feed.activated` event (re-runs the BAA gate). */
export async function handleFeedActivated(deps: SupervisorDeps, feedId: string): Promise<FeedBootOutcome> {
  const feed = await deps.loadFeedById(feedId);
  if (feed === null || feed.status !== "active") {
    deps.log("warn", "hl7.listener.activate_skip_not_active", { feedId });
    return { feedId, started: false, reason: "not_inbound" };
  }
  return startFeedListener(feed, deps);
}

/** §4.11.1 step 3 — hot-reload handler for `m29.external_feed.suspended` / `revoked` (unbind the listener). */
export async function handleFeedStopped(
  deps: SupervisorDeps,
  feedId: string,
  reason: "suspended" | "revoked",
): Promise<void> {
  await deps.registry.stop(feedId, reason);
  deps.log("info", "hl7.listener.stopped", { feedId, reason });
}

/**
 * §4.11.4 graceful shutdown: stop accepting on every listener, drain in-flight frames (≤30s), emit the
 * per-feed shutdown audit. Does NOT call `process.exit` — the entrypoint owns process lifecycle so this
 * stays pure/testable. Returns the feed ids that were drained.
 */
export async function drainAndShutdown(deps: SupervisorDeps): Promise<readonly string[]> {
  deps.log("info", "hl7.listener.shutdown.begin", {});
  const feedIds = [...deps.registry.boundFeedIds()];
  for (const feedId of feedIds) {
    await deps.registry.stop(feedId, "shutdown");
    deps.log("info", "hl7.listener.shutdown.stop_accept", { feedId });
  }
  await deps.drainInflight(LISTENER_DRAIN_DEADLINE_MS);
  for (const feedId of feedIds) {
    await deps.emitShutdownAudit(feedId);
  }
  deps.log("info", "hl7.listener.shutdown.complete", { count: feedIds.length });
  return feedIds;
}
