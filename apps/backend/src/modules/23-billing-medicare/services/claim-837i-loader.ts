// M23 — the claim-to-837I LOADER: from a persisted claim id to the x12-837-client builders' `Claim837iInput` (and the
// raw 837I / Stedi JSON). It is the one place that joins the claim row, its lines, the M6 admission date, the M5
// beneficiary identity (via the existing seams) and the billing/submitter/receiver/payer parties.
//
// Rules:
//   • Nothing is invented. A field with no source is a typed gap; the loader returns ALL gaps it can find at once.
//   • The MBI is read ONLY through M5's `MbiUnlockReader` seam (the M23-only unlock), held in the returned in-memory
//     input and never stored, logged or audited here. The detailed claim document carries no beneficiary identity.
//   • PHI is not read for a claim that is already unsubmittable: the beneficiary seams are consulted only after the
//     claim-level and party checks pass.
//   • The caller owns the clock and the interchange control number (a port-less, deterministic loader).
//
// NOT wired: the submit worker still sends the thin `claimDocumentFor` document to the gateway. Binding this loader
// (and the parties port, which has no production implementation yet) into the Stedi submit path is a later slice.
import {
  type ClaimDocument837iDetail,
  type ClaimGap,
  buildClaimDocument837iDetail,
  gap,
  repositories,
} from "@wardenx/billing";
import type { MbiUnlockReader, PatientAddressReader, PatientReader } from "@wardenx/types";
import type { Claim837iInput, ClearinghouseContext } from "@wardenx/x12-837-client";
import {
  type Claim837iParties,
  type Rendered837i,
  type TransientSubscriber,
  mapClaimTo837iInput,
  render837i,
} from "./claim-837i-mapper";
import type { AdmissionContextReader } from "./claim-assembly-types";

/** The party records. Each section is `null` when its source cannot supply it (a typed gap, never a default). */
export interface Claim837iPartiesPort {
  partiesFor(args: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly patientPayerId: string;
    /** The payer id the clearinghouse routes on (from the clearinghouse context). */
    readonly payerId: string;
  }): Promise<{
    readonly submitter: Claim837iParties["submitter"] | null;
    readonly receiver: Claim837iParties["receiver"] | null;
    readonly billingProvider: Claim837iParties["billingProvider"] | null;
    readonly payer: Claim837iParties["payer"] | null;
  }>;
}

/** The claim persistence reads the loader needs (the default adapter wraps the M23 repositories). */
export interface Claim837iPersistencePort {
  claimById(claimId: string): Promise<repositories.ClaimRecord | null>;
  linesForClaim(claimId: string): Promise<readonly repositories.ClaimLineRecord[]>;
}

/** The default persistence adapter over the M23 repositories (bind it on the worker's per-job tx). */
export function buildClaim837iPersistencePort(
  tx: repositories.BillingDb,
): Claim837iPersistencePort {
  const claims = new repositories.ClaimRepository(tx);
  const lines = new repositories.ClaimLineRepository(tx);
  return {
    claimById: (id) => claims.findById(id),
    linesForClaim: (id) => lines.listForClaim(id),
  };
}

export interface Claim837iLoaderDeps {
  readonly persistence: Claim837iPersistencePort;
  readonly admission: AdmissionContextReader;
  /** Resolved lazily per call (registration order at boot never matters). */
  readonly mbiUnlock: () => MbiUnlockReader;
  readonly patients: PatientReader;
  readonly addresses: PatientAddressReader;
  readonly parties: Claim837iPartiesPort;
}

export interface LoadClaim837iArgs {
  readonly claimId: string;
  /** Scopes the claim read: a claim of another org / provider entity is `claim_not_found`. */
  readonly context: ClearinghouseContext;
  readonly interchangeControlNumber: number;
  readonly createdAt: Date;
}

export type LoadClaim837iFailure =
  | { readonly ok: false; readonly kind: "claim_not_found" }
  | { readonly ok: false; readonly kind: "gaps"; readonly gaps: readonly ClaimGap[] };

export type LoadClaim837iResult =
  | {
      readonly ok: true;
      /** The stored-safe claim document (no beneficiary identity). */
      readonly document: ClaimDocument837iDetail;
      /** CONTAINS THE MBI: transmit it, never store or log it. */
      readonly input: Claim837iInput;
    }
  | LoadClaim837iFailure;

const fail = (gaps: readonly ClaimGap[]): LoadClaim837iFailure => ({
  ok: false,
  kind: "gaps",
  gaps,
});

/** `billingNpi` binds the clearinghouse context to the provider whose claim this is (and is required in production). */
function billingNpiGaps(
  context: ClearinghouseContext,
  billingProvider: Claim837iParties["billingProvider"] | null,
): ClaimGap[] {
  if (context.billingNpi === undefined) {
    return context.usage === "production" ? [gap("context.billingNpi", "missing")] : [];
  }
  return billingProvider !== null && billingProvider.npi !== context.billingNpi
    ? [gap("billingProvider.npi", "inconsistent")]
    : [];
}

function partyGaps(
  parties: Awaited<ReturnType<Claim837iPartiesPort["partiesFor"]>>,
  context: ClearinghouseContext,
): ClaimGap[] {
  const gaps: ClaimGap[] = [];
  for (const name of ["submitter", "receiver", "billingProvider", "payer"] as const) {
    if (parties[name] === null) gaps.push(gap(name, "missing"));
  }
  return [...gaps, ...billingNpiGaps(context, parties.billingProvider)];
}

