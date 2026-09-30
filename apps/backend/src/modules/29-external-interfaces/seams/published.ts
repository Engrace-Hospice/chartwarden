// apps/backend/src/modules/29-external-interfaces/seams/published.ts — §4.4's seam IMPLEMENTATIONS (M29-T08).
//
// The FIVE READ-ONLY seams M29 publishes into the M1 registry, each a thin adapter over a Drizzle store that
// reads M29's OWN tables. None re-decides a gate — a seam consumer (M28 FHIR DiagnosticReport, M5/M6 review
// badges, M33/M34 feed status, M40 NPPES roster) reaches these under its OWN org context, so the store
// self-scopes each read (HARD RULE 3) and the seam never compares an org id it was handed.
//
// Two of the five keys already exist in the M1 registry as forward-seam deny-stubs (`LabObservationReader`,
// declared for M28's DiagnosticReport egress; `ExternalInterfaceMetricsProvider`, declared for M35's
// `hl7_message` meter) — M29 registers the REAL impls over them here. The other three (`Hl7InboundProposalReader`,
// `ExternalFeedReader`, `NppesProviderReader`) are M29-owned entries added to the registry this task.
//
// ── PHASE 1: NO STORE ⇒ `registerM29PublishedSeams` REGISTERS NOTHING ────────────────────────────────
// Following the M28/M19/M20 precedent, the five impls register ONLY when a store is supplied (a db-backed
// boot). Without one, `validateSeams()` leaves the M1 fail-closed deny-stubs standing, so a consumer that
// reaches an unbound seam denies LOUDLY rather than reading an empty projection minted from nothing.
import type { ExternalInterfaceMetricsProvider } from "@wardenx/types";

import { registerSeam } from "../../../bootstrap/index";

// ── seam DTOs (leaf-free: the M29 backend module owns these; the registry holds each seam as `unknown`) ──

export interface LabObservationSeamValue {
  readonly obxSetId: number;
  readonly loincCode: string;
  /** The value-row's own display text (`lab_observation_value.loinc_display_text`) — distinct from the
   *  parent observation's panel-level `loincDisplayText` below; a panel can carry several differently
   *  named component results under one observation. */
  readonly loincDisplayText: string;
  readonly valueType: string;
  readonly numericValue: number | null;
  readonly stringValue: string | null;
  readonly units: string | null;
  readonly abnormalFlag: string | null;
  /** F-171 (#248) — the 42 CFR Part 2 SUD-class flag M22's §7.16 redaction gate needs before rendering ANY
   *  lab value (the identical Part-2-disclosure risk F-035 refused for the M12/M13 FHIR projections until
   *  the flag was added). Ingest applies SUD redaction uniformly across every OBX row of one observation
   *  (D15/W-XI-14: `ConsentEvaluator.evaluateForIngressRedaction` decides per MESSAGE, not per value —
   *  `lab-attach-planner.ts`'s `buildValueRows` strips/sentinels every row in the same message together),
   *  so this is the real, non-fabricated per-value projection of the parent `lab_observation
   *  .sud_redacted_at_ingest` column — never an invented per-row classifier. A row whose parent observation
   *  was SUD-redacted at ingest already carries the `SUD_REDACTED_SENTINEL` string, not the raw value; this
   *  flag is what tells a consumer WHY, so the §7.16 gate can still show the redaction banner rather than
   *  rendering the sentinel text as if it were a real result. */
  readonly isSudClass: boolean;
}
export interface LabObservationSeamDTO {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly orderId: string | null;
  readonly loincCode: string;
  readonly loincDisplayText: string;
  readonly observationDate: string;
  readonly resultStatus: string;
  readonly abnormalSummary: string;
  readonly values: readonly LabObservationSeamValue[];
}
export interface InboundProposalSeamDTO {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerModule: string;
  readonly resourceKind: string;
  readonly matchedPatientId: string | null;
  readonly proposalStatus: string;
  readonly proposedAt: string;
}
export interface FeedSeamSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly status: string;
}
export interface FeedHealthSeamDTO {
  readonly feedId: string;
  readonly hourBucket: string;
  readonly listenerUpSeconds: number;
  readonly listenerDownSeconds: number;
  readonly inboundMessageCount: number;
  readonly outboundMessageCount: number;
}
export interface NppesProviderSeamDTO {
  readonly npi: string;
  readonly enumerationType: string;
  readonly status: string;
  readonly basic: unknown;
  readonly taxonomies: unknown;
}

