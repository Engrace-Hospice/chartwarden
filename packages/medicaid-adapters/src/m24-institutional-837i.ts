// M24 institutional document boundary. This package owns Medicaid policy qualification; X12 syntax and
// serialization remain in @chartwarden/x12-837-client. No transport, clock, database, persistence or logging.
import {
  type Claim837iInput,
  type StediClaimJson,
  build837iClaim,
  buildStediClaimJson,
  parse999,
  read277caStatusDates,
  routeAckEvent,
  transactionSetControlNumber,
} from "@chartwarden/x12-837-client";
import { X12FormatError, tokenizeInterchange } from "@chartwarden/x12-837-client";

export type M24DocumentGapCode =
  | "M24_SOURCE_NOT_AUTHORITATIVE"
  | "M24_PAYER_RESPONSIBILITY_UNRESOLVED"
  | "M24_PROGRAM_IDENTITY_UNRESOLVED"
  | "M24_PROVIDER_OWNERSHIP_UNVERIFIED"
  | "M24_SERVICE_DATES_UNRESOLVED"
  | "M24_QUANTITY_UNRESOLVED"
  | "M24_CODING_UNQUALIFIED"
  | "MEDICAID_RATE_POLICY_UNRESOLVED"
  | "M24_AUTHORIZATION_UNRESOLVED"
  | "M24_FORMAT_NOT_QUALIFIED"
  | "M24_ROUTE_NOT_QUALIFIED"
  | "M24_SECONDARY_PAYER_UNSUPPORTED"
  | "M24_SECONDARY_ROOM_AND_BOARD_UNSUPPORTED"
  | "M24_DOCUMENT_INVALID";

export interface M24DocumentGap {
  readonly code: M24DocumentGapCode;
  /** Field path only; never carries a supplied value. */
  readonly field: string;
}

export type M24DocumentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly gaps: readonly M24DocumentGap[] };

const qualifiedFactsMarker: unique symbol = Symbol("M24 qualified facts from authoritative reader");

export interface M24QualifiedClaimFacts {
  /** Opaque capability set only inside this package after trusted server-side reads and checks. */
  readonly [qualifiedFactsMarker]: true;
  readonly authority: "server_reader";
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientReference: string;
  readonly admissionReference: string;
  readonly canonicalPayerId: string;
  readonly programId: string;
  readonly claimKind: "primary_medicaid_hospice" | "other";
  readonly sourceClaimId: string;
  readonly claimTotalCents: number;
  readonly lineEvidence: readonly M24LineEvidence[];
  readonly evidenceReferences: {
    readonly payerResponsibility: readonly string[];
    readonly providerOwnership: readonly string[];
    readonly ratePolicy: readonly string[];
    readonly authorization: readonly string[];
    readonly formatQualification: readonly string[];
    readonly routeQualification: readonly string[];
  };
  readonly qualification: {
    readonly payerResponsibility: "verified" | "unresolved";
    readonly programIdentity: "verified" | "unresolved";
    readonly providerOwnership: "verified" | "unresolved";
    readonly serviceDates: "verified" | "unresolved";
    readonly quantity: "verified" | "unresolved";
    readonly coding: "verified" | "unresolved";
    readonly rate: "verified" | "unresolved";
    readonly authorization: "verified" | "unresolved";
    readonly format: "verified" | "unresolved";
    readonly route: "verified" | "unresolved";
  };
  /** Transient, server-loaded identity and parties. Never persist or log the resulting document. */
  readonly x12Input: Claim837iInput;
  /** Explicitly confirms secondary R&B was excluded from this claim window. */
  readonly secondaryRoomAndBoardIncluded: boolean;
}

type M24DocumentFacts = Omit<M24QualifiedClaimFacts, typeof qualifiedFactsMarker | "authority"> & {
  readonly authority: "server_reader" | "synthetic_fixture";
};

export interface M24LineEvidence {
  readonly sourceLineReference: string;
  readonly sourceLocRecordReferences: readonly string[];
  readonly quantityEvidenceReference: string;
  /**
   * What the line's quantity was read from. An 837I SV204 basis is `DA` or `UN` only, so there is no minutes or hours
   * source: hourly care must be converted to `UN` under a payer policy this mapper does not have, and is refused.
   */
  readonly quantitySource:
    | "verified_daily_units"
    | "verified_other_units"
    | "synthetic_daily_units"
    | "synthetic_other_units";
}

export interface M24InstitutionalLine {
  readonly sourceLineReference: string;
  readonly sourceLocRecordReferences: readonly string[];
  readonly quantityEvidenceReference: string;
  readonly revenueCode: string;
  readonly procedureCode: string | null;
  readonly serviceFrom: string;
  readonly serviceThrough: string | null;
  readonly quantity: number;
  readonly unitBasis: "UN" | "DA";
  readonly chargeCents: number;
}

/** Vendor-neutral claim facts, with patient identifiers kept only in the transient render input. */
export interface M24InstitutionalDocument {
  readonly source: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly patientReference: string;
    readonly admissionReference: string;
    readonly claimId: string;
    readonly canonicalPayerId: string;
    readonly programId: string;
  };
  readonly evidenceReferences: M24QualifiedClaimFacts["evidenceReferences"];
  readonly controlNumber: string;
  readonly typeOfBill: string;
  readonly frequency: string;
  readonly statementFrom: string;
  readonly statementThrough: string;
  readonly diagnosisCodes: readonly string[];
  readonly lines: readonly M24InstitutionalLine[];
  readonly totalChargeCents: number;
  /** Raw X12 and Stedi JSON contain subscriber details; transient output, never persistence/audit evidence. */
  readonly x12: string;
  readonly stediJson: StediClaimJson;
}