/**
 * The beneficiary, assembled from the M5 seams for ONE build. Returns gaps (never a partial identity). The MBI
 * unlock is the audited M23-only seam; this function never copies the identity anywhere but its return value.
 */
async function loadSubscriber(
  deps: Claim837iLoaderDeps,
  claim: repositories.ClaimRecord,
): Promise<{ ok: true; value: TransientSubscriber } | { ok: false; gaps: readonly ClaimGap[] }> {
  const identity = await deps.mbiUnlock().unlockForEligibility({
    organizationId: claim.organizationId,
    patientId: claim.patientId,
    onDate: claim.serviceFrom,
  });
  if (identity === null) return { ok: false, gaps: [gap("subscriber.mbi", "missing")] };
  const gaps: ClaimGap[] = [];
  const patient = await deps.patients.findById({
    organizationId: claim.organizationId,
    id: claim.patientId,
  });
  const sex = patient?.administrativeSex;
  if (sex !== "M" && sex !== "F") gaps.push(gap("subscriber.sex", "missing"));
  const address = await deps.addresses.primaryAddress(claim.organizationId, claim.patientId);
  if (address === null) gaps.push(gap("subscriber.address", "missing"));
  else if (address.state === null) gaps.push(gap("subscriber.address.state", "missing"));
  if (
    gaps.length > 0 ||
    (sex !== "M" && sex !== "F") ||
    address === null ||
    address.state === null
  ) {
    return { ok: false, gaps };
  }
  return {
    ok: true,
    value: {
      mbi: identity.mbi,
      lastName: identity.lastName,
      firstName: identity.firstName,
      dateOfBirth: identity.dateOfBirth,
      sex,
      address: {
        line1: address.line1,
        ...(address.line2 === null ? {} : { line2: address.line2 }),
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
      },
    },
  };
}

/** The payer control number of the claim this one replaces / voids (null when there is none, or none yet). */
async function predecessorPayerClaimControlNumber(
  deps: Claim837iLoaderDeps,
  claim: repositories.ClaimRecord,
): Promise<string | null> {
  if (claim.replacesClaimId === null) return null;
  const predecessor = await deps.persistence.claimById(claim.replacesClaimId);
  return predecessor?.organizationId === claim.organizationId
    ? predecessor.payerClaimControlNumber
    : null;
}

/** Load the claim into the 837I builders' input, or report every gap that blocks it. */
export async function loadClaim837iInput(
  deps: Claim837iLoaderDeps,
  args: LoadClaim837iArgs,
): Promise<LoadClaim837iResult> {
  const { context } = args;
  const claim = await deps.persistence.claimById(args.claimId);
  if (
    claim === null ||
    claim.organizationId !== context.organizationId ||
    claim.providerEntityId !== context.providerEntityId
  ) {
    return { ok: false, kind: "claim_not_found" };
  }
  const [lines, admission, predecessorPccn, parties] = await Promise.all([
    deps.persistence.linesForClaim(claim.id),
    deps.admission.resolveForRange(claim.organizationId, claim.patientId, {
      from: claim.serviceFrom,
      to: claim.serviceTo,
    }),
    predecessorPayerClaimControlNumber(deps, claim),
    deps.parties.partiesFor({
      organizationId: claim.organizationId,
      providerEntityId: claim.providerEntityId,
      patientPayerId: claim.patientPayerId,
      payerId: context.payerId,
    }),
  ]);

  const documentResult = buildClaimDocument837iDetail({
    claim,
    lines,
    claimControlNumber: claim.claimControlNumber,
    admissionDate: admission?.hospiceAdmissionDate ?? null,
    predecessorPayerClaimControlNumber: predecessorPccn,
  });
  const claimGaps = [
    ...(documentResult.ok ? [] : documentResult.gaps),
    ...partyGaps(parties, context),
  ];
  if (
    claimGaps.length > 0 ||
    !documentResult.ok ||
    parties.submitter === null ||
    parties.receiver === null ||
    parties.billingProvider === null ||
    parties.payer === null
  ) {
    return fail(claimGaps);
  }

  const subscriber = await loadSubscriber(deps, claim);
  if (!subscriber.ok) return fail(subscriber.gaps);

  const mapped = mapClaimTo837iInput({
    document: documentResult.value,
    subscriber: subscriber.value,
    parties: {
      submitter: parties.submitter,
      receiver: parties.receiver,
      billingProvider: parties.billingProvider,
      payer: parties.payer,
    },
    envelope: {
      interchangeControlNumber: args.interchangeControlNumber,
      usage: context.usage === "production" ? "P" : "T",
      createdAt: args.createdAt,
    },
  });
  if (!mapped.ok) return fail(mapped.gaps);
  const rendered = render837i(mapped.value);
  if (!rendered.ok) return fail(rendered.gaps);
  return { ok: true, document: documentResult.value, input: mapped.value };
}

/** Load and render in one step (the transport hand-off shape). The result carries the MBI inside its payloads. */
export async function loadAndRender837i(
  deps: Claim837iLoaderDeps,
  args: LoadClaim837iArgs,
): Promise<
  | {
      readonly ok: true;
      readonly document: ClaimDocument837iDetail;
      readonly rendered: Rendered837i;
    }
  | LoadClaim837iFailure
> {
  const loaded = await loadClaim837iInput(deps, args);
  if (!loaded.ok) return loaded;
  const rendered = render837i(loaded.input);
  return rendered.ok
    ? { ok: true, document: loaded.document, rendered: rendered.value }
    : fail(rendered.gaps);
}
