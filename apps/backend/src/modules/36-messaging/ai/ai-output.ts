// apps/backend/src/modules/36-messaging/ai/ai-output.ts - WP 6.5 (ADR-0095 sections 2, 3, 6): the model's answer is UNTRUSTED text. Nothing in it is
// rendered or returned until it has been parsed against a closed shape, every citation has been mapped back through the list M36 itself sent,
// links and markup have been removed, and the dose / order / diagnosis denylist has passed. PURE.
import {
  MESSAGING_AI_CONFIDENCES,
  MESSAGING_AI_LIMITS,
  MESSAGING_AI_PATIENT_TOKEN,
  type MessagingAiConfidence,
  type MessagingAiSummaryPoint,
} from "@chartwarden/types";
import { stripControlChars } from "./pseudonymise";
import type { ThreadInput } from "./thread-input";

export type ParsedSummary =
  | {
      readonly kind: "ok";
      readonly points: readonly MessagingAiSummaryPoint[];
      readonly openQuestions: readonly string[];
      readonly insufficientContext: boolean;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "refused" };

export type ParsedDrafts =
  | { readonly kind: "ok"; readonly drafts: readonly { readonly text: string }[] }
  | { readonly kind: "invalid" }
  | { readonly kind: "refused" };

/**
 * Phrasing that is a clinical conclusion or instruction, not a recollection of what colleagues wrote (governance 7.5). A hit refuses the WHOLE
 * answer with an explanation: the reader falls back to reading the conversation. Deliberately blunt (a restated dose is refused too); the clinical
 * lead may widen or narrow it (ADR-0095 open decision 1).
 */
const DENYLIST: readonly RegExp[] = [
  /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|kg|ml|cc|iu|units?|meq|mmol|mg\/ml)\b/i,
  /\b(?:titrate|prescribe|discontinue|administer|uptitrate|taper)\b/i,
  /\b(?:increase|decrease|reduce|raise|lower|stop|start|hold|give|switch|change)\s+(?:the\s+)?(?:dose|dosage|medication|morphine|opioid|infusion|pump|oxygen|rate)\b/i,
  /\b(?:i|we)\s+(?:recommend|advise|suggest|diagnose)\b/i,
  /\byou\s+should\s+(?:give|increase|decrease|stop|start|order|administer|call 911)\b/i,
  /\b(?:diagnos(?:is|ed|e)|prognos(?:is|es)|differential|likely\s+(?:has|have|due to)|consistent\s+with|rule[s]?\s+out)\b/i,
  /\b(?:place|enter|write)\s+an?\s+order\b/i,
  /\b\d+(?:[.,]\d+)?\s?(?:milligrams?|micrograms?|grams?|millilitres?|milliliters?|tablets?|pills?|patches|puffs?|drops?)\b/i,
  /\b(?:double|halve|up|bump|wean|bolus)\s+(?:the\s+)?(?:dose|dosage|medication|morphine|opioid|infusion|pump|oxygen|rate)\b/i,
  /\b(?:stat|prn|new|standing)\s+orders?\b/i,
  /\bshould\s+(?:be\s+)?(?:given|started|stopped|increased|decreased|ordered|prescribed|held|discontinued)\b/i,
];

export function violatesDenylist(text: string): boolean {
  const folded = text.normalize("NFKC");
  return DENYLIST.some((pattern) => pattern.test(folded));
}

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const TAGS = /<\/?[a-z][^>]*>/gi;