const qualificationGaps: readonly [
  keyof M24QualifiedClaimFacts["qualification"],
  M24DocumentGapCode,
][] = [
  ["payerResponsibility", "M24_PAYER_RESPONSIBILITY_UNRESOLVED"],
  ["programIdentity", "M24_PROGRAM_IDENTITY_UNRESOLVED"],
  ["providerOwnership", "M24_PROVIDER_OWNERSHIP_UNVERIFIED"],
  ["serviceDates", "M24_SERVICE_DATES_UNRESOLVED"],
  ["quantity", "M24_QUANTITY_UNRESOLVED"],
  ["coding", "M24_CODING_UNQUALIFIED"],
  ["rate", "MEDICAID_RATE_POLICY_UNRESOLVED"],
  ["authorization", "M24_AUTHORIZATION_UNRESOLVED"],
  ["format", "M24_FORMAT_NOT_QUALIFIED"],
  ["route", "M24_ROUTE_NOT_QUALIFIED"],
];

const fail = (code: M24DocumentGapCode, field: string): M24DocumentResult<never> => ({
  ok: false,
  gaps: [{ code, field }],
});

function serviceDayCount(from: string, through: string): number | null {
  const parse = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
      ? Math.floor(timestamp / 86_400_000)
      : null;
  };
  const start = parse(from);
  const end = parse(through);
  return start === null || end === null || end < start ? null : end - start + 1;
}

/**
 * Index of the first line that bills the same revenue + procedure code + modifier set for a day an earlier line already
 * covers (a double bill of the same service), or null. Lines for different codes, or for the same code under different
 * modifiers (e.g. a professional/technical split), may legitimately share days. Modifiers compare as a set, so a
 * reordering does not make a double bill look distinct.
 * Dates are compared as ISO strings; a line without a through date covers its own day only.
 */
function firstOverlappingLine(lines: Claim837iInput["claim"]["lines"]): number | null {
  const covered = new Map<string, { from: string; through: string }[]>();
  for (const [index, line] of lines.entries()) {
    const key = `${line.revenueCode}\u0000${line.hcpcs ?? ""}\u0000${[...(line.modifiers ?? [])].sort().join(",")}`;
    const span = { from: line.serviceDate, through: line.serviceThroughDate ?? line.serviceDate };
    const earlier = covered.get(key) ?? [];
    if (earlier.some((other) => span.from <= other.through && other.from <= span.through)) {
      return index;
    }
    covered.set(key, [...earlier, span]);
  }
  return null;
}

