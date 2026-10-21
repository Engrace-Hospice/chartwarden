// apps/web/src/modules/33-reporting — shared status presentation for the M33 Reporting & Analytics
// surfaces (R2). Every M33 screen renders the same StatusPill for a given status by resolving it
// through these tone maps, so the §6.6 badge taxonomy is applied once. Mirrors the M34 saas-status.ts
// precedent: one `Record<string, StatusTone>` per wire enum, plus label helpers and resolvers-with-default.
//
// Lantern maps the design vocabulary onto the six-tone StatusTone alphabet (status-pill.tsx):
// progress(primary)≈"in flight", success≈green "good/published", warning≈amber "needs attention/stale",
// error≈red "failed/irreversible underway", neutral≈gray "inert", critical≈the §10 gold reserved for
// controlled/irreversible acts. Reporting is a read surface (D6 aggregate-only); it has no §10-gold
// state of its own — the gold is reserved for the owner-module drilldown ceremonies, never a tile.
//
// FRESHNESS is the §5.1.2 anchor of this module (the "Data as of HH:MM" badge every tile/MV renders):
// the data-freshness tier palette is green ≤5m · amber ≤10m · red >10m or refresh failed. The six-tone
// vocabulary has no separate "amber" — `warning` (the clock glyph) IS amber, which is exactly correct.
import type { StatusTone } from "@chartwarden/ui";

// ── freshness tiers (§5.1.2 — the data-freshness badge on every tile/MV) ──────────────────────────────

/** The green/amber/red freshness thresholds in minutes (§5.1.2). green ≤5m · amber ≤10m · red >10m. */
export const FRESHNESS_GREEN_MAX_MIN = 5;
export const FRESHNESS_AMBER_MAX_MIN = 10;

/**
 * Tile / MV / replica freshness → §6.6 tone. A failed refresh is always `error` (red) regardless of age;
 * an absent timestamp is `neutral` (nothing computed yet). green ≤5m success · amber ≤10m warning · red
 * >10m error. Accepts either an ISO timestamp or a precomputed age-in-seconds (the tile freshness route
 * returns `data_freshness_seconds`, the MV/lag routes return a `lastRefreshedAt`/`sampledAt` timestamp).
 */
export function freshnessTone(refreshedAt: string | null, state?: string): StatusTone {
  if (state === "failed") return "error";
  if (!refreshedAt) return "neutral";
  const ageMin = (Date.now() - new Date(refreshedAt).getTime()) / 60_000;
  if (ageMin <= FRESHNESS_GREEN_MAX_MIN) return "success"; // green — fresh
  if (ageMin <= FRESHNESS_AMBER_MAX_MIN) return "warning"; // amber — degraded
  return "error"; // red — stale
}

/** The same green/amber/red tier from a freshness already expressed in SECONDS (the tile route shape). */
export function freshnessSecondsTone(seconds: number, breakerOpen?: boolean): StatusTone {
  if (breakerOpen) return "error"; // D14 breaker open — reading a stale snapshot
  const ageMin = seconds / 60;
  if (ageMin <= FRESHNESS_GREEN_MAX_MIN) return "success";
  if (ageMin <= FRESHNESS_AMBER_MAX_MIN) return "warning";
  return "error";
}

/** "Data as of HH:MM" — the human freshness label paired with the freshness pill. */
export function freshnessLabel(refreshedAt: string | null, state?: string): string {
  if (state === "failed") return "Refresh failed";
  if (!refreshedAt) return "—";
  const ageMin = Math.round((Date.now() - new Date(refreshedAt).getTime()) / 60_000);
  return ageMin <= 0 ? "Just now" : `${ageMin}m ago`;
}

