// M36 WP 2.1 - the versioned structured message body ("rich body").
//
// ONE pure, dependency-free module shared by the server (authority: validate + sanitise + canonicalise +
// project) and the web (compose + safe render). The client is never trusted: the server runs
// `sanitizeRichBody` on every write and again on every read, and stores only its OUTPUT.
//
// The AST is deliberately small and CLOSED. There is no raw-HTML node, no image/embed node, no attribute bag.
// Every node is rebuilt field by field from an allowlist, so an unknown key or node type is a rejection, never
// a pass-through. Links accept `https:` and `mailto:` only. See docs/messaging-hub/03-phases-0-to-3.md WP 2.1.

import { CLINICAL_LINK_KINDS, type ClinicalLinkKind } from "./clinical-link";

/** Bumped only by a breaking change to the node set; readers refuse versions they do not know. */
export const RICH_BODY_SCHEMA_VERSION = 1;

export const RICH_BODY_LIMITS = {
  /** Deepest nesting of nodes below the root (doc = depth 1). */
  maxDepth: 8,
  /** All nodes, text and mention nodes included. */
  maxNodes: 500,
  /** Characters of visible text (text + code + mention labels), i.e. the plain-text projection budget. */
  maxTextChars: 10_000,
  maxLinkChars: 2_048,
  maxMentionLabelChars: 120,
  maxMarksPerText: 4,
  /** Links in one document. */
  maxLinks: 50,
  /** WP 3.2: clinicalLink nodes in one document. */
  maxClinicalLinks: 10,
  /** UTF-8 size of the canonical JSON (what is hashed and encrypted); bounds every expansion after cleaning. */
  maxCanonicalBytes: 65_536,
} as const;

/** What a clinicalLink node contributes to the plain-text projection: fixed text, never a title or any record text. */
export const CLINICAL_LINK_PLAIN_TEXT = "[linked record]";

export const RICH_LINK_SCHEMES = ["https:", "mailto:"] as const;

export type RichMark =
  | { readonly type: "bold" }
  | { readonly type: "italic" }
  | { readonly type: "code" }
  | { readonly type: "link"; readonly href: string };

export interface RichText {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly RichMark[];
}
export interface RichMention {
  readonly type: "mention";
  readonly kind: "staff" | "patient";
  readonly entityId: string;
  /** Display label at write time; the server rejects a label that is not the directory name, readers prefer the server's. */
  readonly label: string;
}
/**
 * WP 3.2: a reference to a clinical record owned by another module. Ids only: no label is stored or accepted, the
 * server supplies status/label at read time through the owning module's seam. Additive to schema v1: the node is only
 * ever written while the `messaging.clinical_links` tenant flag is on (the write path refuses it otherwise).
 */
export interface RichClinicalLink {
  readonly type: "clinicalLink";
  readonly kind: ClinicalLinkKind;
  readonly entityId: string;
}
export interface RichHardBreak {
  readonly type: "hardBreak";
}
export type RichInline = RichText | RichMention | RichClinicalLink | RichHardBreak;

export interface RichParagraph {
  readonly type: "paragraph";
  readonly content: readonly RichInline[];
}
export interface RichListItem {
  readonly type: "listItem";
  readonly content: readonly (RichParagraph | RichList)[];
}
export interface RichList {
  readonly type: "bulletList" | "orderedList";
  readonly content: readonly RichListItem[];
}
export interface RichCodeBlock {
  readonly type: "codeBlock";
  readonly text: string;
}

/** WP 3.3: the four SBAR sections in order, their fixed projection labels, and the sender's urgency suggestion. */
export const SBAR_SECTION_KEYS = [
  "situation",
  "background",
  "assessment",
  "recommendation",
] as const;
export type SbarSectionKey = (typeof SBAR_SECTION_KEYS)[number];
export const SBAR_SECTION_LABELS: Readonly<Record<SbarSectionKey, string>> = {
  situation: "Situation",
  background: "Background",
  assessment: "Assessment",
  recommendation: "Recommendation",
};
export const SBAR_URGENCY_HINTS = ["routine", "important", "urgent"] as const;
export type SbarUrgencyHint = (typeof SBAR_URGENCY_HINTS)[number];

