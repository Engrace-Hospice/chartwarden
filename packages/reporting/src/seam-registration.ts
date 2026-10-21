// @chartwarden/reporting — boot-time published-seam registration (M33 §4.3).
//
// Mirrors M34's seam-registration shape, adapted to M33's M1-bootstrap-registry posture (the M22-style
// path: the published-seam contracts are registered into the M1 SeamRegistry, the consumed seams are
// resolved through it). M33 takes NO `apps/backend` edge, so the registry's `registerSeam` / `getSeam`
// are injected as PORTS — the composition root binds them to the real M1 registry at boot (P2C). This
// file is the single wiring site; it does NOT touch the apps/backend boot graph itself (that lands in P2C).
//
// `registerReportingPublishedSeams` registers the three M33 seams (MetricsProvider /
// DashboardCatalogProvider / ScheduledReportProvider) into the M1 registry. The real Drizzle-backed
// providers are supplied by the caller once the §3 repositories land (later M33 phase).
// GAP-208: the former CONSUME half (`bindReportingConsumedSeams` + the forward-seam deny-stub bundle) was
// never called by the composition root and was removed; M33's consumed seams resolve through `getSeam`
// at their use sites.
import type {
  DashboardCatalogProvider,
  MetricsProvider,
  ScheduledReportProvider,
} from "./seams/published";

// ── injected ports (the composition root binds these to the real M1 SeamRegistry at boot, P2C) ───────

/** The M1 SeamRegistry `registerSeam` surface, injected as a port so the package takes no apps/backend edge. */
export interface ReportingSeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

// ── 1. PUBLISH — the three seams M33 registers into the M1 SeamRegistry (§4.3) ───────────────────────

/** The canonical M1-registry seam names M33 publishes (the keys added to the SeamName union in P2C). */
export const REPORTING_PUBLISHED_SEAM_NAMES = [
  "MetricsProvider",
  "DashboardCatalogProvider",
  "ScheduledReportProvider",
] as const;

/** The live published-seam implementations the caller supplies once the §3 repositories land. */
export interface ReportingPublishedSeams {
  readonly metricsProvider: MetricsProvider;
  readonly dashboardCatalogProvider: DashboardCatalogProvider;
  readonly scheduledReportProvider: ScheduledReportProvider;
}

/**
 * Register M33's three published seams into the M1 SeamRegistry through the injected registrar (P2C).
 * Boot-hook stub today: the composition root calls this with the real providers once they are built;
 * `validateSeams()` (the M1 boot gate) then applies fail-closed deny-stubs for any not yet registered (D13).
 */
export function registerReportingPublishedSeams(
  registrar: ReportingSeamRegistrar,
  seams: ReportingPublishedSeams,
): void {
  registrar.registerSeam("MetricsProvider", seams.metricsProvider);
  registrar.registerSeam("DashboardCatalogProvider", seams.dashboardCatalogProvider);
  registrar.registerSeam("ScheduledReportProvider", seams.scheduledReportProvider);
}
