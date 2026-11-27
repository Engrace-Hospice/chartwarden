// apps/backend/src/modules/10-hope/hope-signer-licence.ts — CW-AC-46: a HOPE record is signed only by a clinician whose
// professional licence is active, as of the signing day, in the discipline the record is attributed to.
//
// WHERE THE FACT LIVES. M17 owns the clinical-licence roster (`membership_credential`) and publishes it through the
// `CredentialReader` seam, the same one M22's `extraction_reviewer_eligible` reads. M10 PULLS from it at the signing
// path: no outbox consumer, no copy of the roster, no schema import (M10 `dependsOn` gains no edge). The seam applies the
// status / effective / expiry logic and answers only ACTIVE rows, so an expired, suspended, revoked, not-yet-effective and
// never-recorded licence are one answer here (`M10_SIGNER_LICENCE_NOT_ACTIVE`); a licence held in ANOTHER discipline is
// `M10_SIGNER_LICENCE_WRONG_DISCIPLINE`.
//
// TWO STEPS, because the seam opens its own tenant context (a second pool connection while the sign transaction holds
// one is the self-starvation `signTimepoint` already avoids for the D8 snapshot):
//   1. `readSignerLicence` — BEFORE the write transaction: the signer's active licence kinds as of today. A seam that
//      cannot answer is a retryable 503 (`M10_SIGNER_LICENCE_UNVERIFIABLE`): fail closed, logged with ids and the error
//      class only, and NOT audited as a refusal (it is not a licence verdict, and an audit row would make the idempotency
//      layer cache the 503 for 24 h instead of releasing the key; the key is released only when nothing committed earlier in
//      the request, which a legacy spec-less draft's spec freeze does).
//   2. `applySignerLicence` — INSIDE the transaction, against the record as it is locked (an SFV: against the request's
//      discipline; the pure verdict is `signerLicenceRefusal`). The locked row's frozen `author_discipline` is the one judged,
//      so a draft re-recorded under another discipline between the read and the lock cannot be signed on the old
//      discipline's licence.
// ENFORCEMENT MODE (hope-signer-licence-policy.ts, per organization; enforce unless a platform operator set shadow with a
// reason): in ENFORCE a refusal rolls the sign transaction back, so its `m10.signature.licence_refused` event (mode enforce,
// outcome denied) is written on a NEW one (`auditLicenceRefusals`), after that one ended. In SHADOW the same event is written
// on the signing transaction itself (mode shadow, outcome success) and the signature goes through: the CW-MON-01 burst rule
// counts both. The licence SEAM being unreadable is a 503 in both modes (an outage is no roster fact). Ids and enums only: no
// licence number, no issuing body, no name.
//
// There is no PER-REQUEST override: the check reads only the signer's membership and the record's frozen discipline, so no request
// flag or break-glass grant reaches it (the same structural floor as the author discipline), and a platform admin's late-deadline
// override lifts only the deadline. The one way an unlicensed signature goes through is the organization-level shadow mode above:
// set by a deliberate grant of a platform key, with a reason, behind a step-up, audited, and fail-safe (any mode that is not exactly
// `shadow` enforces). The licence is the signer's, not the author's: an amendment
// (`/correct` inserts a DRAFT and signs nothing) is checked when the correction is SIGNED, against the signer who signs it.
import type { DbClient, schema } from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import { withOrgContext } from "@chartwarden/tenancy";
import { getSeam } from "../../bootstrap/index";
import { errorClassForLog, idForLog } from "./hope-log-id";
import {
  type SignerLicenceRefusalDetail,
  auditHopeSignerLicenceRefused,
} from "./hope-operator-audit";
import type { HopeAuditRequestFacts } from "./hope-signature-audit";
import { readSignerLicenceMode } from "./hope-signer-licence-policy";

/** The frozen author attribution a HOPE record carries (`hope_author_discipline`): a new value must be decided here. */
type HopeAuthorDiscipline = NonNullable<
  (typeof schema.hopeAssessments.$inferSelect)["authorDiscipline"]
>;

/**
 * The M17 `credential_discipline` value that licenses each HOPE author discipline. LVN is the state title of the LPN
 * licence (the platform records one `lpn` kind), so an LVN record is signed on an `lpn` licence. `pa` and the non-nursing
 * kinds license no HOPE discipline.
 */
export const LICENCE_KIND_OF_DISCIPLINE: Readonly<Record<HopeAuthorDiscipline, string>> = {
  RN: "rn",
  NP: "np",
  MD: "md",
  LPN: "lpn",
  LVN: "lpn",
};