export type RichSbarSection = readonly (RichParagraph | RichList)[];
/**
 * WP 3.3: a structured SBAR message. A closed block that must be the document's ONLY top-level block. The sanitiser
 * checks structure only (no length rule: every stored body is re-sanitised on read, so a length rule here would
 * blank old messages when a floor is raised); lengths are checked on write. `urgencyHint` is a sender label and is
 * never projected.
 */
export interface RichSbar {
  readonly type: "sbar";
  readonly urgencyHint: SbarUrgencyHint;
  readonly situation: RichSbarSection;
  readonly background: RichSbarSection;
  readonly assessment: RichSbarSection;
  readonly recommendation: RichSbarSection;
}
export type RichBlock = RichParagraph | RichList | RichCodeBlock | RichSbar;
export interface RichDoc {
  readonly type: "doc";
  readonly content: readonly RichBlock[];
}
export interface RichBody {
  readonly schemaVersion: typeof RICH_BODY_SCHEMA_VERSION;
  readonly doc: RichDoc;
}

export type RichBodyResult =
  | { readonly ok: true; readonly value: RichBody }
  | { readonly ok: false; readonly reason: string };

const MAILTO_ADDRESS = "[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
const MAILTO_PATH = new RegExp(`^${MAILTO_ADDRESS}(?:,${MAILTO_ADDRESS})*$`);
const VISIBLE_GLYPH = /[\p{L}\p{N}\p{S}\p{P}]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// C0/C1 controls (newline and tab are kept only where the node allows them), bidi embedding/override/isolate
// controls (Trojan-Source), BOM, word joiner, zero-width space, line/paragraph separators.
const STRIP_COMMON =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const STRIP_INLINE = /[\n\t\r]/g;

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

// Characters a reader cannot see (or that reorder/hide text): Default_Ignorable_Code_Point (soft hyphen, CGJ, Hangul
// fillers, Khmer inherent vowels, Mongolian separators, variation selectors, tag characters ...) and the format
// category Cf (ZWNJ/ZWJ, bidi marks, invisible operators ...), plus the braille blank U+2800.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F/u;
const EMOJI_BASE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;

/**
 * Remove invisible characters. Documented exception, deliberately simple: a ZWJ (U+200D) survives only between two
 * pictographs (emoji ZWJ sequences), and a VS16 (U+FE0F) only right after a pictograph or a keycap base followed by
 * U+20E3. Everything else invisible is dropped, ZWNJ included (known limit: it is meaningful in Persian and some
 * Indic scripts; recorded in the WP 2.1 note).
 */
export function stripInvisible(value: string): string {
  const chars = Array.from(value);
  let out = "";
  let last = "";
  chars.forEach((char, index) => {
    if (!INVISIBLE.test(char)) {
      out += char;
      last = char;
      return;
    }
    const next = chars[index + 1] ?? "";
    const keepZwj = char === "\u200D" && PICTOGRAPH.test(last) && EMOJI_BASE.test(next);
    const keepVs16 =
      char === "\uFE0F" && (EMOJI_BASE.test(last) || (/[0-9#*]/.test(last) && next === "\u20E3"));
    if (keepZwj || keepVs16) {
      out += char;
      last = char;
    }
  });
  return out;
}

const MAX_CLEAN_PASSES = 8;

/** Text clean-up: Unicode-normalised, controls, bidi and invisible characters removed; newlines only for code. */
export function cleanRichText(
  value: string,
  keepNewlines = false,
  form: "NFC" | "NFKC" = "NFC",
): string {
  // Strip, normalise, strip again, until nothing changes. Normalising after stripping can compose a base with a
  // combining mark that an invisible character used to separate (e + ZWNJ + U+0301), so one pass is not a fixed
  // point; the result of this loop is, which keeps sanitize(sanitize(x)) === sanitize(x) and therefore keeps
  // write-time mention offsets valid against the body as it is read back.
  let text = value.replace(/\r\n?/g, "\n");
  for (let pass = 0; pass < MAX_CLEAN_PASSES; pass += 1) {
    const next = stripInvisible(text.replace(STRIP_COMMON, "")).normalize(form);
    const settled = stripInvisible(next.replace(STRIP_COMMON, "")).normalize(form);
    if (settled === text) break;
    text = settled;
  }
  if (!keepNewlines) text = text.replace(STRIP_INLINE, " ");
  else text = text.replace(/[\t]/g, "  ");
  return text;
}

/** Label comparison form: NFKC, invisible characters removed, trimmed. Both sides of a mention check use it. */
export function normalizeMentionLabel(value: string): string {
  return cleanRichText(value, false, "NFKC").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(node: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) reject(`${what}: unknown field "${key.slice(0, 40)}"`);
  }
}

/** The one place a link target is decided. Returns the normalised URL or null (never throws). */
export function safeLinkHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RICH_BODY_LIMITS.maxLinkChars) {
    return null;
  }
  // Whitespace/control characters inside a scheme are how `java\tscript:` slips past naive filters.
  if (
    INVISIBLE.test(raw) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    /[\u0000-\u0020\u007F-\u009F\u2028\u2029]/.test(raw)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!(RICH_LINK_SCHEMES as readonly string[]).includes(url.protocol)) return null;
  if (
    url.protocol === "https:" &&
    (url.username !== "" || url.password !== "" || url.hostname === "")
  ) {
    return null; // https://trusted.example@evil.example/ - credentials in a URL are a spoofing shape
  }
  if (url.protocol === "mailto:") {
    // Only the address is kept: a query (subject, cc, bcc, body) or fragment is attacker-chosen content.
    // A conservative address list only: no percent escapes (they can hide bidi or invisible characters and are never
    // needed for an ordinary address), no non-ASCII, no spaces. Anything else is not linked.
    if (!MAILTO_PATH.test(url.pathname)) return null;
    const mailto = `mailto:${url.pathname}`;
    return mailto.length > RICH_BODY_LIMITS.maxLinkChars ? null : mailto;
  }
  // The NORMALISED form is what is stored and rendered; percent-encoding can make it much longer than the input.
  return url.href.length > RICH_BODY_LIMITS.maxLinkChars ? null : url.href;
}

