// M25 milestone 8a-1 - ADR documentation READINESS, advisory. PURE (no I/O).
//
// Two sources sit beside the human checklist and never inside it:
//   1. the DETERMINISTIC gap view (no model): for each checklist key, which attached documents map to it, and which
//      keys have none;
//   2. optional AI findings, accepted only through `acceptAiFindings`: an AI finding can add a "possibly missing" /
//      "cannot tell" note or a citation, can NEVER turn a deterministic gap into "present", can NEVER cite a document
//      that is not in the packet, and can never introduce a checklist item (the six keys are the SME-unconfirmed list in
//      adr-packet-rules.ts; this file extends nothing).
// Nothing here states what a hospice ADR response must contain, and nothing judges sufficiency: the vocabulary is
// presence only ("a document that appears to be X is attached"), plus "cannot tell".
import { ADR_CHECKLIST_KEYS, type AdrChecklistKey, isChecklistKey } from "./adr-packet-rules";

export const READINESS_FINDING_STATUSES = [
  "looks_present",
  "possibly_missing",
  "cannot_tell",
] as const;
export type ReadinessFindingStatus = (typeof READINESS_FINDING_STATUSES)[number];

export const READINESS_DISPOSITIONS = ["acknowledged", "dismissed", "disputed"] as const;
export type ReadinessDisposition = (typeof READINESS_DISPOSITIONS)[number];

export const READINESS_REVIEW_STATUSES = ["requested", "ready", "unavailable", "failed"] as const;
export type ReadinessReviewStatus = (typeof READINESS_REVIEW_STATUSES)[number];

export const READINESS_SOURCES = ["deterministic", "ai"] as const;
export type ReadinessSource = (typeof READINESS_SOURCES)[number];

/** Why no assistant answered. Closed: mirrored by a CHECK on adr_readiness_review.unavailable_reason and the event schema. */
export const READINESS_UNAVAILABLE_REASONS = [
  "capability_unavailable",
  "kill_switch_active",
  "tenant_not_opted_in",
  "budget_exhausted",
  "timeout",
  "schema_invalid",
  "assistant_error",
] as const;
export type ReadinessUnavailableReason = (typeof READINESS_UNAVAILABLE_REASONS)[number];

export const MAX_READINESS_NOTE_LENGTH = 500;

// Control characters (incl. newlines and tabs), zero-width and bidi-override/isolate characters: a note is one plain line.
const UNSAFE_NOTE_CHARS = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
/** Strips control and bidi-override characters (each becomes a space), collapses runs and trims. */
export function normalizeReadinessNote(note: string): string {
  return note.replace(UNSAFE_NOTE_CHARS, " ").replace(/ {2,}/g, " ").trim();
}
/** At most this many AI findings are read from one result; the rest are dropped (a model cannot flood the panel). */
export const MAX_READINESS_AI_FINDINGS = ADR_CHECKLIST_KEYS.length * 3;
/** Minimum gap between two review requests on one case (seconds): the per-case rate limit. */
export const READINESS_REQUEST_MIN_INTERVAL_SECONDS = 30;
/** A review is requested while the packet is still being worked on; a filed case has nothing left to check. */
export const READINESS_ALLOWED_CASE_STATES: readonly string[] = ["in_assembly", "in_review"];

export interface PacketAttachment {
  readonly documentId: string;
  readonly checklistKey: string | null;
}

export type DeterministicKeyStatus =
  | "documents_attached"
  | "no_document_attached"
  | "marked_not_applicable";

export interface DeterministicKeyGap {
  readonly checklistKey: AdrChecklistKey;
  readonly status: DeterministicKeyStatus;
  readonly documentIds: readonly string[];
  /** True when the key needs a document and has none. A person ticking "ready" does not clear it. */
  readonly isGap: boolean;
}

export interface DeterministicGaps {
  readonly keys: readonly DeterministicKeyGap[];
  /** Attached documents with no checklist key: shown, never guessed into a key. */
  readonly unmappedDocumentIds: readonly string[];
}

export function deterministicGaps(
  checklist: Readonly<Record<string, string>>,
  attachments: readonly PacketAttachment[],
): DeterministicGaps {
  const keys = ADR_CHECKLIST_KEYS.map((checklistKey): DeterministicKeyGap => {
    const documentIds = attachments
      .filter((a) => a.checklistKey === checklistKey)
      .map((a) => a.documentId);
    if (checklist[checklistKey] === "not_applicable") {
      return { checklistKey, status: "marked_not_applicable", documentIds, isGap: false };
    }
    return documentIds.length > 0
      ? { checklistKey, status: "documents_attached", documentIds, isGap: false }
      : { checklistKey, status: "no_document_attached", documentIds, isGap: true };
  });
  const unmappedDocumentIds = attachments
    .filter((a) => a.checklistKey === null || !isChecklistKey(a.checklistKey))
    .map((a) => a.documentId);
  return { keys, unmappedDocumentIds };
}

