// @chartwarden/fhir — the `CapabilityStatement` deterministic generation + signing (§2.2 / D11 / W-FHIR-09,
// M28-T03).
//
// D11: the `CapabilityStatement` is a DETERMINISTIC boot-time generation from the route registry + the
// seam catalog, persisted as the platform-singleton `fhir_capability_snapshot` row with a signed checksum;
// `GET /fhir/r4/metadata` reads it back. W-FHIR-09: the snapshot is HMAC-SHA256 signed so a tenant can
// prove what the gateway advertised at the time of any historical §164.528 disclosure, and an hourly
// validator re-computes the HMAC over the stored statement and aborts/alerts on a mismatch (tampering).
//
// This module is the PURE core:
//   - `buildCapabilityStatement(catalog)` — a deterministic FHIR `CapabilityStatement` from a catalog of
//     resources + operations. DETERMINISM is the whole contract (W-FHIR-09): it embeds NO clock — the
//     publication date is an injected catalog field derived from the release, never `now()` — and it sorts
//     every collection by a stable key, so the SAME catalog yields byte-identical JSON on every boot.
//   - `capabilityChecksum(statement)` — sha256 (hex) over the canonical JSON (the `fhir_capability_snapshot.checksum`).
//   - `signCapabilitySnapshot(statement, secret)` — HMAC-SHA256 (hex) over the same canonical JSON (the
//     `signature`), keyed by the platform signing key (injected, never read from env here).
//   - `verifyCapabilitySnapshot(statement, signature, secret)` — constant-time re-verification the hourly
//     validator + the operator `/api/v1/fhir/capability` endpoint run.
// IO-free; the persistence + the platform-key resolution are the route/boot concern (M28-T08).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { FhirVersion, PlatformReleaseTag } from "@chartwarden/types";

/** A FHIR RESTful interaction a resource supports. Phase 1 is READ-ONLY US Core R4, so a resource offers
 *  at most `read` (instance-level) + `search-type` (type-level search); the write interactions arrive with
 *  `fhir.write` in Phase 3. */
export type FhirResourceInteraction = "read" | "search-type";

/** One advertised resource in the catalog the builder is fed. `searchParams` are the US Core mandatory
 *  search parameters the `FhirSearchTranslator` (M28-T04) implements for the type. */
export interface FhirCapabilityResource {
  readonly type: string;
  readonly interactions: readonly FhirResourceInteraction[];
  readonly searchParams?: readonly string[];
}

/** One advertised system/type operation (`$export`, `$everything`, `$expand`, `$validate-code`). */
export interface FhirCapabilityOperation {
  readonly name: string;
  readonly definition: string;
}

/** The deterministic inputs the builder generates from (the route registry + seam catalog, per D11). */
export interface FhirCapabilityCatalog {
  readonly fhirVersion: FhirVersion;
  readonly releaseTag: PlatformReleaseTag;
  /** ISO-8601 publication date, DERIVED FROM THE RELEASE — never a wall clock (determinism, W-FHIR-09). */
  readonly publicationDate: string;
  /** The gateway's FHIR base URL, advertised as `implementation.url`. */
  readonly baseUrl: string;
  readonly resources: readonly FhirCapabilityResource[];
  readonly operations: readonly FhirCapabilityOperation[];
}

/** A generated `CapabilityStatement` (the subset of fields Phase 1 emits — a superset is spec-legal but
 *  the point is a deterministic, verifiable artifact, not full CapabilityStatement surface). */
export interface FhirCapabilityStatement {
  readonly resourceType: "CapabilityStatement";
  readonly status: "active";
  readonly date: string;
  readonly kind: "instance";
  readonly fhirVersion: FhirVersion;
  readonly format: readonly string[];
  readonly implementation: { readonly description: string; readonly url: string };
  readonly rest: readonly [
    {
      readonly mode: "server";
      readonly resource: readonly {
        readonly type: string;
        readonly interaction: readonly { readonly code: FhirResourceInteraction }[];
        readonly searchParam?: readonly {
          readonly name: string;
          readonly type: "token" | "date" | "string" | "reference";
        }[];
      }[];
      readonly operation: readonly { readonly name: string; readonly definition: string }[];
    },
  ];
}