function documentFromInput(facts: M24DocumentFacts): M24DocumentResult<M24InstitutionalDocument> {
  if (facts.authority !== "server_reader" && facts.authority !== "synthetic_fixture") {
    return fail("M24_SOURCE_NOT_AUTHORITATIVE", "source.authority");
  }
  if (facts.claimKind !== "primary_medicaid_hospice") {
    return fail("M24_PAYER_RESPONSIBILITY_UNRESOLVED", "claimKind");
  }
  if (facts.secondaryRoomAndBoardIncluded) {
    return fail("M24_SECONDARY_ROOM_AND_BOARD_UNSUPPORTED", "secondaryRoomAndBoardIncluded");
  }
  if ((facts.x12Input.claim.otherPayers ?? []).length > 0) {
    return fail("M24_SECONDARY_PAYER_UNSUPPORTED", "claim.otherPayers");
  }
  const gaps: M24DocumentGap[] = qualificationGaps
    .filter(([dimension]) => facts.qualification[dimension] !== "verified")
    .map(([dimension, code]) => ({ code, field: `qualification.${dimension}` }));
  if (gaps.length > 0) return { ok: false, gaps };
  for (const [dimension, references] of Object.entries(facts.evidenceReferences)) {
    if (references.length === 0) {
      return fail("M24_DOCUMENT_INVALID", `evidenceReferences.${dimension}`);
    }
  }
  if (
    facts.organizationId === "" ||
    facts.providerEntityId === "" ||
    facts.patientReference === "" ||
    facts.admissionReference === "" ||
    facts.canonicalPayerId === "" ||
    facts.programId === "" ||
    facts.sourceClaimId === ""
  ) {
    return fail("M24_DOCUMENT_INVALID", "source");
  }
  const lineTotalCents = facts.x12Input.claim.lines.reduce(
    (sum, line) => sum + line.chargeCents,
    0,
  );
  if (!Number.isSafeInteger(facts.claimTotalCents) || facts.claimTotalCents !== lineTotalCents) {
    return fail("M24_DOCUMENT_INVALID", "claimTotalCents");
  }
  if (facts.lineEvidence.length !== facts.x12Input.claim.lines.length) {
    return fail("M24_QUANTITY_UNRESOLVED", "lineEvidence");
  }
  for (const [index, line] of facts.x12Input.claim.lines.entries()) {
    const evidence = facts.lineEvidence[index];
    if (
      evidence === undefined ||
      evidence.sourceLineReference === "" ||
      evidence.quantityEvidenceReference === "" ||
      evidence.sourceLocRecordReferences.length === 0
    ) {
      return fail("M24_QUANTITY_UNRESOLVED", `lineEvidence[${index}]`);
    }
    if (line.serviceThroughDate === undefined) {
      return fail("M24_SERVICE_DATES_UNRESOLVED", `claim.lines[${index}].serviceThroughDate`);
    }
    if (line.unitBasis !== undefined && line.unitBasis !== "UN" && line.unitBasis !== "DA") {
      // Types forbid this; untyped input (HR, MJ, ...) is refused rather than serialized into SV204.
      return fail("M24_QUANTITY_UNRESOLVED", `claim.lines[${index}].unitBasis`);
    }
    if (line.unitBasis === "DA") {
      const days = serviceDayCount(line.serviceDate, line.serviceThroughDate);
      if (
        days === null ||
        line.units !== days ||
        !["verified_daily_units", "synthetic_daily_units"].includes(evidence.quantitySource)
      ) {
        return fail("M24_QUANTITY_UNRESOLVED", `claim.lines[${index}].units`);
      }
    } else if (
      evidence.quantitySource !== "verified_other_units" &&
      evidence.quantitySource !== "synthetic_other_units"
    ) {
      return fail("M24_QUANTITY_UNRESOLVED", `claim.lines[${index}].units`);
    }
  }
  const overlap = firstOverlappingLine(facts.x12Input.claim.lines);
  if (overlap !== null) return fail("M24_DOCUMENT_INVALID", `claim.lines[${overlap}].serviceDate`);
  if (facts.x12Input.claimFilingIndicator !== "MC" || facts.x12Input.commercial !== undefined) {
    return fail("M24_DOCUMENT_INVALID", "claimFilingIndicator");
  }
  try {
    const x12 = build837iClaim(facts.x12Input);
    const stediJson = buildStediClaimJson(facts.x12Input);
    const claim = facts.x12Input.claim;
    const { segments } = tokenizeInterchange(x12);
    const diagnosisCodes = segments
      .filter((segment) => segment[0] === "HI")
      .flatMap((segment) => segment.slice(1))
      .filter((element) => element.startsWith("ABK:") || element.startsWith("ABF:"))
      .map((element) => element.split(":")[1] ?? "");
    return {
      ok: true,
      value: {
        source: {
          organizationId: facts.organizationId,
          providerEntityId: facts.providerEntityId,
          patientReference: facts.patientReference,
          admissionReference: facts.admissionReference,
          claimId: facts.sourceClaimId,
          canonicalPayerId: facts.canonicalPayerId,
          programId: facts.programId,
        },
        evidenceReferences: facts.evidenceReferences,
        controlNumber: claim.controlNumber,
        typeOfBill: `81${claim.frequency}`,
        frequency: claim.frequency,
        statementFrom: claim.statementFromDate,
        statementThrough: claim.statementThroughDate,
        diagnosisCodes,
        lines: claim.lines.map((line, index) => ({
          sourceLineReference: facts.lineEvidence[index]!.sourceLineReference,
          sourceLocRecordReferences: facts.lineEvidence[index]!.sourceLocRecordReferences,
          quantityEvidenceReference: facts.lineEvidence[index]!.quantityEvidenceReference,
          revenueCode: line.revenueCode,
          procedureCode: line.hcpcs ?? null,
          serviceFrom: line.serviceDate,
          serviceThrough: line.serviceThroughDate ?? null,
          quantity: line.units,
          unitBasis: line.unitBasis ?? "UN",
          chargeCents: line.chargeCents,
        })),
        totalChargeCents: facts.claimTotalCents,
        x12,
        stediJson,
      },
    };
  } catch (error) {
    // Only field names escape the serializer. Don't pass exception messages or input values across this boundary.
    if (error instanceof X12FormatError) return fail("M24_DOCUMENT_INVALID", "x12");
    if (typeof error === "object" && error !== null && "field" in error) {
      const field = typeof error.field === "string" ? error.field : "x12";
      return fail("M24_DOCUMENT_INVALID", field);
    }
    return fail("M24_DOCUMENT_INVALID", "x12");
  }
}

/**
 * TEST ONLY. Mints the capability marker that `mapQualifiedM24ClaimToInstitutionalDocument` requires, so a test can
 * exercise every refusal behind it. Deliberately not re-exported from the package root or `./testing`; production code
 * has no way to import it (the package `exports` map exposes only those two entries).
 */
export function mintQualifiedFactsForTestOnly(
  facts: Omit<M24QualifiedClaimFacts, typeof qualifiedFactsMarker>,
): M24QualifiedClaimFacts {
  return { ...facts, [qualifiedFactsMarker]: true };
}

/** Server-only mapper. Current L3 evidence leaves rate, payer format, route and policy unqualified. */
export function mapQualifiedM24ClaimToInstitutionalDocument(
  facts: M24QualifiedClaimFacts,
): M24DocumentResult<M24InstitutionalDocument> {
  if (
    typeof facts !== "object" ||
    facts === null ||
    Object.getOwnPropertyDescriptor(facts, qualifiedFactsMarker)?.value !== true
  ) {
    return fail("M24_SOURCE_NOT_AUTHORITATIVE", "source.authority");
  }
  if (facts.authority !== "server_reader") {
    return fail("M24_SOURCE_NOT_AUTHORITATIVE", "source.authority");
  }
  return documentFromInput(facts);
}

export const M24_SYNTHETIC_FIXTURE_MARKER = "CHARTWARDEN_SYNTHETIC_837I_FIXTURE_V1" as const;