export interface ReadinessFinding {
  readonly checklistKey: AdrChecklistKey;
  readonly status: ReadinessFindingStatus;
  readonly citedDocumentIds: readonly string[];
  readonly note: string;
}

export type FindingDropReason =
  | "MALFORMED"
  | "TOO_MANY"
  | "UNKNOWN_KEY"
  | "UNKNOWN_STATUS"
  | "KEY_NOT_APPLICABLE"
  | "DUPLICATE_KEY"
  | "NOTE_TOO_LONG"
  | "CITATION_NOT_IN_PACKET"
  | "CITATION_NOT_ON_KEY"
  | "UNCITED_PRESENCE"
  | "PRESENCE_ON_GAP";

export interface AcceptedFindings {
  readonly accepted: readonly ReadinessFinding[];
  /** index -1 means the whole result was unusable. Reasons only, never content. */
  readonly dropped: readonly { readonly index: number; readonly reason: FindingDropReason }[];
}

const isStatus = (s: unknown): s is ReadinessFindingStatus =>
  (READINESS_FINDING_STATUSES as readonly unknown[]).includes(s);

type Verdict =
  | { readonly ok: true; readonly finding: ReadinessFinding }
  | { readonly ok: false; readonly reason: FindingDropReason };

const refuse = (reason: FindingDropReason): Verdict => ({ ok: false, reason });

function judge(
  raw: unknown,
  gaps: DeterministicGaps,
  packet: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Verdict {
  if (typeof raw !== "object" || raw === null) return refuse("MALFORMED");
  const r = raw as Record<string, unknown>;
  if (typeof r.checklistKey !== "string") return refuse("MALFORMED");
  if (!isChecklistKey(r.checklistKey)) return refuse("UNKNOWN_KEY");
  if (!isStatus(r.status)) return refuse("UNKNOWN_STATUS");
  if (typeof r.note !== "string" || !Array.isArray(r.citedDocumentIds)) return refuse("MALFORMED");
  if (!r.citedDocumentIds.every((c) => typeof c === "string")) return refuse("MALFORMED");
  const key = r.checklistKey;
  const cited = r.citedDocumentIds as string[];
  const state = gaps.keys.find((g) => g.checklistKey === key);
  if (state?.status === "marked_not_applicable") return refuse("KEY_NOT_APPLICABLE");
  if (seen.has(key)) return refuse("DUPLICATE_KEY");
  const note = normalizeReadinessNote(r.note);
  if (note.length > MAX_READINESS_NOTE_LENGTH) return refuse("NOTE_TOO_LONG");
  if (!cited.every((c) => packet.has(c))) return refuse("CITATION_NOT_IN_PACKET");
  if (r.status === "looks_present") {
    if (state?.isGap) return refuse("PRESENCE_ON_GAP");
    if (cited.length === 0) return refuse("UNCITED_PRESENCE");
    // A presence claim must cite a document a person attached to THIS item, not any document in the packet.
    if (!cited.some((c) => state?.documentIds.includes(c))) return refuse("CITATION_NOT_ON_KEY");
  }
  return {
    ok: true,
    finding: {
      checklistKey: key,
      status: r.status,
      citedDocumentIds: [...new Set(cited)],
      note,
    },
  };
}

/** Filters whatever a (possibly misbehaving) assistant returned down to findings that are safe to show. */
export function acceptAiFindings(
  candidates: unknown,
  gaps: DeterministicGaps,
  packetDocumentIds: readonly string[],
): AcceptedFindings {
  if (!Array.isArray(candidates)) {
    return { accepted: [], dropped: [{ index: -1, reason: "MALFORMED" }] };
  }
  const packet = new Set(packetDocumentIds);
  const seen = new Set<string>();
  const accepted: ReadinessFinding[] = [];
  const dropped: { index: number; reason: FindingDropReason }[] = [];
  candidates.forEach((raw: unknown, index) => {
    if (index >= MAX_READINESS_AI_FINDINGS) {
      dropped.push({ index, reason: "TOO_MANY" });
      return;
    }
    const verdict = judge(raw, gaps, packet, seen);
    if (!verdict.ok) {
      dropped.push({ index, reason: verdict.reason });
      return;
    }
    seen.add(verdict.finding.checklistKey);
    accepted.push(verdict.finding);
  });
  return { accepted, dropped };
}

/** A review counts as "reviewed" once every finding has a disposition. It is never a sign-off requirement. */
export function isReviewDisposed(
  findings: readonly { readonly disposition: string | null }[],
): boolean {
  return findings.every((f) => f.disposition !== null);
}