/** What a reader shows on hover for a link: the real destination host (or the mailto address). */
export function linkTargetLabel(href: string): string {
  try {
    const url = new URL(href);
    // Never empty: a reader who is shown nothing cannot tell where the link goes, so fall back to the whole target.
    return (url.protocol === "mailto:" ? url.pathname : url.host) || href;
  } catch {
    return href;
  }
}

interface Budget {
  nodes: number;
  chars: number;
  links: number;
  clinicalLinks: number;
}

function enter(budget: Budget, depth: number, what: string): void {
  if (depth > RICH_BODY_LIMITS.maxDepth)
    reject(`${what}: nesting deeper than ${RICH_BODY_LIMITS.maxDepth}`);
  budget.nodes += 1;
  if (budget.nodes > RICH_BODY_LIMITS.maxNodes)
    reject(`more than ${RICH_BODY_LIMITS.maxNodes} nodes`);
}

function spend(budget: Budget, text: string): void {
  budget.chars += text.length;
  if (budget.chars > RICH_BODY_LIMITS.maxTextChars) {
    reject(`more than ${RICH_BODY_LIMITS.maxTextChars} characters of text`);
  }
}

function cleanMarks(raw: unknown, budget: Budget): RichMark[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > RICH_BODY_LIMITS.maxMarksPerText)
    reject("text: invalid marks");
  const seen = new Set<string>();
  const marks: RichMark[] = [];
  for (const mark of raw as unknown[]) {
    if (!isRecord(mark) || typeof mark.type !== "string") return reject("mark: not an object");
    if (seen.has(mark.type)) reject(`mark: duplicate "${mark.type}"`);
    seen.add(mark.type);
    if (mark.type === "bold" || mark.type === "italic" || mark.type === "code") {
      exactKeys(mark, ["type"], "mark");
      marks.push({ type: mark.type });
    } else if (mark.type === "link") {
      exactKeys(mark, ["type", "href"], "link");
      const href = safeLinkHref(mark.href);
      if (href === null) reject("link: only https: and mailto: targets are allowed");
      budget.links += 1;
      if (budget.links > RICH_BODY_LIMITS.maxLinks)
        reject(`more than ${RICH_BODY_LIMITS.maxLinks} links`);
      marks.push({ type: "link", href: href as string });
    } else {
      reject(`mark: unknown type "${mark.type.slice(0, 40)}"`);
    }
  }
  return marks;
}

