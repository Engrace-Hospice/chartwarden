/**
 * M4 §2.5 — PHI read-audit coverage gate (apps/backend/src/bootstrap/plugins/read-audit.ts).
 *
 * Closes audit finding #4: the read-audit declaration contract existed but nothing enforced it. The
 * composition root now installs an onRoute gate that REFUSES to register a GET/HEAD under a covered
 * PHI prefix unless it declares `config.auditRead` (emission config or a justified waiver) — so the
 * server cannot boot with an undeclared PHI read route.
 */
import { resetReadAuditDeclarations } from "@wardenx/audit";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  ReadAuditCoverageError,
  applyReadAuditCoverage,
  isGovernedReadRoute,
} from "../src/bootstrap/plugins/read-audit";

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
    expect(isGovernedReadRoute("GET", "/healthz", PREFIXES)).toBe(false);
    // a prefix must match a path segment boundary, not a string prefix of another resource
    expect(isGovernedReadRoute("GET", "/api/v1/patients-archive", PREFIXES)).toBe(false);
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