export interface SyntheticM24ClaimFixture {
  readonly marker: typeof M24_SYNTHETIC_FIXTURE_MARKER;
  readonly fixtureId: string;
  readonly organizationId: `synthetic:${string}`;
  readonly providerEntityId: `synthetic:${string}`;
  readonly patientReference: `synthetic:${string}`;
  readonly admissionReference: `synthetic:${string}`;
  readonly canonicalPayerId: `synthetic:${string}`;
  readonly programId: `synthetic:${string}`;
  readonly sourceClaimId: `synthetic:${string}`;
  readonly claimTotalCents: number;
  readonly lineEvidence: readonly M24LineEvidence[];
  readonly claimInput: Claim837iInput;
  readonly secondaryRoomAndBoardIncluded: false;
}

const SYNTHETIC_ID = /^synthetic:[A-Za-z0-9._:-]{1,80}$/;
const SYNTHETIC_VENDOR_PAYER_ID = /^SYNTHETIC-[A-Za-z0-9-]{1,48}$/;
const FIXTURE_ID = /^[A-Za-z0-9._-]{1,48}$/;

/** Test-only builder, exported only from the `@chartwarden/medicaid-adapters/testing` package subpath. */
export function buildSyntheticM24InstitutionalDocument(
  fixture: SyntheticM24ClaimFixture,
): M24DocumentResult<M24InstitutionalDocument> {
  if (
    fixture.marker !== M24_SYNTHETIC_FIXTURE_MARKER ||
    !FIXTURE_ID.test(fixture.fixtureId) ||
    !SYNTHETIC_ID.test(fixture.organizationId) ||
    !SYNTHETIC_ID.test(fixture.providerEntityId) ||
    !SYNTHETIC_ID.test(fixture.patientReference) ||
    !SYNTHETIC_ID.test(fixture.admissionReference) ||
    !SYNTHETIC_ID.test(fixture.canonicalPayerId) ||
    !SYNTHETIC_ID.test(fixture.programId) ||
    !SYNTHETIC_ID.test(fixture.sourceClaimId)
  ) {
    return fail("M24_SOURCE_NOT_AUTHORITATIVE", "syntheticFixture.marker");
  }
  if (fixture.secondaryRoomAndBoardIncluded !== false) {
    return fail("M24_SECONDARY_ROOM_AND_BOARD_UNSUPPORTED", "syntheticFixture");
  }
  if (fixture.claimInput.envelope.usage !== "T") {
    return fail("M24_DOCUMENT_INVALID", "envelope.usage");
  }
  if (fixture.claimInput.claim.lines.some((line) => line.serviceThroughDate === undefined)) {
    return fail("M24_SERVICE_DATES_UNRESOLVED", "claim.lines.serviceThroughDate");
  }
  if (fixture.claimInput.claim.lines.some((line) => line.unitBasis === undefined)) {
    return fail("M24_QUANTITY_UNRESOLVED", "claim.lines.unitBasis");
  }
  const document = documentFromInput({
    authority: "synthetic_fixture",
    organizationId: fixture.organizationId,
    providerEntityId: fixture.providerEntityId,
    patientReference: fixture.patientReference,
    admissionReference: fixture.admissionReference,
    canonicalPayerId: fixture.canonicalPayerId,
    programId: fixture.programId,
    claimKind: "primary_medicaid_hospice",
    sourceClaimId: fixture.sourceClaimId,
    claimTotalCents: fixture.claimTotalCents,
    lineEvidence: fixture.lineEvidence,
    evidenceReferences: {
      payerResponsibility: [`synthetic:${fixture.fixtureId}:payer-responsibility`],
      providerOwnership: [`synthetic:${fixture.fixtureId}:provider-ownership`],
      ratePolicy: [`synthetic:${fixture.fixtureId}:rate-policy`],
      authorization: [`synthetic:${fixture.fixtureId}:authorization`],
      formatQualification: [`synthetic:${fixture.fixtureId}:format`],
      routeQualification: [`synthetic:${fixture.fixtureId}:route`],
    },
    qualification: {
      payerResponsibility: "verified",
      programIdentity: "verified",
      providerOwnership: "verified",
      serviceDates: "verified",
      quantity: "verified",
      coding: "verified",
      rate: "verified",
      authorization: "verified",
      format: "verified",
      route: "verified",
    },
    x12Input: fixture.claimInput,
    secondaryRoomAndBoardIncluded: false,
  });
  return document;
}

export interface SyntheticClearinghouseRequest {
  readonly vendor: "stedi" | "claimmd";
  readonly transport: "offline-contract-only";
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programId: string;
  readonly transaction: "837I";
  readonly vendorPayerId: string;
  readonly idempotencyKey: string;
  readonly request:
    | {
        readonly contentType: "application/json";
        readonly headers: { readonly "Idempotency-Key": string };
        readonly body: { readonly x12: string };
      }
    | {
        readonly contentType: "application/json";
        readonly headers: { readonly "Idempotency-Key": string };
        readonly body: StediClaimJson;
      }
    | {
        readonly contentType: "multipart/form-data";
        readonly fields: readonly ["AccountKey", "Filename", "File"];
        readonly filename: string;
        readonly fileContentType: "text/plain";
        readonly file: string;
      };
}

