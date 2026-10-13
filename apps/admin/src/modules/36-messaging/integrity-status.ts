// apps/admin/src/modules/36-messaging — integrity-job status, derived from audit rows `m36.*`.
// Source: GET /api/v1/audit/events?eventType=<exact type> (permission `audit.read`, the same typed client). Rows
// emitted by the M36 integrity jobs: `m36.hash_verify.run` (one summary per run), `m36.integrity.hash_mismatch` and
// `m36.integrity.systemic_decrypt_failure` (critical findings). The adapter is the only thing that touches the client,
// so the tile logic below stays pure. GAP (reported): the route is tenant-scoped; whether org-less platform rows are
// visible to a platform_ops session is unverified, and no dedicated M36 integrity-status route exists.
import type { ApiClient } from "@wardenx/ui";
import { type ReadResult, toReadResult } from "./ui";

export const RUN_EVENT = "m36.hash_verify.run";
export const FINDING_EVENTS = [
  "m36.integrity.hash_mismatch",
  "m36.integrity.systemic_decrypt_failure",
] as const;

export interface IntegrityEvent {
  readonly eventType: string;
  readonly createdAt: string;
  readonly outcome: "success" | "failure" | "denied";
}

/** Latest row per event type (null when none), or a no-access / error result. */
export type IntegritySource = () => Promise<
  ReadResult<Readonly<Record<string, IntegrityEvent | null>>>
>;

export function auditIntegritySource(client: ApiClient): IntegritySource {
  return async () => {
    const types = [RUN_EVENT, ...FINDING_EVENTS];
    const results = await Promise.all(
      types.map(async (eventType) => {
        const { data, error, response } = await client.GET("/api/v1/audit/events", {
          params: { query: { eventType, limit: 1 } },
        });
        return toReadResult(response.status, data?.items[0] ?? null, Boolean(error));
      }),
    );
    const forbidden = results.some((r) => r.kind === "forbidden");
    if (forbidden) return { kind: "forbidden" };
    const entries: [string, IntegrityEvent | null][] = [];
    for (const [i, r] of results.entries()) {
      if (r.kind !== "ok") return { kind: "error" };
      entries.push([types[i] as string, r.data]);
    }
    return { kind: "ok", data: Object.fromEntries(entries) };
  };
}

export type IntegrityHealth = "healthy" | "attention" | "no-runs";

export interface IntegritySummary {
  readonly health: IntegrityHealth;
  readonly lastRunAt: string | null;
  readonly findings: readonly IntegrityEvent[];
}

/** Attention when the last run failed or a finding is at/after the last run; no-runs when no summary row exists. */
export function summariseIntegrity(
  latest: Readonly<Record<string, IntegrityEvent | null>>,
): IntegritySummary {
  const run = latest[RUN_EVENT] ?? null;
  const findings = FINDING_EVENTS.flatMap((t) => (latest[t] ? [latest[t] as IntegrityEvent] : []));
  if (!run) {
    return { health: findings.length > 0 ? "attention" : "no-runs", lastRunAt: null, findings };
  }
  const unresolved = findings.filter((f) => Date.parse(f.createdAt) >= Date.parse(run.createdAt));
  const health = run.outcome !== "success" || unresolved.length > 0 ? "attention" : "healthy";
  return { health, lastRunAt: run.createdAt, findings: unresolved };
}
