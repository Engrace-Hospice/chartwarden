// apps/backend/src/modules/06-admission/state-machines/election-addendum.ts — FY2027 (CMS-1851-F).
//
// The election statement addendum version lifecycle (42 CFR 418.24(c), (d)):
//
//   draft ──furnish──▶ furnished ──recordSignature──────────▶ signed
//     │                    ├──────recordRefusal─────────────▶ refused                (reason on the addendum, (c)(9))
//     │                    └──────recordSignatureNotRequired▶ signature_not_required  (death/revocation/discharge, (d)(4))
//     └──markNotRequired──────────────────────────────────▶ not_required             (left care before furnish, (d)(3))
//
// `updateItems` is a `draft` self-loop: once furnished, a version is part of the record and never edited — a
// plan-of-care change makes a NEW version instead. Every terminal state is final.
//
// Pure: the caller resolves every fact (the row, the reason, who signed) and passes it in. Guards raise
// `AdmissionStateError` with an ADDENDUM_* code the UI maps to a message.
import type {
  ElectionAddendumExemptionReason,
  ElectionAddendumFurnishMethod,
  ElectionAddendumSignerKind,
  ElectionAddendumStatus,
} from "@wardenx/types";
import { AdmissionStateError, require_ } from "./errors";

/** The minimum characters a refusal reason or an exemption note must carry to be meaningful. */
export const ADDENDUM_TEXT_MINIMUM = 5;

/** One non-covered line as the machine validates it (418.24(c)(5)–(6)). */
export interface AddendumItemInput {
  readonly category: "condition" | "item" | "service" | "drug";
  readonly description: string;
  readonly reasonNotCovered: string;
}

/** The content facts `furnish` checks against 418.24(c)(1)–(8). */
export interface AddendumContentFacts {
  readonly hospiceName: string | null;
  readonly patientName: string | null;
  readonly medicalRecordNumber: string | null;
  readonly terminalDiagnosisCount: number;
  readonly items: readonly AddendumItemInput[];
  readonly noNonCoveredItems: boolean;
  readonly clinicalExplanation: string | null;
}

export type ElectionAddendumEvent =
  | { readonly type: "updateItems"; readonly content: AddendumContentFacts }
  | {
      readonly type: "furnish";
      readonly content: AddendumContentFacts;
      readonly method: ElectionAddendumFurnishMethod;
      /** The signed paper copy IS the addendum (scanned-upload path only): skip the (c) completeness check. */
      readonly contentOnPaper?: boolean;
    }
  | {
      readonly type: "recordSignature";
      readonly signerKind: ElectionAddendumSignerKind;
      readonly representativeName: string | null;
    }
  | { readonly type: "recordRefusal"; readonly reason: string }
  | {
      readonly type: "recordSignatureNotRequired";
      readonly reason: ElectionAddendumExemptionReason;
    }
  | {
      readonly type: "markNotRequired";
      readonly reason: ElectionAddendumExemptionReason;
    };

export type ElectionAddendumEventType = ElectionAddendumEvent["type"];

/** The outbox event a transition asks the service to publish (null = none). */
export type ElectionAddendumEmission =
  | "m6.election_addendum.furnished"
  | "m6.election_addendum.acknowledged"
  | "m6.election_addendum.not_required"
  | null;

export interface ElectionAddendumTransition {
  readonly from: ElectionAddendumStatus;
  readonly to: ElectionAddendumStatus;
  readonly event: ElectionAddendumEventType;
  readonly emits: ElectionAddendumEmission;
  /** True when the 418.24(d) compliance window for this version closes on this transition. */
  readonly closesWindow: boolean;
}

/** The legal transition graph. */
export const ELECTION_ADDENDUM_GRAPH: Readonly<
  Record<ElectionAddendumStatus, ReadonlyArray<ElectionAddendumEventType>>
> = {
  draft: ["updateItems", "furnish", "markNotRequired"],
  furnished: ["recordSignature", "recordRefusal", "recordSignatureNotRequired"],
  signed: [],
  refused: [],
  signature_not_required: [],
  not_required: [],
};

/** States in which the addendum obligation for that version is settled (no further action owed). */
export const SETTLED_ADDENDUM_STATUSES: ReadonlySet<ElectionAddendumStatus> = new Set([
  "signed",
  "refused",
  "signature_not_required",
  "not_required",
]);