// ── the seam interfaces (M29-owned; the registry holds each as `unknown`) ─────────────────────────────

/** §4.4 — read-side projection of a `lab_observation` for cross-module consumers (M28 FHIR DiagnosticReport). */
export interface LabObservationReader {
  getById(opts: {
    organizationId: string;
    patientId: string;
    observationId: string;
  }): Promise<LabObservationSeamDTO | null>;
  listByPatient(opts: {
    organizationId: string;
    patientId: string;
    limit?: number;
  }): Promise<readonly LabObservationSeamDTO[]>;
  /** F-171 (#248) — the M22 §7.15 lab-backref render consumer resolves an observation from `m11.order
   *  .results_received`, whose real catalogued payload (`events-by-m11.ts`) carries `observationId` but
   *  NOT `patientId` (M11 owns the order, not the patient binding a lab result resolves to). `getById`
   *  cannot be used there — it REQUIRES a `patientId` the caller does not have. Additive rather than
   *  widening `getById` (which stays required for the M28 caller that already supplies one, and whose
   *  extra `patientId` predicate is real defense-in-depth, not vestigial): `lab_observation.id` is already
   *  the app-generated PK, unique with no `patientId` needed to disambiguate it. */
  getByObservationId(opts: {
    organizationId: string;
    observationId: string;
  }): Promise<LabObservationSeamDTO | null>;
}

/** §4.4 — read-side projection of pending ADT proposals for cross-module review surfaces (M5/M6 badges). */
export interface Hl7InboundProposalReader {
  listForPatient(opts: {
    organizationId: string;
    patientId: string;
    ownerModule: "m5" | "m6";
    status?: string;
  }): Promise<readonly InboundProposalSeamDTO[]>;
  countPendingByOwner(opts: {
    organizationId: string;
  }): Promise<{ readonly m5: number; readonly m6: number }>;
}

/** §4.4 — read-side projection of `external_feed` for cross-module status surfaces (M33/M34). No credentials. */
export interface ExternalFeedReader {
  listForOrganization(opts: {
    organizationId: string;
    kind?: string;
    status?: string;
  }): Promise<readonly FeedSeamSummary[]>;
  getHealth(opts: {
    organizationId: string;
    feedId: string;
  }): Promise<FeedHealthSeamDTO | null>;
}

/** §4.4 — read-side projection of platform-shared NPPES providers (M28 Practitioner / M40 roster). */
export interface NppesProviderReader {
  getByNpi(opts: { npi: string }): Promise<NppesProviderSeamDTO | null>;
  getByNpis(opts: {
    npis: readonly string[];
  }): Promise<Map<string, NppesProviderSeamDTO | null>>;
}

// ── the Drizzle-store the five seams delegate to (impl in ./published-store-drizzle) ───────────────────