export type M24RouteFailure =
  | "no-selected-clearinghouse"
  | "ambiguous-clearinghouse"
  | "wrong-organization"
  | "wrong-provider-entity"
  | "payer-mapping-missing"
  | "payer-mapping-conflict"
  | "expired-enrollment"
  | "provider-participation-unverified"
  | "format-not-qualified"
  | "payer-destination-unqualified"
  | "service-period-not-covered"
  | "unsupported-claim-type";

export interface SyntheticRouteScope {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programId: string;
  readonly transaction: "837I";
  readonly claimType: "primary-medicaid-hospice" | "other";
  readonly serviceFrom: string;
  readonly serviceThrough: string;
}

export interface SyntheticRouteCandidate extends SyntheticRouteScope {
  readonly vendor: "stedi" | "claimmd";
  readonly vendorPayerId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveThrough: string | null;
  readonly enrollment: "verified" | "expired" | "missing" | "pending";
  readonly providerParticipation: "verified" | "unverified" | "missing";
  readonly payerMapping: "verified" | "unverified" | "missing" | "conflicting";
  readonly formatQualification: "verified" | "unverified" | "missing";
  readonly destinationQualification: "verified" | "unverified" | "missing";
}

export type SyntheticRouteResult =
  | { readonly ok: true; readonly candidate: SyntheticRouteCandidate; readonly offlineOnly: true }
  | { readonly ok: false; readonly reason: M24RouteFailure };

/** Scope-safe route resolver for the offline qualification harness; it never binds a transport. */
export function resolveSyntheticRoute(
  scope: SyntheticRouteScope,
  selectedVendor: "stedi" | "claimmd" | null,
  candidates: readonly SyntheticRouteCandidate[],
): SyntheticRouteResult {
  if (scope.claimType !== "primary-medicaid-hospice") {
    return { ok: false, reason: "unsupported-claim-type" };
  }
  if (selectedVendor === null) return { ok: false, reason: "no-selected-clearinghouse" };
  const selected = candidates.filter((candidate) => candidate.vendor === selectedVendor);
  if (selected.length === 0) return { ok: false, reason: "no-selected-clearinghouse" };
  const organizationCandidates = selected.filter(
    (candidate) => candidate.organizationId === scope.organizationId,
  );
  if (organizationCandidates.length === 0) return { ok: false, reason: "wrong-organization" };
  const providerCandidates = organizationCandidates.filter(
    (candidate) => candidate.providerEntityId === scope.providerEntityId,
  );
  if (providerCandidates.length === 0) return { ok: false, reason: "wrong-provider-entity" };
  const payerCandidates = providerCandidates.filter(
    (candidate) =>
      candidate.canonicalPayerId === scope.canonicalPayerId &&
      candidate.programId === scope.programId &&
      candidate.transaction === scope.transaction,
  );
  if (payerCandidates.length === 0) {
    return { ok: false, reason: "payer-destination-unqualified" };
  }
  const routeCandidates = payerCandidates.filter(
    (candidate) =>
      candidate.effectiveFrom <= scope.serviceFrom &&
      (candidate.effectiveThrough === null || candidate.effectiveThrough >= scope.serviceThrough),
  );
  if (routeCandidates.length === 0) return { ok: false, reason: "service-period-not-covered" };
  if (routeCandidates.length > 1) return { ok: false, reason: "ambiguous-clearinghouse" };
  const candidate = routeCandidates[0];
  if (candidate === undefined) return { ok: false, reason: "no-selected-clearinghouse" };
  if (
    candidate.canonicalPayerId !== scope.canonicalPayerId ||
    candidate.programId !== scope.programId ||
    candidate.transaction !== scope.transaction
  ) {
    return { ok: false, reason: "payer-destination-unqualified" };
  }
  if (candidate.vendorPayerId === null) return { ok: false, reason: "payer-mapping-missing" };
  if (
    !SYNTHETIC_ID.test(candidate.organizationId) ||
    !SYNTHETIC_ID.test(candidate.providerEntityId) ||
    !SYNTHETIC_ID.test(candidate.canonicalPayerId) ||
    !SYNTHETIC_ID.test(candidate.programId) ||
    !SYNTHETIC_VENDOR_PAYER_ID.test(candidate.vendorPayerId)
  ) {
    return { ok: false, reason: "payer-destination-unqualified" };
  }
  if (candidate.payerMapping === "conflicting") {
    return { ok: false, reason: "payer-mapping-conflict" };
  }
  if (candidate.enrollment === "expired") return { ok: false, reason: "expired-enrollment" };
  if (candidate.enrollment !== "verified") {
    return { ok: false, reason: "payer-destination-unqualified" };
  }
  if (candidate.providerParticipation !== "verified") {
    return { ok: false, reason: "provider-participation-unverified" };
  }
  if (candidate.payerMapping !== "verified") {
    return { ok: false, reason: "payer-mapping-missing" };
  }
  if (candidate.formatQualification !== "verified") {
    return { ok: false, reason: "format-not-qualified" };
  }
  if (candidate.destinationQualification !== "verified") {
    return { ok: false, reason: "payer-destination-unqualified" };
  }
  return { ok: true, candidate, offlineOnly: true };
}

