// apps/backend/src/modules/22-documents/render-pdf/generic-payload-doc.ts — the structured fallback renderer
// (GAP-033). A template with no bespoke builder used to be written as JSON behind a "%PDF" header: a file with a
// .pdf name, a PDF mime type and a content hash that no PDF reader could open. Instead it now renders its typed
// payload as a REAL, valid, byte-deterministic PDF: labelled facts for scalars, a sub-heading per nested object,
// bullets for scalar lists and a table for lists of records. That is the payload laid out readably, not a
// bespoke form layout - a template earns its own layout by registering a builder in registry.ts.
import type { Block, DocModel } from "./doc-model";
import { latestInstant } from "./doc-model";
import { arr, humanize, isRec, shortId, str } from "./shared";

const MAX_DEPTH = 3;
const MAX_BLOCKS = 400;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 6;
const MAX_VALUE_CHARS = 2000;
/** Render plumbing the consumer adds to every payload; not content a reader needs on the page. */
const HIDDEN_KEYS: ReadonlySet<string> = new Set([
  "sourceEventId",
  "retentionClassOverride",
  "sudRedacted",
  "isSudClass",
  "aggregateId",
  "title",
]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type Row = readonly [label: string, value: string];

function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string")
    return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}...` : v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return null;
}

function compact(v: unknown): string {
  const s = scalar(v);
  if (s !== null) return s;
  const json = JSON.stringify(v) ?? "";
  return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}...` : json;
}

function tableOf(items: readonly Record<string, unknown>[]): Block {
  const keys: string[] = [];
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      if (!keys.includes(k) && !HIDDEN_KEYS.has(k) && v !== null && v !== undefined) keys.push(k);
    }
  }
  const shown = keys.slice(0, MAX_TABLE_COLUMNS);
  return {
    kind: "table",
    columns: shown.map((k) => ({ header: humanize(k), weight: 1 })),
    rows: items.slice(0, MAX_TABLE_ROWS).map((item) => shown.map((k) => compact(item[k] ?? ""))),
    emptyText: "None.",
  };
}

function blocksOf(obj: Readonly<Record<string, unknown>>, depth: number): Block[] {
  const out: Block[] = [];
  const facts: Row[] = [];
  const flushFacts = () => {
    if (facts.length > 0) out.push({ kind: "facts", rows: [...facts] });
    facts.length = 0;
  };
  for (const [key, value] of Object.entries(obj)) {
    if (HIDDEN_KEYS.has(key) || value === null || value === undefined) continue;
    const s = scalar(value);
    if (s !== null) {
      facts.push([humanize(key), s]);
      continue;
    }
    flushFacts();
    out.push({ kind: "heading", level: depth === 0 ? 1 : 2, text: humanize(key) });
    if (Array.isArray(value)) {
      const items = arr(value);
      if (items.every(isRecord)) out.push(tableOf(items as Record<string, unknown>[]));
      else out.push({ kind: "bullets", items: items.map(compact) });
    } else if (isRec(value) && depth + 1 < MAX_DEPTH) {
      out.push(...blocksOf(value, depth + 1));
    } else {
      out.push({ kind: "paragraph", text: compact(value) });
    }
  }
  flushFacts();
  return out;
}

const isRecord = (v: unknown): boolean => isRec(v);

function instantsIn(obj: Readonly<Record<string, unknown>>): string[] {
  return Object.values(obj).filter(
    (v): v is string => typeof v === "string" && ISO_INSTANT.test(v),
  );
}

/** Builds the fallback document for a template that has no bespoke layout. Never throws on a payload shape. */
export function buildGenericPayloadDoc(defaultTitle: string): (payload: unknown) => DocModel {
  return (payload) => {
    const p = isRec(payload) ? payload : {};
    // The VISIBLE heading may use a payload title; the PDF /Title and the footer label on every page are the
    // template's constant, PHI-free default (a payload title can carry a patient's name).
    const heading = str(p.title) ?? defaultTitle;
    const title = defaultTitle;
    const body = blocksOf(p, 0);
    const blocks: Block[] = [
      { kind: "title", text: heading, subtitle: `Reference ${shortId(p.aggregateId)}` },
      ...body.slice(0, MAX_BLOCKS),
    ];
    if (body.length > MAX_BLOCKS)
      blocks.push({
        kind: "paragraph",
        muted: true,
        text: "Additional content was omitted for length.",
      });
    return { title, createdAtIso: latestInstant(instantsIn(p)), blocks };
  };
}
