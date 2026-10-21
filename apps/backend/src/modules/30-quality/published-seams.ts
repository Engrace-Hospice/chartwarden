import type { DbClient } from "@chartwarden/db";
// apps/backend/src/modules/30-quality/published-seams.ts — M30's §4.3 published-seam registration into
// the M1 SeamRegistry (the M23 `registerM23PublishedSeams` / M26 `registerM26PublishedSeams` precedent).
//
// This is M30's FIRST M1 publish. Before it, `registerQualityPublishedSeams` existed in @chartwarden/quality
// with no caller anywhere in apps/backend, and M30's seam names were not members of the M1
// `SeamContracts` / `REQUIRED_SEAMS` — so M30 was reachable cross-module ONLY through its §4.10 outbox
// events, with no read path to the measure ledger, the incident register, QAPI, CoP status, or the SRA
// posture.
//
// GAP-066 — WHO CONSUMES THIS TODAY: nobody. The four consumers this file used to name (M22's quality
// report, M28's FHIR MeasureReport/AdverseEvent, M33's executive dashboards, M34's FY-rollover tenant
// gate) are unbuilt FEATURES, not unwired bindings — none of those surfaces exists. The impls below are
// live and tested against the M1 registry; they are simply the read path a future consumer will use.
//
// The package owns the wiring shape: `registerQualityPublishedSeams(registrar, seams)` takes the M1
// `registerSeam` as an injected PORT so @chartwarden/quality keeps its no-apps-backend edge. This file is the
// composition-root side of that port — it builds the five live Drizzle-backed impls and hands them over.
//
// Tenancy (§4.3 / D3): each impl opens its OWN `withOrgContext` transaction per read, because the seam
// consumers call it OUTSIDE M30's request pipeline. It therefore needs the M1 PRIMARY DbClient and a
// system actor for `app.user_id`. The per-provider-entity aggregation grain comes from M40's
// `ProviderEntityReader`, injected as an optional resolver — UNBOUND ⇒ the per-PE aggregates collapse to
// empty rather than fabricating a cross-provider number (D6 / D13).
import {
  ComplianceStatusProviderImpl,
  IncidentRegisterProviderImpl,
  QapiProjectProviderImpl,
  QualityMeasureProviderImpl,
  type QualityPublishedSeamDeps,
  SecurityRiskAssessmentReaderImpl,
  registerQualityPublishedSeams,
} from "@chartwarden/quality";
import { registerSeam } from "../../bootstrap/index";

/** The platform system actor the aggregate (actor-less) seam reads bind to `app.user_id`. */
const M30_SEAM_SYSTEM_USER = "system";

export interface M30PublishedSeamOptions {
  /**
   * Resolves an org's provider-entity ids — the per-PE aggregation grain (M40 `ProviderEntityReader`).
   * Omitted ⇒ the impls' own fail-closed default (`[]`), never a fabricated cross-provider rollup.
   */
  readonly providerEntities?: (organizationId: string) => Promise<readonly string[]>;
}

/** Build the five live published-seam implementations over the M1 primary handle. */
export function buildM30PublishedSeams(db: DbClient, options: M30PublishedSeamOptions = {}) {
  const deps: QualityPublishedSeamDeps = {
    db,
    systemUserId: M30_SEAM_SYSTEM_USER,
    providerEntities: options.providerEntities,
  };
  return {
    qualityMeasureProvider: new QualityMeasureProviderImpl(deps),
    incidentRegisterProvider: new IncidentRegisterProviderImpl(deps),
    qapiProjectProvider: new QapiProjectProviderImpl(deps),
    complianceStatusProvider: new ComplianceStatusProviderImpl(deps),
    securityRiskAssessmentReader: new SecurityRiskAssessmentReaderImpl(deps),
  };
}

/**
 * Register M30's five §4.3 seams into the M1 registry. No-op without a db — the M1 deny-stubs stand and
 * every consumer gets a fail-closed throw rather than a fabricated quality number (the M23/M26 posture).
 */
export function registerM30PublishedSeams(
  db: DbClient | undefined,
  options: M30PublishedSeamOptions = {},
): void {
  if (!db) return;
  registerQualityPublishedSeams({ registerSeam }, buildM30PublishedSeams(db, options));
}