/** Offline-only, exact-shape vendor request constructors. No vendor transport is imported or invoked. */
export function mapSyntheticVendorRequest(
  route: SyntheticRouteCandidate,
  fixture: SyntheticM24ClaimFixture,
  document: M24InstitutionalDocument,
  representation: "json" | "raw-x12" = "raw-x12",
): M24DocumentResult<SyntheticClearinghouseRequest> {
  const mappedVendorPayerId = route.vendorPayerId;
  if (
    fixture.marker !== M24_SYNTHETIC_FIXTURE_MARKER ||
    mappedVendorPayerId === null ||
    !SYNTHETIC_VENDOR_PAYER_ID.test(mappedVendorPayerId) ||
    route.effectiveFrom > document.statementFrom ||
    (route.effectiveThrough !== null && route.effectiveThrough < document.statementThrough) ||
    route.serviceFrom !== document.statementFrom ||
    route.serviceThrough !== document.statementThrough ||
    route.organizationId !== fixture.organizationId ||
    route.providerEntityId !== fixture.providerEntityId ||
    route.canonicalPayerId !== fixture.canonicalPayerId ||
    route.programId !== fixture.programId ||
    route.enrollment !== "verified" ||
    route.providerParticipation !== "verified" ||
    route.payerMapping !== "verified" ||
    route.formatQualification !== "verified" ||
    route.destinationQualification !== "verified" ||
    route.transaction !== "837I" ||
    route.claimType !== "primary-medicaid-hospice" ||
    document.source.organizationId !== fixture.organizationId ||
    document.source.providerEntityId !== fixture.providerEntityId ||
    document.source.canonicalPayerId !== fixture.canonicalPayerId ||
    document.source.programId !== fixture.programId ||
    document.source.patientReference !== fixture.patientReference ||
    document.source.admissionReference !== fixture.admissionReference ||
    document.source.claimId !== fixture.sourceClaimId ||
    document.stediJson.tradingPartnerServiceId !== mappedVendorPayerId
  ) {
    return fail("M24_ROUTE_NOT_QUALIFIED", "vendorPayerId");
  }
  const common = {
    vendor: route.vendor,
    transport: "offline-contract-only" as const,
    organizationId: fixture.organizationId,
    providerEntityId: fixture.providerEntityId,
    canonicalPayerId: fixture.canonicalPayerId,
    programId: fixture.programId,
    transaction: "837I" as const,
    vendorPayerId: mappedVendorPayerId,
    idempotencyKey: syntheticIdempotencyKey(
      route.vendor,
      fixture.organizationId,
      fixture.providerEntityId,
      fixture.fixtureId,
      document.controlNumber,
    ),
  };
  if (route.vendor === "stedi" && representation === "json") {
    return {
      ok: true,
      value: {
        ...common,
        request: {
          contentType: "application/json",
          headers: { "Idempotency-Key": common.idempotencyKey },
          body: document.stediJson,
        },
      },
    };
  }
  if (route.vendor === "stedi") {
    return {
      ok: true,
      value: {
        ...common,
        request: {
          contentType: "application/json",
          headers: { "Idempotency-Key": common.idempotencyKey },
          body: { x12: document.x12 },
        },
      },
    };
  }
  if (representation !== "raw-x12") {
    return fail("M24_FORMAT_NOT_QUALIFIED", "vendor.format");
  }
  return {
    ok: true,
    value: {
      ...common,
      request: {
        contentType: "multipart/form-data",
        fields: ["AccountKey", "Filename", "File"],
        filename: `cw-${fixture.fixtureId}.837`,
        fileContentType: "text/plain",
        file: document.x12,
      },
    },
  };
}

export type SyntheticReceiptOutcome = "not-sent" | "received" | "unknown";
export type SyntheticAckKind = "transport_receipt" | "999" | "277CA";
/**
 * `received` is a 277CA A1 receipt: the payer has the claim, which (X12 code list 507) does not mean it was accepted for
 * adjudication. Only a 277CA can carry it; it never maps to an acceptance decision.
 */
export type SyntheticAckDisposition = "accepted" | "rejected" | "received";

export interface SyntheticSubmissionIdentity {
  readonly vendor: "stedi" | "claimmd";
  readonly usage: "test";
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly canonicalPayerId: string;
  readonly programId: string;
  /** CLM01 / BHT03 / the 277CA TRN02 claim identifier. */
  readonly controlNumber: string;
  /** ST02, the id a 999 echoes in AK202 for the acknowledged transaction set (not the CLM01). */
  readonly transactionSetControlNumber: string;
  /** GS06, the id a 999 echoes in AK102. */
  readonly functionalGroupControlNumber: string;
  readonly idempotencyKey: string;
}

function syntheticIdempotencyKey(
  vendor: "stedi" | "claimmd",
  organizationId: string,
  providerEntityId: string,
  fixtureId: string,
  controlNumber: string,
): string {
  return `synthetic:${vendor}:${organizationId}:${providerEntityId}:${fixtureId}:${controlNumber}`;
}

export interface SyntheticAcknowledgment {
  readonly eventId: string;
  readonly identity: SyntheticSubmissionIdentity;
  readonly kind: SyntheticAckKind;
  readonly disposition: SyntheticAckDisposition;
  readonly sequence: number;
}

export type SyntheticAckDecision =
  | "transport-received"
  | "transport-rejected"
  | "clearinghouse-accepted"
  | "clearinghouse-rejected"
  | "payer-acknowledged"
  | "payer-received"
  | "payer-rejected"
  | "duplicate"
  | "out-of-order"
  | "unknown-control-number"
  | "identity-mismatch"
  | "conflict";

