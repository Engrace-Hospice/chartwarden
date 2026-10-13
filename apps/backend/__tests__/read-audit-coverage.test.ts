/**
 * M4 §2.5 — PHI read-audit coverage gate (apps/backend/src/bootstrap/plugins/read-audit.ts).
 *
 * Closes audit finding #4: the read-audit declaration contract existed but nothing enforced it. The
 * composition root now installs an onRoute gate that REFUSES to register a GET/HEAD under a covered
 * PHI prefix unless it declares `config.auditRead` (emission config or a justified waiver) — so the
 * server cannot boot with an undeclared PHI read route.
 */
import { resetReadAuditDeclarations } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READ_AUDIT_PREFIXES, buildServer } from "../src/bootstrap/index";
import {
  ReadAuditCoverageError,
  applyReadAuditCoverage,
  isGovernedReadRoute,
  listAuditFilter,
} from "../src/bootstrap/plugins/read-audit";
import type { M26RouteServices } from "../src/modules/26-cap/routes/index";
import { mountM26Routes } from "../src/modules/26-cap/routes/mount";
import {
  createInMemoryM29Store,
  mountM29Routes,
} from "../src/modules/29-external-interfaces/routes";
import { mountConsentRoutes } from "../src/modules/39-consent/index";

const PREFIXES = ["/api/v1/patients"];

beforeEach(() => {
  resetReadAuditDeclarations();
});

describe("isGovernedReadRoute", () => {
  it("governs GET/HEAD under a covered prefix (exact, sub-path, query)", () => {
    expect(isGovernedReadRoute("GET", "/api/v1/patients", PREFIXES)).toBe(true);
    expect(isGovernedReadRoute("GET", "/api/v1/patients/:id", PREFIXES)).toBe(true);
    expect(isGovernedReadRoute("HEAD", "/api/v1/patients/:id/payers", PREFIXES)).toBe(true);
  });

  it("ignores writes (POST/PUT/PATCH/DELETE) — covered by write-audit triggers", () => {
    expect(isGovernedReadRoute("POST", "/api/v1/patients", PREFIXES)).toBe(false);
    expect(isGovernedReadRoute(["PUT", "DELETE"], "/api/v1/patients/:id", PREFIXES)).toBe(false);
  });

  it("ignores reads outside every covered prefix", () => {
    expect(isGovernedReadRoute("GET", "/api/v1/orgs/:id/members", PREFIXES)).toBe(false);
    expect(isGovernedReadRoute("GET", "/health", PREFIXES)).toBe(false);
    // a prefix must match a path segment boundary, not a string prefix of another resource
    expect(isGovernedReadRoute("GET", "/api/v1/patients-archive", PREFIXES)).toBe(false);
  });
});

describe("listAuditFilter (WP 2.7a: a search term is content, never audit metadata)", () => {
  it("keeps the query shape but replaces the omitted keys' values", () => {
    expect(listAuditFilter({ q: "morphine", limit: "20", hasAttachment: "true" }, ["q"])).toEqual({
      q: "[omitted]",
      limit: "20",
      hasAttachment: "true",
    });
  });
  it("passes the query through untouched when nothing is omitted", () => {
    expect(listAuditFilter({ limit: "5" }, undefined)).toEqual({ limit: "5" });
    expect(listAuditFilter(undefined, ["q"])).toBeUndefined();
  });
});

describe("read-audit coverage gate (onRoute, via buildServer)", () => {
  it("refuses to register a covered PHI GET with no config.auditRead", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() => app.get("/api/v1/patients/:id", async () => ({}))).toThrow(ReadAuditCoverageError);
  });

  it("allows a covered PHI GET that declares an emission config", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() =>
      app.get(
        "/api/v1/patients/:id",
        { config: { auditRead: { resourceKind: "patient", patientIdParam: "id" } } },
        async () => ({}),
      ),
    ).not.toThrow();
  });

  it("allows a covered PHI GET with a justified waiver", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() =>
      app.get(
        "/api/v1/patients/census-metrics",
        { config: { auditRead: { none: "aggregate counts only; no patient fields surfaced" } } },
        async () => ({}),
      ),
    ).not.toThrow();
  });

  it("rejects an empty waiver justification (an empty waiver is not a waiver)", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() =>
      app.get("/api/v1/patients/x", { config: { auditRead: { none: "  " } } }, async () => ({})),
    ).toThrow();
  });

  it("does not govern a write route under the prefix", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() => app.post("/api/v1/patients", async () => ({}))).not.toThrow();
  });

  it("does not govern a read outside the covered prefixes", () => {
    const app = buildServer({ readAuditPrefixes: PREFIXES, security: { rateLimitEnabled: false } });
    expect(() => app.get("/api/v1/orgs/:id/members", async () => ({}))).not.toThrow();
  });

  it("applyReadAuditCoverage is the unit under test (exported for direct wiring)", () => {
    expect(typeof applyReadAuditCoverage).toBe("function");
  });
});

