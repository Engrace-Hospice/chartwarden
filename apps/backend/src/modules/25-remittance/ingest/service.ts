// apps/backend/src/modules/25-remittance/ingest/service.ts — WX-PR-012 M25 §2.2/§2.6 the 835 RECEIVE →
// PARSE → POST pipeline contract (spec Tasks #7/#8: the 835-pull receipt half + the `ingest-835.ts`
// parse+post worker). Two service methods, two transactions, matching the spec's own state machine:
//
//   receiveAdvice — "Secure receive; validate; dedup" (§2.2 `queued`). Takes a raw 835 file ALREADY staged
//     in MinIO (this package does not itself speak to a clearinghouse/SFTP — the actual external pull
//     transport is a separate, unbuilt concern, same posture as every other unwired M25 forward seam) plus
//     its bytes (to derive the ISA/ST dedup key locally — @chartwarden/x12-835-client's
//     `parseX12EnvelopeHeader`, no sidecar round-trip needed for just the header) and its sha256. Inserts
//     the `remittance_advice` envelope row; the DB's `ux_remittance_envelope_dedupe` unique index is the
//     actual dedup enforcement (§2.6) — a caught unique-violation means "already ingested", not an error,
//     and creates NO second row. On success, emits `m25.edi.835_received` in the SAME tx (D2 outbox
//     posture) — the dispatcher-registered consumer (./  ../outbox-consumers/live-binding.ts) picks it up.
//
//   postAdvice — "parse; transactionally post; create denial; surface partial failure". Calls the injected
//     X12835WorkerClient for the full CLP-level parse, then in ONE transaction: inserts every
//     line/service-line/adjustment/remark row, auto-matches each line to a claim (D3, via the injected
//     {@link ClaimMatchCandidateProvider} — empty-by-default until the M23 cross-module seam BIND lands,
//     same posture as M27/HCI consuming M23/M26), routes each adjustment (D4/D5) via the terminology
//     lookup, seeds `denial_case` / `patient_responsibility_ledger` rows, classifies each line's posting
//     outcome (§2.4) and emits the matching M23-forwarding event. Either everything commits (posted /
//     partial_posted) or NOTHING does (a thrown error rolls the whole batch back — no half-posted lines) —
//     a SEPARATE, later transaction then marks the advice `failed` with a PHI-free reason so it stays
//     operator-actionable via the EXISTING `remittance.replay` route (which re-emits
//     `m25.edi.835_received`, naturally re-driving this same pipeline).
import type { X12835WorkerClient } from "@chartwarden/x12-835-client";
import type { MatchCandidate } from "../domain/match";
import type { WriteOutboxPort } from "../routes/write-service";

export type { X12835WorkerClient };

/** The org-scoped system actor an ingestion run executes as — no human membership (§2.5: worker-only). */
export interface M25IngestActor {
  readonly organizationId: string;
}

/**
 * #658 — where the raw 835 lives between `receiveAdvice` and `postAdvice`. Keyed by the server-generated advice id,
 * never the caller's `minioObjectKey`, so two advices cannot overwrite each other's staged text. Tenant-scoped by
 * `organizationId` (the adapter picks the tenant bucket); `get` returns null when the object is gone.
 */
export interface RawAdviceStore {
  put(organizationId: string, adviceId: string, text: string): Promise<void>;
  get(organizationId: string, adviceId: string): Promise<string | null>;
}

export interface ReceiveAdviceInput {
  readonly providerEntityId: string;
  readonly payerId: string;
  /** Also the X12835WorkerClient `payerProgram` discriminator — the DB enum and the sidecar's program
   *  literal happen to be the exact same 3-value union, so this one field serves both. */
  readonly payerKind: "medicare" | "medicaid" | "commercial";
  readonly minioObjectKey: string;
  readonly fileSha256: string;
  /** The raw 835 text — parsed locally for the ISA13/ST02 dedup key and staged in the `RawAdviceStore`; never stored in the database. */
  readonly rawEdi: string;
}

