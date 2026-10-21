// apps/backend/src/modules/29-external-interfaces/listener/process.ts — GAP-086. `startListenerProcess`: the composition of
// the §4.11 MLLP listener supervisor over its REAL ports (`listener/index.ts` deferred exactly this to "T08").
//
//   feeds      `createDrizzleFeedLoader` (per-org reads behind the allowlisted platform org enumerator)
//   BAA gate   the injected M40 `BaaStatusProvider` slice (D16) — resolved by the composition root
//   registry   `createTlsListenerRegistry` (mTLS, TLSv1.3-min, pinned client CA) fed by `createCredentialLoader`
//   sink       `createDrizzleIngestSinkFactory` (persist-after-ACK-gate: `aa` only after COMMIT)
//   alerts     the M36 `AlertEmitter` — BAA refusals ride the seeded `external_feed.baa_*` rules, a cleartext /
//              credential / bind failure rides `external_feed.listener_blocked`
//
// HOT RELOAD BY RECONCILIATION (replaces the spec's outbox subscriptions). The listener process runs no outbox
// dispatcher, so rather than subscribe to `activated`/`suspended`/`revoked` it re-reads the active feed set every
// `reconcileIntervalMs` (30s, the spec's health-probe tick) and converges: a newly-active feed binds (behind the BAA
// gate), a feed no longer active unbinds, a feed whose port / protocol / sender allowlist changed rebinds. A feed
// that failed to bind is retried each tick (its alert is windowed per day by M36's correlation-id dedupe).
// A credential ROTATION takes effect on the next (re)bind — a bound server keeps the certificate it started with.
//
// This file never calls `process.exit` and never reads `process.env` except through the injected `allowPlainProtocol`
// (the entrypoint in `index.ts` owns process lifecycle).
import { randomUUID } from "node:crypto";

import type { DbClient } from "@chartwarden/db";
import type { ExternalInterfaceBaaGate } from "../feed/baa-gate";
import type { InboundCipher } from "../inbound/inbound-crypto";
import { MLLP_READ_TIMEOUT_MS, type MllpConnectionDeps, type MllpIngestSink } from "./connection";
import { createCredentialLoader } from "./credential-loader";
import { createDrizzleFeedLoader } from "./feed-loader";
import { createDrizzleFeedHealthStore } from "./health-store-drizzle";
import { runFeedHealthTick } from "./health-sweep";
import { createTlsListenerRegistry } from "./index";
import { createDrizzleIngestSinkFactory } from "./ingest-sink";
import {
  type FeedBootOutcome,
  type SupervisorAlert,
  type SupervisorDeps,
  type SupervisorFeedDescriptor,
  drainAndShutdown,
  startFeedListener,
} from "./supervisor";

/** The §4.11.1 health-probe tick the reconcile loop shares. */
export const LISTENER_RECONCILE_INTERVAL_MS = 30_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A stalled process must not credit hours of uptime for one gap: cap the elapsed credit per tick. */
const MAX_HEALTH_CREDIT_MS = 120_000;

/** The slice of M36's `AlertEmitter` this process calls (the `getSeam("AlertEmitter")` shape). */
export interface ListenerAlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

export interface ListenerProcessDeps {
  readonly db: DbClient;
  readonly cipher: InboundCipher;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** Thunk: the M40 seam registers during `wireModuleSeams()`, after this object may be constructed. */
  readonly baaGate: () => ExternalInterfaceBaaGate;
  readonly alerts: () => ListenerAlertPort;
  readonly log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
  readonly now?: () => Date;
  /** F-182 — omitted ⇒ derived from the environment (never in production). */
  readonly allowPlainProtocol?: boolean;
  readonly reconcileIntervalMs?: number;
  readonly readTimeoutMs?: number;
  /**
   * GAP-043 - the worker-role watcher (`M29_LISTENER_WATCH_ENABLED=true`) decides `listener_down`; this process then only
   * leaves the heartbeat + bound facts. Omitted/false => this process still pages (no watcher, nobody left unpaged).
   */
  readonly watcherOwnsListenerDown?: boolean;
}

export interface ReconcileSummary {
  readonly started: readonly string[];
  readonly stopped: readonly string[];
  readonly failed: readonly { readonly feedId: string; readonly reason: string }[];
  readonly refused: readonly { readonly feedId: string; readonly reason: string }[];
}

