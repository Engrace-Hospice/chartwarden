// apps/backend/src/modules/17-scheduling/seams — M17's published §4.3 owned seams (M17-T05). M17 publishes FOUR
// leaf-typed READ surfaces forward consumers attach to instead of importing M17's schema (architecture §25.15
// blocks the schema import): `VisitReader` — the visit read path M8 (encounter-authoring context, which CLOSES
// M8's visit-seeding inert consumer M8 D9), M18 (EVV geofence target), M14 (IDG "completed visits since last
// meeting") consume; `VisitAssignmentReader` — the assignment read path M5 (the §4.5 D11 caseload-contribution
// projection `patientCaseloadProvider` reads), M19 (on-call triage roster), M20 (field-safety live-awareness)
// consume; `PortalVisitReader` — the M31 portal upcoming-visit read path (lay-language, scheduler-internal notes
// scrubbed); `VisitMetricsProvider` — the M30/M33 productivity + quality measures read path. `registerScheduling
// Seams` registers all four real impls over their boot deny-stubs (before validateSeams()), driven from the
// composition root's wireModuleSeams(). All four share ONE injected SchedulingSeamStore (in-memory slice here;
// Drizzle in prod, reads under the consumer's RLS) — mirrors the M9/M10/M11/M12/M13/M14 seams/index.ts precedents.
// None is a mutate path: M17 owns the visit lifecycle internally.
import type {
  CredentialReader,
  PortalVisitReader,
  VisitAssignmentReader,
  VisitMetricsProvider,
  VisitReader,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { type CredentialSeamDeps, registerCredentialSeam } from "./credentials";
import {
  createPortalVisitReader,
  createVisitAssignmentReader,
  createVisitMetricsProvider,
  createVisitReader,
} from "./providers";
import { type SchedulingSeamStore, createInMemorySchedulingSeamStore } from "./store";

export {
  type PortalVisitSeedRow,
  type RouteEfficiencySeedRow,
  type SchedulingMetricsCounts,
  type SchedulingRouteEfficiency,
  type SchedulingSeamSeed,
  type SchedulingSeamStore,
  createInMemorySchedulingSeamStore,
} from "./store";
export {
  createPortalVisitReader,
  createVisitAssignmentReader,
  createVisitMetricsProvider,
  createVisitReader,
} from "./providers";
export {
  SchedulingOnCallRosterUnavailableError,
  createDrizzleSchedulingSeamStore,
} from "./drizzle-store";
export {
  type CredentialDiscipline,
  type CredentialRecord,
  type CredentialRecordStatus,
  type CredentialSeamDeps,
  type CredentialStore,
  type GrantCredentialInput,
  createCredentialReader,
  createInMemoryCredentialStore,
  registerCredentialSeam,
} from "./credentials";
export { createDrizzleCredentialStore } from "./credentials-drizzle-store";
export {
  type CreateOnCallRotationInput,
  type OnCallRotationStore,
  type OnCallRotationView,
  createDrizzleOnCallRotationStore,
} from "./oncall-rotation-store";

/** Deps for M17's owned-seam registration (slice defaults to the in-memory store). */
export interface SchedulingSeamDeps {
  /** The §4.3 data port (Drizzle over M17's tables in prod; in-memory slice in tests). */
  store?: SchedulingSeamStore;
  /** The GAP-093 credential data port (Drizzle over `membership_credential` in prod; in-memory in tests). */
  credentials?: CredentialSeamDeps;
}

/**
 * Register M17's five §4.3 owned seams into the M1 registry over their boot deny-stubs (M17-T05/GAP-093;
 * before validateSeams()). The four visit/assignment/portal/metrics reads share one
 * {@link SchedulingSeamStore}; `CredentialReader` (GAP-093) is a separate, independently-mutable store
 * over `membership_credential`. Called by the composition root's wireModuleSeams().
 */
export function registerSchedulingSeams(deps: SchedulingSeamDeps = {}): void {
  const store = deps.store ?? createInMemorySchedulingSeamStore().store;
  registerSeam("VisitReader", createVisitReader(store));
  registerSeam("VisitAssignmentReader", createVisitAssignmentReader(store));
  registerSeam("PortalVisitReader", createPortalVisitReader(store));
  registerSeam("VisitMetricsProvider", createVisitMetricsProvider(store));
  registerCredentialSeam(deps.credentials);
}

/** Typed resolver for M17's VisitReader (M8 encounter context + M18 EVV geofence + M14 IDG consume the read seam). */
export function getVisitReader(): VisitReader {
  return getSeam("VisitReader");
}

/** Typed resolver for M17's VisitAssignmentReader (M5 caseload + M19 on-call + M20 field-safety consume the seam). */
export function getVisitAssignmentReader(): VisitAssignmentReader {
  return getSeam("VisitAssignmentReader");
}

/** Typed resolver for M17's PortalVisitReader (M31 portal upcoming-visits view consumes the read seam). */
export function getPortalVisitReader(): PortalVisitReader {
  return getSeam("PortalVisitReader");
}

/** Typed resolver for M17's VisitMetricsProvider (M30/M33 productivity + quality dashboards consume the seam). */
export function getVisitMetricsProvider(): VisitMetricsProvider {
  return getSeam("VisitMetricsProvider");
}

/** Typed resolver for M17's CredentialReader (GAP-093; the D8 gate + future M23/M31 consumers). */
export function getCredentialReader(): CredentialReader {
  return getSeam("CredentialReader");
}
