// apps/backend/src/modules/31-portal/seams/registration.ts — M31-T06 boot-time seam registration + the
// §4.4 consumed-seam contract (validateSeams). Mirrors M27's `seam-registration.ts`: the SEVEN published-seam
// contracts (§4.3) register into the M1 SeamRegistry; the consumed seams (§4.4) resolve through it. M31 takes
// NO extra `apps/backend` edge here — the registry `registerSeam`/`getSeam` surfaces are injected as PORTS and
// the composition root binds them to the real M1 registry at boot (T07). This file is the single wiring
// declaration; it does not touch the apps/backend boot graph (that is T07, the M27-T05→T06 split precedent).
//
// Two halves:
//   1. PUBLISH — `registerM31PublishedSeams` registers M31's seven seams (§4.3). The live Drizzle-backed
//      providers come from `createM31PublishedSeamImpls(stores)` once T07 binds the stores.
//   2. CONSUME — `M31_REQUIRED_SEAMS`, the §4.4 consumed-seam names. All producers (M2/M5/M6/M7/M8/M9/M10/
//      M11/M12/M13/M15/M16/M17/M21/M22/M36/M38/M39/M40) are LIVE (M31 is a late-wave module). `getSeam` reads
//      through the M1 registry; check-fitness-gaps scans this `*_REQUIRED_SEAMS = [...]` literal so any name
//      consumed via `getSeam` is registered.
import type {
  PortalAccessGrantReader,
  PortalAccountReader,
  PortalDisclosureAccountingProvider,
  PortalEngagementProvider,
  PortalSessionMinter,
  TelehealthMetricsProvider,
  TelehealthVisitReader,
} from "@wardenx/types";
import {
  createPortalAccessGrantReader,
  createPortalAccountReader,
  createPortalDisclosureAccountingProvider,
  createPortalEngagementProvider,
  createPortalSessionMinter,
  createTelehealthMetricsProvider,
  createTelehealthVisitReader,
} from "./readers";
import type { M31SeamStores } from "./stores";

/** The M1 SeamRegistry `registerSeam` surface, injected as a port (no apps/backend edge). */
export interface M31SeamRegistrar {
  registerSeam(name: string, impl: unknown): void;
}

/** The seven live published-seam implementations (the composition root supplies the backing stores at T07). */
export interface M31PublishedSeamImpls {
  portalAccountReader: PortalAccountReader;
  portalAccessGrantReader: PortalAccessGrantReader;
  portalEngagementProvider: PortalEngagementProvider;
  telehealthMetricsProvider: TelehealthMetricsProvider;
  telehealthVisitReader: TelehealthVisitReader;
  portalSessionMinter: PortalSessionMinter;
  portalDisclosureAccountingProvider: PortalDisclosureAccountingProvider;
}

/** Build the seven published-seam impls over the injected {@link M31SeamStores} (Drizzle at boot; slice in tests). */
export function createM31PublishedSeamImpls(stores: M31SeamStores): M31PublishedSeamImpls {
  return {
    portalAccountReader: createPortalAccountReader(stores.accounts),
    portalAccessGrantReader: createPortalAccessGrantReader(stores.grants),
    portalEngagementProvider: createPortalEngagementProvider(stores.engagement),
    telehealthMetricsProvider: createTelehealthMetricsProvider(stores.telehealth),
    telehealthVisitReader: createTelehealthVisitReader(stores.telehealth),
    portalSessionMinter: createPortalSessionMinter({
      grants: stores.grants,
      sessions: stores.sessions,
    }),
    portalDisclosureAccountingProvider: createPortalDisclosureAccountingProvider(
      stores.disclosures,
    ),
  };
}

/** The §4.3 published-seam names, in canonical `SeamContracts` key form (the boot assert validates against this). */
export const M31_PUBLISHED_SEAM_NAMES = [
  "PortalAccountReader",
  "PortalAccessGrantReader",
  "PortalEngagementProvider",
  "TelehealthMetricsProvider",
  "TelehealthVisitReader",
  "PortalSessionMinter",
  "PortalDisclosureAccountingProvider",
] as const;

export type M31PublishedSeamName = (typeof M31_PUBLISHED_SEAM_NAMES)[number];

