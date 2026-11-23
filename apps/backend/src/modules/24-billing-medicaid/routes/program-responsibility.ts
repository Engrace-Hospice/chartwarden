export type ProgramAssignmentCandidate = {
  id: string;
  programKind: "ffs_open_card" | "managed_care" | "other_managed_care" | "unsupported";
  canonicalPayerId: string | null;
  status: "candidate" | "pending" | "verified" | "rejected" | "revoked" | "superseded";
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type ProgramResolution =
  | {
      status: "verified";
      programKind: ProgramAssignmentCandidate["programKind"];
      canonicalPayerId: string;
      assignmentIds: readonly string[];
      reasonCode: "PROGRAM_RESPONSIBILITY_VERIFIED";
    }
  | {
      status:
        | "missing"
        | "pending"
        | "rejected"
        | "expired"
        | "revoked"
        | "ambiguous"
        | "changes"
        | "unsupported"
        | "unavailable";
      programKind: "unresolved" | "ambiguous" | "unsupported";
      canonicalPayerId: null;
      assignmentIds: readonly string[];
      reasonCode: string;
    };

const day = (v: string) => v.slice(0, 10);

/**
 * The assembly-preview contract (`AssemblyPreviewResponse.programResponsibility`) names these fields only: the
 * assignment ids stay server-side, so the view is built field by field and never spreads the resolution.
 */
export function previewProgramResponsibility(resolution: ProgramResolution) {
  return {
    status: resolution.status,
    programKind: resolution.programKind,
    canonicalPayerId: resolution.canonicalPayerId,
    canonicalPayerName: null,
    reasonCode: resolution.reasonCode,
  };
}

export function enrollmentTransactionMatches(
  actual: string | null,
  required: "837I" | "835" | null,
): boolean {
  return required === null || actual === required;
}

export function verificationSourceAllowed(
  evidenceKind: string,
  verificationSource: string,
  assignment = false,
): boolean {
  if (assignment) {
    return ["state_portal", "payer_written_confirmation", "executed_contract"].includes(
      verificationSource,
    );
  }
  const allowedByKind: Record<string, readonly string[]> = {
    state_medicaid_provider_enrollment: ["state_portal", "payer_written_confirmation"],
    mco_participation: ["payer_written_confirmation", "executed_contract"],
    "837i_enrollment": ["payer_written_confirmation", "clearinghouse_written_confirmation"],
    "835_era_enrollment": ["payer_written_confirmation", "clearinghouse_written_confirmation"],
    clearinghouse_payer_route: ["payer_written_confirmation", "clearinghouse_written_confirmation"],
    institutional_format_qualification: ["clearinghouse_sandbox", "payer_written_confirmation"],
    payer_transport_certification: ["clearinghouse_sandbox", "payer_written_confirmation"],
    production_activation_approval: ["internal_approval"],
  };
  return allowedByKind[evidenceKind]?.includes(verificationSource) ?? false;
}

export interface ProviderPayerRouteCandidate {
  clearinghouse: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function resolveProviderPayerRoute(
  rows: readonly ProviderPayerRouteCandidate[],
  from: string,
  to: string,
  account: { source: string; vendor: string | null; status: string | null } | null,
): {
  status: "selected" | "missing" | "unavailable";
  vendor: string | null;
  configurationStatus: string | null;
} {
  const relevant = rows.filter(
    (row) =>
      (row.status === "pending" || row.status === "verified") &&
      day(row.effectiveFrom) <= day(to) &&
      (!row.effectiveTo || day(row.effectiveTo) >= day(from)),
  );
  const fullWindow = relevant.filter(
    (row) =>
      day(row.effectiveFrom) <= day(from) && (!row.effectiveTo || day(row.effectiveTo) >= day(to)),
  );
  if (relevant.length > 1 || fullWindow.length > 1) {
    return {
      status: "unavailable",
      vendor: null,
      configurationStatus: "PROVIDER_PAYER_ROUTE_AMBIGUOUS",
    };
  }
  if (relevant.length === 0) {
    return {
      status: "missing",
      vendor: null,
      configurationStatus: "PROVIDER_PAYER_ROUTE_SELECTION_MISSING",
    };
  }
  if (fullWindow.length === 0) {
    return {
      status: "unavailable",
      vendor: null,
      configurationStatus: "PROVIDER_PAYER_ROUTE_DOES_NOT_COVER_SERVICE_RANGE",
    };
  }
  const vendor = fullWindow[0]!.clearinghouse;
  if (!vendor) {
    return {
      status: "unavailable",
      vendor: null,
      configurationStatus: "PROVIDER_PAYER_ROUTE_VENDOR_MISSING",
    };
  }
  return {
    status: "selected",
    vendor,
    configurationStatus:
      account?.source === "tenant" && account.vendor === vendor
        ? account.status
        : "TENANT_ACCOUNT_NOT_CONFIGURED_FOR_PROVIDER_ROUTE",
  };
}

/**
 * Resolve only one verified identity that covers every service date, from one assignment record. Overlaps, identity
 * changes and a window spread over several records fail closed.
 */
export function resolveProgramResponsibility(
  rows: readonly ProgramAssignmentCandidate[],
  fromInput: string,
  toInput: string,
): ProgramResolution {
  const from = day(fromInput);
  const to = day(toInput);
  if (from > to) {
    return {
      status: "ambiguous",
      programKind: "ambiguous",
      canonicalPayerId: null,
      assignmentIds: [],
      reasonCode: "PROGRAM_ASSIGNMENT_AMBIGUOUS",
    };
  }
  const relevant = rows.filter(
    (r) => r.effectiveFrom <= to && (r.effectiveTo === null || r.effectiveTo >= from),
  );
  const verified = relevant.filter((r) => r.status === "verified");
  const pending = relevant.filter((r) => r.status === "candidate" || r.status === "pending");
  const boundaries = new Set<string>([from]);
  const toNext = new Date(`${to}T00:00:00.000Z`);
  toNext.setUTCDate(toNext.getUTCDate() + 1);
  boundaries.add(toNext.toISOString().slice(0, 10));
  for (const row of relevant) {
    if (row.effectiveFrom > from && row.effectiveFrom <= to) boundaries.add(row.effectiveFrom);
    if (row.effectiveTo) {
      const next = new Date(`${row.effectiveTo}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const boundary = next.toISOString().slice(0, 10);
      if (boundary > from && boundary <= to) boundaries.add(boundary);
    }
  }
  const points = [...boundaries].sort();
  let identity: {
    programKind: ProgramAssignmentCandidate["programKind"];
    canonicalPayerId: string;
  } | null = null;
  const used = new Set<string>();
  for (let i = 0; i < points.length - 1; i += 1) {
    const at = points[i]!;
    const active = verified.filter(
      (r) => r.effectiveFrom <= at && (r.effectiveTo === null || r.effectiveTo >= at),
    );
    if (active.length > 1) {
      return {
        status: "ambiguous",
        programKind: "ambiguous",
        canonicalPayerId: null,
        assignmentIds: active.map((r) => r.id),
        reasonCode: "PROGRAM_ASSIGNMENT_AMBIGUOUS",
      };
    }
    if (active.length === 0) {
      const waiting = pending.filter(
        (r) => r.effectiveFrom <= at && (r.effectiveTo === null || r.effectiveTo >= at),
      );
      const revoked = relevant.filter(
        (r) =>
          r.status === "revoked" &&
          r.effectiveFrom <= at &&
          (r.effectiveTo === null || r.effectiveTo >= at),
      );
      const rejected = relevant.filter(
        (r) =>
          r.status === "rejected" &&
          r.effectiveFrom <= at &&
          (r.effectiveTo === null || r.effectiveTo >= at),
      );
      const expired = verified.filter((r) => r.effectiveTo !== null && r.effectiveTo < at);
      const status = waiting.length
        ? "pending"
        : revoked.length
          ? "revoked"
          : rejected.length
            ? "rejected"
            : expired.length
              ? "expired"
              : "missing";
      return {
        status,
        programKind: "unresolved",
        canonicalPayerId: null,
        assignmentIds: [...waiting, ...revoked, ...rejected, ...expired].map((r) => r.id),
        reasonCode: waiting.length
          ? "PROGRAM_ASSIGNMENT_PENDING"
          : revoked.length
            ? "PROGRAM_ASSIGNMENT_REVOKED"
            : rejected.length
              ? "PROGRAM_ASSIGNMENT_REJECTED"
              : expired.length
                ? "PROGRAM_ASSIGNMENT_EXPIRED"
                : "PROGRAM_ASSIGNMENT_MISSING",
      };
    }
    const row = active[0]!;
    if (!row.canonicalPayerId) {
      return {
        status: "ambiguous",
        programKind: "ambiguous",
        canonicalPayerId: null,
        assignmentIds: [row.id],
        reasonCode: "PROGRAM_ASSIGNMENT_AMBIGUOUS",
      };
    }
    if (row.programKind === "unsupported") {
      return {
        status: "unsupported",
        programKind: "unsupported",
        canonicalPayerId: null,
        assignmentIds: [row.id],
        reasonCode: "PROGRAM_UNSUPPORTED",
      };
    }
    if (
      identity &&
      (identity.programKind !== row.programKind ||
        identity.canonicalPayerId !== row.canonicalPayerId)
    ) {
      return {
        status: "changes",
        programKind: "ambiguous",
        canonicalPayerId: null,
        assignmentIds: [...used, row.id],
        reasonCode: "PROGRAM_RESPONSIBILITY_CHANGES",
      };
    }
    identity = { programKind: row.programKind, canonicalPayerId: row.canonicalPayerId };
    used.add(row.id);
  }
  if (!identity) {
    return {
      status: "missing",
      programKind: "unresolved",
      canonicalPayerId: null,
      assignmentIds: [],
      reasonCode: "PROGRAM_ASSIGNMENT_MISSING",
    };
  }
  // A claim records ONE program assignment (`program_assignment_id`), and submission evidence is qualified against
  // that single id. A window stitched together from several contiguous records would read "verified" yet could
  // never qualify, so it fails closed: record one covering assignment or split the claim.
  if (used.size > 1) {
    return {
      status: "ambiguous",
      programKind: "ambiguous",
      canonicalPayerId: null,
      assignmentIds: [...used],
      reasonCode: "PROGRAM_ASSIGNMENT_SPANS_MULTIPLE_RECORDS",
    };
  }
  return {
    status: "verified",
    ...identity,
    assignmentIds: [...used],
    reasonCode: "PROGRAM_RESPONSIBILITY_VERIFIED",
  };
}