const blank = (v: string | null | undefined): boolean => (v ?? "").trim().length === 0;

/**
 * The items list and the "no non-covered items" determination are mutually exclusive, and each item needs a
 * description and a reason (the (c)(6) clinical explanation for that line).
 */
export function checkAddendumItems(content: AddendumContentFacts): void {
  require_(
    !(content.noNonCoveredItems && content.items.length > 0),
    "ADDENDUM_ITEMS_CONFLICT",
    "An addendum cannot list non-covered items and also record that there are none",
  );
  for (const [i, item] of content.items.entries()) {
    require_(!blank(item.description), "ADDENDUM_INCOMPLETE", `Item ${i + 1} needs a description`);
    require_(
      !blank(item.reasonNotCovered),
      "ADDENDUM_INCOMPLETE",
      `Item ${i + 1} needs the reason it is not covered`,
    );
  }
}

/** The 418.24(c) content an addendum must carry before it can be furnished. Returns the missing elements. */
export function missingAddendumContent(content: AddendumContentFacts): string[] {
  const missing: string[] = [];
  if (blank(content.hospiceName)) missing.push("hospice name (c)(2)");
  if (blank(content.patientName)) missing.push("patient name (c)(3)");
  if (blank(content.medicalRecordNumber)) missing.push("medical record identifier (c)(3)");
  if (content.terminalDiagnosisCount === 0) missing.push("terminal diagnosis (c)(4)");
  if (content.items.length === 0 && !content.noNonCoveredItems) {
    missing.push("non-covered items, or the determination that there are none (c)(5)");
  }
  if (content.items.length > 0 && blank(content.clinicalExplanation)) {
    missing.push("clinical explanation (c)(6)");
  }
  return missing;
}

/**
 * Everything that keeps a version from being furnished from its structured content: the missing (c) elements
 * plus item lines without a description or reason. Empty = the structured content is complete.
 */
export function addendumContentGaps(content: AddendumContentFacts): string[] {
  const lines = content.items.flatMap((item, i) =>
    blank(item.description) || blank(item.reasonNotCovered)
      ? [`item ${i + 1} description and reason (c)(5)`]
      : [],
  );
  return [...missingAddendumContent(content), ...lines];
}

/** Apply one addendum event. Throws `ILLEGAL_TRANSITION` / an ADDENDUM_* code on a guard failure. */
export function transitionElectionAddendum(
  from: ElectionAddendumStatus,
  event: ElectionAddendumEvent,
): ElectionAddendumTransition {
  if (!ELECTION_ADDENDUM_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `An election addendum cannot ${event.type} from '${from}'`,
    );
  }
  const done = (
    to: ElectionAddendumStatus,
    emits: ElectionAddendumEmission,
    closesWindow: boolean,
  ): ElectionAddendumTransition => ({ from, to, event: event.type, emits, closesWindow });

  switch (event.type) {
    case "updateItems":
      checkAddendumItems(event.content);
      return done("draft", null, false);
    case "furnish": {
      if (event.contentOnPaper) {
        // The content is on the signed paper copy: keep whatever structured fields exist, but they must not
        // contradict themselves (the list XOR "none" determination — also a DB CHECK).
        require_(
          !(event.content.noNonCoveredItems && event.content.items.length > 0),
          "ADDENDUM_ITEMS_CONFLICT",
          "An addendum cannot list non-covered items and also record that there are none",
        );
        return done("furnished", "m6.election_addendum.furnished", true);
      }
      checkAddendumItems(event.content);
      const missing = missingAddendumContent(event.content);
      require_(
        missing.length === 0,
        "ADDENDUM_INCOMPLETE",
        `The addendum is missing: ${missing.join("; ")}`,
      );
      // The written copy IS the furnish (FR-F: a hospice cannot require an electronic signature; MLN: furnished
      // in writing). Both methods produce a printable copy, so either closes the (d)(1)/(d)(2) clock.
      return done("furnished", "m6.election_addendum.furnished", true);
    }
    case "recordSignature":
      require_(
        event.signerKind === "beneficiary" || !blank(event.representativeName),
        "ADDENDUM_REPRESENTATIVE_REQUIRED",
        "A representative signature must name the representative",
      );
      return done("signed", "m6.election_addendum.acknowledged", false);
    case "recordRefusal":
      require_(
        event.reason.trim().length >= ADDENDUM_TEXT_MINIMUM,
        "ADDENDUM_REFUSAL_REASON_REQUIRED",
        "Document why the addendum was not signed (42 CFR 418.24(c)(9))",
      );
      return done("refused", "m6.election_addendum.acknowledged", false);
    case "recordSignatureNotRequired":
      return done("signature_not_required", "m6.election_addendum.acknowledged", false);
    case "markNotRequired":
      return done("not_required", "m6.election_addendum.not_required", true);
  }
}

