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

/**
 * A pending row speaks only when no verified row does (as in resolveProgramResponsibility). Nothing can reject or
 * withdraw a pending row, so a mistaken one must not make a verified route ambiguous for good.
 */
export function preferVerified<T extends { readonly status: string }>(rows: readonly T[]): T[] {
  const verified = rows.filter((row) => row.status === "verified");
  return verified.length > 0 ? verified : [...rows];
}

/** The fields of an enrollment-evidence row that choose and map a payer route. */
export interface PayerRouteEvidenceRow {
  readonly evidenceKind: string;
  readonly canonicalPayerId: string | null;
  readonly clearinghouse: string | null;
  readonly transactionType: string | null;
  readonly vendorPayerId: string | null;
  readonly status: string;
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string | null;
}

const routeDay = (value: Date | string): string =>
  (typeof value === "string" ? value : value.toISOString()).slice(0, 10);

/**
 * The 837I payer-route rows recorded for the program's payer. No payer matches nothing: the record route allows a
 * payer-less row (only verification refuses it), and it must not match an unresolved program whose payer is also null.
 */
export function routeRowsForPayer<T extends PayerRouteEvidenceRow>(
  rows: readonly T[],
  canonicalPayerId: string | null,
): T[] {
  if (canonicalPayerId === null) return [];
  return rows.filter(
    (row) =>
      row.evidenceKind === "clearinghouse_payer_route" &&
      row.canonicalPayerId === canonicalPayerId &&
      row.transactionType === "837I",
  );
}

/**
 * The vendor payer id the selected route maps for the window, or null when no single row speaks for it. Same
 * precedence as {@link resolveProviderPayerRoute}: verified rows over pending ones. No selected vendor maps nothing.
 */
export function routeVendorPayerId(
  routeRows: readonly PayerRouteEvidenceRow[],
  vendor: string | null,
  from: string,
  to: string,
): string | null {
  if (vendor === null) return null;
  const speaking = preferVerified(
    routeRows.filter(
      (row) =>
        row.clearinghouse === vendor &&
        (row.status === "pending" || row.status === "verified") &&
        routeDay(row.effectiveFrom) <= to &&
        (!row.effectiveTo || routeDay(row.effectiveTo) >= from),
    ),
  );
  return speaking.length === 1 ? speaking[0]!.vendorPayerId : null;
}

/** The tenant's selected clearinghouse account for the preview; a reader outage reads as unavailable and is logged. */
export async function readTenantClearinghouseAccount(
  reader:
    | {
        selectedTenantRoute(organizationId: string): Promise<{
          source: string;
          vendor: string | null;
          status: string | null;
        }>;
      }
    | undefined,
  organizationId: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<{ source: string; vendor: string | null; status: string | null }> {
  const unavailable = { source: "unavailable", vendor: null, status: null };
  if (!reader) return unavailable;
  try {
    const route = await reader.selectedTenantRoute(organizationId);
    return { source: route.source, vendor: route.vendor, status: route.status };
  } catch (error) {
    // Ids and the error class only: the preview reports an unconfigured account, so the outage must be visible here.
    warn(
      JSON.stringify({
        event: "m24.preview.tenant_clearinghouse_reader_failed",
        organizationId,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    return unavailable;
  }
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
  const open = rows.filter(
    (row) =>
      (row.status === "pending" || row.status === "verified") &&
      day(row.effectiveFrom) <= day(to) &&
      (!row.effectiveTo || day(row.effectiveTo) >= day(from)),
  );
  const relevant = preferVerified(open);
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
