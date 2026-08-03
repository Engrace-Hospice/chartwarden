// TASK-020 — regression guard for the two concurrency pre-handlers (`requireIfMatch` /
// `requireIdempotencyKey`, apps/backend/src/modules/**/routes/concurrency.ts). Before this task the
// generated contract said nothing about the headers those guards require, so a client could not know
// `If-Match`/`Idempotency-Key` were expected without reading the handler source. Asserts the emitted
// docs/api/openapi.json declares an `in: header` parameter for every route that mounts one of the
// guards, plus the route's REAL success status where it differs from the emitter's 200 default.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const doc = JSON.parse(readFileSync(join(process.cwd(), "docs/api/openapi.json"), "utf8")) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string; required?: boolean }[]; responses: Record<string, unknown> }>>;
};

function headerNames(method: string, path: string): string[] {
  const op = doc.paths[path]?.[method];
  if (!op) throw new Error(`route not found in openapi.json: ${method.toUpperCase()} ${path}`);
  return (op.parameters ?? []).filter((p) => p.in === "header").map((p) => p.name);
}

function statusKeys(method: string, path: string): string[] {
  const op = doc.paths[path]?.[method];
  if (!op) throw new Error(`route not found in openapi.json: ${method.toUpperCase()} ${path}`);
  return Object.keys(op.responses);
}

describe("openapi.json declares If-Match / Idempotency-Key on every guarded route (TASK-020)", () => {
  const ifMatchOnly: Array<[string, string]> = [
    ["patch", "/api/v1/encounters/{encounterId}/selections"],
    ["patch", "/api/v1/encounters/{encounterId}/vitals/{vitalId}"],
    ["patch", "/api/v1/encounters/{encounterId}/mileage"],
    ["patch", "/api/v1/encounters/{encounterId}/addenda/{addendumId}/selections"],
    ["post", "/api/v1/patients/{patientId}/assessments/{id}/corrections"],
    ["put", "/api/v1/tenant-overlays/{templateKey}"],
  ];

  const both: Array<[string, string]> = [
    ["patch", "/api/v1/care-plans/{planId}/problems/{elementId}"],
    ["patch", "/api/v1/care-plans/{planId}/goals/{elementId}"],
    ["patch", "/api/v1/care-plans/{planId}/interventions/{elementId}"],
    ["patch", "/api/v1/billing/claims/{id}"],
    ["post", "/api/v1/billing/claims/{id}/submit"],
    ["post", "/api/v1/billing/claims/{id}/replace"],
    ["post", "/api/v1/billing/claims/{id}/void"],
    ["patch", "/api/v1/billing/rule-configs/{id}"],
    ["delete", "/api/v1/billing/rule-configs/{id}"],
  ];

  const idempotencyOnly: Array<[string, string]> = [
    ["post", "/api/v1/billing/claims/assemble"],
    ["delete", "/api/v1/billing/claims/{id}"],
    ["post", "/api/v1/billing/claims/{id}/validate"],
    ["post", "/api/v1/billing/rule-configs/custom"],
  ];

  it.each(ifMatchOnly)("%s %s carries If-Match", (method, path) => {
    expect(headerNames(method, path)).toContain("If-Match");
  });

  it.each(both)("%s %s carries both Idempotency-Key and If-Match", (method, path) => {
    const names = headerNames(method, path);
    expect(names).toContain("Idempotency-Key");
    expect(names).toContain("If-Match");
  });

  it.each(idempotencyOnly)("%s %s carries Idempotency-Key", (method, path) => {
    expect(headerNames(method, path)).toContain("Idempotency-Key");
  });

  it("a claim submit is documented as 202 (async state transition)", () => {
    expect(statusKeys("post", "/api/v1/billing/claims/{id}/submit")).toContain("202");
  });

  it("claim assemble/replace/void are documented as 201 (creates a new claim row)", () => {
    expect(statusKeys("post", "/api/v1/billing/claims/assemble")).toContain("201");
    expect(statusKeys("post", "/api/v1/billing/claims/{id}/replace")).toContain("201");
    expect(statusKeys("post", "/api/v1/billing/claims/{id}/void")).toContain("201");
  });

  it("a claim delete is documented as 204 (no body)", () => {
    expect(statusKeys("delete", "/api/v1/billing/claims/{id}")).toContain("204");
  });
});