/** Plain text only: no markdown link or image, no URL, no tag, no control character. The browser still escapes it; this is the second wall. */
export function plainText(raw: string): string {
  return stripControlChars(raw)
    .replace(MARKDOWN_LINK, "$1")
    .replace(URL_LIKE, "")
    .replace(TAGS, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const ALIAS_WITH_TOKEN =
  /Sender\s+([A-Z])(\d*)(?:\s*\[(?:RN|SW|MD|CHAPLAIN|AIDE|FAMILY|STAFF)\])?/g;

/**
 * Put real names back for the CALLER, who can already read them in the thread: "Sender A [RN]" becomes the author's display name and [PATIENT]
 * becomes "the patient". This runs AFTER the model, on the answer only, so no real name ever travels to the model.
 */
export function reidentify(text: string, aliasToDisplayName: ReadonlyMap<string, string>): string {
  return text
    .replace(ALIAS_WITH_TOKEN, (_match, letter: string, round: string) => {
      return aliasToDisplayName.get(`Sender ${letter}${round}`) ?? "a colleague";
    })
    .split(MESSAGING_AI_PATIENT_TOKEN)
    .join("the patient")
    .replace(/\[(?:RN|SW|MD|CHAPLAIN|AIDE|FAMILY|STAFF|PHONE|EMAIL|LINK|DATE|ADDRESS|ID)\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const isString = (v: unknown): v is string => typeof v === "string";
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);
const isConfidence = (v: unknown): v is MessagingAiConfidence =>
  isString(v) && (MESSAGING_AI_CONFIDENCES as readonly string[]).includes(v);

/**
 * Parse and map a summary. Citations: the model only ever saw `m1..mN`; a ref that is not one whose TEXT was sent (including a withheld one, or an
 * invented one) is dropped and its point demoted to low; a point left with no valid source is discarded. The real ids come from `input`, never
 * from the model.
 */
export function parseSummary(raw: string, input: ThreadInput): ParsedSummary {
  const obj = parseJsonObject(raw);
  if (!obj || !Array.isArray(obj.points) || !Array.isArray(obj.openQuestions))
    return { kind: "invalid" };
  if (typeof obj.insufficientContext !== "boolean") return { kind: "invalid" };
  const points: MessagingAiSummaryPoint[] = [];
  const texts: string[] = [];
  for (const entry of obj.points.slice(0, MESSAGING_AI_LIMITS.maxPoints)) {
    if (typeof entry !== "object" || entry === null) return { kind: "invalid" };
    const e = entry as Record<string, unknown>;
    if (!isString(e.text) || !Array.isArray(e.sourceMessageRefs) || !isConfidence(e.confidence)) {
      return { kind: "invalid" };
    }
    const refs = [...new Set(e.sourceMessageRefs.filter(isString))];
    const valid = refs.filter((ref) => input.sentRefToMessageId.has(ref));
    const text = clip(
      reidentify(plainText(e.text), input.aliasToDisplayName),
      MESSAGING_AI_LIMITS.maxPointChars,
    );
    if (text.length === 0 || valid.length === 0) continue;
    texts.push(text);
    points.push({
      text,
      confidence: valid.length < refs.length ? "low" : e.confidence,
      sources: valid.slice(0, MESSAGING_AI_LIMITS.maxSourcesPerPoint).map((ref, i) => {
        const messageId = input.sentRefToMessageId.get(ref) as string;
        return {
          n: i + 1,
          message_id: messageId,
          sent_at: input.sentAtByMessageId.get(messageId) as string,
        };
      }),
    });
  }
  const questions: string[] = [];
  for (const q of obj.openQuestions.slice(0, MESSAGING_AI_LIMITS.maxOpenQuestions)) {
    if (!isString(q)) return { kind: "invalid" };
    const text = clip(
      reidentify(plainText(q), input.aliasToDisplayName),
      MESSAGING_AI_LIMITS.maxQuestionChars,
    );
    if (text.length > 0) questions.push(text);
  }
  if ([...texts, ...questions].some(violatesDenylist)) return { kind: "refused" };
  return {
    kind: "ok",
    points,
    openQuestions: questions,
    insufficientContext: obj.insufficientContext,
  };
}

export function parseDrafts(
  raw: string,
  aliasToDisplayName: ReadonlyMap<string, string>,
): ParsedDrafts {
  const obj = parseJsonObject(raw);
  if (!obj || !Array.isArray(obj.drafts)) return { kind: "invalid" };
  const drafts: { text: string }[] = [];
  for (const entry of obj.drafts.slice(0, MESSAGING_AI_LIMITS.maxDrafts)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isString((entry as { text?: unknown }).text)
    ) {
      return { kind: "invalid" };
    }
    const text = clip(
      reidentify(plainText((entry as { text: string }).text), aliasToDisplayName),
      MESSAGING_AI_LIMITS.maxDraftChars,
    );
    if (text.length > 0) drafts.push({ text });
  }
  if (drafts.length === 0) return { kind: "invalid" };
  if (drafts.some((d) => violatesDenylist(d.text))) return { kind: "refused" };
  return { kind: "ok", drafts };
}
