// Module 28 — §2.2 FSMs + §2.3 domain validation (M28-T01).
//
// The three state machines are the gateway's onboarding, export and inbound-proposal contracts: a wrong
// edge is a client activated without dual approval, an export that never releases its concurrency lock,
// or a rejected proposal whose PHI payload is never scheduled for shred. So the tests assert the edges
// the §2.2 diagrams DO have and — the part that catches regressions — the plausible ones they do NOT.

import { describe, expect, it } from "vitest";

import { scopesExceedingGrant, unsupportedScopes } from "../src/auth/scopes";
import {
  fhirDefaultRateLimitFor,
  fhirRateLimitWithinFloor,
  isCidrShaped,
} from "../src/domain/validation";
import {
  FHIR_BULK_EXPORT_INITIAL_STATUS,
  FHIR_BULK_EXPORT_TERMINAL_STATUSES,
  canFhirBulkExportTransition,
  fhirBulkExportTransition,
  isFhirBulkExportActive,
} from "../src/lifecycle/bulk-export";
import {
  FHIR_CLIENT_CASCADE_ON_ENTRY,
  FHIR_CLIENT_INITIAL_STATUS,
  FHIR_CLIENT_TERMINAL_STATUSES,
  FHIR_CLIENT_TRANSITIONS,
  canFhirClientTransition,
  fhirClientEdgeRequiresDualApproval,
  fhirClientServePosture,
  fhirClientTransition,
  fhirDualApprovalSatisfied,
} from "../src/lifecycle/client";
import {
  FHIR_INBOUND_INITIAL_STATUS,
  FHIR_INBOUND_TERMINAL_STATUSES,
  canFhirInboundTransition,
  fhirInboundEntryErasesPayload,
  fhirInboundOwnerModuleFor,
  fhirInboundRejectRationaleValid,
} from "../src/lifecycle/inbound";

describe("§2.2 fhir_client onboarding FSM", () => {
  it("starts a proposed client in pending_approval with a null from-status", () => {
    expect(FHIR_CLIENT_INITIAL_STATUS).toBe("pending_approval");
    expect(canFhirClientTransition(null, "pending_approval")).toBe(true);
    // Proposal is the only null-from edge — nothing else may materialise mid-ladder.
    expect(FHIR_CLIENT_TRANSITIONS.filter((t) => t.fromStatus === null)).toHaveLength(1);
  });

  it("walks approve → suspend → unsuspend → revoke", () => {
    expect(canFhirClientTransition("pending_approval", "active")).toBe(true);
    expect(canFhirClientTransition("active", "suspended")).toBe(true);
    expect(canFhirClientTransition("suspended", "active")).toBe(true);
    expect(canFhirClientTransition("active", "revoked")).toBe(true);
    expect(canFhirClientTransition("suspended", "revoked")).toBe(true);
  });

  it("forbids the plausible-but-illegal edges", () => {
    // No skipping approval straight to active is fine (that IS the edge); but a rejected/revoked client
    // is terminal and cannot come back.
    expect(canFhirClientTransition("rejected", "active")).toBe(false);
    expect(canFhirClientTransition("revoked", "active")).toBe(false);
    expect(canFhirClientTransition("pending_approval", "suspended")).toBe(false);
    // A pending client cannot be revoked directly — it is rejected.
    expect(canFhirClientTransition("pending_approval", "revoked")).toBe(false);
  });

  it("marks only pending→active as the D12 dual-approval edge", () => {
    expect(fhirClientEdgeRequiresDualApproval("pending_approval", "active")).toBe(true);
    expect(fhirClientEdgeRequiresDualApproval("suspended", "active")).toBe(false);
  });

  it("requires two distinct approvers for dual approval", () => {
    expect(fhirDualApprovalSatisfied("admin-1", "compl-1")).toBe(true);
    expect(fhirDualApprovalSatisfied("same", "same")).toBe(false); // one person cannot sign both roles
    expect(fhirDualApprovalSatisfied("admin-1", null)).toBe(false);
    expect(fhirDualApprovalSatisfied(null, "compl-1")).toBe(false);
  });

  it("runs the cascade on entry to suspended and revoked, and treats revoked/rejected as terminal", () => {
    expect([...FHIR_CLIENT_CASCADE_ON_ENTRY].sort()).toEqual(["revoked", "suspended"]);
    expect([...FHIR_CLIENT_TERMINAL_STATUSES].sort()).toEqual(["rejected", "revoked"]);
  });

  it("reports the serve posture per status", () => {
    expect(fhirClientServePosture("active")).toEqual({ kind: "serving" });
    expect(fhirClientServePosture("pending_approval")).toEqual({ kind: "awaiting_approval" });
    expect(fhirClientServePosture("suspended")).toEqual({ kind: "suspended" });
    expect(fhirClientServePosture("revoked")).toEqual({
      kind: "terminated",
      terminalStatus: "revoked",
    });
  });

  it("attaches an audit action to every edge", () => {
    for (const t of FHIR_CLIENT_TRANSITIONS) {
      expect(t.auditAction.startsWith("m28.fhir.client.")).toBe(true);
    }
  });
});

