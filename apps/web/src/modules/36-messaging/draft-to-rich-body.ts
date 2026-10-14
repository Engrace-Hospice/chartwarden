import {
  type ClinicalLinkKind,
  RICH_BODY_SCHEMA_VERSION,
  type RichBlock,
  type RichBody,
  type RichInline,
  type RichList,
  type RichListItem,
  type RichMark,
  type RichParagraph,
  safeLinkHref,
  sanitizeRichBody,
} from "@wardenx/types";
import type { MessageReferenceInput } from "./messaging-types";

/** What the body needs of a chosen clinical link: ids only. */
export interface ClinicalLinkRef {
  readonly kind: ClinicalLinkKind;
  readonly entityId: string;
}

// M36 WP 2.1 - the composer's markdown shortcuts. The textarea holds plain text; on send, the small markdown subset
// below becomes the structured body: **bold**, *italic* / _italic_, `code`, [text](https://link), "- " / "* " /
// "1. " lists and ``` fenced code. Nothing else is interpreted (no HTML, no images, no headings): everything that is
// not recognised stays literal text. The result is only a PROPOSAL - the server sanitises it again and is the
// authority. Returns null when the draft has no formatting, so unformatted messages keep going out as plain text.

type Inline = RichInline;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^\d{1,3}[.)] (.*)$/;
// An ordered run is a list only when it starts at 1; "3. text" on its own stays prose.
const ORDERED_START = /^1[.)] /;
// A fence line is the whole trimmed line: three backticks and an optional language word. Inline ```code``` is not one.
const FENCE_OPEN = /^```[\w+-]*$/;
const FENCE_CLOSE = "```";

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function withMark(marks: readonly RichMark[], mark: RichMark): RichMark[] | null {
  return marks.some((existing) => existing.type === mark.type) ? null : [...marks, mark];
}

/** Find the closing delimiter for an opener at `from`; the span must be non-empty and not padded by spaces. */
function closingIndex(text: string, from: number, delimiter: string): number {
  if (text.startsWith(" ", from)) return -1;
  let index = text.indexOf(delimiter, from + 1);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + delimiter.length];
    const padded = before === " ";
    const doubled = delimiter.length === 1 && after === delimiter;
    if (!padded && !doubled && index > from) {
      if (delimiter !== "_" || !isWordChar(after)) return index;
    }
    index = text.indexOf(delimiter, index + 1);
  }
  return -1;
}

function parseInline(text: string, marks: readonly RichMark[]): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer === "") return;
    out.push(
      marks.length > 0 ? { type: "text", text: buffer, marks } : { type: "text", text: buffer },
    );
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const wrapped = (delimiter: string, mark: RichMark, recurse: boolean): boolean => {
      if (!rest.startsWith(delimiter)) return false;
      if (delimiter === "_" && isWordChar(text[i - 1])) return false;
      const end = closingIndex(text, i + delimiter.length, delimiter);
      const nextMarks = withMark(marks, mark);
      if (end === -1 || nextMarks === null) return false;
      const inner = text.slice(i + delimiter.length, end);
      if (inner === "") return false;
      flush();
      if (recurse) out.push(...parseInline(inner, nextMarks));
      else out.push({ type: "text", text: inner, marks: nextMarks });
      i = end + delimiter.length;
      return true;
    };
    if (
      wrapped("`", { type: "code" }, false) ||
      wrapped("**", { type: "bold" }, true) ||
      wrapped("*", { type: "italic" }, true) ||
      wrapped("_", { type: "italic" }, true)
    ) {
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    const href = link ? safeLinkHref(link[2]) : null;
    const linkMarks = href ? withMark(marks, { type: "link", href }) : null;
    if (link && linkMarks) {
      flush();
      out.push(...parseInline(link[1] ?? "", linkMarks));
      i += link[0].length;
      continue;
    }
    buffer += text[i];
    i += 1;
  }
  flush();
  return out;
}

// A mention inside a line is swapped for this private-use character while the line's markdown is parsed, so a
// marker pair can span a mention (**see @Bob**) with no stray literal markers; the mention nodes are put back after.
// A U+E000 typed by the user is replaced by a space first, so it can never forge a mention.
const MENTION_SLOT = "\uE000";

