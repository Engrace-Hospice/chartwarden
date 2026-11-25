import { type DbClient, schema } from "@chartwarden/db";
import {
  type ClassifiedPage,
  type CodeOnPage,
  type CodingFlag,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  type GroundedDiagnosis,
  type IntakeDocumentType,
  type PacketSegment,
  SUD_RULESET_VERSION,
  type SudIndicator,
  type SudIndicatorCategory,
  attachCodesToDiagnoses,
  classifyPages,
  detectSudIndicators,
  dominantSudCategory,
  findCodeTokens,
  findExtractionField,
  findExtractionSchema,
  groundQuote,
  resolveCodeTokens,
  runCodingChecks,
  splitPacket,
} from "@chartwarden/intake-extraction";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ClassifiedPageDocType,
  DegradedError,
  type IntakeSudDetectedPayload,
  M22_INTAKE_SUD_DETECTED_EVENT,
} from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import {
  type RecordsRequestMatchSummary,
  matchInboundRecordsRequest,
} from "../records-request/inbound-match";
// apps/backend/src/modules/22-documents/extraction/intake-job.ts — the DocLens intake JOB: one uploaded
// batch through stages 2–4 of §7.1 W1, persisted for review (F-236, ADR-0048).
//
//   source document (MinIO) ──presigned GET──▶ docling-worker  (stage 2: OCR + layout + boxes)
//     ──per page──▶ M32 DocLensClassifier                       (stage 3: document type)
//     ──per same-type run──▶ M32 DocLensExtractor               (stage 4: value + verbatim quote + page)
//     ──▶ groundQuote against Docling's text                    (the box is always Docling's)
//     ──▶ high/medium-risk values: docling /render crop ──▶ M32 DocLensVisionVerifier (stage 5, F-237)
//     ──▶ classified_page / extraction_job / extraction_candidate (value DEK-encrypted)
//   every page ──▶ SUD rules (+ optional M32 DocLensSudDetector, grounded) (§7.4 W4, F-237)
//     ──▶ batch `sud_status` + encrypted evidence + `m22.intake.sud_detected`, atomic with completion
//
// Stage 5 never shows the model the extracted value: it asks the model to READ the field from a crop of
// the page and compares the reading here (alphanumerics only). A match sets `vision_verified`; a mismatch
// stores the model's reading encrypted in `vision_disagreement`; a refusal or an illegible crop leaves the
// value unverified, which the review UI says out loud.
//
// SUD detection runs whatever the AI posture: the rules need no capability. Every candidate on a page
// with an indicator is tagged `sud_detected` (the page is Part 2-bearing content; the F-235 planner
// excludes it from writeback until a reviewer rejects the detection as a false positive).
//
// What it never does:
//   · trust the model for a box, a page, a risk tier or a field path. Box/page come from grounding; tier
//     and path from the schema registry (`findExtractionField`). A path the schema does not declare, or a
//     quote that does not ground, is DROPPED and counted — never stored.
//   · store a value in the clear. `value_cipher` only (the F-235 commit decrypts server-side).
//   · write back to the chart. That is the reviewer's act (F-235's route 23).
//   · read M32 code: the seams are reached opaquely through the M1 registry (M22 deps stay [1, 5]).
//
// A refused AI call (ai.full off, lifecycle, opt-in, budget, no template, no healthy backend …) is not an
// error to retry blindly: the affected job is marked `awaiting_capability` and the summary carries the
// refusal detail. A Docling outage IS retried (thrown). An unparseable source marks the batch
// `parse_failed`. Re-running a batch that already produced jobs is a no-op (idempotent on status).
import {
  type BatchIdentityStatus,
  type IdentityTargetPorts,
  refreshBatchIdentity,
} from "./batch-identity";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import type { CodingTerminologyAdapter } from "./coding-terminology";
import { type DoclingClient, type DoclingPage, DoclingParseError } from "./docling-client";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;
const DV = schema.documentVersions;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;
const PROCESSABLE_BATCH_STATUSES = ["uploaded", "docling_complete", "classifier_complete"] as const;

class BatchNoLongerProcessable extends Error {
  constructor(readonly status: string) {
    super(`intake batch became ${status}`);
  }
}

/** The structural slices of M32's DocLens seams this job calls (M22 has no M32 edge). */
type SeamRefusal = { readonly available: false; readonly detail?: string };
export interface DocLensClassifierPort {
  classify(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    extractedText: string;
    pageCount: number;
    pageNumber?: number;
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly documentType: string;
        readonly confidence: number;
      }
    | SeamRefusal
  >;
}
export interface DocLensExtractorPort {
  extract(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    documentType: string;
    extractedText: string;
    schemaKey: string;
    fieldSpecs: readonly { fieldPath: string; description: string }[];
    pages: readonly { page: number; text: string }[];
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly fields: Readonly<
          Record<
            string,
            {
              readonly value: unknown;
              readonly confidence: number;
              readonly sourceQuote?: { readonly page: number; readonly text: string };
            }
          >
        >;
      }
    | SeamRefusal
  >;
}

/** F-237 — M32's stage-5 seam, `field_value` mode only (structural). */
export interface DocLensVisionVerifierPort {
  verify(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    verificationKey: "field_value";
    images: readonly { pageNumber: number; mediaType: "image/png"; dataBase64: string }[];
    field: { fieldPath: string; description: string };
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly verdict: "pass" | "fail" | "uncertain";
        readonly observedValue?: string;
        readonly observedValues?: readonly string[];
      }
    | SeamRefusal
  >;
}

/** F-237 — M32's SUD detector seam (structural). Its quotes are GROUNDED here before they count. */
export interface DocLensSudDetectorPort {
  detect(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    extractedText: string;
    pages: readonly { page: number; text: string }[];
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly indicators: readonly {
          readonly pageNumber: number;
          readonly snippet: string;
          readonly category: string;
        }[];
      }
    | SeamRefusal
  >;
}

export interface DocLensIntakeDeps {
  readonly db: DbClient;
  readonly docling: DoclingClient;
  readonly presignSource: (args: {
    organizationId: string;
    bucket: string;
    objectKey: string;
  }) => Promise<string>;
  readonly cipher: CandidateValueCipher;
  readonly classifier: () => DocLensClassifierPort;
  readonly extractor: () => DocLensExtractorPort;
  /** F-237 — stage 5. Absent ⇒ high/medium-risk values stay unverified (and say so). */
  readonly visionVerifier?: () => DocLensVisionVerifierPort;
  /** F-237 — the optional model pass of SUD detection. Absent ⇒ the rules alone. */
  readonly sudDetector?: () => DocLensSudDetectorPort;
  /** F-237 — publishes `m22.intake.sud_detected`. Required the moment a batch has an indicator. */
  readonly outbox?: ExtractionOutboxPort;
  readonly confidenceFloor?: number;
  /**
   * F-238 — ICD-10-CM for the code scanner + coding checks (M38). Absent, or no release loaded ⇒ codes are
   * neither scanned nor checked, and the summary says so (`coding.status`).
   */
  readonly codingTerminology?: () => CodingTerminologyAdapter;
  /** F-238 — M5 patient / M6 referral lookups for the per-document identity check (absent ⇒ not run). */
  readonly identityTargets?: IdentityTargetPorts;
}

