// @wardenx/ui — view-layer types mirroring M1's system-status / feature-flag wire
// contracts (apps/backend .../routes/system.ts, spec §4.1–4.2). They are intentionally
// re-declared here, not imported, because packages/ui is a LEAF (.dependency-cruiser
// `leaves-stay-leaves`): it may not import apps/* or feature packages. The UI consumes
// the HTTP response shape, so it owns its own copy of that shape.

export type SystemStatusLevel = "operational" | "degraded" | "outage";

/** One row of `GET /api/v1/system/status` → `{ components: SystemStatusComponent[] }`. */
export interface SystemStatusComponent {
  id: string;
  status: SystemStatusLevel;
  headline: string | null;
  details: string | null;
  updatedAt: string;
}

/** Resolved flags for the current org: `GET /api/v1/system/feature-flags` → `{ flags }`. */
export type FeatureFlags = Record<string, boolean>;
