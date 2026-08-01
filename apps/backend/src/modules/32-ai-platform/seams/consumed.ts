// apps/backend/src/modules/32-ai-platform/seams/consumed.ts — the seams M32 CONSUMES (§4.3, M32-T06).
//
// Architecture §25.15: M32 never imports M9's, M10's, M16's, M20's, M36's or M38's Drizzle schema.
// Every upstream fact the routing decisions, PHI-minimisation gate, feature snapshots and alert fan-out
// need is resolved through the M1 boot-registered seam registry.
//
// Resolving through `getSeam` is why M32's manifest `dependsOn` carries M1 (the registry lives in
// `apps/backend/src/bootstrap`, which is M1 code) — which it already does. M2/M3/M4 are already edges.
// M9 / M10 / M16 / M20 need NO new edge: their contracts are leaf `@wardenx/types` types (ADR-0005
// D1/D2) and the binding is runtime. M36 / M38 need no edge either, for a different reason — their
// seams are OPAQUE (`SeamContracts[...] = unknown`), so M32 resolves each to its OWN minimal consumer
// view declared below rather than importing `@wardenx/messaging` / `@wardenx/terminology`. That is the
// M27/M30 precedent, and it is what keeps §13's proposed `dependsOn = [1,2,3,4,36,38]` patch
// unnecessary: the edges that patch wanted to "surface" are runtime seam resolutions, not imports.
//
// ── FOUR OF §4.3's TWELVE ROWS ARE NOT ACCESSORS HERE, AND EACH FOR A STATED REASON ──────────────
//
//   • `PermissionEvaluator` (M3) — §4.7's ABAC predicates are registered INTO M3's named-predicate
//     registry, not resolved out of it. M3's `requireAbac` factory does the evaluating; a consumer-side
//     "evaluator" accessor would be a second authorization path. That registration is M32-T07's.
//   • `AuditEventEmitter` / `DestructionCertCallback` (M4) — M4 is consumed through its own module API
//     (`audit()`, `registerEraser`), which is how every module on the platform reaches it. M32-T02
//     already registered the two §3.7 erasers that way.
//   • `OutboxPublisher` (M1) — §4.11's events publish through M1's transactional outbox helper, an M1
//     API rather than a registry seam. M32-T07 wires it.
//
// ── AND ONE SEAM §4.3 NAMES DOES NOT EXIST ON THE PLATFORM ───────────────────────────────────────
//
//   • `IdentityResolver` / `OrgContextResolver` (M2) — M2 publishes `SessionContextResolver` and
//     `AuditorSessionMinter`, and nothing named either of §4.3's two. The actual need — "resolve
//     `actorUserId` for opt-out checks" and "resolve the org's BAA/ZDR contract metadata" — is met by
//     `SessionContextResolver` for the first (the ambient request context already carries the actor)
//     and by NOTHING for the second: no seam on the platform reports a tenant's Anthropic BAA/ZDR
//     posture. M32-T04's `AnthropicZdrContractResolver` is a constructor port for exactly that gap and
//     is deliberately left UNBOUND — the adapter refuses to construct without one (D19), so an unbound
//     ZDR resolver is a backend that cannot dispatch rather than one that dispatches unprotected. No
//     accessor is invented here for a seam nobody publishes.
import type {
  BereavementRiskFactorsProvider,
  HopeJ2051Provider,
  SafetyIncidentReader,
  ScaleSeriesProvider,
  SessionContextResolver,
} from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/**
 * M32 CONSUMES M2's `SessionContextResolver` — §4.3's "resolve `actorUserId` for opt-out checks", under
 * the name M2 actually published (see the header).
 */
export function getSessionContextResolver(): SessionContextResolver {
  return getSeam("SessionContextResolver");
}

/**
 * M32 CONSUMES M9's §4.7 `ScaleSeriesProvider` — the windowed symptom trajectories §4.3 feeds into the
 * `hospitalization_risk_30d` feature snapshot.
 *
 * OPTIONAL, per §4.4's `reg.optional(...)`. M32 must boot whether or not the assessment module is
 * mounted, so callers get `null` rather than a throw when the seam is unregistered — see
 * {@link optionalSeam}.
 */