/** The compact "Data as of HH:MM" stamp (local wall-clock) for the freshness badge subtitle. */
export function asOfLabel(refreshedAt: string | null): string {
  if (!refreshedAt) return "—";
  return `Data as of ${new Date(refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** Freshness tone from a `data_freshness_seconds` integer (tile route) → label. */
export function freshnessSecondsLabel(seconds: number, breakerOpen?: boolean): string {
  if (breakerOpen) return "Stale (replica lag)";
  const ageMin = Math.round(seconds / 60);
  return ageMin <= 0 ? "Just now" : `${ageMin}m ago`;
}

// ── replica-lag posture (§4.8 / D14 — the admin page-level freshness anchor) ──────────────────────────

/** Replica-lag tier → tone: fresh ≤5m success · degraded ≤10m warning · stale >10m (or breaker) error. */
export function lagTone(lagSeconds: number, breakerOpen?: boolean): StatusTone {
  if (breakerOpen) return "error";
  return freshnessSecondsTone(lagSeconds);
}

/** Human label for the replica-lag tier (the gauge caption). */
export function lagLabel(lagSeconds: number, breakerOpen?: boolean): string {
  if (breakerOpen) return "Stale — breaker open";
  const ageMin = lagSeconds / 60;
  if (ageMin <= FRESHNESS_GREEN_MAX_MIN) return "Fresh";
  if (ageMin <= FRESHNESS_AMBER_MAX_MIN) return "Degraded";
  return "Stale";
}

// ── enum tone maps (one per M33 wire enum) ────────────────────────────────────────────────────────────

/** §2.3 scheduled-run lifecycle → tone (queued/running/rendering are in-flight; failed needs attention). */
export const RUN_STATUS_TONE: Record<string, StatusTone> = {
  queued: "progress",
  running: "progress",
  rendered_pending: "progress",
  rendered_complete: "progress",
  delivered: "success",
  failed: "error",
};

/** §2.3 schedule status → tone (active delivering = success; paused = inert; cancelled = terminal). */
export const SCHEDULE_STATUS_TONE: Record<string, StatusTone> = {
  active: "success",
  paused: "neutral",
  cancelled: "neutral",
};

/** §3.3 materialized-view status → tone (active = good; suspended = needs attention; retired = inert). */
export const MV_STATUS_TONE: Record<string, StatusTone> = {
  registered: "neutral",
  active: "success",
  suspended: "warning",
  retired: "neutral",
};

/** §2.3 report-definition status → tone (published = good; draft/superseded/archived = inert). */
export const DEFINITION_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "neutral",
  superseded: "neutral",
};

/** §3.3 saved-view status → tone. */
export const VIEW_STATUS_TONE: Record<string, StatusTone> = {
  active: "success",
  archived: "neutral",
};

/** §3.3 report-base / metric catalog status → tone. */
export const CATALOG_STATUS_TONE: Record<string, StatusTone> = {
  seeded: "neutral",
  active: "success",
  deprecated: "warning",
  retired: "neutral",
};

// ── label helpers (mirror saas-status.ts) ─────────────────────────────────────────────────────────────

/** Title-case an underscore enum value, e.g. `rendered_complete` → `Rendered Complete`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Title-case helper alias (mirror M34 `cap`). */
export const cap = (s: string): string => statusLabel(s);

/** Resolve a scheduled-run status to its tone, defaulting to neutral for unknown values. */
export function runTone(status: string): StatusTone {
  return RUN_STATUS_TONE[status] ?? "neutral";
}

/** Resolve a schedule status to its tone, defaulting to neutral. */
export function scheduleTone(status: string): StatusTone {
  return SCHEDULE_STATUS_TONE[status] ?? "neutral";
}

/** Resolve an MV status to its tone; a non-zero refresh-failure count escalates to `error`. */
export function mvTone(status: string, refreshFailureCount = 0): StatusTone {
  if (refreshFailureCount > 0) return "error";
  return MV_STATUS_TONE[status] ?? "neutral";
}

/** Resolve a report-definition status to its tone, defaulting to neutral. */
export function definitionTone(status: string): StatusTone {
  return DEFINITION_STATUS_TONE[status] ?? "neutral";
}
