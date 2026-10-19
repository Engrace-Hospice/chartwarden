// apps/backend/src/bootstrap/ack-queue-metrics.ts - WP 4.9 (ADR-0076): the ops view of the unacknowledged queue, as Prometheus gauges
// and a threshold notice. Pure over its ports (no DB, no Fastify), the same shape as geocode-coverage.ts, so it unit-tests with fakes.
//
//   wardenx_m36_ack_overdue_total                     waiting requests past their deadline, all organisations (-1 = not measured)
//   wardenx_m36_ack_failed_unreachable_total          requests no route could reach, all organisations (-1 = not measured)
//   wardenx_m36_ack_oldest_overdue_seconds            the longest-overdue waiting request, any organisation (-1 = not measured)
//   wardenx_m36_ack_latency_seconds{stat="mean|max"}  acknowledgment latency (acknowledged_at - requested_at) over the trailing 24 h
//   wardenx_m36_ack_latency_samples                   how many acknowledgments those two figures cover
//
// Labels are a fixed two-value `stat`; there is NO organisation, user, request or patient label (cardinality and privacy). An
// organisation that could not be counted makes the whole reading UNMEASURED (-1), never zero: a gap that cannot be measured must not
// look closed. Percentiles are not offered because they cannot be merged across organisations; mean and max can (ceiling in ADR-0076).
import { Gauge, type Registry } from "prom-client";

export interface AckQueueOrgStats {
  readonly overdue: number;
  readonly failedUnreachable: number;
  readonly oldestOverdueSeconds: number;
  readonly ackedCount: number;
  readonly ackLatencySumSeconds: number;
  readonly ackLatencyMaxSeconds: number;
}

export interface AckQueueSample extends AckQueueOrgStats {
  readonly orgsChecked: number;
  readonly orgsFailed: number;
}

export interface AckQueuePorts {
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly statsForOrg: (organizationId: string) => Promise<AckQueueOrgStats>;
}

export type AckQueueSampler = () => Promise<AckQueueSample | null>;

/** Organisations read in parallel at a time. */
export const ORG_CHUNK = 4;
/** A scrape never waits longer than this for the whole sample; on timeout every gauge reads -1. */
export const SAMPLE_TIMEOUT_MS = 8_000;

/** Combine per-organisation figures: counts and sums add, maxima take the maximum. `null` when the org list cannot be read. */
export async function sampleAckQueue(ports: AckQueuePorts): Promise<AckQueueSample | null> {
  let orgs: readonly { readonly organizationId: string }[];
  try {
    orgs = await ports.listOrgs();
  } catch {
    return null;
  }
  // A small bounded fan-out: one slow or hung organisation must not open a connection per organisation at once.
  const results: (AckQueueOrgStats | null)[] = [];
  for (let i = 0; i < orgs.length; i += ORG_CHUNK) {
    const chunk = orgs.slice(i, i + ORG_CHUNK);
    results.push(
      ...(await Promise.all(
        chunk.map((o) =>
          ports.statsForOrg(o.organizationId).then(
            (s) => s,
            () => null,
          ),
        ),
      )),
    );
  }
  const measured = results.filter((r): r is AckQueueOrgStats => r !== null);
  return {
    orgsChecked: measured.length,
    orgsFailed: results.length - measured.length,
    overdue: measured.reduce((n, r) => n + r.overdue, 0),
    failedUnreachable: measured.reduce((n, r) => n + r.failedUnreachable, 0),
    oldestOverdueSeconds: measured.reduce((n, r) => Math.max(n, r.oldestOverdueSeconds), 0),
    ackedCount: measured.reduce((n, r) => n + r.ackedCount, 0),
    ackLatencySumSeconds: measured.reduce((n, r) => n + r.ackLatencySumSeconds, 0),
    ackLatencyMaxSeconds: measured.reduce((n, r) => Math.max(n, r.ackLatencyMaxSeconds), 0),
  };
}

const UNMEASURED = -1;

/** One read is shared by every gauge and by scrapes closer together than this (each read enumerates the active organisations). */
export const SAMPLE_TTL_MS = 30_000;
/** A sample unsettled for this long (three cache lifetimes) is presumed lost; a new one may start. */
export const LOST_SAMPLE_MS = 3 * SAMPLE_TTL_MS;