const sameIdentity = (a: SyntheticSubmissionIdentity, b: SyntheticSubmissionIdentity): boolean =>
  a.vendor === b.vendor &&
  a.usage === b.usage &&
  a.organizationId === b.organizationId &&
  a.providerEntityId === b.providerEntityId &&
  a.canonicalPayerId === b.canonicalPayerId &&
  a.programId === b.programId &&
  a.controlNumber === b.controlNumber &&
  a.transactionSetControlNumber === b.transactionSetControlNumber &&
  a.functionalGroupControlNumber === b.functionalGroupControlNumber &&
  a.idempotencyKey === b.idempotencyKey;

/** Pure correlation only. It cannot mutate a claim, submission row, outbox or financial ledger. */
export function correlateSyntheticAcknowledgment(
  expected: SyntheticSubmissionIdentity,
  acknowledgment: SyntheticAcknowledgment,
  prior: readonly SyntheticAcknowledgment[] = [],
): SyntheticAckDecision {
  if (acknowledgment.identity.controlNumber !== expected.controlNumber) {
    return "unknown-control-number";
  }
  if (!sameIdentity(expected, acknowledgment.identity)) return "identity-mismatch";
  if (acknowledgment.disposition === "received" && acknowledgment.kind !== "277CA")
    return "conflict";
  if (prior.some((event) => event.eventId === acknowledgment.eventId)) return "duplicate";
  const latest = prior.reduce((max, event) => Math.max(max, event.sequence), 0);
  const conflicting = prior.find(
    (event) =>
      event.sequence === acknowledgment.sequence &&
      (event.kind !== acknowledgment.kind || event.disposition !== acknowledgment.disposition),
  );
  if (conflicting) return "conflict";
  if (acknowledgment.sequence <= latest) return "out-of-order";
  if (acknowledgment.kind === "transport_receipt") {
    return acknowledgment.disposition === "accepted" ? "transport-received" : "transport-rejected";
  }
  if (acknowledgment.kind === "999") {
    return acknowledgment.disposition === "accepted"
      ? "clearinghouse-accepted"
      : "clearinghouse-rejected";
  }
  if (acknowledgment.disposition === "received") return "payer-received";
  return acknowledgment.disposition === "accepted" ? "payer-acknowledged" : "payer-rejected";
}

export function classifySyntheticRetry(
  outcome: SyntheticReceiptOutcome,
): "retry-safe-before-send" | "hold-indeterminate" | "do-not-resend-received" {
  switch (outcome) {
    case "not-sent":
      return "retry-safe-before-send";
    case "unknown":
      return "hold-indeterminate";
    case "received":
      return "do-not-resend-received";
  }
}

export function createSyntheticSubmissionIdentity(
  fixture: SyntheticM24ClaimFixture,
  vendor: "stedi" | "claimmd",
): SyntheticSubmissionIdentity {
  if (fixture.marker !== M24_SYNTHETIC_FIXTURE_MARKER || !FIXTURE_ID.test(fixture.fixtureId)) {
    throw new Error("synthetic submission identity requires an explicit fixture");
  }
  const controlNumber = fixture.claimInput.claim.controlNumber;
  return {
    vendor,
    usage: "test",
    organizationId: fixture.organizationId,
    providerEntityId: fixture.providerEntityId,
    canonicalPayerId: fixture.canonicalPayerId,
    programId: fixture.programId,
    controlNumber,
    transactionSetControlNumber: transactionSetControlNumber(
      fixture.claimInput.envelope.interchangeControlNumber,
    ),
    functionalGroupControlNumber: String(fixture.claimInput.envelope.interchangeControlNumber),
    // Deterministic and scoped; excludes subscriber data and payload content.
    idempotencyKey: syntheticIdempotencyKey(
      vendor,
      fixture.organizationId,
      fixture.providerEntityId,
      fixture.fixtureId,
      controlNumber,
    ),
  };
}

/** Reuses the shared 999 parser and stage router; parse failures return a content-free refusal. */
export function inspectSynthetic999(
  expected: SyntheticSubmissionIdentity,
  raw: string,
  eventId: string,
  sequence: number,
):
  | { readonly ok: true; readonly acknowledgment: SyntheticAcknowledgment }
  | { readonly ok: false; readonly reason: "invalid-ack" | "identity-mismatch" } {
  try {
    const parsed = parse999(raw);
    if (
      parsed.acknowledgedGroupControlNumber !== expected.functionalGroupControlNumber ||
      !parsed.transactionSets.some(
        (transactionSet) => transactionSet.controlNumber === expected.transactionSetControlNumber,
      )
    ) {
      return { ok: false, reason: "identity-mismatch" };
    }
    const routed = routeAckEvent({
      eventId,
      controlNumber: expected.controlNumber,
      reasonCodes: parsed.errors.map((error) => error.code),
      occurredAt: parsed.functionalGroupDate ?? parsed.interchangeDate ?? "",
      stage: "clearinghouse",
      disposition: parsed.outcome === "accepted" ? "accepted" : "rejected",
    });
    return {
      ok: true,
      acknowledgment: {
        eventId,
        identity: expected,
        kind: routed.kind === "ack_999" ? "999" : "277CA",
        disposition: routed.outcome === "accepted" ? "accepted" : "rejected",
        sequence,
      },
    };
  } catch {
    return { ok: false, reason: "invalid-ack" };
  }
}