/** F-237 — the risk tiers stage 5 re-reads from the page (medications/allergies + name/DOB). */
export const VISION_VERIFIED_RISK_LEVELS: ReadonlySet<string> = new Set(["high", "medium"]);
/**
 * Context around a value's box, in page units (points). Wide horizontally (the label beside the value),
 * TIGHT vertically: a list's neighbouring entries sit ~20pt apart on a fax, and a crop that shows three
 * medication lines lets the model read the wrong one — the first E2E run did exactly that (F-237).
 */
const CROP_PAD_X = 48;
const CROP_PAD_Y = 6;
const CROP_SCALE = 3;

/**
 * Does the model's independent reading agree with the extracted value? Alphanumerics only, lower-cased
 * (OCR spacing and punctuation are not disagreements); one containing the other counts when they are of
 * comparable length ("Penicillin" vs "penicillin." agrees; "Penicillin" vs "Penicillin — anaphylaxis"
 * does not, and the reviewer sees the longer reading).
 */
const alnum = (s: string): string => s.toLowerCase().replace(/[^0-9a-z]/g, "");

/** The reading most like the extracted value (bigram overlap) — what the reviewer is shown on a mismatch. */
export function closestReading(extracted: string, readings: readonly string[]): string {
  const grams = (s: string) => {
    const a = alnum(s);
    const out = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) out.add(a.slice(i, i + 2));
    return out;
  };
  const target = grams(extracted);
  let best = readings[0] as string;
  let bestScore = -1;
  for (const r of readings) {
    const g = grams(r);
    let shared = 0;
    for (const x of g) if (target.has(x)) shared += 1;
    const score = (2 * shared) / (g.size + target.size || 1);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * How a reading is compared. `entry` (default): a list entry or identity value — the reading must be about
 * as long as the value, so a truncated "Penicillin" never agrees with "Penicillin — anaphylaxis".
 * `prose`: a diagnosis description. The crop is the whole paragraph the diagnosis sits in, so the reading is a
 * sentence and the value is a part of it; it agrees when the sentence contains the whole value.
 */
export type VisionComparison = "entry" | "prose";

const PROSE_DESCRIPTION = /^diagnoses\[\d+\]\.description$/;
/** A normalised enum (the document's label for a diagnosis) has no verbatim form on the page to re-read. */
const NORMALISED_ENUM = /^diagnoses\[\d+\]\.role$/;

export const visionComparisonFor = (fieldPath: string): VisionComparison =>
  PROSE_DESCRIPTION.test(fieldPath) ? "prose" : "entry";

/** Does stage 5 re-read this field from the page? High/medium risk, except a normalised enum. */
export const requiresVisionCheck = (riskLevel: string, fieldPath: string): boolean =>
  VISION_VERIFIED_RISK_LEVELS.has(riskLevel) && !NORMALISED_ENUM.test(fieldPath);

/**
 * The model is asked for EVERY entry of a list visible in the crop. Given "diagnoses[1].description" it
 * instead returns the 2nd entry of the crop — the index counts entries across the whole document, not within
 * the image — so entries sharing one paragraph were each checked against the wrong neighbour. Without the
 * number it returns them all, and the comparison picks the one it needs.
 */
export const unindexedFieldPath = (fieldPath: string): string =>
  fieldPath.replace(/\[\d+\]/g, "[]");

/**
 * Any of these anywhere in the sentence means the page does not state the extracted finding as the
 * patient's: negated, ruled out, uncertain, or someone else's. Scanned across the WHOLE sentence — a
 * "Denies the following: chest pain, COPD" list and "COPD ruled out" are both caught. ("non" is not here:
 * "Non-ischemic cardiomyopathy" is a diagnosis; "Non-COPD" fails on the adjacent-word rule below.)
 */
const FINDING_QUALIFIERS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "never",
  "neg",
  "negative",
  "deny",
  "denies",
  "denied",
  "absent",
  "absence",
  "ruled",
  "rule",
  "exclude",
  "excluded",
  "exclusion",
  "possible",
  "possibly",
  "probable",
  "probably",
  "suspect",
  "suspected",
  "questionable",
  "versus",
  "vs",
  "family",
  "maternal",
  "paternal",
  "mother",
  "father",
  "sister",
  "brother",
  "sibling",
  "parent",
  // Resolved, doubtful or unconfirmed: the page does not state an active diagnosis.
  "resolved",
  "unlikely",
  "likely",
  "doubtful",
  "none",
  "remission",
  "cured",
  "cleared",
  "inactive",
  "unconfirmed",
  "differential",
  "screening",
  "unknown",
  // Someone else's, by every spelling a chart uses.
  "mom",
  "mum",
  "dad",
  "son",
  "daughter",
  "aunt",
  "uncle",
  "grandmother",
  "grandfather",
  "grandparent",
  "wife",
  "husband",
  "spouse",
  "relative",
  "relatives",
  "fam",
  "fh",
  "fhx",
  // A bare "N" in a yes/no column.
  "n",
  // "n't" contractions with the apostrophe dropped, as OCR often reads them.
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "wasnt",
  "arent",
  "werent",
  "hasnt",
  "hadnt",
  "havent",
  "cant",
  "cannot",
  "wont",
]);
/**
 * Negates only what FOLLOWS it. "Presented without COPD" denies it, but "Alzheimer's disease with late onset,
 * with dementia, without behavioral disturbance" is a descriptor of a diagnosis that is stated.
 */
const NEGATES_FOLLOWING: ReadonlySet<string> = new Set(["without"]);
/** "?COPD", "r/o COPD" (also "R.O."), a negative "(-)" / "[-]", and an unticked or crossed box. */
const UNCERTAIN_MARK = /\?|\br\s*[/.]\s*o\b|\(\s*-\s*\)|\[\s*-?\s*\]|[✗✘✕☐☒×]/i;

/**
 * The only words that may touch the value without changing which disease it names. Anything else adjacent
 * ("Diabetes insipidus", "Vascular dementia", "Breast cancer") makes the extracted value a less specific
 * name for a different diagnosis, which changes its code.
 */
const MODIFIER_BEFORE: ReadonlySet<string> = new Set([
  "severe",
  "moderate",
  "mild",
  "advanced",
  "chronic",
  "acute",
  "end",
  "stage",
  "permanent",
  "persistent",
  "known",
  "metastatic",
  // "Alzheimer's dementia (moderate) and malnutrition": a list of findings, each its own.
  "and",
  // "Stage IV pancreatic cancer": the numeral belongs to "stage".
  "i",
  "ii",
  "iii",
  "iv",
]);
const CONNECTOR_AFTER: ReadonlySet<string> = new Set([
  "with",
  "without",
  "on",
  "in",
  "and",
  "due",
  "is",
  "was",
  "are",
  "were",
  "has",
  "had",
  "diagnosed",
  "since",
  "stage",
  "grade",
  "class",
  "gold",
]);
const PHRASE_BREAK: ReadonlySet<string> = new Set([",", ":", ";", "(", ")", "[", "]"]);