describe("§2.2 fhir_bulk_export_job FSM", () => {
  it("starts accepted and can reach completed via in_progress", () => {
    expect(FHIR_BULK_EXPORT_INITIAL_STATUS).toBe("accepted");
    expect(canFhirBulkExportTransition("accepted", "in_progress")).toBe(true);
    expect(canFhirBulkExportTransition("in_progress", "completed")).toBe(true);
    expect(canFhirBulkExportTransition("completed", "expired")).toBe(true);
  });

  it("allows cancel before and during run, and fail only mid-run", () => {
    expect(canFhirBulkExportTransition("accepted", "cancelled")).toBe(true);
    expect(canFhirBulkExportTransition("in_progress", "cancelled")).toBe(true);
    expect(canFhirBulkExportTransition("in_progress", "failed")).toBe(true);
    // A completed job is done — no failing it after the fact.
    expect(canFhirBulkExportTransition("completed", "failed")).toBe(false);
    expect(canFhirBulkExportTransition("expired", "completed")).toBe(false);
  });

  it("counts accepted + in_progress as holding the per-client concurrency lock", () => {
    expect(isFhirBulkExportActive("accepted")).toBe(true);
    expect(isFhirBulkExportActive("in_progress")).toBe(true);
    expect(isFhirBulkExportActive("completed")).toBe(false);
    expect(isFhirBulkExportActive("expired")).toBe(false);
  });

  it("treats expired/failed/cancelled as terminal", () => {
    expect([...FHIR_BULK_EXPORT_TERMINAL_STATUSES].sort()).toEqual([
      "cancelled",
      "expired",
      "failed",
    ]);
    expect(fhirBulkExportTransition("expired", "in_progress")).toBeNull();
  });
});

describe("§2.2 fhir_inbound_resource FSM", () => {
  it("starts pending and resolves to accepted/rejected/expired", () => {
    expect(FHIR_INBOUND_INITIAL_STATUS).toBe("pending");
    expect(canFhirInboundTransition("pending", "accepted")).toBe(true);
    expect(canFhirInboundTransition("pending", "rejected")).toBe(true);
    expect(canFhirInboundTransition("pending", "expired")).toBe(true);
  });

  it("forbids re-deciding a terminal proposal", () => {
    expect(canFhirInboundTransition("accepted", "rejected")).toBe(false);
    expect(canFhirInboundTransition("rejected", "accepted")).toBe(false);
    expect(canFhirInboundTransition("expired", "accepted")).toBe(false);
    expect([...FHIR_INBOUND_TERMINAL_STATUSES].sort()).toEqual(["accepted", "expired", "rejected"]);
  });

  it("shreds the payload on rejected/expired but keeps it on accepted", () => {
    expect(fhirInboundEntryErasesPayload("rejected")).toBe(true);
    expect(fhirInboundEntryErasesPayload("expired")).toBe(true);
    expect(fhirInboundEntryErasesPayload("accepted")).toBe(false);
    expect(fhirInboundEntryErasesPayload("pending")).toBe(false);
  });

  it("requires a ≥40-char rationale to reject", () => {
    expect(fhirInboundRejectRationaleValid("too short")).toBe(false);
    expect(fhirInboundRejectRationaleValid("x".repeat(40))).toBe(true);
    expect(fhirInboundRejectRationaleValid(null)).toBe(false);
    expect(fhirInboundRejectRationaleValid("   " + "x".repeat(39))).toBe(false); // trimmed length counts
  });

  it("resolves the owner module or null (→ 501) for unknown types", () => {
    expect(fhirInboundOwnerModuleFor("Patient")).toBe("m5");
    expect(fhirInboundOwnerModuleFor("MedicationStatement")).toBe("m12");
    expect(fhirInboundOwnerModuleFor("Observation")).toBeNull();
    expect(fhirInboundOwnerModuleFor("Claim")).toBeNull(); // known resource, but not inbound-supported
  });
});

describe("§2.3 domain validation", () => {
  it("enforces platform-floor / tenant-tighten-only rate limits", () => {
    expect(fhirRateLimitWithinFloor("tier-1", 100)).toBe(true); // at floor = default, legal
    expect(fhirRateLimitWithinFloor("tier-1", 50)).toBe(true); // tighten below floor, legal
    expect(fhirRateLimitWithinFloor("tier-1", 101)).toBe(false); // loosen above floor, refused
    expect(fhirRateLimitWithinFloor("tier-2", 11)).toBe(false);
    expect(fhirRateLimitWithinFloor("tier-3", 1)).toBe(true);
    expect(fhirRateLimitWithinFloor("tier-3", 0)).toBe(false); // zero is nonsense
    expect(fhirRateLimitWithinFloor("tier-1", 1.5)).toBe(false); // non-integer
    expect(fhirDefaultRateLimitFor("tier-2")).toBe(10);
  });

  it("shape-checks CIDR allowlist entries", () => {
    expect(isCidrShaped("10.0.0.0/8")).toBe(true);
    expect(isCidrShaped("192.168.1.0/24")).toBe(true);
    expect(isCidrShaped("2001:db8::/32")).toBe(true);
    expect(isCidrShaped("10.0.0.0")).toBe(false); // no prefix
    expect(isCidrShaped("10.0.0.0/33")).toBe(false); // IPv4 prefix out of range
    expect(isCidrShaped("999.0.0.0/8")).toBe(false); // octet out of range
    expect(isCidrShaped("not-an-ip/24")).toBe(false);
  });

  it("matches scope subsets both directions", () => {
    expect(unsupportedScopes(["system/Patient.read", "system/Encounter.read"])).toEqual([]);
    expect(unsupportedScopes(["system/Patient.write"])).toEqual(["system/Patient.write"]);
    expect(
      scopesExceedingGrant(["system/Patient.read"], ["system/Patient.read", "system/Goal.read"]),
    ).toEqual([]);
    expect(scopesExceedingGrant(["system/Goal.read"], ["system/Patient.read"])).toEqual([
      "system/Goal.read",
    ]);
  });
});