/** Registers M31's seven published seams into the M1 registry (idempotent at the registry layer). */
export function registerM31PublishedSeams(
  registrar: M31SeamRegistrar,
  impls: M31PublishedSeamImpls,
): void {
  registrar.registerSeam("PortalAccountReader", impls.portalAccountReader);
  registrar.registerSeam("PortalAccessGrantReader", impls.portalAccessGrantReader);
  registrar.registerSeam("PortalEngagementProvider", impls.portalEngagementProvider);
  registrar.registerSeam("TelehealthMetricsProvider", impls.telehealthMetricsProvider);
  registrar.registerSeam("TelehealthVisitReader", impls.telehealthVisitReader);
  registrar.registerSeam("PortalSessionMinter", impls.portalSessionMinter);
  registrar.registerSeam(
    "PortalDisclosureAccountingProvider",
    impls.portalDisclosureAccountingProvider,
  );
}

/**
 * The §4.4 consumed-seam names (the REQUIRED_SEAMS contract validateSeams checks). Every producer is LIVE —
 * M31 is a late-wave module locking after M2–M22 + M36/M38/M39/M40. The T04 read-surfaces already consume the
 * portal-summary arms (M12/M13/M17/M19/M22 + M5/M16); this is the full §4.4 set the module reaches through the
 * M1 registry across all tasks. `TelehealthProvider` is M31's own adapter (self-published at boot, §4.5).
 */
export const M31_REQUIRED_SEAMS = [
  // M2 — identity / session minting
  "MembershipReader",
  "CredentialReader",
  // M5 — portal landing context + amendment submit destination
  "PatientReader",
  "CaregiverReader",
  "PatientCaregiverReader",
  "PatientAddressReader",
  // M6 — election + discharge state (post-discharge grace / bereaved flip)
  "ElectionPeriodReader",
  "AdmissionStatusReader",
  // M7 — lay-language care-plan summary
  "CarePlanReader",
  // M8 — lay-language visit summary
  "SignedEncountersReader",
  // M9 — symptom-trend visualization
  "LatestAssessmentProvider",
  "ScaleSeriesProvider",
  // M10 — patient-facing symptom-impact
  "HopeTimepointProvider",
  // M11 — non-medication order summary
  "OrderProvider",
  // M12 — lay-language active-medication list
  "MedicationOrderProvider",
  // M13 — lay-language administration history + the caregiver-attested write
  "MedicationAdministrationProvider",
  // M15 — discipline-specific lay summaries
  "DisciplinePlanReader",
  // M16 — bereaved-family session scope + plan
  "BereavedPortalScopeProvider",
  "BereavementPlanProvider",
  // M17 — upcoming visits + telehealth room back-ref
  "PortalVisitReader",
  "VisitReader",
  // M21 — upcoming supply deliveries
  "SupplyFulfillmentProvider",
  // M22 — documents view + portal upload intake
  "PortalDocumentReader",
  // M36 — secure-message membership reconciliation + alerts
  "MessagingProvider",
  "AlertEmitter",
  // M38 — lay-language label resolution
  "TerminologyProvider",
  // M39 — the foundation consent gate on every portal route
  "ConsentEvaluator",
  // M40 — discipline labels + grief resources + facility names
  "DisciplineTaxonomyReader",
  "ExternalGriefResourceReader",
  "FacilityReader",
] as const;

export type M31RequiredSeamName = (typeof M31_REQUIRED_SEAMS)[number];

/** Thrown by any forward-seam deny-stub method (none in M31 today — every consumed producer is live). */
export const SEAM_NOT_BOUND = "SEAM_NOT_BOUND" as const;

/**
 * Builds a fail-closed deny-stub whose every accessed method rejects with `SEAM_NOT_BOUND`. Kept for parity
 * with the M27/M28 pattern so a future forward seam (should one appear) fails CLOSED rather than open. M31 has
 * no forward seams today — all §4.4 producers are live — so nothing registers one at boot.
 */
export function makeDenyStub(seamName: string): Record<string, (...args: unknown[]) => never> {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`${SEAM_NOT_BOUND}: ${seamName}`);
        };
      },
    },
  ) as Record<string, (...args: unknown[]) => never>;
}