export interface M29PublishedSeamStore {
  labObservationById(
    organizationId: string,
    patientId: string,
    observationId: string,
  ): Promise<LabObservationSeamDTO | null>;
  /** F-171 (#248) — the patientId-free lookup {@link LabObservationReader.getByObservationId} delegates to. */
  labObservationByObservationId(
    organizationId: string,
    observationId: string,
  ): Promise<LabObservationSeamDTO | null>;
  labObservationsForPatient(
    organizationId: string,
    patientId: string,
    limit: number,
  ): Promise<readonly LabObservationSeamDTO[]>;
  proposalsForPatient(
    organizationId: string,
    patientId: string,
    ownerModule: "m5" | "m6",
    status: string | undefined,
  ): Promise<readonly InboundProposalSeamDTO[]>;
  pendingProposalCounts(
    organizationId: string,
  ): Promise<{ readonly m5: number; readonly m6: number }>;
  feedsForOrganization(
    organizationId: string,
    kind: string | undefined,
    status: string | undefined,
  ): Promise<readonly FeedSeamSummary[]>;
  feedHealth(organizationId: string, feedId: string): Promise<FeedHealthSeamDTO | null>;
  feedMessageCounts(
    organizationId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<{ readonly inbound: number; readonly outbound: number }>;
  nppesByNpi(npi: string): Promise<NppesProviderSeamDTO | null>;
  nppesByNpis(npis: readonly string[]): Promise<Map<string, NppesProviderSeamDTO | null>>;
}

// ── seam factories ─────────────────────────────────────────────────────────────────────────────────

export function createLabObservationReader(store: M29PublishedSeamStore): LabObservationReader {
  return {
    getById: (o) => store.labObservationById(o.organizationId, o.patientId, o.observationId),
    getByObservationId: (o) =>
      store.labObservationByObservationId(o.organizationId, o.observationId),
    listByPatient: (o) =>
      store.labObservationsForPatient(o.organizationId, o.patientId, o.limit ?? 50),
  };
}

export function createHl7InboundProposalReader(
  store: M29PublishedSeamStore,
): Hl7InboundProposalReader {
  return {
    listForPatient: (o) =>
      store.proposalsForPatient(o.organizationId, o.patientId, o.ownerModule, o.status),
    countPendingByOwner: (o) => store.pendingProposalCounts(o.organizationId),
  };
}

export function createExternalFeedReader(store: M29PublishedSeamStore): ExternalFeedReader {
  return {
    listForOrganization: (o) => store.feedsForOrganization(o.organizationId, o.kind, o.status),
    getHealth: (o) => store.feedHealth(o.organizationId, o.feedId),
  };
}

export function createNppesProviderReader(store: M29PublishedSeamStore): NppesProviderReader {
  return {
    getByNpi: (o) => store.nppesByNpi(o.npi),
    getByNpis: (o) => store.nppesByNpis(o.npis),
  };
}

export function createExternalInterfaceMetricsProvider(
  store: M29PublishedSeamStore,
): ExternalInterfaceMetricsProvider {
  return {
    async feedHealthForOrg(input) {
      const counts = await store.feedMessageCounts(
        input.organizationId,
        input.periodStart,
        input.periodEnd,
      );
      return {
        organizationId: input.organizationId,
        inboundMessageCount: counts.inbound,
        outboundMessageCount: counts.outbound,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      };
    },
  };
}

/** Deps for M29's §4.4 published-seam registration. */
export interface M29PublishedSeamDeps {
  /** The T08 Drizzle store. Absent ⇒ the five seams keep their M1 fail-closed deny-stubs. */
  store?: M29PublishedSeamStore;
}

/**
 * §4.4 — publish M29's five read seams into the M1 registry over their boot deny-stubs (M29-T08).
 *
 * Called by the composition root's `wireModuleSeams()`, before `validateSeams()`. Without a store this is a
 * NO-OP (the M28/M19/M20 posture) and the M1 fail-closed deny-stubs stand.
 */
export function registerM29PublishedSeams(deps: M29PublishedSeamDeps = {}): void {
  const store = deps.store;
  if (store === undefined) return;
  registerSeam("LabObservationReader", createLabObservationReader(store));
  registerSeam("Hl7InboundProposalReader", createHl7InboundProposalReader(store));
  registerSeam("ExternalFeedReader", createExternalFeedReader(store));
  registerSeam("NppesProviderReader", createNppesProviderReader(store));
  registerSeam("ExternalInterfaceMetricsProvider", createExternalInterfaceMetricsProvider(store));
}