/**
 * Which exemption a patient leaving care earns a version in `status` (418.24(d)(3)/(d)(4)): an unfurnished draft
 * becomes `not_required`, a furnished-but-unsigned version becomes `signature_not_required`, anything settled is
 * left alone (null).
 */
export function exemptionEventFor(
  status: ElectionAddendumStatus,
  reason: ElectionAddendumExemptionReason,
): ElectionAddendumEvent | null {
  if (status === "draft") return { type: "markNotRequired", reason };
  if (status === "furnished") return { type: "recordSignatureNotRequired", reason };
  return null;
}

/** What a scanned signed (or refused) paper copy attached to a version needs to know (pure inputs). */
export interface UploadedAcknowledgementFacts {
  readonly status: ElectionAddendumStatus;
  /** When the paper was signed (signature) or the refusal documented (refusal). */
  readonly acknowledgedAt: Date;
  /** When the paper addendum was handed over — required only when the version was never furnished in-system. */
  readonly furnishedAt: Date | null;
  /** {@link addendumContentGaps} of the version's structured content (only consulted for a draft). */
  readonly contentGaps: readonly string[];
  readonly now: Date;
}

/** The plan for an uploaded acknowledgement: furnish first (paper furnished outside WardenX), or not. */
export interface UploadedAcknowledgementPlan {
  readonly furnishFirst: boolean;
  /** The (c)(10) furnish date to record when `furnishFirst`; null otherwise. */
  readonly furnishedAt: Date | null;
  /** True when a draft's structured content is incomplete: the scanned paper copy stands as the content. */
  readonly contentOnPaper: boolean;
}

const validPast = (d: Date | null, now: Date): d is Date =>
  d !== null && !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime();

/**
 * 418.24(c)(9)/(c)(10) — attach a scanned signed (or refused) paper copy. Allowed from `furnished` (the
 * acknowledgement step) and from `draft` (the paper was furnished outside the system, so it is furnished — by
 * paper — at `furnishedAt` in the same step). A draft therefore REQUIRES `furnishedAt`, on or before the
 * acknowledgement; neither date may be in the future. An INCOMPLETE draft is not refused here: the signed paper
 * copy IS the furnished addendum, so its content is on paper (`contentOnPaper`) — the keyed furnish keeps the
 * completeness check. The acknowledgement guard itself (representative name,
 * refusal reason) stays in {@link transitionElectionAddendum}.
 */
export function planUploadedAcknowledgement(
  facts: UploadedAcknowledgementFacts,
): UploadedAcknowledgementPlan {
  if (facts.status !== "draft" && facts.status !== "furnished") {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `A signed paper copy cannot be attached to an election addendum that is '${facts.status}'`,
    );
  }
  require_(
    validPast(facts.acknowledgedAt, facts.now),
    "ADDENDUM_DATE_INVALID",
    "The signature date must be a valid date that is not in the future",
  );
  if (facts.status === "furnished") {
    return { furnishFirst: false, furnishedAt: null, contentOnPaper: false };
  }
  require_(
    facts.furnishedAt !== null,
    "ADDENDUM_FURNISH_DATE_REQUIRED",
    "This addendum was never furnished in WardenX: enter the date the paper copy was given to the patient",
  );
  require_(
    validPast(facts.furnishedAt, facts.now) &&
      facts.furnishedAt.getTime() <= facts.acknowledgedAt.getTime(),
    "ADDENDUM_DATE_INVALID",
    "The furnished date must be a valid past date on or before the signature date",
  );
  return {
    furnishFirst: true,
    furnishedAt: facts.furnishedAt,
    contentOnPaper: facts.contentGaps.length > 0,
  };
}