/** Sort + de-dupe a string list — used so the same catalog fed in any order yields identical JSON. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * §D11 — build the deterministic `CapabilityStatement`. Resources are sorted by `type`, their interactions
 * and search params sorted, operations sorted by `name`, so the generated JSON is a pure function of the
 * catalog's CONTENT, not the order the route registry happened to enumerate it. A US Core search-param
 * type is inferred from the parameter name (`_lastUpdated`/`date` → date, `patient`/`subject` → reference,
 * else token) purely for the advertised `searchParam.type`; the real translation is M28-T04's concern.
 */
export function buildCapabilityStatement(catalog: FhirCapabilityCatalog): FhirCapabilityStatement {
  const resource = [...catalog.resources]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((r) => {
      const interaction = sortedUnique(r.interactions).map((code) => ({
        code: code as FhirResourceInteraction,
      }));
      const params = r.searchParams ? sortedUnique(r.searchParams) : [];
      const searchParam = params.map((name) => ({ name, type: inferSearchParamType(name) }));
      return searchParam.length > 0
        ? { type: r.type, interaction, searchParam }
        : { type: r.type, interaction };
    });

  const operation = [...catalog.operations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => ({ name: o.name, definition: o.definition }));

  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: catalog.publicationDate,
    kind: "instance",
    fhirVersion: catalog.fhirVersion,
    format: ["application/fhir+json"],
    implementation: {
      description: `ChartWarden FHIR Gateway (${catalog.releaseTag})`,
      url: catalog.baseUrl,
    },
    rest: [{ mode: "server", resource, operation }],
  };
}

/** The advertised `searchParam.type` inferred from the US Core parameter name (advertisement only). */
function inferSearchParamType(name: string): "token" | "date" | "string" | "reference" {
  if (name === "_lastUpdated" || name === "date" || name === "birthdate") return "date";
  if (name === "patient" || name === "subject" || name === "encounter") return "reference";
  if (name === "name" || name === "family" || name === "given") return "string";
  return "token";
}

/**
 * Canonical JSON of any value with recursively SORTED object keys — the byte string the checksum + HMAC
 * are computed over. Key order is the one thing `JSON.stringify` does not normalize, so two structurally
 * equal statements must serialize identically for the re-verification (W-FHIR-09) to be meaningful.
 */
export function canonicalizeCapability(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** §W-FHIR-09 — the `fhir_capability_snapshot.checksum`: sha256 (hex) of the canonical statement JSON. */
export function capabilityChecksum(statement: FhirCapabilityStatement): string {
  return createHash("sha256").update(canonicalizeCapability(statement), "utf8").digest("hex");
}

/** §W-FHIR-09 — the `fhir_capability_snapshot.signature`: HMAC-SHA256 (hex) of the canonical statement
 *  JSON, keyed by the platform signing key. Computed at boot; re-computed by the hourly validator. */
export function signCapabilitySnapshot(
  statement: FhirCapabilityStatement,
  signingKey: string,
): string {
  return createHmac("sha256", signingKey)
    .update(canonicalizeCapability(statement), "utf8")
    .digest("hex");
}

/**
 * §W-FHIR-09 — constant-time re-verification of a stored snapshot's signature. Re-computes the HMAC over
 * the stored statement and compares to `signature` via `timingSafeEqual` (a length mismatch on a malformed
 * stored signature is a non-match, never a throw). A `false` verdict is the tampering signal the validator
 * escalates + the metadata endpoint refuses to serve on.
 */
export function verifyCapabilitySnapshot(
  statement: FhirCapabilityStatement,
  signature: string,
  signingKey: string,
): boolean {
  const expected = signCapabilitySnapshot(statement, signingKey);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
