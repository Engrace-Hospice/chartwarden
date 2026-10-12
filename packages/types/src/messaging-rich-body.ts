// M36 WP 2.1 - the versioned structured message body ("rich body").
//
// ONE pure, dependency-free module shared by the server (authority: validate + sanitise + canonicalise +
// project) and the web (compose + safe render). The client is never trusted: the server runs
// `sanitizeRichBody` on every write and again on every read, and stores only its OUTPUT.
//
// The AST is deliberately small and CLOSED. There is no raw-HTML node, no image/embed node, no attribute bag.
// Every node is rebuilt field by field from an allowlist, so an unknown key or node type is a rejection, never
// a pass-through. Links accept `https:` and `mailto:` only. See docs/messaging-hub/03-phases-0-to-3.md WP 2.1.

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
} as const;

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
  /** Display label at write time; the server overwrites it from the directory, readers prefer the server's. */
  readonly label: string;
}
export interface RichHardBreak {
  readonly type: "hardBreak";
}
export type RichInline = RichText | RichMention | RichHardBreak;

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
export type RichBlock = RichParagraph | RichList | RichCodeBlock;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// C0/C1 controls (newline and tab are kept only where the node allows them), bidi embedding/override/isolate
// controls (Trojan-Source), BOM, word joiner, zero-width space, line/paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const STRIP_COMMON =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const STRIP_INLINE = /[\n\t\r]/g;

class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

/** Text clean-up: NFC, controls and bidi overrides removed; `keepNewlines` only for code blocks. */
export function cleanRichText(value: string, keepNewlines = false): string {
  let text = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(STRIP_COMMON, "");
  if (!keepNewlines) text = text.replace(STRIP_INLINE, " ");
  else text = text.replace(/[\t]/g, "  ");
  return text;
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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    /[\u0000-\u0020\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/.test(raw)
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
  if (url.protocol === "mailto:" && url.pathname === "") return null;
  return url.href;
}

/** What a reader shows on hover for a link: the real destination host (or the mailto address). */
export function linkTargetLabel(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" ? decodeURIComponent(url.pathname) : url.host;
  } catch {
    return "";
  }
}

interface Budget {
  nodes: number;
  chars: number;
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

function cleanMarks(raw: unknown): RichMark[] {
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
      const marks = cleanMarks(node.marks);
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
      const label = cleanRichText(node.label as string).trim();
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
    const budget: Budget = { nodes: 1, chars: 0 };
    const content = cleanChildren(doc.content, "doc", (block) => cleanBlock(block, budget));
    return {
      ok: true,
      value: { schemaVersion: RICH_BODY_SCHEMA_VERSION, doc: { type: "doc", content } },
    };
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

function inlineText(node: RichInline): string {
  if (node.type === "text") return node.text;
  if (node.type === "mention") return `@${node.label}`;
  return "\n";
}

function listLines(list: RichList, indent: number): string[] {
  const lines: string[] = [];
  list.content.forEach((item, index) => {
    const marker = list.type === "orderedList" ? `${index + 1}. ` : "- ";
    let first = true;
    for (const child of item.content) {
      if (child.type === "paragraph") {
        const text = child.content.map(inlineText).join("");
        lines.push(`${" ".repeat(indent)}${first ? marker : " ".repeat(marker.length)}${text}`);
        first = false;
      } else {
        lines.push(...listLines(child, indent + 2));
      }
    }
  });
  return lines;
}

/**
 * The deterministic plain-text projection: visible text only. No JSON, no mark delimiters, no link targets, no
 * labels for anything the reader would not see. This is the ONLY form that may reach previews, search, the
 * `body` field legacy clients read, and any non-in-app channel.
 */
export function richBodyToPlainText(body: RichBody): string {
  const blocks = body.doc.content.map((block) => {
    if (block.type === "paragraph") return block.content.map(inlineText).join("");
    if (block.type === "codeBlock") return block.text;
    return listLines(block, 0).join("\n");
  });
  return blocks
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RichMentionSpan {
  readonly kind: "staff" | "patient";
  readonly entityId: string;
  readonly label: string;
  /** Offsets into `richBodyToPlainText`, covering the `@label` token (what message_entity_reference stores). */
  readonly start: number;
  readonly end: number;
}

/** Mention nodes in document order with their offsets in the plain-text projection. */
export function richBodyMentions(body: RichBody): RichMentionSpan[] {
  const spans: RichMentionSpan[] = [];
  const full = richBodyToPlainText(body);
  // Walk in the same order and with the same separators as the projection, locating each token from a cursor.
  let cursor = 0;
  const visit = (node: RichInline | RichBlock | RichListItem): void => {
    if (node.type === "text") {
      const at = full.indexOf(node.text, cursor);
      if (at >= 0) cursor = at + node.text.length;
    } else if (node.type === "mention") {
      const token = `@${node.label}`;
      const at = full.indexOf(token, cursor);
      if (at >= 0) {
        spans.push({
          kind: node.kind,
          entityId: node.entityId,
          label: node.label,
          start: at,
          end: at + token.length,
        });
        cursor = at + token.length;
      }
    } else if (node.type === "codeBlock") {
      const at = full.indexOf(node.text, cursor);
      if (at >= 0) cursor = at + node.text.length;
    } else if (node.type !== "hardBreak") {
      for (const child of node.content) visit(child);
    }
  };
  for (const block of body.doc.content) visit(block);
  return spans;
}

/** Collapse a stored body of ANY kind to the text a reader/preview may show. Unreadable rich body => "". */
export function storedBodyToPlainText(bodyKind: string, plaintext: string): string {
  if (bodyKind !== "rich") return plaintext;
  const parsed = parseStoredRichBody(plaintext);
  return parsed.ok ? richBodyToPlainText(parsed.value) : "";
}
