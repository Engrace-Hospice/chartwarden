// M23 — the claim-to-837I LOADER: from a persisted claim id to the x12-837-client builders' `Claim837iInput` (and the
// raw 837I / Stedi JSON). It is the one place that joins the claim row, its lines, the M6 admission date, the M5
// beneficiary identity (via the existing seams) and the billing/submitter/receiver/payer parties.
//
// Rules:
//   • Nothing is invented. A field with no source is a typed gap; the loader returns ALL gaps it can find at once.
//   • The MBI is read ONLY through M5's `MbiUnlockReader` seam (the M23-only unlock), held in the returned in-memory
//     input (an opaque `SensitiveValue`) and never stored or logged here. The unlock is passed a `disclosure`
//     (purpose `claim_837i_submission` + the claim id + the optional acting user) and the claim's own
//     `patientPayerId`, so M5 reads exactly that coverage and writes the PHI-disclosure audit_event (ids and purpose,
//     never the MBI) in the same transaction as the read. The detailed claim document carries no beneficiary identity.
//   • The audit is written AT UNLOCK, before the mapper and builders run. A later mapper/builder gap therefore still
//     leaves a disclosure row: over-audit by design (the MBI was read; the record of that must not depend on whether
//     the claim then turned out to be sendable). Every check that does not need the MBI runs before the unlock.
//   • PHI is not read for a claim that is already unsubmittable: the claim-level and party checks run first, then the
//     non-MBI beneficiary fields (sex, address, DOB) are read and checked, and the MBI is unlocked LAST.
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
import { SensitiveValue } from "./sensitive-value";

/** The disclosure purpose recorded on the MBI-unlock audit event. */
export const CLAIM_837I_DISCLOSURE_PURPOSE = "claim_837i_submission" as const;

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
  /** The user who triggered this load, when there is one; recorded on the MBI-disclosure audit (else system). */
  readonly actorUserId?: string;
}

export type LoadClaim837iFailure =
  | { readonly ok: false; readonly kind: "claim_not_found" }
  | { readonly ok: false; readonly kind: "gaps"; readonly gaps: readonly ClaimGap[] };

export type LoadClaim837iResult =
  | {
      readonly ok: true;
      /** The stored-safe claim document (no beneficiary identity). */
      readonly document: ClaimDocument837iDetail;
      /** CONTAINS THE MBI (opaque: `reveal()` it at the transmit boundary; never store or log it). */
      readonly input: SensitiveValue<Claim837iInput>;
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
 * The beneficiary, assembled from the M5 seams for ONE build. Returns gaps (never a partial identity). The non-MBI
 * fields are read and checked FIRST so no MBI is unlocked for a claim that cannot be sent; the MBI unlock is last and
 * carries the disclosure (M5 audits it in the same tx). This function never copies the identity anywhere but its
 * return value.
 */
async function loadSubscriber(
  deps: Claim837iLoaderDeps,
  claim: repositories.ClaimRecord,
  actorUserId: string | undefined,
): Promise<{ ok: true; value: TransientSubscriber } | { ok: false; gaps: readonly ClaimGap[] }> {
  const patient = await deps.patients.findById({
    organizationId: claim.organizationId,
    id: claim.patientId,
  });
  const sex = patient?.administrativeSex;
  const gaps: ClaimGap[] = [];
  if (sex !== "M" && sex !== "F") gaps.push(gap("subscriber.sex", "missing"));
  if (!patient?.dateOfBirth) gaps.push(gap("subscriber.dateOfBirth", "missing"));
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

  const identity = await deps.mbiUnlock().unlockForEligibility({
    organizationId: claim.organizationId,
    patientId: claim.patientId,
    onDate: claim.serviceFrom,
    // Select the claim's own coverage (the post-check below stays as defense in depth).
    expectedPatientPayerId: claim.patientPayerId,
    disclosure: {
      purpose: CLAIM_837I_DISCLOSURE_PURPOSE,
      subjectId: claim.id,
      ...(actorUserId === undefined ? {} : { actorUserId }),
    },
  });
  if (identity === null) return { ok: false, gaps: [gap("subscriber.mbi", "missing")] };
  // The MBI must come from the very coverage this claim bills; a different Medicare row is not this claim's payer.
  if (identity.patientPayerId !== claim.patientPayerId) {
    return { ok: false, gaps: [gap("subscriber.mbi", "inconsistent")] };
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

/**
 * The payer control number of the claim this one replaces / voids. Null when there is none, none yet, or the
 * predecessor is not the same organization, provider entity and patient (a cross-patient or cross-tenant
 * predecessor must never lend its payer control number — it surfaces as a missing `payerClaimControlNumber`).
 */
async function predecessorPayerClaimControlNumber(
  deps: Claim837iLoaderDeps,
  claim: repositories.ClaimRecord,
): Promise<string | null> {
  if (claim.replacesClaimId === null) return null;
  const predecessor = await deps.persistence.claimById(claim.replacesClaimId);
  if (
    predecessor === null ||
    predecessor.organizationId !== claim.organizationId ||
    predecessor.providerEntityId !== claim.providerEntityId ||
    predecessor.patientId !== claim.patientId
  ) {
    return null;
  }
  return predecessor.payerClaimControlNumber;
}

interface LoadedOnce {
  readonly document: ClaimDocument837iDetail;
  readonly input: Claim837iInput;
  readonly rendered: Rendered837i;
}

/** Load, map and render ONCE (the builders run a single time per load). */
async function loadOnce(
  deps: Claim837iLoaderDeps,
  args: LoadClaim837iArgs,
): Promise<({ readonly ok: true } & LoadedOnce) | LoadClaim837iFailure> {
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

  const subscriber = await loadSubscriber(deps, claim, args.actorUserId);
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
  // A builder refusal is a field-name-only gap, so the caller never holds an unsendable input.
  const rendered = render837i(mapped.value);
  if (!rendered.ok) return fail(rendered.gaps);
  return {
    ok: true,
    document: documentResult.value,
    input: mapped.value,
    rendered: rendered.value,
  };
}

/** Load the claim into the 837I builders' input, or report every gap that blocks it. */
export async function loadClaim837iInput(
  deps: Claim837iLoaderDeps,
  args: LoadClaim837iArgs,
): Promise<LoadClaim837iResult> {
  const loaded = await loadOnce(deps, args);
  return loaded.ok
    ? { ok: true, document: loaded.document, input: new SensitiveValue(loaded.input) }
    : loaded;
}

/** Load and render in one step (the transport hand-off shape). The rendered payloads carry the MBI (opaque). */
export async function loadAndRender837i(
  deps: Claim837iLoaderDeps,
  args: LoadClaim837iArgs,
): Promise<
  | {
      readonly ok: true;
      readonly document: ClaimDocument837iDetail;
      readonly rendered: SensitiveValue<Rendered837i>;
    }
  | LoadClaim837iFailure
> {
  const loaded = await loadOnce(deps, args);
  return loaded.ok
    ? { ok: true, document: loaded.document, rendered: new SensitiveValue(loaded.rendered) }
    : loaded;
}