/** One line of prose, with mention references (offsets into the whole draft) kept as atoms. */
function lineInlines(
  line: string,
  lineStart: number,
  references: readonly MessageReferenceInput[],
): Inline[] {
  const inside: MessageReferenceInput[] = [];
  let slotted = "";
  let cursor = 0;
  const candidates = references
    .filter((reference) => reference.start >= lineStart && reference.end <= lineStart + line.length)
    .sort((a, b) => a.start - b.start);
  for (const reference of candidates) {
    const start = reference.start - lineStart;
    if (start < cursor) continue;
    slotted += line.slice(cursor, start).replaceAll(MENTION_SLOT, " ") + MENTION_SLOT;
    inside.push(reference);
    cursor = reference.end - lineStart;
  }
  slotted += line.slice(cursor).replaceAll(MENTION_SLOT, " ");

  const out: Inline[] = [];
  for (const node of parseInline(slotted, [])) {
    if (node.type !== "text" || !node.text.includes(MENTION_SLOT)) {
      out.push(node);
      continue;
    }
    node.text.split(MENTION_SLOT).forEach((piece, index, pieces) => {
      if (piece !== "") {
        out.push(
          node.marks
            ? { type: "text", text: piece, marks: node.marks }
            : { type: "text", text: piece },
        );
      }
      const reference = index < pieces.length - 1 ? inside.shift() : undefined;
      if (reference) {
        out.push({
          type: "mention",
          kind: reference.kind,
          entityId: reference.entityId,
          label: reference.displayLabel,
        });
      }
    });
  }
  return out;
}

interface Line {
  readonly text: string;
  readonly start: number;
}

function toLines(draft: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const text of draft.split("\n")) {
    lines.push({ text, start });
    start += text.length + 1;
  }
  return lines;
}

function paragraph(
  group: readonly Line[],
  references: readonly MessageReferenceInput[],
): RichParagraph {
  const content: Inline[] = [];
  group.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...lineInlines(line.text, line.start, references));
  });
  return { type: "paragraph", content };
}

function listBlock(
  group: readonly Line[],
  kind: RichList["type"],
  references: readonly MessageReferenceInput[],
): RichList {
  const content = group.map((line): RichListItem => {
    const body = (kind === "bulletList" ? BULLET : ORDERED).exec(line.text)?.[1] ?? "";
    const offset = line.start + line.text.length - body.length;
    return { type: "listItem", content: [paragraph([{ text: body, start: offset }], references)] };
  });
  return { type: kind, content };
}

function blocksOf(draft: string, references: readonly MessageReferenceInput[]): RichBlock[] {
  const lines = toLines(draft);
  const blocks: RichBlock[] = [];
  let prose: Line[] = [];
  const endProse = (): void => {
    if (prose.length > 0) blocks.push(paragraph(prose, references));
    prose = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as Line;
    if (FENCE_OPEN.test(line.text.trim())) {
      endProse();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] as Line).text.trim() !== FENCE_CLOSE) {
        code.push((lines[i] as Line).text);
        i += 1;
      }
      blocks.push({ type: "codeBlock", text: code.join("\n") });
      continue;
    }
    const kind = BULLET.test(line.text)
      ? "bulletList"
      : ORDERED_START.test(line.text)
        ? "orderedList"
        : null;
    if (kind) {
      endProse();
      const group: Line[] = [line];
      const pattern = kind === "bulletList" ? BULLET : ORDERED;
      while (i + 1 < lines.length && pattern.test((lines[i + 1] as Line).text)) {
        i += 1;
        group.push(lines[i] as Line);
      }
      blocks.push(listBlock(group, kind, references));
      continue;
    }
    if (line.text.trim() === "") endProse();
    else prose.push(line);
  }
  endProse();
  return blocks;
}

function hasFormatting(blocks: readonly RichBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.type !== "paragraph" ||
      block.content.some((node) => node.type === "text" && (node.marks?.length ?? 0) > 0),
  );
}

/**
 * The structured body for a draft, or null when it has no formatting (send it as plain text, mentions as
 * references, exactly as before) or when the result would not pass the shared sanitiser (too large, a mention
 * without a uuid): the server's own plain-text path then applies, so no draft is ever lost to formatting.
 */
export function draftToRichBody(
  draft: string,
  references: readonly MessageReferenceInput[],
  links: readonly ClinicalLinkRef[] = [],
): RichBody | null {
  const textBlocks = blocksOf(draft.replace(/\r\n?/g, "\n"), references);
  // WP 3.2: chosen links ride in a trailing paragraph of `clinicalLink` nodes (ids only; the server validates each).
  const blocks: RichBlock[] =
    links.length === 0
      ? textBlocks
      : [
          ...textBlocks,
          {
            type: "paragraph",
            content: links.map(({ kind, entityId }) => ({ type: "clinicalLink", kind, entityId })),
          },
        ];
  if (links.length === 0 && !hasFormatting(blocks)) return null;
  const checked = sanitizeRichBody({
    schemaVersion: RICH_BODY_SCHEMA_VERSION,
    doc: { type: "doc", content: blocks },
  });
  return checked.ok ? checked.value : null;
}