export function getScaleSeriesProvider(): ScaleSeriesProvider | null {
  return optionalSeam<ScaleSeriesProvider>("ScaleSeriesProvider");
}

/** M32 CONSUMES M10's `HopeJ2051Provider` — symptom-impact history for the same feature snapshot. Optional. */
export function getHopeJ2051Provider(): HopeJ2051Provider | null {
  return optionalSeam<HopeJ2051Provider>("HopeJ2051Provider");
}

/**
 * M32 CONSUMES M16's `BereavementRiskFactorsProvider` — the D3/D17 factor snapshot the
 * `bereavement_risk_narrative` capability narrates from. Optional.
 *
 * NOTE THE DIRECTION. §4.2.4's seam already takes `riskFactors` as an INPUT from M16, so this accessor
 * is not how the narrative gets its facts on the hot path — M16 supplies them, per D5 ("caller-supplied
 * chart context"). It exists for the evaluation-run path (§3.2.11), where M32 assembles its own golden
 * set and has no consumer to hand it one.
 */
export function getBereavementRiskFactorsProvider(): BereavementRiskFactorsProvider | null {
  return optionalSeam<BereavementRiskFactorsProvider>("BereavementRiskFactorsProvider");
}

/**
 * M32 CONSUMES M20's §4.3 `SafetyIncidentReader` — the §8.6 minimum-necessary incident corpus the R26
 * evaluation runs read. Optional.
 *
 * M20 already rounds the geography to ~110 m and strips identity on its side; M32 never asks for and
 * never receives a raw coordinate.
 */
export function getSafetyIncidentReader(): SafetyIncidentReader | null {
  return optionalSeam<SafetyIncidentReader>("SafetyIncidentReader");
}

// ── M36 / M38 — opaque rich-seams, resolved to M32's own minimal consumer views ───────────────────

/**
 * §4.3's `MessagingAlertBus`, as M32 needs it. M36 publishes `AlertEmitter` as an OPAQUE seam (its rich
 * interface lives in `@wardenx/messaging`, which M32 may not import), so this is the narrow view M32
 * casts to — the M27/M30 consumer-view precedent.
 *
 * §4.9's typed alert payloads are M32-T07's; this is the port they will publish through.
 */
export interface AiAlertBusView {
  emit(input: {
    readonly organizationId: string | null;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

/** Resolve M36's alert bus as M32's view. `null` when M36 is not mounted — §4.9's alerts are then
 *  UNSENT, which is a degradation M32 must be able to see rather than a crash it cannot. */
export function getAiAlertBus(): AiAlertBusView | null {
  return optionalSeam<AiAlertBusView>("AlertEmitter");
}

/**
 * §4.3's `TerminologyProvider`, as M32 needs it: "validate ICD-10 / SNOMED tokens in capability inputs
 * where applicable". M38's rich interface lives in `@wardenx/terminology`; this is M32's minimal view.
 */
export interface AiTerminologyView {
  validateCode(input: {
    readonly system: string;
    readonly code: string;
  }): Promise<{ readonly valid: boolean }>;
}

/** Resolve M38's terminology provider as M32's view. `null` when M38 is not mounted. */
export function getAiTerminologyProvider(): AiTerminologyView | null {
  return optionalSeam<AiTerminologyView>("TerminologyProvider");
}

/**
 * §4.4's `reg.optional(...)`, over M1's `getSeam` (which throws when a name was never registered).
 *
 * IT CATCHES THE LOOKUP, NOT THE CALL. A seam that resolved and then threw on use is a live upstream
 * failing, and swallowing that would turn a real outage into a silent "M9 has no scale series". Only
 * the RESOLUTION is optional here; every call site handles its own errors.
 *
 * `validateSeams()` applies a deny-stub to every REQUIRED_SEAMS entry, so in a real boot these resolve
 * to a stub rather than to `null`. The `null` arm is what a slice host or a worker that never ran
 * `validateSeams()` gets, and it is the arm that keeps M32 bootable outside the full server.
 */
function optionalSeam<T>(name: Parameters<typeof getSeam>[0]): T | null {
  try {
    return getSeam(name) as unknown as T;
  } catch {
    return null;
  }
}