export type SignerLicenceOperation = SignerLicenceRefusalDetail["operation"];

/** The signer's active licence kinds as the seam reported them for one signing day (ids and enums only). */
export interface SignerLicence {
  readonly membershipId: string;
  /** The calendar day (UTC, the form M17 and M22 use) the licences were judged on. */
  readonly asOf: string;
  readonly heldKinds: readonly string[];
}

/** A licence refusal (403): the only {@link HopeStateError} {@link auditLicenceRefusals} audits. */
export class HopeSignerLicenceRefusal extends HopeStateError {
  constructor(
    code: "M10_SIGNER_LICENCE_NOT_ACTIVE" | "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
    message: string,
    readonly detail: SignerLicenceRefusalDetail,
  ) {
    super(code, message);
    this.name = "HopeSignerLicenceRefusal";
  }
}

// The refusal is audited, which is a committed write, so the idempotency layer replays it for 24 h on the same key
// (it releases a 403 only when the request committed nothing): the text tells the client to renew the key.
const RETRY_NOTE =
  "Once the licence is recorded, send the request again with a NEW Idempotency-Key (the refusal is replayed for 24 h on the same key).";

/** The signer's ACTIVE licence kinds as of `at`'s day, through M17's `CredentialReader` seam. Call it OUTSIDE any transaction. */
export async function readSignerLicence(
  organizationId: string,
  membershipId: string,
  at: Date,
): Promise<SignerLicence> {
  const asOf = at.toISOString().slice(0, 10);
  try {
    const grants = await getSeam("CredentialReader").activeCredentialsAsOf({
      organizationId,
      membershipId,
      asOf,
    });
    // The seam already answers only active rows; the status is re-checked so a seam that lets a suspended row through
    // still cannot sign (fail closed on the one field this control rests on).
    const heldKinds = [...new Set(grants.filter((g) => g.status === "active").map((g) => g.kind))];
    return { membershipId, asOf, heldKinds: heldKinds.sort() };
  } catch (error) {
    console.warn(
      `m10: signature refused: the credential seam threw ${errorClassForLog(error)} reading the licences of membership ${idForLog(membershipId)} (org ${idForLog(organizationId)}).`,
    );
    throw new HopeStateError(
      "M10_SIGNER_LICENCE_UNVERIFIABLE",
      "The signer's professional licence could not be verified right now; nothing was signed. Retry the request.",
    );
  }
}

/**
 * Pure verdict: does `licence` include an active licence in the discipline `record` is attributed to? `null` when it does;
 * otherwise the {@link HopeSignerLicenceRefusal} to throw (enforce) or to record as a finding (shadow). A record with no
 * frozen discipline matches no licence.
 */
export function signerLicenceRefusal(
  licence: SignerLicence,
  record: { readonly authorDiscipline: string | null; readonly rfaKind: string },
  operation: SignerLicenceOperation,
): HopeSignerLicenceRefusal | null {
  const { authorDiscipline } = record;
  // An own-property lookup: a discipline string that is the name of an Object.prototype member matches nothing.
  const required =
    authorDiscipline !== null && Object.hasOwn(LICENCE_KIND_OF_DISCIPLINE, authorDiscipline)
      ? LICENCE_KIND_OF_DISCIPLINE[authorDiscipline as HopeAuthorDiscipline]
      : undefined;
  if (required !== undefined && licence.heldKinds.includes(required)) return null;
  const holdsOther = licence.heldKinds.length > 0;
  const detail: SignerLicenceRefusalDetail = {
    operation,
    reason: holdsOther ? "wrong_discipline" : "no_active_licence",
    rfaKind: record.rfaKind,
    requiredDiscipline: authorDiscipline,
    heldKinds: licence.heldKinds,
    asOf: licence.asOf,
  };
  if (authorDiscipline === null) {
    // No licence can ever match: the cure is the record's, not the roster's (so no "record the licence" note).
    return new HopeSignerLicenceRefusal(
      holdsOther ? "M10_SIGNER_LICENCE_WRONG_DISCIPLINE" : "M10_SIGNER_LICENCE_NOT_ACTIVE",
      "The record carries no author discipline, so no professional licence can be matched to it; it has to be re-recorded with one before it can be signed.",
      detail,
    );
  }
  const subject = `Signing a ${authorDiscipline}-attributed HOPE record requires an active ${authorDiscipline} licence on ${licence.asOf}.`;
  if (holdsOther) {
    return new HopeSignerLicenceRefusal(
      "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      `${subject} The signer holds an active licence in another discipline only. ${RETRY_NOTE}`,
      detail,
    );
  }
  return new HopeSignerLicenceRefusal(
    "M10_SIGNER_LICENCE_NOT_ACTIVE",
    `${subject} The signer has no active licence on file for that day (missing, expired, suspended or revoked). ${RETRY_NOTE}`,
    detail,
  );
}