export function registerAckQueueMetrics(
  registry: Registry,
  sampler: AckQueueSampler,
  now: () => number = Date.now,
): void {
  let cached: { readonly at: number; readonly read: Promise<AckQueueSample | null> } | null = null;
  // The sampler itself (not the timed-out race) is unsettled: never start another, so a hung database cannot pile up connections.
  let runningSince: number | null = null;
  const sample = (): Promise<AckQueueSample | null> => {
    const expired = !cached || now() - cached.at >= SAMPLE_TTL_MS;
    // ...unless it has been unsettled for 3 timeouts: then it is presumed lost and a fresh sample may start.
    const lost = runningSince !== null && now() - runningSince >= LOST_SAMPLE_MS;
    if (cached && (!expired || (runningSince !== null && !lost))) return cached.read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SAMPLE_TIMEOUT_MS);
    });
    const started = now();
    runningSince = started;
    const underlying = sampler()
      .catch(() => null)
      .finally(() => {
        if (runningSince === started) runningSince = null;
      });
    cached = {
      at: now(),
      read: Promise.race([underlying, timeout]).finally(() => clearTimeout(timer)),
    };
    return cached.read;
  };
  const measured = (s: AckQueueSample | null): AckQueueSample | null =>
    s && s.orgsFailed === 0 ? s : null;
  const gauge = (name: string, help: string, read: (s: AckQueueSample) => number): void => {
    new Gauge({
      name,
      help: `${help} (-1 = not measured)`,
      registers: [registry],
      async collect() {
        const s = measured(await sample());
        this.set(s ? read(s) : UNMEASURED);
      },
    });
  };
  gauge(
    "wardenx_m36_ack_overdue_total",
    "M36 acknowledgment requests past their deadline and still waiting for a human, all organisations",
    (s) => s.overdue,
  );
  gauge(
    "wardenx_m36_ack_failed_unreachable_total",
    "M36 acknowledgment requests no delivery route could reach, still open, all organisations",
    (s) => s.failedUnreachable,
  );
  gauge(
    "wardenx_m36_ack_oldest_overdue_seconds",
    "Seconds the longest-overdue waiting M36 acknowledgment request is past its deadline",
    (s) => s.oldestOverdueSeconds,
  );
  gauge(
    "wardenx_m36_ack_latency_samples",
    "M36 acknowledgments in the trailing 24 h that the latency gauges cover",
    (s) => s.ackedCount,
  );
  new Gauge({
    name: "wardenx_m36_ack_latency_seconds",
    help: "M36 acknowledgment latency (acknowledged_at - requested_at) over the trailing 24 h; stat=mean|max (-1 = not measured, 0 with no samples)",
    labelNames: ["stat"],
    registers: [registry],
    async collect() {
      const s = measured(await sample());
      this.set(
        { stat: "mean" },
        s ? (s.ackedCount > 0 ? s.ackLatencySumSeconds / s.ackedCount : 0) : UNMEASURED,
      );
      this.set({ stat: "max" }, s ? s.ackLatencyMaxSeconds : UNMEASURED);
    },
  });
}

// ---- threshold notice (per organisation, evaluated by the minute sweep) ------------------------------------------------------------

/** PROVISIONAL (brief section 11): a request this long past its deadline means the escalation ladder did not close the loop. */
export const OVERDUE_NOTICE_SECONDS = 15 * 60;
/** PROVISIONAL: mean acknowledgment latency over the trailing 24 h that is worth telling ops about, and the least samples to judge by. */
export const LATENCY_NOTICE_MEAN_SECONDS = 15 * 60;
export const LATENCY_NOTICE_MIN_SAMPLES = 5;
/** A breach is repeated at most this often while it lasts; recovery re-arms it. */
export const NOTICE_REPEAT_MS = 60 * 60 * 1000;

export type AckQueueNoticeKind = "overdue_long" | "latency_high";

export interface AckQueueNotice {
  readonly kind: "m36.ack.queue_overdue" | "m36.ack.latency_high";
  readonly summary: string;
  readonly details: Readonly<Record<string, string | number>>;
  readonly correlationId: string;
}

/** Which thresholds this organisation's figures breach right now. Pure. */
export function breachedKinds(stats: AckQueueOrgStats): readonly AckQueueNoticeKind[] {
  const kinds: AckQueueNoticeKind[] = [];
  if (stats.overdue > 0 && stats.oldestOverdueSeconds >= OVERDUE_NOTICE_SECONDS) {
    kinds.push("overdue_long");
  }
  if (
    stats.ackedCount >= LATENCY_NOTICE_MIN_SAMPLES &&
    stats.ackLatencySumSeconds / stats.ackedCount >= LATENCY_NOTICE_MEAN_SECONDS
  ) {
    kinds.push("latency_high");
  }
  return kinds;
}

/**
 * Build the evaluator the sweep calls once per organisation per tick. State is process-local and keyed by (organisation, kind): the first
 * breach notifies, a lasting breach repeats after NOTICE_REPEAT_MS, a recovery clears the key. The notice names the organisation id and
 * counts only; the always-on log line and optional webhook are the existing platform-ops sink's.
 */
export function createAckQueueNoticeEvaluator(deps: {
  readonly statsForOrg: (organizationId: string) => Promise<AckQueueOrgStats>;
  readonly notify: (notice: AckQueueNotice) => void;
  readonly now?: () => number;
}): (organizationId: string) => Promise<void> {
  const lastNotified = new Map<string, number>();
  const clock = deps.now ?? Date.now;
  return async (organizationId) => {
    const stats = await deps.statsForOrg(organizationId);
    const breached = new Set(breachedKinds(stats));
    for (const kind of ["overdue_long", "latency_high"] as const) {
      const key = `${organizationId}:${kind}`;
      if (!breached.has(kind)) {
        lastNotified.delete(key);
        continue;
      }
      const at = clock();
      const previous = lastNotified.get(key);
      if (previous !== undefined && at - previous < NOTICE_REPEAT_MS) continue;
      lastNotified.set(key, at);
      deps.notify(
        kind === "overdue_long"
          ? {
              kind: "m36.ack.queue_overdue",
              summary: `${stats.overdue} acknowledgment request(s) are past their deadline; the longest by ${Math.round(stats.oldestOverdueSeconds / 60)} min`,
              details: {
                organizationId,
                overdue: stats.overdue,
                oldestOverdueSeconds: stats.oldestOverdueSeconds,
              },
              correlationId: key,
            }
          : {
              kind: "m36.ack.latency_high",
              summary: `mean acknowledgment latency is ${Math.round(stats.ackLatencySumSeconds / stats.ackedCount / 60)} min over the last 24 h`,
              details: {
                organizationId,
                samples: stats.ackedCount,
                meanSeconds: Math.round(stats.ackLatencySumSeconds / stats.ackedCount),
                maxSeconds: Math.round(stats.ackLatencyMaxSeconds),
              },
              correlationId: key,
            },
      );
    }
  };
}
