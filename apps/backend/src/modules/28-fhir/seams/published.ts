// apps/backend/src/modules/28-fhir/seams/published.ts — §4.3's seam IMPLEMENTATIONS (M28-T06).
//
// The three READ-ONLY seams M28 publishes into the M1 registry, each a thin adapter over a Drizzle
// store that reads M28's OWN tables (`fhir_client` / `fhir_inbound_resource` / `fhir_read_disclosure`). None re-decides a gate — a FHIR consumer's authz is decided at the request pipeline (T08); a
// seam consumer (M33 / M30 / M34 / M5 / M12) reaches these under its OWN org context, so the store
// self-scopes each read (HARD RULE 3) and the seam never compares an org id it was handed.
//
// ── REGISTRATION IS STORE-GATED (and the store EXISTS) ───────────────────────────────────────────────
//
// `registerFhirPublishedSeams` registers the three impls only when a store is supplied. The composition
// root supplies `createDrizzleFhirPublishedSeamStore(deps.db)` on every db boot, so on a real deployment
// all three are live; a db-less boot passes none and `validateSeams()` leaves the M1 fail-closed
// deny-stubs standing, so a consumer that reaches an unbound seam denies LOUDLY rather than reading an
// empty projection minted from nothing — the M19/M20 posture.
//
// This header used to say "PHASE 1: NO STORE, SO `registerFhirPublishedSeams` REGISTERS NOTHING", which
// stopped being true the moment the T08 store landed one directory over. An external audit read the
// header and reported the seams as unregistered (F-035, #95). A comment that outlives its subject does
// not merely go stale — it is read as the specification.
import type {
  FhirClientDetail,
  FhirClientId,
  FhirClientReader,
  FhirClientSummary,
  FhirDisclosureMetrics,
  FhirGatewayMetrics,
  FhirGatewayMetricsProvider,
  FhirInboundOwnerModule,
  FhirInboundProposalDetail,
  FhirInboundProposalReader,
  FhirInboundProposalSummary,
  FhirInboundResourceId,
  IsoInstant,
  OrgId,
} from "@wardenx/types";

import { registerSeam } from "../../../bootstrap/index";

/**
 * The Drizzle-store reads the three §4.3 seams delegate to. Granular so a store implementation (T08)
 * writes one query per method rather than assembling whole DTOs behind an opaque facade. Every method
 * self-scopes to the caller's ambient org context; the `organizationId` argument is ASSERTED against that
 * scope, never used to select across tenants.
 */
export interface FhirPublishedSeamStore {
  metricsForOrg(args: {
    organizationId: OrgId;
    from: IsoInstant;
    to: IsoInstant;
  }): Promise<FhirGatewayMetrics>;
  disclosureMetricsForOrg(args: {
    organizationId: OrgId;
    quarter: string;
  }): Promise<FhirDisclosureMetrics>;
  clientsForOrg(args: { organizationId: OrgId }): Promise<ReadonlyArray<FhirClientSummary>>;
  clientDetail(args: {
    organizationId: OrgId;
    clientId: FhirClientId;
  }): Promise<FhirClientDetail | null>;
  pendingForOwnerModule(args: {
    organizationId: OrgId;
    ownerModule: FhirInboundOwnerModule;
  }): Promise<ReadonlyArray<FhirInboundProposalSummary>>;
  proposalDetail(args: {
    organizationId: OrgId;
    proposalId: FhirInboundResourceId;
  }): Promise<FhirInboundProposalDetail | null>;
}

/** §4.3 — M28's `FhirGatewayMetricsProvider` implementation over the store. */
export function createFhirGatewayMetricsProvider(
  store: FhirPublishedSeamStore,
): FhirGatewayMetricsProvider {
  return {
    metricsForOrg: (args) => store.metricsForOrg(args),
    disclosureMetricsForOrg: (args) => store.disclosureMetricsForOrg(args),
  };
}

/** §4.3 — M28's `FhirClientReader` implementation over the store. */
export function createFhirClientReader(store: FhirPublishedSeamStore): FhirClientReader {
  return {
    clientsForOrg: (args) => store.clientsForOrg(args),
    clientDetail: (args) => store.clientDetail(args),
  };
}

/** §4.3 — M28's `FhirInboundProposalReader` implementation over the store. */
export function createFhirInboundProposalReader(
  store: FhirPublishedSeamStore,
): FhirInboundProposalReader {
  return {
    pendingForOwnerModule: (args) => store.pendingForOwnerModule(args),
    proposalDetail: (args) => store.proposalDetail(args),
  };
}

/** Deps for M28's §4.3 published-seam registration. */
export interface FhirPublishedSeamDeps {
  /** The Drizzle store. Absent (a db-less boot) ⇒ the three seams keep their M1 fail-closed deny-stubs. */
  store?: FhirPublishedSeamStore;
}

/**
 * §4.3 — publish M28's three read seams into the M1 registry over their boot deny-stubs.
 *
 * Called by the composition root's `wireModuleSeams()`, before `validateSeams()`. Idempotent (a second
 * call replaces the registrations with equivalent ones). Without a store this is a NO-OP (see the header).
 */
export function registerFhirPublishedSeams(deps: FhirPublishedSeamDeps = {}): void {
  const store = deps.store;
  if (store === undefined) return;
  registerSeam("FhirGatewayMetricsProvider", createFhirGatewayMetricsProvider(store));
  registerSeam("FhirClientReader", createFhirClientReader(store));
  registerSeam("FhirInboundProposalReader", createFhirInboundProposalReader(store));
}