function cleanInline(node: unknown, depth: number, budget: Budget): RichInline {
  if (!isRecord(node)) return reject("inline: not an object");
  enter(budget, depth, "inline");
  switch (node.type) {
    case "text": {
      exactKeys(node, ["type", "text", "marks"], "text");
      if (typeof node.text !== "string") reject("text: not a string");
      const text = cleanRichText(node.text as string);
      if (text === "") reject("text: empty after sanitisation");
      spend(budget, text);
      const marks = cleanMarks(node.marks, budget);
      // A link needs something to click: text with no letter, digit, symbol or punctuation left after cleaning
      // (whitespace, NBSP, U+3000, a lone combining mark ...) would be an invisible link. Digit-only text is fine.
      if (!VISIBLE_GLYPH.test(text) && marks.some((mark) => mark.type === "link")) {
        reject("text: a link needs visible text");
      }
      return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
    }
    case "hardBreak":
      exactKeys(node, ["type"], "hardBreak");
      return { type: "hardBreak" };
    case "mention": {
      exactKeys(node, ["type", "kind", "entityId", "label"], "mention");
      if (node.kind !== "staff" && node.kind !== "patient") reject("mention: unknown kind");
      if (typeof node.entityId !== "string" || !UUID.test(node.entityId))
        reject("mention: bad entityId");
      if (typeof node.label !== "string") reject("mention: bad label");
      const label = normalizeMentionLabel(node.label as string);
      if (label === "" || label.length > RICH_BODY_LIMITS.maxMentionLabelChars)
        reject("mention: bad label");
      spend(budget, `@${label}`);
      return {
        type: "mention",
        kind: node.kind as "staff" | "patient",
        entityId: (node.entityId as string).toLowerCase(),
        label,
      };
    }
    case "clinicalLink": {
      exactKeys(node, ["type", "kind", "entityId"], "clinicalLink");
      if (
        typeof node.kind !== "string" ||
        !(CLINICAL_LINK_KINDS as readonly string[]).includes(node.kind)
      )
        reject("clinicalLink: unknown kind");
      if (typeof node.entityId !== "string" || !UUID.test(node.entityId))
        reject("clinicalLink: bad entityId");
      budget.clinicalLinks += 1;
      if (budget.clinicalLinks > RICH_BODY_LIMITS.maxClinicalLinks)
        reject(`more than ${RICH_BODY_LIMITS.maxClinicalLinks} clinical links`);
      spend(budget, CLINICAL_LINK_PLAIN_TEXT);
      return {
        type: "clinicalLink",
        kind: node.kind as ClinicalLinkKind,
        entityId: (node.entityId as string).toLowerCase(),
      };
    }
    default:
      return reject(`inline: unknown node type "${String(node.type).slice(0, 40)}"`);
  }
}

function cleanChildren<T>(raw: unknown, what: string, clean: (child: unknown) => T): T[] {
  if (!Array.isArray(raw)) return reject(`${what}: content is not a list`);
  return (raw as unknown[]).map(clean);
}

function cleanParagraph(
  node: Record<string, unknown>,
  depth: number,
  budget: Budget,
): RichParagraph {
  exactKeys(node, ["type", "content"], "paragraph");
  return {
    type: "paragraph",
    content: cleanChildren(node.content, "paragraph", (child) =>
      cleanInline(child, depth + 1, budget),
    ),
  };
}

function cleanList(node: Record<string, unknown>, depth: number, budget: Budget): RichList {
  exactKeys(node, ["type", "content"], "list");
  const type = node.type as "bulletList" | "orderedList";
  const items = cleanChildren(node.content, "list", (item): RichListItem => {
    if (!isRecord(item) || item.type !== "listItem") return reject("list: only listItem children");
    enter(budget, depth + 1, "listItem");
    exactKeys(item, ["type", "content"], "listItem");
    const content = cleanChildren(item.content, "listItem", (child) => {
      if (!isRecord(child)) return reject("listItem: child is not an object");
      enter(budget, depth + 2, "listItem child");
      if (child.type === "paragraph") return cleanParagraph(child, depth + 2, budget);
      if (child.type === "bulletList" || child.type === "orderedList") {
        return cleanList(child, depth + 2, budget);
      }
      return reject("listItem: only paragraph or list children");
    });
    return { type: "listItem", content };
  });
  return { type, content: items };
}

