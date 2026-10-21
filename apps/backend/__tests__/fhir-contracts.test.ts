// Module 28 (FHIR Gateway) — M28-T01 contract drift guards.
//
// `packages/types/src/fhir.ts` says its enum mirrors are "kept in lock-step with
// `packages/db/src/enums.ts`". A comment does not keep anything in lock-step. These tests are where the
// claim is enforced: `@chartwarden/types` is a LEAF and cannot import `@chartwarden/db`, so the two sides can
// only be compared somewhere that already depends on both — the backend, which is exactly the consumer
// that would ship the drift. The owned-table descriptors are likewise pinned to the manifest, the single
// source of truth for what M28 owns.

import { describe, expect, it } from "vitest";

import {
  fhirBulkExportRequestKind,
  fhirBulkExportStatus,
  fhirClientCredentialKind,
  fhirClientCredentialStatus,
  fhirClientStatus,
  fhirClientTier,
  fhirClientType,
  fhirInboundOwnerModule,
  fhirInboundStatus,
  fhirVersionEnum,
} from "@chartwarden/db/schema";
import { SUPPORTED_SCOPES } from "@chartwarden/fhir";
import {
  FHIR_BULK_EXPORT_ACTIVE_STATUSES,
  FHIR_BULK_EXPORT_REQUEST_KINDS,
  FHIR_BULK_EXPORT_STATUSES,
  FHIR_CLIENT_CREDENTIAL_KINDS,
  FHIR_CLIENT_CREDENTIAL_STATUSES,
  FHIR_CLIENT_STATUSES,
  FHIR_CLIENT_TIERS,
  FHIR_CLIENT_TYPES,
  FHIR_FORWARD_SEAM_RESOURCES,
  FHIR_INBOUND_OWNER_MODULES,
  FHIR_INBOUND_PAYLOAD_ERASE_STATUSES,
  FHIR_INBOUND_STATUSES,
  FHIR_KNOWN_INBOUND_OWNER,
  FHIR_PHASE_1_VERSION,
  FHIR_SUPPORTED_SCOPES,
  FHIR_TIER_RATE_LIMIT_FLOOR_RPS,
  FHIR_VERSIONS,
  type FhirBulkExportRequestKind,
  type FhirBulkExportStatus,
  type FhirClientCredentialKind,
  type FhirClientCredentialStatus,
  type FhirClientStatus,
  type FhirClientTier,
  type FhirClientType,
  type FhirInboundOwnerModule,
  type FhirInboundStatus,
  type FhirVersion,
  M28_AUDIT_DENYLIST,
  M28_AUDIT_RETENTION_CLASS,
  M28_CIPHER_COLUMNS,
  M28_ERASER_DATA_CLASS,
  M28_PARTITIONED_TABLES,
  M28_TABLE_NAMES,
  M28_TABLE_TENANCY,
} from "@chartwarden/types";
import { MODULES } from "../../../architecture/module-manifest";

/** Each triple is (SQL type name, the pgEnum's runtime values, the leaf mirror's members). The third
 *  element is a `satisfies`-checked literal array, so a member added to the TS union without being added
 *  here is a COMPILE error and a member added to the pgEnum without the union is a RUNTIME failure. */
