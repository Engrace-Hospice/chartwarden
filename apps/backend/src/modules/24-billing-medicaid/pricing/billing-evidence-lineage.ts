/**
 * Resolve append-only billing evidence at an explicit assessment time.
 *
 * A correction changes a historical evidence head only after it has been verified. Pending
 * corrections do not rewrite earlier assessments, and an assessment taken while a conflicting
 * correction is pending is held for review. The resolver never chooses one overlapping head.
 */
export interface BillingEvidenceLineageFact {
  readonly id: string;
  readonly supersedesId: string | null;
  readonly verificationStatus: string;
  readonly createdAt: Date | string;
  readonly verifiedAt: Date | string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export type BillingEvidenceLineageResult<T extends BillingEvidenceLineageFact> =
  | { readonly status: "verified"; readonly row: T }
  | { readonly status: "segmentation_required"; readonly rows: readonly T[] }
  | { readonly status: "unresolved" | "ambiguous"; readonly reasonCode: string };

function instant(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function overlaps(row: BillingEvidenceLineageFact, from: string, to: string): boolean {
  return row.effectiveFrom <= to && (row.effectiveTo === null || row.effectiveTo >= from);
}

function nextDay(day: string): string | null {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) ? new Date(time + 86_400_000).toISOString().slice(0, 10) : null;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function resolveBillingEvidenceLineage<T extends BillingEvidenceLineageFact>(input: {
  readonly rows: readonly T[];
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly assessedAt: string;
}): BillingEvidenceLineageResult<T> {
  const assessedAt = Date.parse(input.assessedAt);
  if (
    !Number.isFinite(assessedAt) ||
    input.serviceFrom > input.serviceTo ||
    !isCalendarDate(input.serviceFrom) ||
    !isCalendarDate(input.serviceTo)
  ) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_ASSESSMENT_TIME_INVALID" };
  }

  const knownAtAssessment = input.rows.filter((row) => {
    const createdAt = instant(row.createdAt);
    const verifiedAt = instant(row.verifiedAt);
    if (createdAt === null || createdAt > assessedAt || row.effectiveFrom > input.serviceTo) {
      return false;
    }
    // A future verification is not part of the evidence known at this assessment time. A pending
    // row is retained only as a current conflict signal; it cannot supersede an earlier verified row.
    return row.verificationStatus === "pending" || row.verificationStatus === "unverified"
      ? true
      : verifiedAt !== null && verifiedAt <= assessedAt;
  });
  const observed = knownAtAssessment.filter((row) =>
    overlaps(row, input.serviceFrom, input.serviceTo),
  );
  if (observed.length === 0) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_MISSING" };
  }

  const pending = observed.filter(
    (row) => row.verificationStatus === "pending" || row.verificationStatus === "unverified",
  );
  if (pending.length > 0) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_CORRECTION_PENDING" };
  }

  const supersessionCounts = new Map<string, number>();
  // A verified correction can narrow its predecessor out of the requested service range. Resolve
  // that identity transition before effective-date selection; filtering successors by service overlap
  // first would resurrect an obsolete predecessor for dates after its corrected end.
  for (const row of knownAtAssessment) {
    if (
      row.supersedesId !== null &&
      (row.verificationStatus === "verified" || row.verificationStatus === "revoked")
    ) {
      supersessionCounts.set(row.supersedesId, (supersessionCounts.get(row.supersedesId) ?? 0) + 1);
    }
  }
  if ([...supersessionCounts.values()].some((count) => count > 1)) {
    return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_SUPERSESSION_BRANCH" };
  }

  const superseded = new Set(
    knownAtAssessment
      .filter(
        (row) =>
          row.supersedesId !== null &&
          (row.verificationStatus === "verified" || row.verificationStatus === "revoked"),
      )
      .map((row) => row.supersedesId as string),
  );
  const heads = knownAtAssessment.filter((row) => !superseded.has(row.id));
  const relevantHeads = heads.filter((row) => overlaps(row, input.serviceFrom, input.serviceTo));
  if (relevantHeads.length === 0) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
  }
  if (relevantHeads.some((row) => row.verificationStatus === "revoked")) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_REVOKED" };
  }
  const verifiedHeads = relevantHeads.filter((row) => row.verificationStatus === "verified");
  if (verifiedHeads.length === 0) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_UNVERIFIED" };
  }

  const segments = verifiedHeads
    .filter((row) => overlaps(row, input.serviceFrom, input.serviceTo))
    .map((row) => ({
      row,
      from: row.effectiveFrom < input.serviceFrom ? input.serviceFrom : row.effectiveFrom,
      to:
        row.effectiveTo === null || row.effectiveTo > input.serviceTo
          ? input.serviceTo
          : row.effectiveTo,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  if (segments.length === 0) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
  }

  let expected = input.serviceFrom;
  for (const segment of segments) {
    if (segment.from < expected) {
      return { status: "ambiguous", reasonCode: "BILLING_EVIDENCE_OVERLAPPING_HEADS" };
    }
    if (segment.from > expected) {
      return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
    }
    const after = nextDay(segment.to);
    if (!after) return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INVALID" };
    expected = after;
  }
  const afterRequested = nextDay(input.serviceTo);
  if (expected !== afterRequested) {
    return { status: "unresolved", reasonCode: "BILLING_EVIDENCE_PERIOD_INCOMPLETE" };
  }
  if (segments.length > 1) {
    return {
      status: "segmentation_required",
      rows: segments.map((segment) => segment.row),
    };
  }
  return { status: "verified", row: segments[0]!.row };
}