function cleanSbar(node: Record<string, unknown>, budget: Budget): RichSbar {
  exactKeys(node, ["type", "urgencyHint", ...SBAR_SECTION_KEYS], "sbar");
  if (!(SBAR_URGENCY_HINTS as readonly unknown[]).includes(node.urgencyHint))
    reject("sbar: bad urgencyHint");
  const sections = {} as Record<SbarSectionKey, RichSbarSection>;
  for (const key of SBAR_SECTION_KEYS) {
    const cleaned = cleanChildren(node[key], `sbar ${key}`, (child) => {
      if (!isRecord(child)) return reject(`sbar ${key}: child is not an object`);
      enter(budget, 3, `sbar ${key} child`);
      if (child.type === "paragraph") return cleanParagraph(child, 3, budget);
      if (child.type === "bulletList" || child.type === "orderedList")
        return cleanList(child, 3, budget);
      return reject(`sbar ${key}: only paragraph or list children`);
    });
    const visible = richBlocksToPlainText(cleaned);
    if (!VISIBLE_GLYPH.test(visible)) reject(`sbar ${key}: section is empty`);
    sections[key] = cleaned;
  }
  return {
    type: "sbar",
    urgencyHint: node.urgencyHint as SbarUrgencyHint,
    situation: sections.situation,
    background: sections.background,
    assessment: sections.assessment,
    recommendation: sections.recommendation,
  };
}

function cleanBlock(node: unknown, budget: Budget): RichBlock {
  if (!isRecord(node)) return reject("block: not an object");
  enter(budget, 2, "block");
  switch (node.type) {
    case "paragraph":
      return cleanParagraph(node, 2, budget);
    case "bulletList":
    case "orderedList":
      return cleanList(node, 2, budget);
    case "codeBlock": {
      exactKeys(node, ["type", "text"], "codeBlock");
      if (typeof node.text !== "string") reject("codeBlock: not a string");
      const text = cleanRichText(node.text as string, true);
      spend(budget, text);
      return { type: "codeBlock", text };
    }
    case "sbar":
      return cleanSbar(node, budget);
    default:
      return reject(`block: unknown node type "${String(node.type).slice(0, 40)}"`);
  }
}

/**
 * Validate and rebuild an untrusted value into a canonical rich body. The result shares no object with the
 * input, carries only allowlisted fields in a fixed key order (so its JSON is deterministic), and every string is
 * cleaned. Never throws.
 */
export function sanitizeRichBody(input: unknown): RichBodyResult {
  try {
    if (!isRecord(input)) return reject("body: not an object");
    exactKeys(input, ["schemaVersion", "doc"], "body");
    if (input.schemaVersion !== RICH_BODY_SCHEMA_VERSION) reject("body: unsupported schemaVersion");
    const doc = input.doc;
    if (!isRecord(doc) || doc.type !== "doc") return reject("body: doc missing");
    exactKeys(doc, ["type", "content"], "doc");
    const budget: Budget = { nodes: 1, chars: 0, links: 0, clinicalLinks: 0 };
    const content = cleanChildren(doc.content, "doc", (block) => cleanBlock(block, budget));
    if (content.length > 1 && content.some((block) => block.type === "sbar"))
      reject("sbar: must be the only block in the document");
    const value: RichBody = {
      schemaVersion: RICH_BODY_SCHEMA_VERSION,
      doc: { type: "doc", content },
    };
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > RICH_BODY_LIMITS.maxCanonicalBytes
    ) {
      return reject(`body: larger than ${RICH_BODY_LIMITS.maxCanonicalBytes} bytes`);
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.message };
    return { ok: false, reason: "body: could not be read" };
  }
}

/** Deterministic JSON of an already-sanitised body: this exact string is what gets hashed and encrypted. */
export function canonicalRichBodyJson(body: RichBody): string {
  return JSON.stringify(body);
}

/** Parse the stored plaintext of a `rich` message. Re-sanitises, so a stored value is never trusted either. */
export function parseStoredRichBody(plaintext: string): RichBodyResult {
  try {
    return sanitizeRichBody(JSON.parse(plaintext));
  } catch {
    return { ok: false, reason: "stored body is not JSON" };
  }
}

// --- plain-text projection ------------------------------------------------------------------------------------

export interface RichMentionSpan {
  readonly kind: "staff" | "patient";
  readonly entityId: string;
  readonly label: string;
  /** Offsets into `richBodyToPlainText`, covering the `@label` token (what message_entity_reference stores). */
  readonly start: number;
  readonly end: number;
}