const MIRRORS = [
  [
    "fhir_client_type",
    fhirClientType.enumValues,
    FHIR_CLIENT_TYPES satisfies readonly FhirClientType[],
  ],
  [
    "fhir_client_tier",
    fhirClientTier.enumValues,
    FHIR_CLIENT_TIERS satisfies readonly FhirClientTier[],
  ],
  [
    "fhir_client_status",
    fhirClientStatus.enumValues,
    FHIR_CLIENT_STATUSES satisfies readonly FhirClientStatus[],
  ],
  [
    "fhir_client_credential_kind",
    fhirClientCredentialKind.enumValues,
    FHIR_CLIENT_CREDENTIAL_KINDS satisfies readonly FhirClientCredentialKind[],
  ],
  [
    "fhir_client_credential_status",
    fhirClientCredentialStatus.enumValues,
    FHIR_CLIENT_CREDENTIAL_STATUSES satisfies readonly FhirClientCredentialStatus[],
  ],
  [
    "fhir_bulk_export_status",
    fhirBulkExportStatus.enumValues,
    FHIR_BULK_EXPORT_STATUSES satisfies readonly FhirBulkExportStatus[],
  ],
  [
    "fhir_bulk_export_request_kind",
    fhirBulkExportRequestKind.enumValues,
    FHIR_BULK_EXPORT_REQUEST_KINDS satisfies readonly FhirBulkExportRequestKind[],
  ],
  [
    "fhir_inbound_status",
    fhirInboundStatus.enumValues,
    FHIR_INBOUND_STATUSES satisfies readonly FhirInboundStatus[],
  ],
  [
    "fhir_inbound_owner_module",
    fhirInboundOwnerModule.enumValues,
    FHIR_INBOUND_OWNER_MODULES satisfies readonly FhirInboundOwnerModule[],
  ],
  ["fhir_version_enum", fhirVersionEnum.enumValues, FHIR_VERSIONS satisfies readonly FhirVersion[]],
] as const satisfies readonly (readonly [string, readonly string[], readonly string[]])[];

describe("§3.2 pgEnum ↔ @chartwarden/types mirror", () => {
  it.each(MIRRORS)("%s carries the same members on both sides", (_name, pgValues, unionValues) => {
    expect([...pgValues].sort()).toEqual([...unionValues].sort());
  });

  it("declares all ten §3.2 enums", () => {
    expect(MIRRORS).toHaveLength(10);
  });

  it("serves US Core R4 in Phase 1 and lists R5/R6 as the compile-shell targets", () => {
    expect(FHIR_PHASE_1_VERSION).toBe("4.0.1");
    expect(fhirVersionEnum.enumValues).toContain("5.0.0");
    expect(fhirVersionEnum.enumValues).toContain("6.0.0");
  });

  it("keeps the derived active/erase status subsets inside their parent enums", () => {
    for (const s of FHIR_BULK_EXPORT_ACTIVE_STATUSES) {
      expect(fhirBulkExportStatus.enumValues).toContain(s);
    }
    // A completed/failed/cancelled/expired job does NOT hold the concurrency lock.
    expect(FHIR_BULK_EXPORT_ACTIVE_STATUSES as readonly string[]).toEqual([
      "accepted",
      "in_progress",
    ]);
    for (const s of FHIR_INBOUND_PAYLOAD_ERASE_STATUSES) {
      expect(fhirInboundStatus.enumValues).toContain(s);
    }
    // An ACCEPTED proposal keeps its payload (the owner module now owns the native row); only the two
    // terminal-without-write statuses shred it.
    expect(FHIR_INBOUND_PAYLOAD_ERASE_STATUSES as readonly string[]).not.toContain("accepted");
  });
});

describe("§2.3 domain constants", () => {
  it("mirrors the fhir scope set into the module and its leaf copy identically", () => {
    expect([...SUPPORTED_SCOPES].sort()).toEqual([...FHIR_SUPPORTED_SCOPES].sort());
  });

  it("ships only read scopes in the read-only Phase-1 gateway", () => {
    for (const scope of FHIR_SUPPORTED_SCOPES) {
      expect(scope.endsWith(".read")).toBe(true);
    }
  });

  it("orders the tier rate-limit floor high→low (100/10/1) per §2.3", () => {
    expect(FHIR_TIER_RATE_LIMIT_FLOOR_RPS["tier-1"]).toBe(100);
    expect(FHIR_TIER_RATE_LIMIT_FLOOR_RPS["tier-2"]).toBe(10);
    expect(FHIR_TIER_RATE_LIMIT_FLOOR_RPS["tier-3"]).toBe(1);
  });

  it("routes the Phase-1 inbound owner modules to the two KNOWN_OWNER_MODULES", () => {
    expect(FHIR_KNOWN_INBOUND_OWNER.Patient).toBe("m5");
    expect(FHIR_KNOWN_INBOUND_OWNER.MedicationStatement).toBe("m12");
    const owners = new Set(Object.values(FHIR_KNOWN_INBOUND_OWNER));
    expect([...owners].sort()).toEqual(["m12", "m5"]);
  });

  it("gates the four write-facing resources as forward-seam 404s (W-FHIR-07)", () => {
    expect([...FHIR_FORWARD_SEAM_RESOURCES].sort()).toEqual([
      "Claim",
      "ClaimResponse",
      "ExplanationOfBenefit",
      "ServiceRequest",
    ]);
  });
});