export interface ListenerProcessHandle {
  /** One convergence pass (also what the interval runs). */
  reconcile(): Promise<ReconcileSummary>;
  boundFeedIds(): readonly string[];
  /** Stop the interval, unbind every listener, drain in-flight frames (≤30s). */
  shutdown(): Promise<readonly string[]>;
}

/** HL7 `YYYYMMDDHHMMSS` (UTC). */
export function hl7Timestamp(at: Date): string {
  return at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

const feedShape = (feed: SupervisorFeedDescriptor): string =>
  `${feed.port}|${feed.protocol}|${[...feed.sendingFacilityAllowlist].sort().join(",")}`;

export function alertEmitInput(
  alert: SupervisorAlert,
  now: Date,
): Parameters<ListenerAlertPort["emit"]>[1] {
  const kind = alert.kind ?? "external_feed.listener_blocked";
  return {
    eventType: kind,
    // PHI-free: ids + the supervisor's fixed sentence (it names no partner host / port / cert).
    payload: { feedId: alert.feedId, detail: alert.body },
    severity: alert.severity,
    // A down alert fires on a breaker TRANSITION, so its window is the hour (a second outage the same day must
    // still page); the bind/BAA refusals repeat every tick while unresolved, so they stay windowed per day.
    correlationId: `m29-listener:${kind}:${alert.feedId}:${Math.floor(
      now.getTime() / (kind === "external_feed.listener_down" ? HOUR_MS : DAY_MS),
    )}`,
  };
}

export async function startListenerProcess(
  deps: ListenerProcessDeps,
): Promise<ListenerProcessHandle> {
  const now = deps.now ?? (() => new Date());
  let inflight = 0;
  const trackedSink = (sink: MllpIngestSink): MllpIngestSink => {
    const track = async <T>(work: () => Promise<T>): Promise<T> => {
      inflight += 1;
      try {
        return await work();
      } finally {
        inflight -= 1;
      }
    };
    return {
      isDuplicate: (i) => track(() => sink.isDuplicate(i)),
      ingest: (i) => track(() => sink.ingest(i)),
      recordRejected: (i) => track(() => sink.recordRejected(i)),
    };
  };

  const sinkFor = createDrizzleIngestSinkFactory({
    db: deps.db,
    cipher: deps.cipher,
    now,
    log: deps.log,
  });
  const feeds = createDrizzleFeedLoader({ db: deps.db, activeOrgs: deps.activeOrgs });
  const registry = createTlsListenerRegistry({
    loadCredential: createCredentialLoader({ db: deps.db, cipher: deps.cipher, now }),
    connectionDeps: (feed): MllpConnectionDeps => ({
      sink: trackedSink(sinkFor(feed)),
      mintAckControlId: () => `WX${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
      now,
      hl7Timestamp,
      readTimeoutMs: deps.readTimeoutMs ?? MLLP_READ_TIMEOUT_MS,
      log: deps.log,
    }),
    log: deps.log,
    ...(deps.allowPlainProtocol === undefined
      ? {}
      : { allowPlainProtocol: deps.allowPlainProtocol }),
  });

  const dispatchAlert = async (alert: SupervisorAlert): Promise<void> => {
    try {
      await deps.alerts().emit(alert.organizationId, alertEmitInput(alert, now()));
    } catch (err) {
      // An alerting failure must never take the listener down; the refusal is also on the structured log.
      deps.log("warn", "hl7.listener.alert_emit_failed", {
        feedId: alert.feedId,
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  };

  const supervisorDeps: SupervisorDeps = {
    loadActiveInboundFeeds: () => feeds.loadActiveInboundFeeds(),
    loadFeedById: (feedId) => feeds.loadFeedById(feedId),
    get baaGate() {
      return deps.baaGate();
    },
    registry,
    dispatchAlert,
    drainInflight: async (deadlineMs) => {
      const deadline = Date.now() + deadlineMs;
      while (inflight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (inflight > 0) deps.log("warn", "hl7.listener.drain_deadline", { inflight });
    },
    emitShutdownAudit: async (feedId) => {
      deps.log("info", "hl7.listener.shutdown", { feedId, at: now().toISOString() });
    },
    ...(deps.allowPlainProtocol === undefined
      ? {}
      : { allowPlainProtocol: deps.allowPlainProtocol }),
    now,
    log: deps.log,
  };

  const boundShapes = new Map<string, string>();
  let reconciling: Promise<ReconcileSummary> | null = null;

  const reconcileOnce = async (): Promise<ReconcileSummary> => {
    const started: string[] = [];
    const stopped: string[] = [];
    const failed: { feedId: string; reason: string }[] = [];
    const refused: { feedId: string; reason: string }[] = [];
    const active = await feeds.loadActiveInboundFeeds();

    for (const feedId of registry.boundFeedIds()) {
      const feed = active.find((f) => f.id === feedId);
      if (!feed || boundShapes.get(feedId) !== feedShape(feed)) {
        await registry.stop(feedId, "suspended");
        boundShapes.delete(feedId);
        stopped.push(feedId);
      }
    }
    for (const feed of active) {
      if (registry.boundFeedIds().includes(feed.id)) continue;
      let outcome: FeedBootOutcome;
      try {
        outcome = await startFeedListener(feed, supervisorDeps);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "bind_failed";
        deps.log("warn", "hl7.listener.start_failed", { feedId: feed.id, reason });
        await dispatchAlert({
          kind: "external_feed.listener_blocked",
          severity: "critical",
          channel: "operator_on_call",
          feedId: feed.id,
          organizationId: feed.organizationId,
          title: `MLLP listener could not start for feed ${feed.displayName}`,
          body: `Feed ${feed.id} on org ${feed.organizationId} is active but its listener failed to bind (${reason.split(":")[0]}). No inbound HL7 is being accepted on this feed.`,
        });
        failed.push({ feedId: feed.id, reason });
        continue;
      }
      if (outcome.started) {
        boundShapes.set(feed.id, feedShape(feed));
        started.push(feed.id);
      } else {
        refused.push({ feedId: feed.id, reason: outcome.reason });
      }
    }
    return { started, stopped, failed, refused };
  };

  // GAP-043 — the §4.11.1 health probe rides the same tick: after the registry has converged, advance each
  // feed's circuit breaker and persist the hourly rollup. Best-effort: a health failure never fails the pass.
  const healthStore = createDrizzleFeedHealthStore({ db: deps.db });
  let lastHealthTickMs: number | null = null;
  const healthTick = async (): Promise<void> => {
    const nowMs = now().getTime();
    const elapsedSeconds =
      lastHealthTickMs === null
        ? 0
        : Math.min(
            Math.round((nowMs - lastHealthTickMs) / 1000),
            Math.round(MAX_HEALTH_CREDIT_MS / 1000),
          );
    lastHealthTickMs = nowMs;
    try {
      await runFeedHealthTick(
        {
          feeds: () => feeds.loadActiveInboundFeeds(),
          isBound: (feedId) => registry.boundFeedIds().includes(feedId),
          store: healthStore,
          dispatchAlert,
          ...(deps.watcherOwnsListenerDown === undefined
            ? {}
            : { watcherOwnsListenerDown: deps.watcherOwnsListenerDown }),
          now,
          log: deps.log,
        },
        elapsedSeconds,
      );
    } catch (err) {
      deps.log("warn", "hl7.listener.health_sweep_failed", {
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  };

  // Single-flight: an interval tick never overlaps a slow pass.
  const reconcile = (): Promise<ReconcileSummary> => {
    if (reconciling) return reconciling;
    reconciling = reconcileOnce()
      .then(async (summary) => {
        await healthTick();
        return summary;
      })
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  };

  const first = await reconcile();
  deps.log("info", "hl7.listener.boot_complete", {
    started: first.started.length,
    refused: first.refused.length,
    failed: first.failed.length,
  });
  const timer = setInterval(() => {
    reconcile().catch((err) =>
      deps.log("warn", "hl7.listener.reconcile_failed", {
        errorName: err instanceof Error ? err.name : "unknown",
      }),
    );
  }, deps.reconcileIntervalMs ?? LISTENER_RECONCILE_INTERVAL_MS);
  timer.unref();

  return {
    reconcile,
    boundFeedIds: () => registry.boundFeedIds(),
    async shutdown() {
      clearInterval(timer);
      if (reconciling) await reconciling.catch(() => undefined);
      return drainAndShutdown(supervisorDeps);
    },
  };
}
