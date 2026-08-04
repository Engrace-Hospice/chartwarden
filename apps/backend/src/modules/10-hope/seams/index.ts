// apps/backend/src/modules/10-hope/seams — M10's published §2 / D10 owned seams (M10-T05). M10 publishes
// THREE leaf-typed read-only DTO surfaces downstream modules consume instead of importing M10's schema
// (architecture §11 blocks the schema import): HopeTimepointProvider (M14 open HOPE windows on the IDG
// packet, M22 per-admission timeline PDF, M30 on-time rate, M32 decline-prediction), HopeJ2051Provider
// (M30 Timely-Follow-Up, M32 symptom-trajectory) and HopeSubmissionProvider (M30 acceptance posture /
// HQRP counter, M33 submission dashboards). `registerHopeSeams` registers all three real impls over their
// boot deny-stubs (before validateSeams()), driven from the composition root's wireModuleSeams(). All
// three share ONE injected HopeSeamStore (in-memory slice here; Drizzle in prod, reads under the
// consumer's RLS) — mirrors the M9 seams/index.ts precedent.
import type { DbClient } from "@wardenx/db";
import type {
  HopeJ2051Provider,
  HopeOrgRollupProvider,
  HopeSubmissionProvider,
  HopeTimepointProvider,
  LatestAssessmentProvider,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createDrizzleHopeSeamStore } from "./drizzle-store";
import { createHopeOrgRollupProvider } from "./org-rollup-provider";
import {
  type HopeOrgRollupStore,
  createDrizzleHopeOrgRollupStore,
  createInMemoryHopeOrgRollupStore,
} from "./org-rollup-store";
import {
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
} from "./providers";
import { type HopeSeamStore, createInMemoryHopeSeamStore } from "./store";
export { createDrizzleHopeSeamStore } from "./drizzle-store";

export {
  type HopeSeamSeed,
  type HopeSeamStore,
  createInMemoryHopeSeamStore,
} from "./store";
export {
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
} from "./providers";
export { createHopeOrgRollupProvider } from "./org-rollup-provider";
export {
  type HopeOrgRollupSeed,
  type HopeOrgRollupStore,
  type J2051SeverityEntry,
  type J2051TriggerRow,
  type SfvTimelinessRow,
  type SubmissionPostureRow,
  type TimepointCompletionRow,
  createDrizzleHopeOrgRollupStore,
  createInMemoryHopeOrgRollupStore,
} from "./org-rollup-store";

/** Deps for M10's owned-seam registration (slice defaults to the in-memory store). */
export interface HopeSeamDeps {
  /** The §2 / D10 data port (Drizzle over M10's tables in prod; in-memory slice in tests). */
  store?: HopeSeamStore;
  /** The pooled Drizzle client (#107). When present, the ORG-LEVEL `HopeOrgRollupProvider` is registered
   * over a Drizzle aggregate reader; absent, the org-rollup seam stays unregistered (boot deny-stub). */
  db?: DbClient;
  /** Explicit org-rollup aggregate reader (an in-memory double in tests). Takes precedence over {@link db};
   * when neither is supplied the org-rollup seam falls through to the fail-closed boot deny-stub. */
  orgRollupStore?: HopeOrgRollupStore;
}

/**
 * Register M10's §2 / D10 owned seams into the M1 registry over their boot deny-stubs (M10-T05; before
 * validateSeams()). The three PER-ENTITY readers share one {@link HopeSeamStore}. The ORG-LEVEL
 * {@link HopeOrgRollupProvider} (#107) is registered over its DEDICATED Drizzle aggregate reader when a db /
 * store is present (M30's measure-recompute consumes it); without one it stays on the fail-closed deny-stub.
 * Called by the composition root's wireModuleSeams().
 */
export function registerHopeSeams(deps: HopeSeamDeps = {}): void {
  // TASK-002 (ARCH-003): a db-present boot defaults the per-entity store to the Drizzle reader —
  // the in-memory slice stands only when there is genuinely no database behind the process.
  const store =
    deps.store ??
    (deps.db ? createDrizzleHopeSeamStore(deps.db) : createInMemoryHopeSeamStore().store);
  registerSeam("HopeTimepointProvider", createHopeTimepointProvider(store));
  registerSeam("HopeJ2051Provider", createHopeJ2051Provider(store));
  registerSeam("HopeSubmissionProvider", createHopeSubmissionProvider(store));

  const orgRollupStore =
    deps.orgRollupStore ?? (deps.db ? createDrizzleHopeOrgRollupStore(deps.db) : undefined);
  if (orgRollupStore) {
    registerSeam("HopeOrgRollupProvider", createHopeOrgRollupProvider(orgRollupStore));
  }
}

/** Typed resolver for M10's ORG-LEVEL HopeOrgRollupProvider (registered when a db/store is present). */
export function getHopeOrgRollupProvider(): HopeOrgRollupProvider {
  return getSeam("HopeOrgRollupProvider");
}

/** Typed resolver for M10's HopeTimepointProvider (sound: registered real impl; validateSeams guards it). */
export function getHopeTimepointProvider(): HopeTimepointProvider {
  return getSeam("HopeTimepointProvider");
}

/** Typed resolver for M10's HopeJ2051Provider. */
export function getHopeJ2051Provider(): HopeJ2051Provider {
  return getSeam("HopeJ2051Provider");
}

/** Typed resolver for M10's HopeSubmissionProvider. */
export function getHopeSubmissionProvider(): HopeSubmissionProvider {
  return getSeam("HopeSubmissionProvider");
}

/**
 * M10-T06 — CONSUME M9's `LatestAssessmentProvider` seam (registered by M9-T04; deps edge 10→9 already in
 * the manifest). The HOPE recording service injects this resolver to snapshot PPS / ESAS-r at sign (D8 /
 * §7.2). It is the read-only seam M10 consumes — never a direct cross-module schema import (§11). The boot
 * path passes the resolved provider into `createInMemoryHopeBackend({ latestAssessments })`; absent (M9
 * down) the snapshot is skipped and a warning is recorded (§7.13 / DR Tier-2).
 */
export function getLatestAssessmentProviderForHope(): LatestAssessmentProvider {
  return getSeam("LatestAssessmentProvider");
}
