// apps/backend/src/modules/22-documents/domain/retention.ts — M22-T03 (§2.3, §8.6, D9, D12, D23).
//
// The PURE retention-class rules. Three concerns live here, all clock-/DB-free:
//
//   • §2.3 retention-class consistency — the class is set at INSERT and the only permitted post-insert change
//     is the `clinical_record → compliance` UPGRADE (never a downgrade). `compliance_42cfr_part2` (SUD, D23) is
//     set at INSERT only and is immutable thereafter except via the M4 legal-hold workflow — a service-layer
//     retention change touching it is refused.
//   • D9 intake_artifact promotion — an `intake_artifact`-class document auto-promotes to `clinical_record`
//     the moment any extraction candidate it produced is committed to a chart (retaining provenance for the
//     chart's lifetime). This is the one promotion path that is NOT a manual upgrade.
//   • D12 / §7.14 destruction eligibility — the eraser must SKIP a document under an active legal hold, and a
//     `compliance_42cfr_part2` document is REFUSED during the patient's lifetime (passed through to M4's
//     `eraseAuditRows`). The full eraseFn wiring lands in M22-T10; this is the pure decision it consumes.
import type { DocumentRetentionClass } from "@wardenx/types";
import { require_ } from "./errors";

/** §2.3 — the retention classes that may be downgraded-protected; only this one upgrade edge is legal. */
const UPGRADE_EDGE: { readonly from: DocumentRetentionClass; readonly to: DocumentRetentionClass } = {
  from: "clinical_record",
  to: "compliance",
};

/**
 * §2.3 — validate a service-requested retention-class change. The ONLY legal manual change is
 * `clinical_record → compliance` (the upgrade); anything else is a downgrade or a no-op. `compliance_42cfr_part2`
 * is immutable on either side (D23). A no-op (`from === to`) is allowed (idempotent). Throws otherwise.
 */
export function assertRetentionClassChange(
  from: DocumentRetentionClass,
  to: DocumentRetentionClass,
): void {
  if (from === to) return;
  require_(
    from !== "compliance_42cfr_part2" && to !== "compliance_42cfr_part2",
    "DOCUMENT_SUD_RETENTION_IMMUTABLE",
    "compliance_42cfr_part2 is set at insert only and never changed except via the M4 legal-hold workflow (D23).",
  );
  require_(
    from === UPGRADE_EDGE.from && to === UPGRADE_EDGE.to,
    "DOCUMENT_RETENTION_DOWNGRADE_FORBIDDEN",
    "retention_class can only change clinical_record → compliance (upgrade); downgrades are forbidden.",
  );
}

/**
 * D9 — resolve the effective retention class after a writeback. An `intake_artifact` document auto-promotes to
 * `clinical_record` once any of its extraction candidates commits (`anyCandidateCommitted = true`); every other
 * class is unchanged. Pure: returns the class the service should persist (idempotent if already promoted).
 */
export function retentionClassAfterWriteback(
  current: DocumentRetentionClass,
  anyCandidateCommitted: boolean,
): DocumentRetentionClass {
  if (current === "intake_artifact" && anyCandidateCommitted) return "clinical_record";
  return current;
}

/** The §7.14 D12 per-document destruction decision (the eraser consumes this; M22-T10 wires the executor). */
export type DestructionDecision =
  /** Destroy: tombstone + version-aware MinIO delete + DEK shred (the non-held, non-SUD path). */
  | { readonly outcome: "destroy" }
  /** Skip: the document is under an active legal hold (eraser emits `m22.eraser.legal_hold_skip`). */
  | { readonly outcome: "skip_legal_hold" }
  /** Skip: a `compliance_42cfr_part2` document is refused during the patient's lifetime (M4 `eraseAuditRows`). */
  | { readonly outcome: "skip_compliance_42cfr_part2" };

/**
 * §7.14 D12 — decide, purely, whether a single document is destroyable. Legal hold wins first (non-negotiable,
 * D12), then the SUD refusal, else destroy. The eraser (M22-T10) maps each decision to its effects + outbox
 * skip/complete signal; this keeps the policy in one testable place.
 */
export function decideDestruction(args: {
  readonly retentionClass: DocumentRetentionClass;
  readonly hasActiveLegalHold: boolean;
}): DestructionDecision {
  if (args.hasActiveLegalHold) return { outcome: "skip_legal_hold" };
  if (args.retentionClass === "compliance_42cfr_part2") return { outcome: "skip_compliance_42cfr_part2" };
  return { outcome: "destroy" };
}