interface Projection {
  readonly text: string;
  readonly mentions: RichMentionSpan[];
}

/** One pass builds the text and the mention offsets together, so they cannot disagree. */
function project(body: RichBody): Projection {
  let raw = "";
  const found: RichMentionSpan[] = [];
  const inline = (node: RichInline): void => {
    if (node.type === "text") raw += node.text;
    else if (node.type === "hardBreak") raw += "\n";
    else if (node.type === "clinicalLink") raw += CLINICAL_LINK_PLAIN_TEXT;
    else {
      const token = `@${node.label}`;
      found.push({
        kind: node.kind,
        entityId: node.entityId,
        label: node.label,
        start: raw.length,
        end: raw.length + token.length,
      });
      raw += token;
    }
  };
  const listBlock = (node: RichList, indent: number): void => {
    node.content.forEach((item, index) => {
      const marker = node.type === "orderedList" ? `${index + 1}. ` : "- ";
      let first = true;
      for (const child of item.content) {
        if (child.type === "paragraph") {
          if (raw !== "" && !raw.endsWith("\n")) raw += "\n";
          raw += `${" ".repeat(indent)}${first ? marker : " ".repeat(marker.length)}`;
          first = false;
          for (const node2 of child.content) inline(node2);
        } else listBlock(child, indent + 2);
      }
    });
  };
  const blocks = (list: readonly RichBlock[]): void => {
    list.forEach((block, index) => {
      if (index > 0) raw += "\n";
      if (block.type === "paragraph") for (const node of block.content) inline(node);
      else if (block.type === "codeBlock") raw += block.text;
      else if (block.type === "sbar") {
        raw += "SBAR";
        for (const key of SBAR_SECTION_KEYS) {
          raw += `\n${SBAR_SECTION_LABELS[key]}: `;
          blocks(block[key]);
        }
      } else listBlock(block, 0);
    });
  };
  blocks(body.doc.content);
  const lead = raw.length - raw.trimStart().length;
  return {
    text: raw.trim(),
    mentions: found.map((span) => ({ ...span, start: span.start - lead, end: span.end - lead })),
  };
}

/**
 * The deterministic plain-text projection: visible text only. No JSON, no mark delimiters, no link targets, no
 * labels for anything the reader would not see. This is the ONLY form that may reach previews, search, the
 * `body` field legacy clients read, and any non-in-app channel.
 */
export function richBodyToPlainText(body: RichBody): string {
  return project(body).text;
}

/** Projection of a run of blocks on its own (an SBAR section); offsets are not needed there. */
export function richBlocksToPlainText(content: readonly RichBlock[]): string {
  return project({ schemaVersion: RICH_BODY_SCHEMA_VERSION, doc: { type: "doc", content } }).text;
}

/** Mention nodes in document order with their offsets in the plain-text projection. */
export function richBodyMentions(body: RichBody): RichMentionSpan[] {
  return project(body).mentions;
}
/** Collapse a stored body of ANY kind to the text a reader/preview may show. Unreadable rich body => "". */
export function storedBodyToPlainText(bodyKind: string, plaintext: string): string {
  if (bodyKind !== "rich") return plaintext;
  const parsed = parseStoredRichBody(plaintext);
  return parsed.ok ? richBodyToPlainText(parsed.value) : "";
}

/** The distinct clinicalLink nodes of a body in document order (a repeated record is one link). */
export function richBodyClinicalLinks(
  body: RichBody,
): Array<{ readonly kind: ClinicalLinkKind; readonly entityId: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: ClinicalLinkKind; entityId: string }> = [];
  const inline = (node: RichInline): void => {
    if (node.type !== "clinicalLink") return;
    const key = `${node.kind}:${node.entityId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: node.kind, entityId: node.entityId });
  };
  const list = (node: RichList): void => {
    for (const item of node.content)
      for (const child of item.content) {
        if (child.type === "paragraph") child.content.forEach(inline);
        else list(child);
      }
  };
  const blocks = (content: readonly RichBlock[]): void => {
    for (const block of content) {
      if (block.type === "paragraph") block.content.forEach(inline);
      else if (block.type === "bulletList" || block.type === "orderedList") list(block);
      else if (block.type === "sbar") for (const key of SBAR_SECTION_KEYS) blocks(block[key]);
    }
  };
  blocks(body.doc.content);
  return out;
}