/**
 * Words and phrase-break marks, lower-cased. Hyphens and apostrophes split words; a decimal point does not end a
 * sentence. A contraction of "not" is read as the word ("doesn't" is "does not"), so it negates like "not" does.
 */
const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/n['’]t\b/g, " not")
    .match(/[0-9a-z]+|[,:;()[\]]/g) ?? [];
/**
 * A period ends a sentence only after a word of four or more letters (or a number) and not before a digit:
 * "Neg. COPD", "Fam. hx: COPD" and "Mat. breast cancer" are one sentence led by an abbreviation, not two.
 */
const SENTENCE_END = /(?<=[a-z]{4}|\d)\.(?!\d)/i;
/** A sentence this short is a qualifier standing alone ("Negative.", "Ruled out.") and applies to its neighbours. */
const FRAGMENT_TOKENS = 3;
/** A sentence of the value plus at most this many other words is the bare diagnosis name ("Pneumonia."). */
const BARE_EXTRA_WORDS = 1;

const isWord = (t: string): boolean => !PHRASE_BREAK.has(t);

interface ScannedSentence {
  readonly tokens: readonly string[];
  /** The sentence negates, doubts or reassigns what it states, or a qualified neighbour governs it. */
  readonly blocked: boolean;
}

/**
 * Splits a reading into sentences and marks the ones that do not state a finding as the patient's. A qualified
 * neighbour governs a sentence that is only the diagnosis name ("Pneumonia. Ruled out per CXR.", "Denies the
 * following. COPD."), and a short qualifier fragment ("Negative.") governs whatever sentence stands beside it.
 */
function scanSentences(text: string, valueWords: number): ScannedSentence[] {
  const parts = text.split(SENTENCE_END).map((part) => ({ part, tokens: tokenize(part) }));
  const qualified = ({ part, tokens }: (typeof parts)[number]): boolean =>
    UNCERTAIN_MARK.test(part) || tokens.some((t) => FINDING_QUALIFIERS.has(t));
  // The nearest qualified sentence on one side, reached across short unqualified list items ("Denies the following
  // symptoms. Chest pain. COPD."); a sentence that states something of its own ends the reach.
  const reach = (at: number, step: 1 | -1): (typeof parts)[number] | undefined => {
    for (let n = at + step; n >= 0 && n < parts.length; n += step) {
      const next = parts[n] as (typeof parts)[number];
      if (qualified(next)) return next;
      if (next.tokens.length > FRAGMENT_TOKENS) return undefined;
    }
    return undefined;
  };
  return parts.map((sentence, at) => {
    const bare = sentence.tokens.filter(isWord).length <= valueWords + BARE_EXTRA_WORDS;
    const governed = ([-1, 1] as const).some((step) => {
      const governor = reach(at, step);
      return governor !== undefined && (bare || governor.tokens.length <= FRAGMENT_TOKENS);
    });
    return { tokens: sentence.tokens, blocked: qualified(sentence) || governed };
  });
}

/** Where the value's words occur in order, as a run, within a sentence's tokens. */
const phraseStarts = (tokens: readonly string[], value: readonly string[]): number[] =>
  tokens.flatMap((_, i) =>
    i + value.length <= tokens.length && value.every((t, k) => tokens[i + k] === t) ? [i] : [],
  );

/** "presented without COPD" — a "without" earlier in the sentence negates what follows it. */
const followsWithout = (tokens: readonly string[], at: number): boolean =>
  tokens.slice(0, at).some((t) => NEGATES_FOLLOWING.has(t));

/**
 * Prose comparison for a diagnosis description. True when a sentence of the reading holds every token of
 * the value in order, as a whole phrase (the words either side are a phrase break or a plain modifier or
 * connector), and nothing in that sentence negates, doubts or reassigns it. Fails safe: anything doubtful is
 * a disagreement, which sends the reviewer to the page.
 */
function proseContains(extracted: string, observed: string): boolean {
  const value = tokenize(extracted);
  const words = value.filter(isWord).length;
  if (words === 0) return false;
  for (const { tokens, blocked } of scanSentences(observed, words)) {
    if (blocked) continue;
    for (const i of phraseStarts(tokens, value)) {
      if (followsWithout(tokens, i)) continue;
      const before = tokens[i - 1];
      const after = tokens[i + value.length];
      if (before !== undefined && !PHRASE_BREAK.has(before) && !MODIFIER_BEFORE.has(before))
        continue;
      if (after !== undefined && !PHRASE_BREAK.has(after) && !CONNECTOR_AFTER.has(after)) continue;
      return true;
    }
  }
  return false;
}

/**
 * The value's own page quote (what the extractor grounded it in) is a second signal beside the vision reading: the
 * model returns each list entry as its own string, so it can return a bare "COPD" out of "Denies: chest pain, COPD"
 * and the reading alone cannot tell. True when the quote holds the value only inside a sentence that negates, doubts
 * or reassigns it. A quote that does not hold the value's words cannot judge, so it never denies.
 */
export function quoteDeniesValue(extracted: string, quote: string): boolean {
  const value = tokenize(extracted);
  const words = value.filter(isWord).length;
  if (words === 0) return false;
  const occurrences = scanSentences(quote, words).flatMap(({ tokens, blocked }) =>
    phraseStarts(tokens, value).map((i) => blocked || followsWithout(tokens, i)),
  );
  return occurrences.length > 0 && occurrences.every(Boolean);
}

export function visionReadingAgrees(
  extracted: string,
  observed: string,
  mode: VisionComparison = "entry",
): boolean {
  const a = alnum(extracted);
  const b = alnum(observed);
  if (a.length === 0 || b.length === 0) return false;
  // Prose has its own rule; the length-ratio shortcut below would let "No heart failure" through. Letters
  // and digits alone equal ("COPD" / "COPD." / "type2 diabetes") agrees unless the page marks it uncertain.
  if (mode === "prose")
    return a === b ? !UNCERTAIN_MARK.test(observed) : proseContains(extracted, observed);
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short) && short.length / long.length >= 0.6;
}

/**
 * Stage 5's verdict for one value: some reading of the crop agrees with it, and for a diagnosis description the
 * value's own page quote does not deny it (a bare reading cannot show the "Denies:" in front of it).
 */
export function visionConfirms(input: {
  readonly fieldPath: string;
  readonly value: string;
  readonly quote?: string | undefined;
  readonly readings: readonly string[];
}): boolean {
  const mode = visionComparisonFor(input.fieldPath);
  if (!input.readings.some((o) => visionReadingAgrees(input.value, o, mode))) return false;
  return mode !== "prose" || !input.quote || !quoteDeniesValue(input.value, input.quote);
}

