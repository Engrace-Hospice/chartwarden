/**
 * The request-header authorization gate (F-028).
 *
 * The defect it exists to refuse is not hypothetical: four commit-point routes across M14/M17/M18
 * decided a step-up (re-authentication) requirement from `request.headers["x-step-up"] === "fresh"`
 * — a string the gated caller sends. Every existing gate was self-consistent about it, because a
 * contract and an implementation can agree with each other and both be wrong about what the route
 * really requires.
 *
 * These tests pin the two properties that make the gate worth having: it FAILS on that exact read,
 * and it does not fail on the reads that are legitimate (verified credentials, concurrency control),
 * which is what stops a future reader from deleting it as noise.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_READERS,
  type HeaderRead,
  REGISTERED_HEADERS,
  findHeaderReads,
  unregisteredReads,
} from "../check-request-header-auth";

const REPO_ROOT = join(__dirname, "../..");

const read = (header: string): HeaderRead => ({
  file: "apps/backend/src/modules/14-idg/routes/idg-routes.ts",
  line: 1,
  header,
  text: `request.headers["${header}"]`,
});

describe("request-header authorization gate", () => {
  it("the repo has no unregistered request-header read", () => {
    expect(unregisteredReads(findHeaderReads(REPO_ROOT))).toEqual([]);
  });

  it("fails on the exact read that shipped: `x-step-up`", () => {
    // The header is deliberately NOT in the registry, and there is no classification it could
    // honestly take: nothing verifies it, and an authorization decision rides on it.
    expect("x-step-up" in REGISTERED_HEADERS).toBe(false);
    expect(unregisteredReads([read("x-step-up")])).toHaveLength(1);
  });

  it("passes the reads that are legitimate, so it is not just a ban on the word `headers`", () => {
    // Concurrency control and verified credentials — the two shapes that must keep working.
    expect(unregisteredReads([read("if-match"), read("idempotency-key")])).toEqual([]);
    expect(unregisteredReads([read("stripe-signature"), read("x-csrf-token")])).toEqual([]);
    expect(unregisteredReads([read("x-witness-attestation")])).toEqual([]);
  });

  it("classifies every registered header as verified or not-authorization, with a reason", () => {
    // There is deliberately no third classification. A header that would need one is the bug.
    for (const [name, spec] of Object.entries(REGISTERED_HEADERS)) {
      expect(["verified", "not-authorization"], name).toContain(spec.classification);
      expect(spec.reason.length, name).toBeGreaterThan(20);
      expect(name, "registry keys must be lower-case — Fastify lower-cases incoming names").toBe(
        name.toLowerCase(),
      );
    }
  });

  it("reads a header name through a module constant rather than reporting the identifier", () => {
    // `request.headers[CSRF_HEADER_NAME]` must resolve to `x-csrf-token`, or every indirect read
    // would need its IDENTIFIER registered and the registry would stop being about headers.
    const reads = findHeaderReads(REPO_ROOT);
    const csrf = reads.filter((r) => r.file.endsWith("plugins/csrf.ts"));
    expect(csrf.length).toBeGreaterThan(0);
    expect(csrf.every((r) => r.header === "x-csrf-token")).toBe(true);
  });

  it("resolves a generic accessor through its declared callers", () => {
    // `headerOf(request, name)` takes the name as a PARAMETER, so its read site names no header.
    // DYNAMIC_READERS declares which constants reach it; both must resolve to registered headers.
    const file = "apps/backend/src/bootstrap/plugins/authenticate.ts";
    expect(DYNAMIC_READERS[file]).toBeDefined();
    const found = findHeaderReads(REPO_ROOT).filter((r) => r.file === file);
    expect(found.map((r) => r.header).sort()).toEqual([
      "x-internal-org-id",
      "x-internal-service-token",
    ]);
  });

  it("ignores response headers and comments — neither is an input a caller controls", () => {
    const reads = findHeaderReads(REPO_ROOT);
    // The three route files DOCUMENT the header they used to read; the gate must not resurrect it.
    expect(reads.filter((r) => r.header === "x-step-up")).toEqual([]);
    // `res.headers["set-cookie"]` is a response the server wrote.
    expect(reads.filter((r) => r.header === "set-cookie")).toEqual([]);
  });
});