/**
 * 277CA claim status categories (X12 code list 507, STC01-1) that decide the disposition. A1 acknowledges receipt only
 * ("does not mean that the claim has been accepted for adjudication"), A2 acceptance into adjudication; A3/A6/A7/A8
 * return or reject the claim. Every other category (A0 forwarded, A4 not found, A5 split, E*, ...) does not settle
 * received, accepted or rejected and is refused instead of guessed.
 */
const RECEIVED_277CA_CATEGORIES: readonly string[] = ["A1"];
const ACCEPTED_277CA_CATEGORIES: readonly string[] = ["A2"];
const REJECTED_277CA_CATEGORIES: readonly string[] = ["A3", "A6", "A7", "A8"];

/** Reuses the shared 277CA control/date reader; the disposition is read from the claim's STC01 category. */
export function inspectSynthetic277ca(
  expected: SyntheticSubmissionIdentity,
  raw: string,
):
  | {
      readonly ok: true;
      readonly claimControlNumber: string;
      readonly statusEffectiveDate: string | null;
      readonly stage: "payer";
      readonly disposition: SyntheticAckDisposition;
    }
  | { readonly ok: false; readonly reason: "invalid-ack" | "identity-mismatch" } {
  try {
    const claim = read277caStatusDates(raw).find(
      (item) => item.claimControlNumber === expected.controlNumber,
    );
    if (claim === undefined) return { ok: false, reason: "identity-mismatch" };
    const category = claim.statusCategoryCode ?? "";
    const disposition: SyntheticAckDisposition | null = RECEIVED_277CA_CATEGORIES.includes(category)
      ? "received"
      : ACCEPTED_277CA_CATEGORIES.includes(category)
        ? "accepted"
        : REJECTED_277CA_CATEGORIES.includes(category)
          ? "rejected"
          : null;
    if (disposition === null) return { ok: false, reason: "invalid-ack" };
    // M23's ack alphabet has no receipt-only state, so a receipt is not routed (routing would call it accepted).
    if (disposition === "received") {
      return {
        ok: true,
        claimControlNumber: expected.controlNumber,
        statusEffectiveDate: claim.statusEffectiveDate,
        stage: "payer",
        disposition,
      };
    }
    const routed = routeAckEvent({
      eventId: "synthetic-277ca-inspection",
      controlNumber: expected.controlNumber,
      reasonCodes: [],
      occurredAt: claim.statusEffectiveDate ?? "",
      stage: "payer",
      disposition,
    });
    return {
      ok: true,
      claimControlNumber: expected.controlNumber,
      statusEffectiveDate: claim.statusEffectiveDate,
      stage: "payer",
      disposition: routed.outcome === "accepted" ? "accepted" : "rejected",
    };
  } catch {
    return { ok: false, reason: "invalid-ack" };
  }
}

export type SyntheticReservationOutcome =
  | "reserved"
  | "replayed-identical"
  | "idempotency-conflict"
  | "control-number-conflict";

/** Ephemeral test-only attempt registry. Payload bytes stay in this object only and are never hashed or logged. */
export class InMemorySyntheticSubmissionLedger {
  private readonly byKey = new Map<
    string,
    { identity: SyntheticSubmissionIdentity; payload: string }
  >();
  private readonly byControl = new Map<string, string>();

  reserve(identity: SyntheticSubmissionIdentity, payload: string): SyntheticReservationOutcome {
    const scope = `${identity.organizationId}\u0000${identity.providerEntityId}\u0000${identity.vendor}\u0000${identity.usage}`;
    const key = `${scope}\u0000${identity.idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing) {
      return sameIdentity(existing.identity, identity) && existing.payload === payload
        ? "replayed-identical"
        : "idempotency-conflict";
    }
    const controlKey = `${scope}\u0000${identity.controlNumber}`;
    if (this.byControl.has(controlKey)) return "control-number-conflict";
    this.byKey.set(key, { identity, payload });
    this.byControl.set(controlKey, key);
    return "reserved";
  }

  clear(): void {
    this.byKey.clear();
    this.byControl.clear();
  }
}

export interface OfflineSyntheticSubmissionResult {
  readonly transport: "offline-fake";
  readonly outcome: SyntheticReceiptOutcome;
  readonly retry: ReturnType<typeof classifySyntheticRetry>;
  readonly durableSubmissionCreated: false;
  readonly claimStateAdvanced: false;
}

/** Test-only outcome simulation. It accepts data only and has no callback or network-capable port. */
export function simulateSyntheticClearinghouseDelivery(
  request: SyntheticClearinghouseRequest,
  outcome: SyntheticReceiptOutcome,
): OfflineSyntheticSubmissionResult {
  if (request.transport !== "offline-contract-only") {
    throw new Error("synthetic outcome simulation requires an offline request");
  }
  return {
    transport: "offline-fake",
    outcome,
    retry: classifySyntheticRetry(outcome),
    durableSubmissionCreated: false,
    claimStateAdvanced: false,
  };
}

/** Test-only document validation entry used before serialization; fields and quantities remain exact. */
export function inspectSyntheticClaimFixture(
  fixture: SyntheticM24ClaimFixture,
): M24DocumentResult<M24InstitutionalDocument> {
  if (fixture.marker !== M24_SYNTHETIC_FIXTURE_MARKER) {
    return fail("M24_SOURCE_NOT_AUTHORITATIVE", "syntheticFixture.marker");
  }
  return buildSyntheticM24InstitutionalDocument(fixture);
}