export interface DocLensIntakeJob {
  readonly organizationId: string;
  readonly batchId: string;
  /** The user whose request started the run — the AI ledger's actor (M32 resolves the membership). */
  readonly actorUserId: string;
  readonly correlationId: string;
}

export type DocLensIntakeSummary =
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "parse_failed"; readonly reason: string }
  | {
      readonly outcome: "extracted" | "awaiting_capability";
      readonly pages: number;
      readonly jobs: number;
      readonly candidates: number;
      readonly dropped: Readonly<Record<string, number>>;
      readonly refusals: readonly string[];
      /** F-237 — counts only. */
      readonly vision: {
        readonly verified: number;
        readonly disagreed: number;
        readonly unverified: number;
      };
      readonly sud: { readonly indicators: number; readonly pages: readonly number[] };
      /** F-238 — the batch's worst per-document identity verdict, or why none was computed. */
      readonly identity: BatchIdentityStatus | "not_configured";
      /** F-238 — the records-request code match (a `conflict` outcome is a warning for staff). */
      readonly recordsRequest: RecordsRequestMatchSummary;
      /** F-238 — the splitter's documents and the coding checks (counts only). */
      readonly documents: number;
      readonly coding: {
        readonly status: "checked" | "icd10cm_not_loaded" | "not_configured";
        readonly codes: number;
        readonly repaired: number;
        readonly flags: number;
        readonly unreadable: number;
      };
    };

const SCHEMA_KEY = "doclens_v1";

/** F-238 — a document's label for a diagnosis, normalised to the four the review and writeback know. */
function normaliseRole(v: string): string {
  const s = v.toLowerCase();
  if (/princip|primary/.test(s)) return "principal";
  if (/second|other|additional/.test(s)) return "secondary";
  if (/hist|past|resolv|prior/.test(s)) return "history";
  return "unspecified";
}
const pageText = (p: DoclingPage): string => p.blocks.map((b) => b.text).join("\n");

export async function runDocLensIntake(
  deps: DocLensIntakeDeps,
  job: DocLensIntakeJob,
): Promise<DocLensIntakeSummary> {
  try {
    return await runDocLensIntakeWhileProcessable(deps, job);
  } catch (error) {
    if (error instanceof BatchNoLongerProcessable) {
      return { outcome: "skipped", reason: `batch_became_${error.status}` };
    }
    throw error;
  }
}