export type ReceiveAdviceResult =
  | { readonly outcome: "queued"; readonly adviceId: string }
  | { readonly outcome: "duplicate"; readonly existingAdviceId: string }
  | { readonly outcome: "malformed"; readonly reason: string };

export type PostAdviceResult =
  | {
      readonly outcome: "posted" | "partial_posted";
      readonly adviceId: string;
      readonly postedLineCount: number;
      readonly unmatchedLineCount: number;
    }
  | { readonly outcome: "failed"; readonly adviceId: string; readonly reason: string }
  | { readonly outcome: "not_found"; readonly adviceId: string }
  /** Already posted/partial_posted — a re-delivery of `m25.edi.835_received` (dispatcher retry) is a no-op. */
  | { readonly outcome: "already_posted"; readonly adviceId: string };

/**
 * The auto-match candidate lookup M25 consumes from M23 (D3) — deliberately narrower than the full spec
 * §4.4 `ClaimReader` seam (that one is a cross-module foundation BIND, out of scope here; same posture the
 * M27 HCI/cap seams document). Defaults to "no candidates" — an honest degrade (every line queues for
 * manual match) rather than a fabricated match.
 */
export interface ClaimMatchCandidateProvider {
  candidatesForLine(args: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly payerIcn?: string;
    readonly patientControlNumber?: string;
    readonly patientMemberId?: string;
  }): Promise<readonly MatchCandidate[]>;
  /** Resolve a matched claim's patient id (needed only to seed a PR-ledger row — `patientId` is NOT NULL). */
  patientIdForClaim(organizationId: string, claimId: string): Promise<string | null>;
}

/** The deny-safe default: no live M23 candidate/patient seam bound — never fabricates a match or id. */
export const NO_CLAIM_MATCH_CANDIDATES: ClaimMatchCandidateProvider = {
  async candidatesForLine() {
    return [];
  },
  async patientIdForClaim() {
    return null;
  },
};

/**
 * F-172 (#248, m24 group) — the auto-match candidate lookup, ROUTED BY PAYER. `receiveAdvice`'s own
 * `ReceiveAdviceInput.payerKind` discriminator has always been on the wire (§2.2), but `postAdvice`'s
 * auto-match ignored it and matched EVERY advice — Medicare, Medicaid, commercial alike — against the
 * single injected M23 `ClaimMatchCandidateProvider`. For a Medicaid 835 that means matching a real
 * CLP01 control number against M23's `claim` table, which owns no Medicaid claims: an honest "no
 * candidates" degrade at best, or (if a Medicare claim happened to carry the identical control number
 * in the same provider entity — an X12-generated string, not guaranteed unique cross-payer) a
 * misrouted match at worst. Keyed by the SAME three-value union the advice envelope itself carries, so
 * routing needs no new matching scheme — only the discriminator already on the wire. A payer with no
 * entry (today: `commercial`, and `medicaid`/`medicare` too until the composition root supplies them)
 * degrades to {@link NO_CLAIM_MATCH_CANDIDATES} — every line queues for manual match, never a fabricated
 * or cross-payer match.
 */
export type ClaimMatchCandidateProviderByPayer = Partial<
  Record<ReceiveAdviceInput["payerKind"], ClaimMatchCandidateProvider>
>;

/** CARC/RARC → category lookup (reuses the M38 terminology port the read service already injects). */
export interface TerminologyLookupPort {
  lookup(
    carcCode: string,
    rarcCode: string | null,
  ): Promise<{ category: string; plainLanguage: string } | null>;
}

export const DENY_TERMINOLOGY: TerminologyLookupPort = {
  async lookup() {
    return null;
  },
};

export interface M25IngestService {
  receiveAdvice(actor: M25IngestActor, input: ReceiveAdviceInput): Promise<ReceiveAdviceResult>;
  postAdvice(actor: M25IngestActor, adviceId: string): Promise<PostAdviceResult>;
}

export type { WriteOutboxPort };