interface LicenceRefusalCaller {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly request?: HopeAuditRequestFacts;
}

/** The record the refused signature was for: the draft being signed, or the admission an SFV completion was filed under. */
interface LicenceRefusalResource {
  readonly kind: "hope_assessment" | "admission";
  readonly id: string;
}

/**
 * Write the `denied` audit event for a licence refusal on a NEW transaction (the refusal rolled the request's own one
 * back, and a second pool connection taken while that one is held can starve the pool). Best effort: a failure to write
 * it is logged (ids and the error class only) and never changes the 403 the caller gets.
 */
async function auditSignerLicenceRefusal(
  db: DbClient,
  caller: LicenceRefusalCaller,
  resource: LicenceRefusalResource,
  refusal: HopeSignerLicenceRefusal,
): Promise<void> {
  try {
    await withOrgContext(db, { organizationId: caller.organizationId, userId: "" }, (tx) =>
      auditHopeSignerLicenceRefused(tx as unknown as DbClient, {
        organizationId: caller.organizationId,
        membershipId: caller.membershipId,
        request: caller.request,
        resourceKind: resource.kind,
        resourceId: resource.id,
        code: refusal.code,
        mode: "enforce",
        refusal: refusal.detail,
      }),
    );
  } catch (error) {
    // An error, not a warning: this refusal is missing from the trail, so the CW-MON-01 burst rule cannot count it.
    console.error(
      `m10: signer licence refusal audit NOT written (${errorClassForLog(error)}); the 403 stands but the trail and the burst alert miss it: org ${idForLog(caller.organizationId)}, membership ${idForLog(caller.membershipId)}, resource ${idForLog(resource.id)}.`,
    );
  }
}

/**
 * The licence verdict INSIDE the sign transaction, against the record as it is locked (an SFV: the request's discipline), under
 * the organization's enforcement mode (hope-signer-licence-policy.ts). No refusal: nothing happens and no policy is read. A refusal
 * while the organization ENFORCES (the default, and the answer for an organization with no setting) is thrown, rolling the
 * transaction back; {@link auditLicenceRefusals} audits it afterwards. A refusal while it is in SHADOW is recorded as the
 * `m10.signature.licence_refused` finding with `mode: shadow` on THIS transaction (so it commits with the signature it let
 * through) and the signature proceeds. A policy that cannot be read fails the transaction: nothing is signed.
 */
export async function applySignerLicence(
  t: DbClient,
  caller: LicenceRefusalCaller,
  resource: LicenceRefusalResource,
  licence: SignerLicence,
  record: { readonly authorDiscipline: string | null; readonly rfaKind: string },
  operation: SignerLicenceOperation,
): Promise<void> {
  const refusal = signerLicenceRefusal(licence, record, operation);
  if (!refusal) return;
  const mode = await readSignerLicenceMode(t, caller.organizationId);
  // Fail safe: only the exact value `shadow` lets a signature through. The mode is a database enum that can gain a value, and a
  // value this code does not know must enforce, not fall into the shadow path.
  if (mode !== "shadow") throw refusal;
  await auditHopeSignerLicenceRefused(t, {
    organizationId: caller.organizationId,
    membershipId: caller.membershipId,
    request: caller.request,
    resourceKind: resource.kind,
    resourceId: resource.id,
    code: refusal.code,
    mode,
    refusal: refusal.detail,
  });
}

/**
 * Await `signing` (the sign transaction, already started by the caller and passed as a promise, so the one `try` here
 * wraps both call sites without a second one around each transaction); a licence refusal it rejects with is audited on a
 * new transaction, then rethrown unchanged.
 */
export async function auditLicenceRefusals<T>(
  db: DbClient,
  caller: LicenceRefusalCaller,
  resource: LicenceRefusalResource,
  signing: Promise<T>,
): Promise<T> {
  try {
    return await signing;
  } catch (error) {
    if (error instanceof HopeSignerLicenceRefusal) {
      await auditSignerLicenceRefusal(db, caller, resource, error);
    }
    throw error;
  }
}