async function runDocLensIntakeWhileProcessable(
  deps: DocLensIntakeDeps,
  job: DocLensIntakeJob,
): Promise<DocLensIntakeSummary> {
  const org = job.organizationId;
  const inOrg = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, { organizationId: org, userId: "" }, (tx) => fn(tx as DbClient));
  const inProcessableOrg = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    inOrg(async (tx) => {
      const [current] = await tx
        .select({ status: BATCH.status })
        .from(BATCH)
        .where(eq(BATCH.id, job.batchId))
        .for("update")
        .limit(1);
      if (!current || !PROCESSABLE_BATCH_STATUSES.includes(current.status as never)) {
        throw new BatchNoLongerProcessable(current?.status ?? "missing");
      }
      return fn(tx);
    });

  // ── 1. the batch and its filed source document ─────────────────────────────────────────────────────
  const source = await inOrg(async (tx) => {
    const [b] = await tx
      .select({
        status: BATCH.status,
        documentId: BATCH.initialDocumentId,
        patientId: BATCH.patientId,
      })
      .from(BATCH)
      .where(eq(BATCH.id, job.batchId))
      .limit(1);
    if (!b) return { kind: "missing" as const };
    if (
      b.status !== "uploaded" &&
      b.status !== "docling_complete" &&
      b.status !== "classifier_complete"
    ) {
      return { kind: "done" as const, status: b.status };
    }
    const [d] = await tx
      .select({ objectKey: DV.minioObjectKey })
      .from(DOC)
      .innerJoin(DV, eq(DV.id, DOC.activeVersionId))
      .where(eq(DOC.id, b.documentId))
      .limit(1);
    return d
      ? {
          kind: "ok" as const,
          documentId: b.documentId,
          objectKey: d.objectKey,
          patientId: b.patientId,
        }
      : { kind: "unfiled" as const, documentId: b.documentId };
  });
  if (source.kind === "missing") return { outcome: "skipped", reason: "batch_not_found" };
  if (source.kind === "done")
    return { outcome: "skipped", reason: `batch_already_${source.status}` };
  const setBatch = (
    status: "docling_complete" | "classifier_complete" | "extraction_complete" | "parse_failed",
  ) =>
    inProcessableOrg((tx) =>
      tx
        .update(BATCH)
        .set({ status })
        .where(
          and(eq(BATCH.id, job.batchId), inArray(BATCH.status, [...PROCESSABLE_BATCH_STATUSES])),
        )
        .then(() => undefined),
    );
  if (source.kind === "unfiled") {
    await setBatch("parse_failed");
    return { outcome: "parse_failed", reason: "source_document_has_no_filed_version" };
  }

  // ── 2. Docling ───────────────────────────────────────────────────────────────────────────────────
  let pages: readonly DoclingPage[];
  const presign = () =>
    deps.presignSource({
      organizationId: org,
      bucket: deriveTenantBucket(org),
      objectKey: source.objectKey,
    });
  try {
    const url = await presign();
    pages = (
      await deps.docling.parse({
        organizationId: org,
        jobId: job.batchId,
        sourceUrl: url,
        correlationId: job.correlationId,
      })
    ).pages;
  } catch (err) {
    if (err instanceof DoclingParseError && err.kind !== "unavailable") {
      await setBatch("parse_failed");
      return { outcome: "parse_failed", reason: err.kind };
    }
    throw err; // worker unavailable / storage error ⇒ BullMQ retries
  }
  await inProcessableOrg((tx) =>
    tx
      .update(BATCH)
      .set({
        status: "docling_complete",
        pageGeometry: pages.map((p) => ({ page: p.page, width: p.width, height: p.height })),
      })
      .where(and(eq(BATCH.id, job.batchId), inArray(BATCH.status, [...PROCESSABLE_BATCH_STATUSES])))
      .then(() => undefined),
  );

  // ── 2a. F-238: records returned for an outbound request? The cover sheet's code on the first pages (or
  // the e-mail subject in source metadata) files an unfiled batch under the request's referral. Runs
  // BEFORE the identity check (step 6), which then compares the documents against that prospect. A batch
  // already filed elsewhere is never moved: the summary carries the warning instead.
  const recordsRequest = await inProcessableOrg((tx) =>
    matchInboundRecordsRequest(tx, {
      organizationId: org,
      batchId: job.batchId,
      pageTexts: pages.map(pageText),
    }),
  );

  // ── 2b. SUD detection over every page (§7.4 W4 step 1) — rules always, the model when it may run ──
  const refusalsEarly: string[] = [];
  const decodeStoredSud = async (ciphertext: string | null): Promise<SudIndicator[]> => {
    if (!ciphertext) return [];
    try {
      const decoded = JSON.parse(await deps.cipher.decrypt(org, ciphertext));
      if (!Array.isArray(decoded)) throw new Error("not an array");
      return decoded.filter(
        (indicator): indicator is SudIndicator =>
          indicator !== null &&
          typeof indicator === "object" &&
          Number.isInteger((indicator as SudIndicator).page) &&
          typeof (indicator as SudIndicator).category === "string" &&
          typeof (indicator as SudIndicator).ruleId === "string" &&
          typeof (indicator as SudIndicator).term === "string" &&
          Array.isArray((indicator as SudIndicator).bbox) &&
          (indicator as SudIndicator).bbox.length === 4,
      );
    } catch {
      throw new DegradedError("doclens-intake", "stored SUD evidence could not be read");
    }
  };
  const authoritativeSud = await inProcessableOrg(async (tx) => {
    const [current] = await tx
      .select({
        patientId: BATCH.patientId,
        sudStatus: BATCH.sudStatus,
        sudEvidenceCipher: BATCH.sudEvidenceCipher,
        sudDetectorRef: BATCH.sudDetectorRef,
      })
      .from(BATCH)
      .where(eq(BATCH.id, job.batchId))
      .limit(1);
    if (!current) throw new BatchNoLongerProcessable("missing");
    const indicators = [
      ...(await decodeStoredSud(current.sudEvidenceCipher)),
      ...detectSudIndicators(pages),
    ];
    const refs = [
      ...new Set(
        [...(current.sudDetectorRef?.split("+") ?? []), SUD_RULESET_VERSION].filter(Boolean),
      ),
    ];
    // Legacy workers persisted `rules:v1` even when the configured detector refused. Only an AI
    // invocation proves that optional scan completed; rules-only is complete when no detector exists.
    let scanComplete = deps.sudDetector
      ? refs.some((ref) => ref.startsWith("ai_invocation:"))
      : true;
    if (!scanComplete && deps.sudDetector) {
      const result = await deps.sudDetector().detect({
        organizationId: org,
        actorUserId: job.actorUserId,
        documentId: source.documentId,
        extractedText: "",
        pages: pages.map((page) => ({ page: page.page, text: pageText(page) })),
      });
      if (!result.available) {
        refusalsEarly.push(`sud_detect: ${result.detail ?? "refused"}`);
      } else {
        scanComplete = true;
        refs.push(`ai_invocation:${result.invocationId}`);
        for (const indicator of result.indicators) {
          const grounded = groundQuote(pages, {
            page: indicator.pageNumber,
            quote: indicator.snippet,
            value: indicator.snippet,
          });
          if (!grounded.grounded) continue;
          indicators.push({
            page: grounded.page,
            category: (SUD_CATEGORIES.has(indicator.category)
              ? indicator.category
              : "social_history") as SudIndicatorCategory,
            ruleId: `ai:${indicator.category}`,
            term: indicator.snippet,
            bbox: grounded.bbox,
          });
        }
      }
    } else if (!deps.sudDetector) {
      scanComplete = true;
    }
    const merged = [
      ...new Map(
        indicators.map((indicator) => [
          JSON.stringify([
            indicator.page,
            indicator.category,
            indicator.ruleId,
            indicator.term,
            indicator.bbox,
          ]),
          indicator,
        ]),
      ).values(),
    ];
    const newlyDetected = current.sudStatus === "not_detected" && merged.length > 0;
    if (newlyDetected && !deps.outbox) {
      throw new DegradedError("doclens-intake", "SUD indicators found but no outbox is bound");
    }
    const evidence = merged.length ? await deps.cipher.encrypt(org, JSON.stringify(merged)) : null;
    if (scanComplete || evidence) {
      await tx
        .update(BATCH)
        .set({
          ...(scanComplete ? { sudDetectorRef: [...new Set(refs)].join("+") } : {}),
          ...(evidence
            ? {
                sudEvidenceCipher: evidence,
                ...(newlyDetected ? { sudStatus: "detected" as const } : {}),
              }
            : {}),
        })
        .where(eq(BATCH.id, job.batchId));
    }
    if (newlyDetected && deps.outbox) {
      const payload: IntakeSudDetectedPayload = {
        intakeBatchId: job.batchId,
        patientId: current.patientId,
        candidateCount: 0,
        suggestedSudKind: dominantSudCategory(merged),
        pages: [...new Set(merged.map((indicator) => indicator.page))].sort((a, b) => a - b),
      };
      await deps.outbox.publish(tx, {
        eventName: M22_INTAKE_SUD_DETECTED_EVENT,
        payload: { ...payload, organizationId: org },
        organizationId: org,
        aggregateKind: "intake_upload_batch",
        aggregateId: job.batchId,
      });
    }
    return { indicators: merged, scanComplete };
  });
  const sudIndicators = authoritativeSud.indicators;
  const sudPages = new Set(sudIndicators.map((i) => i.page));

  // ── 3. classify each page ────────────────────────────────────────────────────────────────────────
  const refusals: string[] = [...refusalsEarly];
  const loadClassificationPlan = () =>
    inOrg((tx) =>
      tx
        .select({
          id: CP.id,
          pageFrom: CP.pageRangeStart,
          pageTo: CP.pageRangeEnd,
          documentType: CP.documentType,
          confidence: CP.confidence,
          humanConfirmed: CP.humanConfirmed,
          classifierModelVersionRef: CP.classifierModelVersionRef,
          title: CP.documentTitle,
          documentDate: CP.documentDate,
          duplicateOfPage: CP.duplicateOfPage,
          boundary: CP.segmentBoundary,
        })
        .from(CP)
        .where(eq(CP.intakeUploadBatchId, job.batchId))
        .orderBy(CP.pageRangeStart),
    );
  let persistedPlan = await loadClassificationPlan();
  const classifierRef = new Map<number, string>();
  if (persistedPlan.length === 0) {
    const classified: ClassifiedPage[] = [];
    for (const p of pages) {
      const r = await deps.classifier().classify({
        organizationId: org,
        actorUserId: job.actorUserId,
        documentId: source.documentId,
        extractedText: pageText(p),
        pageCount: pages.length,
        pageNumber: p.page,
      });
      if (!r.available) {
        refusals.push(`classify p${p.page}: ${r.detail ?? "refused"}`);
        classified.push(
          ...classifyPages(
            [{ pageNumber: p.page, documentType: "unknown", confidence: 0 }],
            deps.confidenceFloor,
          ),
        );
        classifierRef.set(p.page, "refused");
        continue;
      }
      classified.push(
        ...classifyPages(
          [
            {
              pageNumber: p.page,
              documentType: r.documentType as ClassifiedPageDocType,
              confidence: r.confidence,
            },
          ],
          deps.confidenceFloor ?? DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
        ),
      );
      classifierRef.set(p.page, `ai_invocation:${r.invocationId}`);
    }
    const proposed = splitPacket(pages, classified);
    await inProcessableOrg(async (tx) => {
      // A second BullMQ delivery may have classified while this one was awaiting a model. The batch
      // lock makes one complete plan win; the other delivery resumes that plan instead of appending.
      const [existing] = await tx
        .select({ id: CP.id })
        .from(CP)
        .where(eq(CP.intakeUploadBatchId, job.batchId))
        .limit(1);
      if (existing) return;
      await tx.insert(CP).values(
        proposed.map((seg) => ({
          organizationId: org,
          intakeUploadBatchId: job.batchId,
          sourceDocumentId: source.documentId,
          pageRangeStart: Math.min(...seg.pageNumbers),
          pageRangeEnd: Math.max(...seg.pageNumbers),
          documentType: seg.documentType,
          confidence: seg.confidence.toFixed(3),
          classifierModelVersionRef: classifierRef.get(seg.pageNumbers[0] as number) ?? "refused",
          documentTitle: seg.title,
          documentDate: seg.documentDate,
          duplicateOfPage: seg.duplicateOfPage,
          segmentBoundary: seg.boundary,
        })),
      );
    });
    persistedPlan = await loadClassificationPlan();
  }

  const plannedPageNumbers = persistedPlan.flatMap((row) =>
    Array.from({ length: row.pageTo - row.pageFrom + 1 }, (_, index) => row.pageFrom + index),
  );
  const parsedPageNumbers = pages.map((page) => page.page);
  if (
    plannedPageNumbers.length !== parsedPageNumbers.length ||
    plannedPageNumbers.some((page, index) => page !== parsedPageNumbers[index])
  ) {
    throw new DegradedError(
      "doclens-intake",
      "persisted classification plan does not cover each parsed page exactly once",
    );
  }

  // Once any classification evidence is stored, its complete page-range plan is authoritative for all
  // retries. The classifier is not called again, so changed labels or boundaries cannot fork evidence.
  const plannedSegments = persistedPlan.map((row) => ({
    id: row.id,
    segment: {
      pageNumbers: Array.from(
        { length: row.pageTo - row.pageFrom + 1 },
        (_, index) => row.pageFrom + index,
      ),
      documentType: row.documentType,
      confidence: Number(row.confidence),
      needsHumanClassification:
        row.documentType === "unknown" ||
        (!row.humanConfirmed &&
          Number(row.confidence) < (deps.confidenceFloor ?? DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR)),
      title: row.title,
      documentDate: row.documentDate,
      duplicateOfPage: row.duplicateOfPage,
      boundary: (row.boundary ?? "first_page") as PacketSegment["boundary"],
    } satisfies PacketSegment,
  }));

  // ── 4. extract each contiguous same-type run, ground, persist ───────────────────────────────────
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const vision = { verified: 0, disagreed: 0, unverified: 0 };

  // ── 3b. split the fax into the documents inside it (F-238) ──────────────────────────────────────
  const segments = plannedSegments.map((planned) => planned.segment);
  const segmentOf = (page: number) => segments.find((s) => s.pageNumbers.includes(page));

  // ── 3c. read the ICD-10-CM codes off the pages and check them (F-238) — deterministic, no model ──────
  // Codes come from the page, never from the extractor (AI Governance §2.1.1). Re-sent pages are skipped
  // so a duplicate never reads as a second, conflicting document.
  let scannedCodes: CodeOnPage[] = [];
  let codingFlags: CodingFlag[] = [];
  let codingStatus: "checked" | "icd10cm_not_loaded" | "not_configured" = "not_configured";
  const terminology = deps.codingTerminology?.();
  if (terminology) {
    if (!(await terminology.isLoaded())) {
      codingStatus = "icd10cm_not_loaded";
    } else {
      codingStatus = "checked";
      const original = pages.filter((p) => segmentOf(p.page)?.duplicateOfPage == null);
      const resolved = await resolveCodeTokens(findCodeTokens(original), terminology);
      scannedCodes = resolved.map((c) => ({
        ...c,
        blockBox: (original.find((p) => p.page === c.page)?.blocks[c.blockIndex]?.bbox ?? [
          0, 0, 0, 0,
        ]) as readonly [number, number, number, number],
      }));
      codingFlags = await runCodingChecks(
        {
          referenceDate: new Date().toISOString().slice(0, 10),
          pageText: new Map(original.map((p) => [p.page, pageText(p)])),
          codes: scannedCodes.map((c) => ({
            ...c,
            documentDate: segmentOf(c.page)?.documentDate ?? null,
            documentKey: segmentOf(c.page)?.pageNumbers[0] ?? c.page,
          })),
        },
        terminology,
      );
    }
  }

  for (const { id: pageId, segment: seg } of plannedSegments) {
    // A re-sent page, or a document that needs a human to classify it, gets its classified_page row (the
    // reviewer sees it) but no extraction job.
    if (seg.duplicateOfPage !== null || seg.needsHumanClassification) {
      continue;
    }
    const run = seg;
    const runPages = pages.filter((p) => run.pageNumbers.includes(p.page));
    const docType = run.documentType as IntakeDocumentType;
    const schemaFields = findExtractionSchema(docType)?.fields ?? [];
    const [persistedJob] = await inOrg((tx) =>
      tx
        .select({ id: EJ.id, status: EJ.status })
        .from(EJ)
        .where(eq(EJ.classifiedPageId, pageId))
        .limit(1),
    );
    if (persistedJob?.status === "ready_for_review") {
      continue;
    }

    const result = await deps.extractor().extract({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: source.documentId,
      documentType: docType,
      extractedText: "",
      schemaKey: SCHEMA_KEY,
      // `page_scan` fields (ICD-10-CM codes) are never asked of a model.
      fieldSpecs: schemaFields
        .filter((f) => f.source !== "page_scan")
        .map((f) => ({ fieldPath: f.fieldPath, description: f.description })),
      pages: runPages.map((p) => ({ page: p.page, text: pageText(p) })),
    });
    if (!result.available) {
      refusals.push(
        `extract ${docType} p${run.pageNumbers.join(",")}: ${result.detail ?? "refused"}`,
      );
      await inProcessableOrg(async (tx) => {
        const [currentJob] = await tx
          .select({ id: EJ.id, status: EJ.status })
          .from(EJ)
          .where(eq(EJ.classifiedPageId, pageId))
          .limit(1);
        if (currentJob?.status === "ready_for_review") return;
        const values = {
          organizationId: org,
          classifiedPageId: pageId,
          documentType: docType,
          status: "awaiting_capability" as const,
          extractorModelVersionRef: "refused",
          failureReason: (result.detail ?? "refused").slice(0, 500),
          correlationId: job.correlationId,
        };
        if (currentJob) {
          await tx.update(EJ).set(values).where(eq(EJ.id, currentJob.id));
        } else {
          await tx.insert(EJ).values(values);
        }
      });
      continue;
    }

    const extractorRef = `ai_invocation:${result.invocationId}`;
    const accepted: Array<{
      fieldPath: string;
      riskLevel: "low" | "medium" | "high";
      value: string;
      confidence: number;
      page: number;
      bbox: readonly [number, number, number, number];
      /** The page quote the value was grounded in; stage 5 checks a diagnosis description against it too. */
      quote?: string;
      codingFlags?: readonly CodingFlag[];
    }> = [];
    // F-238 — diagnoses are collected, then joined with the page-scanned codes below.
    const dxWording: GroundedDiagnosis[] = [];
    const dxRoles = new Map<number, string>();
    const dxQuotes = new Map<number, string>();
    // A description printed with two codes is emitted twice under a new index; it shares its page and wording.
    const dxQuotesByText = new Map<string, string>();
    for (const [fieldPath, f] of Object.entries(result.fields)) {
      const spec = findExtractionField(docType, fieldPath);
      if (!spec) {
        drop("field_not_in_schema");
        continue;
      }
      if (spec.source === "page_scan") {
        drop("model_supplied_code"); // a code is only ever what the page says
        continue;
      }
      const dx = /^diagnoses\[(\d+)\]\.(description|role)$/.exec(fieldPath);
      if (dx?.[2] === "role") {
        // The role is the document's LABEL for a diagnosis, not a quotable value; it rides on its
        // description's grounding and is normalised to the four labels.
        if (typeof f.value === "string") dxRoles.set(Number(dx[1]), normaliseRole(f.value));
        continue;
      }
      if (typeof f.value !== "string" || !f.sourceQuote) {
        drop("no_quote");
        continue;
      }
      const g = groundQuote(runPages, {
        page: f.sourceQuote.page,
        quote: f.sourceQuote.text,
        value: f.value,
      });
      if (!g.grounded) {
        drop(g.reason);
        continue;
      }
      if (dx) {
        dxQuotes.set(Number(dx[1]), f.sourceQuote.text);
        dxQuotesByText.set(`${g.page} ${f.value}`, f.sourceQuote.text);
        dxWording.push({
          index: Number(dx[1]),
          description: f.value,
          role: null,
          page: g.page,
          bbox: g.bbox,
          confidence: f.confidence,
        });
        continue;
      }
      accepted.push({
        fieldPath,
        riskLevel: spec.riskLevel,
        value: f.value,
        confidence: f.confidence,
        page: g.page,
        bbox: g.bbox,
      });
    }
    if (findExtractionField(docType, "diagnoses[0].description")) {
      for (const d of attachCodesToDiagnoses({
        diagnoses: dxWording.map((d) => ({ ...d, role: dxRoles.get(d.index) ?? null })),
        codes: scannedCodes.filter((c) => c.code !== null && run.pageNumbers.includes(c.page)),
        flags: codingFlags,
      })) {
        const spec = findExtractionField(docType, d.fieldPath);
        if (!spec) continue;
        const quote =
          dxQuotes.get(Number(/^diagnoses\[(\d+)\]/.exec(d.fieldPath)?.[1])) ??
          dxQuotesByText.get(`${d.page} ${d.value}`);
        accepted.push({
          fieldPath: d.fieldPath,
          riskLevel: spec.riskLevel,
          value: d.value,
          confidence: d.confidence,
          page: d.page,
          bbox: d.bbox,
          ...(quote ? { quote } : {}),
          ...(d.codingFlags ? { codingFlags: d.codingFlags } : {}),
        });
      }
    }

    // ── 5. stage 5: re-read each high/medium-risk value from a crop of its page (F-237) ─────────────
    const checks = await Promise.all(
      accepted.map(async (a) => {
        if (!requiresVisionCheck(a.riskLevel, a.fieldPath))
          return { kind: "not_required" as const };
        if (!deps.visionVerifier) return { kind: "unverified" as const };
        return verifyByVision(a, docType);
      }),
    );
    for (const c of checks) {
      if (c.kind === "verified") vision.verified += 1;
      else if (c.kind === "disagreed") vision.disagreed += 1;
      else if (c.kind === "unverified") vision.unverified += 1;
    }
    const visionRef = checks.find((c) => "invocationId" in c && c.invocationId);
    const encrypted = await Promise.all(accepted.map((a) => deps.cipher.encrypt(org, a.value)));
    const flagCiphers = await Promise.all(
      accepted.map((a) =>
        a.codingFlags?.length ? deps.cipher.encrypt(org, JSON.stringify(a.codingFlags)) : null,
      ),
    );
    const disagreements = await Promise.all(
      checks.map((c) =>
        c.kind === "disagreed"
          ? deps.cipher.encrypt(org, JSON.stringify({ observedValue: c.observedValue }))
          : null,
      ),
    );
    await inProcessableOrg(async (tx) => {
      const [currentJob] = await tx
        .select({ id: EJ.id, status: EJ.status })
        .from(EJ)
        .where(eq(EJ.classifiedPageId, pageId))
        .limit(1);
      if (currentJob?.status === "ready_for_review") return;
      const values = {
        organizationId: org,
        classifiedPageId: pageId,
        documentType: docType,
        status: "ready_for_review" as const,
        extractorModelVersionRef: extractorRef,
        visionVerifierModelVersionRef:
          visionRef && "invocationId" in visionRef
            ? `ai_invocation:${visionRef.invocationId}`
            : null,
        aggregateConfidence: accepted.length
          ? (accepted.reduce((s, a) => s + a.confidence, 0) / accepted.length).toFixed(3)
          : null,
        failureReason: null,
        correlationId: job.correlationId,
        completedAt: new Date(),
      };
      let jobId = currentJob?.id;
      if (jobId) {
        await tx.update(EJ).set(values).where(eq(EJ.id, jobId));
      } else {
        const [ej] = await tx.insert(EJ).values(values).returning({ id: EJ.id });
        jobId = (ej as { id: string }).id;
      }
      for (const [i, a] of accepted.entries()) {
        await tx.insert(EC).values({
          organizationId: org,
          extractionJobId: jobId,
          fieldPath: a.fieldPath,
          fieldKind: "text",
          riskLevel: a.riskLevel,
          valueCipher: encrypted[i] as string,
          confidence: a.confidence.toFixed(3),
          sourcePage: a.page,
          sourceBoundingBox: { x1: a.bbox[0], y1: a.bbox[1], x2: a.bbox[2], y2: a.bbox[3] },
          visionVerified: checks[i]?.kind === "verified",
          visionDisagreement: disagreements[i] ?? null,
          sudDetected: sudPages.has(a.page),
          codingFlagsCipher: flagCiphers[i] ?? null,
        });
      }
    });
  }

  // ── 6. completion + the W4 SUD record, in ONE transaction (status, evidence, event) ──────────────
  if (sudIndicators.length > 0 && !deps.outbox) {
    // A detection M5 never hears about is a Part 2 flag that silently does not exist. Retry instead.
    throw new DegradedError("doclens-intake", "SUD indicators found but no outbox is bound");
  }
  const expectedJobPageIds = plannedSegments
    .filter(({ segment }) => segment.duplicateOfPage === null && !segment.needsHumanClassification)
    .map(({ id }) => id);
  const persistedState = await inProcessableOrg(async (tx) => {
    const persistedJobs = expectedJobPageIds.length
      ? await tx
          .select({ id: EJ.id, status: EJ.status })
          .from(EJ)
          .where(inArray(EJ.classifiedPageId, expectedJobPageIds))
      : [];
    const [batchSud] = await tx
      .select({
        sudEvidenceCipher: BATCH.sudEvidenceCipher,
        sudDetectorRef: BATCH.sudDetectorRef,
      })
      .from(BATCH)
      .where(eq(BATCH.id, job.batchId))
      .limit(1);
    if (!batchSud) throw new BatchNoLongerProcessable("missing");
    const effectiveIndicators = await decodeStoredSud(batchSud.sudEvidenceCipher);
    const effectiveSudPages = [
      ...new Set(effectiveIndicators.map((indicator) => indicator.page)),
    ].sort((a, b) => a - b);
    const persistedJobIds = persistedJobs.map((persistedJob) => persistedJob.id);
    if (persistedJobIds.length > 0 && effectiveSudPages.length > 0) {
      // Monotonic: a later/refused delivery may add Part 2 protection, never remove an earlier verdict.
      await tx
        .update(EC)
        .set({ sudDetected: true })
        .where(
          and(
            inArray(EC.extractionJobId, persistedJobIds),
            inArray(EC.sourcePage, effectiveSudPages),
          ),
        );
    }
    const persistedCandidates = persistedJobIds.length
      ? await tx
          .select({ sudDetected: EC.sudDetected })
          .from(EC)
          .where(inArray(EC.extractionJobId, persistedJobIds))
      : [];
    const allJobsReady =
      persistedJobs.length === expectedJobPageIds.length &&
      persistedJobs.every((persistedJob) => persistedJob.status === "ready_for_review");
    // Do not expose review readiness until the serialized stage 2b transaction has an authoritative
    // verdict (including legacy rules-only refs whose optional detector had actually refused).
    const allReady = allJobsReady && authoritativeSud.scanComplete;
    const finalStatus: "extraction_complete" | "classifier_complete" = allReady
      ? "extraction_complete"
      : "classifier_complete";
    await tx
      .update(BATCH)
      .set({
        // Keep review closed until the identity refresh below completes. Publishing
        // `extraction_complete` here creates a window where stale/null identity can reach writeback.
        status: "classifier_complete",
      })
      .where(eq(BATCH.id, job.batchId));
    return {
      finalStatus,
      jobs: persistedJobs.length,
      candidates: persistedCandidates.length,
      sudIndicators: effectiveIndicators.length,
      sudPages: effectiveSudPages,
    };
  });
  // ── 6. F-238: is every document about the patient (or referral) this fax is filed under? ───────────
  const identity = deps.identityTargets
    ? (
        await inProcessableOrg((tx) =>
          refreshBatchIdentity(
            tx,
            {
              cipher: deps.cipher,
              ports: deps.identityTargets as IdentityTargetPorts,
              ...(deps.outbox ? { outbox: deps.outbox } : {}),
            },
            org,
            job.batchId,
          ),
        )
      ).status
    : ("not_configured" as const);
  await inProcessableOrg((tx) =>
    tx
      .update(BATCH)
      .set({ status: persistedState.finalStatus })
      .where(and(eq(BATCH.id, job.batchId), eq(BATCH.status, "classifier_complete"))),
  );
  return {
    outcome:
      persistedState.finalStatus === "classifier_complete" ? "awaiting_capability" : "extracted",
    pages: pages.length,
    jobs: persistedState.jobs,
    candidates: persistedState.candidates,
    dropped,
    refusals,
    vision,
    sud: { indicators: persistedState.sudIndicators, pages: persistedState.sudPages },
    identity,
    recordsRequest,
    documents: segments.length,
    coding: {
      status: codingStatus,
      codes: scannedCodes.filter((c) => c.code !== null).length,
      repaired: scannedCodes.filter((c) => c.repaired).length,
      flags: codingFlags.length,
      unreadable: codingFlags.filter((f) => f.kind === "unreadable_code").length,
    },
  };

  /** Stage 5 for one value: render a padded crop of its box and ask the model to read the field. */
  async function verifyByVision(
    a: {
      fieldPath: string;
      value: string;
      page: number;
      bbox: readonly [number, number, number, number];
      quote?: string;
    },
    docType: IntakeDocumentType,
  ): Promise<
    | { kind: "verified"; invocationId: string }
    | { kind: "disagreed"; invocationId: string; observedValue: string }
    | { kind: "unverified"; invocationId?: string }
  > {
    const spec = findExtractionField(docType, a.fieldPath);
    const geometry = pages.find((p) => p.page === a.page);
    if (!spec || !geometry || !deps.visionVerifier) return { kind: "unverified" };
    let png: Uint8Array;
    try {
      png = (
        await deps.docling.render({
          organizationId: org,
          jobId: job.batchId,
          sourceUrl: await presign(),
          correlationId: job.correlationId,
          page: a.page,
          scale: CROP_SCALE,
          crop: [
            Math.max(0, a.bbox[0] - CROP_PAD_X),
            Math.max(0, a.bbox[1] - CROP_PAD_Y),
            Math.min(geometry.width, a.bbox[2] + CROP_PAD_X),
            Math.min(geometry.height, a.bbox[3] + CROP_PAD_Y),
          ],
        })
      ).png;
    } catch {
      return { kind: "unverified" }; // a render failure costs the check, never the extraction
    }
    const r = await deps.visionVerifier().verify({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: (source as { documentId: string }).documentId,
      verificationKey: "field_value",
      images: [
        {
          pageNumber: a.page,
          mediaType: "image/png",
          dataBase64: Buffer.from(png).toString("base64"),
        },
      ],
      field: { fieldPath: unindexedFieldPath(a.fieldPath), description: spec.description },
    });
    if (!r.available) {
      refusals.push(`vision ${a.fieldPath}: ${r.detail ?? "refused"}`);
      return { kind: "unverified" };
    }
    const readings = r.observedValues?.length
      ? r.observedValues
      : r.observedValue
        ? [r.observedValue]
        : [];
    if (r.verdict !== "pass" || readings.length === 0) {
      return { kind: "unverified", invocationId: r.invocationId };
    }
    return visionConfirms({ fieldPath: a.fieldPath, value: a.value, quote: a.quote, readings })
      ? { kind: "verified", invocationId: r.invocationId }
      : {
          kind: "disagreed",
          invocationId: r.invocationId,
          observedValue:
            a.quote &&
            readings.some((o) => visionReadingAgrees(a.value, o, visionComparisonFor(a.fieldPath)))
              ? a.quote // a reading agreed, so only the page quote denied it
              : closestReading(a.value, readings),
        };
  }
}

const SUD_CATEGORIES: ReadonlySet<string> = new Set([
  "medication",
  "diagnosis",
  "social_history",
  "treatment_setting",
]);