describe("§3.3–§3.7 owned tables ↔ the manifest", () => {
  const m28 = MODULES.find((m) => m.id === 28);

  it("mirrors the manifest's ownedTables exactly — the manifest is the source of truth", () => {
    expect(m28).toBeDefined();
    expect([...M28_TABLE_NAMES].sort()).toEqual([...(m28?.ownedTables ?? [])].sort());
  });

  it("owns nine tables", () => {
    // Eight until F-035 (#95) added `fhir_read_disclosure`, the §164.528 accounting ledger the bound
    // read path writes. The count is asserted separately from the manifest mirror above so that adding
    // a table is a DELIBERATE edit here rather than a number that follows whatever the manifest says.
    expect(M28_TABLE_NAMES).toHaveLength(9);
  });

  it("declares a tenancy, denylist, retention class and cipher set per table", () => {
    for (const table of M28_TABLE_NAMES) {
      expect(M28_TABLE_TENANCY[table]).toBeDefined();
      expect(M28_AUDIT_DENYLIST[table]).toBeDefined();
      expect(M28_AUDIT_RETENTION_CLASS[table]).toBeDefined();
      expect(M28_CIPHER_COLUMNS[table]).toBeDefined();
    }
  });

  it("makes only the capability snapshot platform-shared; the rest are tenant-scoped", () => {
    expect(M28_TABLE_TENANCY.fhir_capability_snapshot).toBe("platform_shared");
    for (const table of M28_TABLE_NAMES) {
      if (table === "fhir_capability_snapshot") continue;
      expect(M28_TABLE_TENANCY[table]).toBe("tenant_scoped");
    }
  });

  it("denylists exactly the secret + PHI-payload columns", () => {
    expect(M28_AUDIT_DENYLIST.fhir_client_credential).toEqual([
      "secret_cipher",
      "secret_digest_sha256",
    ]);
    expect(M28_AUDIT_DENYLIST.tenant_fhir_config).toEqual(["cursor_signing_key_cipher"]);
    expect(M28_AUDIT_DENYLIST.fhir_inbound_resource).toEqual(["payload"]);
    // The session table has no PHI and nothing to hide.
    expect(M28_AUDIT_DENYLIST.fhir_client_session).toEqual([]);
  });

  it("every cipher column is also audit-denylisted (a secret in the clear in audit is still a leak)", () => {
    for (const table of M28_TABLE_NAMES) {
      for (const col of M28_CIPHER_COLUMNS[table]) {
        expect(M28_AUDIT_DENYLIST[table]).toContain(col);
      }
    }
  });

  it("classifies the no-PHI session table operational and the disclosure tables compliance", () => {
    expect(M28_AUDIT_RETENTION_CLASS.fhir_client_session).toBe("operational");
    expect(M28_AUDIT_RETENTION_CLASS.fhir_client).toBe("compliance");
    expect(M28_AUDIT_RETENTION_CLASS.fhir_inbound_resource).toBe("compliance");
  });

  it("partitions the two high-volume tables on their time column", () => {
    expect(M28_PARTITIONED_TABLES.fhir_client_session.partitionKey).toBe("issued_at");
    expect(M28_PARTITIONED_TABLES.fhir_inbound_resource.partitionKey).toBe("proposed_at");
  });

  it("registers a single eraser data class", () => {
    expect(M28_ERASER_DATA_CLASS).toBe("fhir_gateway");
  });
});
