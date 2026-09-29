-- F-185 (#248) — the m30 `no-consumer-surface` group's `m37.restraint.applied` binding. M30's own
-- `createIncidentDraft` port only needed the enum widened (the actor-identity half of its blocker was
-- already fixed application-side via the `M30_SYSTEM_MEMBERSHIP_ID` sentinel — no DB-level FK exists on
-- `incident_report.reported_by_membership_id`, so that half needs no migration). Additive-enum ALTER TYPE,
-- mirroring 0258's `order_discontinuation_reason` shape exactly.
ALTER TYPE "public"."m30_incident_kind" ADD VALUE IF NOT EXISTS 'restraint_use';
