// apps/backend/src/modules/22-documents/lifecycle/retention.ts — M22-T03 (§2.2.1 / §2.3 / §8.6 / D9 / D23).
//
// The retention-class domain: per-class disposition-date derivation, the §2.3 "retention-class
// consistency" mutation rule (only the `clinical_record → compliance` upgrade is legal; never a
// downgrade; `compliance_42cfr_part2` is set at INSERT and never mutated except via the M4 legal-hold
// workflow — D23), and the legal-hold OVERRIDE: a document under an active legal hold has no computable
// disposition date and is never destruction-eligible regardless of its retention class (D12). All pure;
// "now" and the anchor instants are injected, so the math is deterministic and unit-testable.
import type { DocumentRetentionClass } from "@chartwarden/types";
import { DocumentStateError, require_ } from "./errors";

/** §8.6 retention floors (days) per class, anchored to the disposition instant. `compliance` = 7y (M4 D1);
 * `intake_artifact` = 30d when no writeback occurred (D9); `bereavement` = 13-month letter floor. The two
 * patient-lifetime classes (`clinical_record`, `compliance_42cfr_part2`) have NO fixed offset — their
 * disposition is anchored to the patient lifecycle / Part-2 refusal, not a day count. */
export const RETENTION_FLOOR_DAYS = {
  compliance: 7 * 365,
  // anchored to patient lifecycle (M5 clinical_record) — no fixed day offset from disposition.
  clinical_record: null,
  // 13-month bereavement-letter floor (~395d) per §8.6.
  bereavement: 395,
  operational: 7 * 365,
  // 30d post-disposition when NO writeback occurred (D9); promotes to clinical_record on writeback.
  intake_artifact: 30,
  // 42 CFR Part 2 — M4 `eraseAuditRows` refuses destruction during the patient's lifetime (D23). No
  // computable disposition date.
  compliance_42cfr_part2: null,
} as const satisfies Record<DocumentRetentionClass, number | null>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A disposition-date verdict. `dueAt === null` means the class is anchored to the patient lifecycle /
 * Part-2 refusal (no day-offset date) — the document is NOT day-count-disposable. */
export interface DispositionVerdict {
  readonly retentionClass: DocumentRetentionClass;
  readonly dueAt: string | null;
  /** True when a legal hold suspends disposition entirely (D12) — overrides any date. */
  readonly heldByLegalHold: boolean;
}

/**
 * Derive the disposition date for a document (§8.6). `dispositionAt` is the instant the document reached a
 * terminal/disposition state (e.g. admission close, batch writeback_complete). A document under an active
 * legal hold is never disposable (D12) — `dueAt` is forced null and `heldByLegalHold` is true regardless
 * of class. Classes with a `null` floor (patient-lifecycle / Part-2) return `dueAt = null`.
 */
export function deriveDispositionDate(args: {
  readonly retentionClass: DocumentRetentionClass;
  readonly dispositionAt: string;
  readonly legalHoldActive: boolean;
}): DispositionVerdict {
  if (args.legalHoldActive) {
    return { retentionClass: args.retentionClass, dueAt: null, heldByLegalHold: true };
  }
  const floor = RETENTION_FLOOR_DAYS[args.retentionClass];
  if (floor === null) {
    return { retentionClass: args.retentionClass, dueAt: null, heldByLegalHold: false };
  }
  const anchor = new Date(args.dispositionAt).getTime();
  if (Number.isNaN(anchor)) throw new Error(`invalid dispositionAt: ${args.dispositionAt}`);
  return {
    retentionClass: args.retentionClass,
    dueAt: new Date(anchor + floor * DAY_MS).toISOString(),
    heldByLegalHold: false,
  };
}

/**
 * Is the document past its disposition date and therefore destruction-eligible (D9 / D12)? A legally-held
 * document is NEVER eligible (the §2.3 legal-hold-immutability rule). A patient-lifecycle / Part-2 class
 * (no computable date) is never day-count-eligible — its destruction runs only via the M4 cert workflow
 * with the Part-2 lifetime refusal applied.
 */
