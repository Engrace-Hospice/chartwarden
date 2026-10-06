// apps/backend/src/modules/15-discipline-care-plans/jobs/types.ts — GAP-044 shared job types.

/** The two stored statuses the nightly watcher moves a live gate to. */
export type GateStatusFlip = "expiring_soon" | "expired";
