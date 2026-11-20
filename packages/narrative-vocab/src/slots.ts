// packages/narrative-vocab/src/slots.ts — slot-value and exclusive-statement validation (WF09 step 1).
//
// Pure functions over the corpus; no IO and no assembly logic (that stays in `@chartwarden/hearthnote`).
// The M8 service runs `validateSelectionTree` on every write that stores selections, so the rule holds
// for any client, not just the composer UI.
import type { SlotSpec, VocabEntry } from "./types";
import { VOCABULARY } from "./vocabulary";

const BY_CODE: ReadonlyMap<string, VocabEntry> = new Map(VOCABULARY.map((e) => [e.code, e]));

/** Slots the assembly context fills itself; a clinician is never asked for them. */
const CONTEXT_SLOTS: ReadonlySet<string> = new Set(["patient", "serviceDate"]);

/** Longest free-text slot value accepted (these are short phrases, not prose — prose is sealed elsewhere). */
export const MAX_TEXT_SLOT_LENGTH = 200;

/** The `${…}` placeholders a phrase interpolates, minus the two the assembly context always supplies. */
export function entrySlots(entry: Pick<VocabEntry, "phrase">): string[] {
  const found = new Set<string>();
  for (const m of entry.phrase.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
    const slot = m[1] as string;
    if (!CONTEXT_SLOTS.has(slot)) found.add(slot);
  }
  return [...found];
}

export type SelectionIssueCode =
  | "SLOT_INVALID"
  | "SLOT_INCOMPLETE"
  | "SLOT_UNKNOWN"
  | "EXCLUSIVE_CONFLICT";

/** One reason a selection tree cannot be stored (or finalized). `sectionId` is the field the UI points at. */
export interface SelectionIssue {
  readonly code: SelectionIssueCode;
  readonly sectionId: string;
  readonly entryCode: string;
  readonly slot?: string;
  readonly message: string;
}

/** The structural slice of a selection tree this module reads (assignable from the M8 / hearthnote shapes). */
export interface SelectionTreeInput {
  readonly sectionId: string;
  readonly entries: readonly {
    readonly code: string;
    readonly params?: Readonly<Record<string, string | number>>;
  }[];
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function isAbsent(v: string | number | undefined): boolean {
  return v === undefined || (typeof v === "string" && v.trim() === "");
}

function toNumber(v: string | number): number {
  if (typeof v === "number") return v;
  const t = v.trim();
  return NUMERIC.test(t) ? Number(t) : Number.NaN;
}

function humanize(slot: string): string {
  const spaced = slot.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function slotLabel(slot: string, spec: SlotSpec | undefined): string {
  return spec?.label ?? humanize(slot);
}

/** The message for a PRESENT value that breaks its spec, or `null` when it is fine. */
function invalidReason(
  slot: string,
  spec: SlotSpec | undefined,
  v: string | number,
): string | null {
  const label = slotLabel(slot, spec);
  if (spec === undefined) {
    return String(v).length > MAX_TEXT_SLOT_LENGTH
      ? `${label} must be ${MAX_TEXT_SLOT_LENGTH} characters or fewer.`
      : null;
  }
  if (spec.kind === "choice") {
    return spec.options.includes(String(v))
      ? null
      : `${label} must be one of: ${spec.options.join(", ")}.`;
  }
  const n = toNumber(v);
  const inRange = Number.isFinite(n) && n >= spec.min && n <= spec.max;
  if (inRange && (spec.kind === "number" || Number.isInteger(n))) return null;
  const kind = spec.kind === "integer" ? "a whole number" : "a number";
  return `${label} must be ${kind} from ${spec.min} to ${spec.max}${spec.unit ? ` ${spec.unit}` : ""}.`;
}

/**
 * Everything wrong with a selection tree, or `[]`.
 *
 * `requireComplete: false` is the DRAFT rule: a present value must be valid, but an empty one is allowed so a
 * clinician can save half-way. `requireComplete: true` is the FINALIZE rule: every slot of every selected
 * statement must also be filled, because an empty slot assembles into "has  dependent edema".
 *
 * An unknown code is skipped — assembly already owns `UNKNOWN_VOCAB_CODE`.
 */
export function validateSelectionTree(
  sections: readonly SelectionTreeInput[],
  options: { readonly requireComplete: boolean },
): SelectionIssue[] {
  const issues: SelectionIssue[] = [];
  const groupOwner = new Map<string, VocabEntry>();
  for (const section of sections) {
    for (const selected of section.entries) {
      const entry = BY_CODE.get(selected.code);
      if (entry === undefined) continue;
      const at = { sectionId: section.sectionId, entryCode: entry.code };

      const group = entry.exclusiveGroup;
      const owner = group === undefined ? undefined : groupOwner.get(group);
      if (group !== undefined && owner === undefined) groupOwner.set(group, entry);
      if (owner !== undefined && owner.code !== entry.code) {
        issues.push({
          ...at,
          code: "EXCLUSIVE_CONFLICT",
          message: `"${entry.label}" contradicts "${owner.label}", which is already in this note.`,
        });
      }

      // A param is a value for ONE of the statement's own `${slot}`s. Any other key (a context slot such as `patient` or
      // `serviceDate` included, which `entrySlots` never lists) is refused: it would be dead text at best and, for a context
      // slot, a way to replace what the assembly itself supplies.
      const declared = entrySlots(entry);
      for (const key of Object.keys(selected.params ?? {})) {
        if (declared.includes(key)) continue;
        issues.push({
          ...at,
          slot: key,
          code: "SLOT_UNKNOWN",
          message: `"${entry.label}" has no "${key}" value to fill.`,
        });
      }

      for (const slot of declared) {
        const spec = entry.slotSpecs?.[slot];
        const value = selected.params?.[slot];
        if (value === undefined || isAbsent(value)) {
          if (options.requireComplete) {
            const message = `${slotLabel(slot, spec)} is required.`;
            issues.push({ ...at, slot, code: "SLOT_INCOMPLETE", message });
          }
          continue;
        }
        const reason = invalidReason(slot, spec, value);
        if (reason !== null) issues.push({ ...at, slot, code: "SLOT_INVALID", message: reason });
      }
    }
  }
  return issues;
}