export function isDestructionEligible(args: {
  readonly verdict: DispositionVerdict;
  readonly now: string;
}): boolean {
  if (args.verdict.heldByLegalHold) return false;
  if (args.verdict.dueAt === null) return false;
  return new Date(args.now).getTime() >= new Date(args.verdict.dueAt).getTime();
}

/** The §2.3 legal retention-class transitions: only the `clinical_record → compliance` upgrade (never a
 * downgrade). The Part-2 class is INSERT-only (D23). `intake_artifact → clinical_record` is the D9
 * promotion-on-writeback, modeled separately ({@link promoteOnWriteback}) because it is a writeback event,
 * not an arbitrary reclassify. */
const LEGAL_RETENTION_UPGRADES: Readonly<
  Partial<Record<DocumentRetentionClass, DocumentRetentionClass>>
> = {
  clinical_record: "compliance",
};

/**
 * Validate a requested retention-class change (§2.3 retention-class-consistency rule). Throws the precise
 * code on an illegal change; returns the resolved next class on success. The ONLY general upgrade is
 * `clinical_record → compliance`; everything else (any downgrade, any change away from `compliance`,
 * any mutation of `compliance_42cfr_part2`) is refused — the only path to changing a Part-2 class is the
 * M4 legal-hold workflow, which is not a renderer/service reclassify (D23).
 */
export function applyRetentionChange(
  current: DocumentRetentionClass,
  requested: DocumentRetentionClass,
): DocumentRetentionClass {
  if (requested === current) return current;
  require_(
    current !== "compliance_42cfr_part2",
    "PART2_RETENTION_IMMUTABLE",
    "a compliance_42cfr_part2 document's retention class is immutable except via the M4 legal-hold workflow (D23)",
  );
  const upgrade = LEGAL_RETENTION_UPGRADES[current];
  require_(
    upgrade === requested,
    "RETENTION_DOWNGRADE_FORBIDDEN",
    `retention class ${current} → ${requested} is not a permitted upgrade (only clinical_record → compliance)`,
  );
  return requested;
}

/**
 * D9 — promote an `intake_artifact` document to `clinical_record` retention when a candidate is committed
 * (a writeback occurred). This is the only legal mutation of an `intake_artifact` class; the promotion
 * writes the new class at commit time. A non-`intake_artifact` document is unchanged (idempotent no-op).
 */
export function promoteOnWriteback(current: DocumentRetentionClass): DocumentRetentionClass {
  return current === "intake_artifact" ? "clinical_record" : current;
}

/**
 * D23 — the renderer's auto-tag at INSERT: a rendered document is `compliance_42cfr_part2` when (a) it is a
 * lab-results PDF whose source observation is SUD-class, (b) it carries DocLens-classified SUD content, or
 * (c) the caller asserts `partTwoOverride`. Otherwise the proposed class stands. Pure decision over the
 * render facts; the result is the INSERT-time class (never updated post-insert — D23).
 */
export function resolveInsertRetentionClass(args: {
  readonly proposed: DocumentRetentionClass;
  readonly labResultSudClass: boolean;
  readonly doclensSudClass: boolean;
  readonly partTwoOverride: boolean;
}): DocumentRetentionClass {
  if (args.labResultSudClass || args.doclensSudClass || args.partTwoOverride) {
    return "compliance_42cfr_part2";
  }
  return args.proposed;
}

/** Guard: a document already in `compliance_42cfr_part2` may not be reclassified by the service (D23). The
 * {@link applyRetentionChange} path enforces this too; this is the standalone INSERT-time assertion. */
export function assertPart2NotMutated(
  insertClass: DocumentRetentionClass,
  current: DocumentRetentionClass,
): void {
  if (current === "compliance_42cfr_part2" && insertClass !== "compliance_42cfr_part2") {
    throw new DocumentStateError(
      "PART2_RETENTION_IMMUTABLE",
      "compliance_42cfr_part2 is INSERT-only and immutable post-insert (D23)",
    );
  }
}