describe("DEFAULT_READ_AUDIT_PREFIXES — the governed PHI surface", () => {
  // The default was ["/api/v1/patients"] and `readAuditPrefixes` was never passed by the composition
  // root, so the gate governed ~9 of ~150 mounted PHI read routes: M30's incident/abuse-allegation/
  // mortality/infection queues and the M23/M24/M25 claim, denial and remittance surfaces all
  // registered with nothing to declare and emitted nothing. These assertions exist so the list can
  // never silently narrow again — a §164.528 accounting gap is invisible until someone asks for one.
  it("governs the M30 quality PHI surface", () => {
    expect(DEFAULT_READ_AUDIT_PREFIXES).toContain("/api/v1/quality");
    expect(
      isGovernedReadRoute("GET", "/api/v1/quality/incidents", DEFAULT_READ_AUDIT_PREFIXES),
    ).toBe(true);
    expect(
      isGovernedReadRoute(
        "GET",
        "/api/v1/quality/mortality/:reviewId",
        DEFAULT_READ_AUDIT_PREFIXES,
      ),
    ).toBe(true);
  });

  it("governs the M23/M24/M25 claim + remittance surfaces (a claim carries patient_id + dx codes)", () => {
    for (const url of [
      "/api/v1/billing/claims",
      "/api/v1/claims/:id/validation-runs",
      "/api/v1/noe-records",
      "/api/v1/medicaid-claims/:id/lines",
      "/api/v1/rb-days",
      "/api/v1/remittance/advices",
      "/api/v1/denials/:id",
      "/api/v1/appeals",
    ]) {
      expect(isGovernedReadRoute("GET", url, DEFAULT_READ_AUDIT_PREFIXES)).toBe(true);
    }
  });

  it("keeps the modules already at full coverage governed, so they cannot regress", () => {
    for (const p of [
      "/api/v1/patients",
      "/api/v1/bereavement",
      "/api/v1/discipline-plans",
      "/api/v1/safety",
      "/api/v1/oncall",
    ]) {
      expect(DEFAULT_READ_AUDIT_PREFIXES).toContain(p);
    }
  });

  it("governs the M6-M14/M17/M18/M22 clinical core (TASK-009) — the largest PHI read surface", () => {
    // Was the "does NOT yet govern" reminder: every GET/HEAD under these prefixes now carries
    // `config.auditRead` (an emission config, or a justified waiver — e.g. M9's admin scale-licensing
    // config, M13's org-level administration policy), so widening the prefix list no longer fails boot.
    for (const url of [
      "/api/v1/referrals",
      "/api/v1/admissions/:id",
      "/api/v1/care-plans/:planId/summary",
      "/api/v1/encounters/:encounterId",
      "/api/v1/hope/schedules",
      "/api/v1/orders",
      "/api/v1/medication-orders/:id",
      "/api/v1/administrations",
      "/api/v1/idg/schedule",
      "/api/v1/visits/:visitId",
      "/api/v1/evv/events",
      "/api/v1/documents/:id",
    ]) {
      expect(isGovernedReadRoute("GET", url, DEFAULT_READ_AUDIT_PREFIXES)).toBe(true);
    }
  });

  it("governs M37 IPU and the M31 portal (also reached by M17/M18/M19's portal-facing reads)", () => {
    for (const url of [
      "/api/v1/ipu-admissions/:id",
      "/api/v1/inpatient-units",
      "/api/v1/portal/documents",
      "/api/v1/portal/visits/upcoming",
      "/api/v1/portal/visits/:visitId/arrival",
      "/api/v1/portal/triage/recent",
      "/api/v1/admin/portal-accounts",
    ]) {
      expect(isGovernedReadRoute("GET", url, DEFAULT_READ_AUDIT_PREFIXES)).toBe(true);
    }
  });

  it("governs M26 Cap and M39 Consent (GAP-079 — the allowlist had not kept pace)", () => {
    // These two modules' patient-scoped reads registered with nothing to declare and emitted nothing:
    // per-beneficiary Medicare cap accrual/projection data, and every consent-record-keyed read
    // (the `/api/v1/patients/:patientId/…` consent routes were already covered, by the patients prefix).
    for (const url of [
      "/api/v1/cap/projections/patient/:periodId/:patientId",
      "/api/v1/cap/accruals/patient/:periodId/:patientId",
      "/api/v1/cap/accruals/patient/:periodId/:patientId/lines",
      "/api/v1/cap/threshold-events",
      "/api/v1/cap/psr-imports/:importId/reconciliation",
      "/api/v1/cap/settlements/:periodId",
      "/api/v1/consents/:consentId",
      "/api/v1/consents/:consentId/version-chain",
      "/api/v1/consents/:consentId/dpoa-agents",
      "/api/v1/consents/eval-audit/by-patient",
      "/api/v1/consent-types",
    ]) {
      expect(isGovernedReadRoute("GET", url, DEFAULT_READ_AUDIT_PREFIXES)).toBe(true);
    }
    // M26's platform-scope constants live under a DIFFERENT prefix and stay outside this gate.
    expect(
      isGovernedReadRoute("GET", "/api/v1/platform/cap/constants", DEFAULT_READ_AUDIT_PREFIXES),
    ).toBe(false);
  });

  it("mounts the REAL M39 consent surface under the default prefixes without a coverage error", () => {
    // The load-bearing half of GAP-079: adding a prefix is only safe once every GET under it declares.
    // Route registration never queries, so a stub handle proves the declarations, not the store.
    const app = buildServer({ security: { rateLimitEnabled: false } });
    expect(() => mountConsentRoutes(app, {} as DbClient)).not.toThrow();
  });

  it("mounts the REAL M26 cap surface under the default prefixes without a coverage error", () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    // Same reasoning: the four §4.1 plugins only close over the services at registration time.
    expect(() =>
      mountM26Routes(app, {
        readService: {} as M26RouteServices["readService"],
        writeService: {} as M26RouteServices["writeService"],
      }),
    ).not.toThrow();
  });

  it("governs the M28 FHIR admin surface, but NOT the /fhir/r4 patient-data mount (a different, non-/api/v1 prefix audited via FhirDisclosureAuditPort)", () => {
    expect(isGovernedReadRoute("GET", "/api/v1/fhir/clients", DEFAULT_READ_AUDIT_PREFIXES)).toBe(
      true,
    );
    expect(isGovernedReadRoute("GET", "/fhir/r4/Patient/:id", DEFAULT_READ_AUDIT_PREFIXES)).toBe(
      false,
    );
  });

  // GAP-044 / GAP-045 — lab results and inbound ADT proposals were outside the allowlist, so their GETs
  // emitted no read event and an undeclared new route booted fine.
  it("governs M29's /api/clinical lab reads and /api/admin/external-interfaces reads", () => {
    for (const url of [
      "/api/clinical/labs/observations",
      "/api/clinical/labs/observations/:observationId",
      "/api/admin/external-interfaces/inbound-proposals",
    ]) {
      expect(isGovernedReadRoute("GET", url, DEFAULT_READ_AUDIT_PREFIXES)).toBe(true);
    }
  });

  it("refuses an undeclared GET under /api/clinical", () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    expect(() => app.get("/api/clinical/labs/observations", async () => ({}))).toThrow(
      ReadAuditCoverageError,
    );
  });

  it("mounts the REAL M29 surface under the default prefixes, and the lab/proposal reads EMIT with patient attribution", () => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    const configs = new Map<string, unknown>();
    app.addHook("onRoute", (route) => {
      if (route.method === "GET") configs.set(route.url, route.config?.auditRead);
    });
    expect(() => mountM29Routes(app, { store: createInMemoryM29Store() })).not.toThrow();
    expect(configs.get("/api/clinical/labs/observations/:observationId")).toMatchObject({
      resourceKind: "lab_observation",
      resourceIdParam: "observationId",
      patientIdPayloadPath: "observation.patientId",
    });
    expect(configs.get("/api/clinical/labs/observations")).toMatchObject({
      list: true,
      patientIdQueryParam: "patientId",
    });
    expect(
      configs.get("/api/admin/external-interfaces/inbound-proposals/:proposalId"),
    ).toMatchObject({ patientIdPayloadPath: "proposal.matchedPatientId" });
  });
});
