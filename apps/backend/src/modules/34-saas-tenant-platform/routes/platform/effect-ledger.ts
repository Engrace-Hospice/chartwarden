// Which lifecycle effects `applyTransition` actually runs. The §2.5 machine names more effects than this service has
// runners for (welcome email, M4 requestDestruction, export offer, ...); the status-event ledger must not claim those
// ran. `queue_job` and `outbox` count as run by kind: their individual jobs/events are filtered inside the runner.
const RUN_BY_APPLY_TRANSITION: ReadonlySet<string> = new Set([
  "status_event",
  "set_timestamp",
  "set_retention_window",
  "outbox",
  "alert",
  "session_cascade",
  "queue_job",
]);

export function partitionEffects(effects: readonly { readonly kind: string }[]): {
  readonly ran: readonly string[];
  readonly notRun: readonly string[];
} {
  const kinds = effects.map((e) => e.kind);
  return {
    ran: kinds.filter((k) => RUN_BY_APPLY_TRANSITION.has(k)),
    notRun: kinds.filter((k) => !RUN_BY_APPLY_TRANSITION.has(k)),
  };
}
