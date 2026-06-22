// @wardenx/iqies-client — the CMS HOPE submission envelope assembler (M10-T07, spec §4.10 / D5 / D6).
// The CMS HOPE submission XML schema, the per-MAC submitter authentication, and the sandbox-vs-prod
// selection are transport-internal (the real XML serialization lands behind `transport.ts` with the
// per-tenant credential wiring); this module owns the *deterministic, PHI-light envelope model* M10 hands
// to `submitBatch`, plus the canonical serialization the worker hashes to record the §4.10 envelope
// SHA-256. Per-PE / per-period batching (not per-assessment) preserves CMS's batch acceptance-report
// semantics (D5). Pure + deterministic: the same envelope always serializes to the same bytes and hash.
import { createHash } from "node:crypto";
import type { HopeRfaKind } from "@wardenx/types";

/** One assessment included in a submission batch. `correctsIqiesRecordId` is set only for Correction RFAs
 * (D7): the new row references the original's iQIES record id; null for a first-time submission. */
export interface HopeEnvelopeItem {
  readonly hopeAssessmentId: string;
  readonly rfaKind: HopeRfaKind;
  readonly correctsIqiesRecordId: string | null;
}

/** The per-ProviderEntity / per-period batch envelope. `providerEntityCcn` is the CMS Certification
 * Number the envelope's submitter credential and `ccn_at_election` cross-check key on (§2.3 / §3). */
export interface HopeSubmissionEnvelope {
  readonly providerEntityCcn: string;
  readonly submissionPeriod: string;
  readonly items: readonly HopeEnvelopeItem[];
}

/**
 * `assembleEnvelopeCanonical` — produce the canonical string used as the SHA-256 pre-image. Items are
 * sorted by `hopeAssessmentId` so member order never perturbs the hash (the batch is a set, not a list);
 * the serialization is a stable, field-pinned JSON projection — NOT the wire XML (that is transport's
 * concern). Deterministic by construction: the recorded SHA-256 is reproducible for any audit replay.
 */
export function assembleEnvelopeCanonical(envelope: HopeSubmissionEnvelope): string {
  const items = [...envelope.items]
    .sort((a, b) => (a.hopeAssessmentId < b.hopeAssessmentId ? -1 : a.hopeAssessmentId > b.hopeAssessmentId ? 1 : 0))
    .map((i) => ({
      hopeAssessmentId: i.hopeAssessmentId,
      rfaKind: i.rfaKind,
      correctsIqiesRecordId: i.correctsIqiesRecordId,
    }));
  return JSON.stringify({
    schema: "cms-hope-submission/v1",
    providerEntityCcn: envelope.providerEntityCcn,
    submissionPeriod: envelope.submissionPeriod,
    items,
  });
}

/** SHA-256 (hex) of the canonical envelope — the value recorded in `hope_submission.envelope_sha256` and
 * carried in the `m10.hope.submission_transmitted` event (§2.4 / §4.10). */
export function envelopeSha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
