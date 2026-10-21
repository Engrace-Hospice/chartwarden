// apps/backend/src/modules/23-billing-medicare/services/rhc-carry-over-stored.ts
//
// READ-TIME normalization of a persisted `per_diem_rate_calculation.rhc_carry_over` (migration 0376). The row is an
// append-only pricing snapshot — M23 spec §3.6 / D7 and migration 0079's `trg_append_only_per_diem_rate_calculation`
// (BEFORE UPDATE OR DELETE → M23_TABLE_APPEND_ONLY); a correction is a TOB 817 replacement claim with a NEW row —
// and its INSERT is the audit evidence of what the claim was priced with. So rows written under an older span
// vocabulary are never relabelled in place: the claim detail maps them to the current display here instead.
//
// THE ONE DRIFT (the stored shape is otherwise unchanged since 0376): between 981ece675 and 16dea2298 a
// transfer-in's sending-hospice span was stored as `{ source: "internal", kind: "stay" }` — the same kind as one
// of our own stays (only `hospiceNpi` differed, and only when the NPI was captured). Rows priced before 981ece675
// never held a sending span (those days were not counted), so they need nothing. An old internal `stay` is the
// sending hospice's when
//   1. it carries a hospice NPI — our own stays are always stored with `hospiceNpi: null`; or
//   2. its `ref` is the claim's own admission — the prior stays are OTHER admissions, so the only span of the
//      priced admission is its own transfer-in's sending span; or
//   3. another internal `stay` has the same `ref` and starts later — an admission contributes at most its own
//      stay plus its transfer-in's sending span, which ends on the transfer day the stay starts on.
// Never mutates the stored value; a value that is not a carry-over object reads as null ("not recorded").
import type { RhcCountedSpan } from "@chartwarden/billing";
import type { RhcCarryOverView } from "./rhc-carry-over-view";

type SpanKind = RhcCountedSpan["kind"];
const KINDS: readonly SpanKind[] = ["stay", "sending_hospice", "election", "benefit_period"];

/** The claim the stored carry-over belongs to. */
export interface StoredRhcCarryOverContext {
  readonly admissionId: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A kind outside today's vocabulary reads by its source (ours → a stay; HETS → a billed period, or NOE). */
function knownKind(span: Record<string, unknown>): SpanKind {
  const kind = span.kind;
  if (typeof kind === "string" && (KINDS as readonly string[]).includes(kind)) {
    return kind as SpanKind;
  }
  if (span.source !== "hets") return "stay";
  return kind === "noe" ? "election" : "benefit_period";
}

/** Rule 3: the ref → start of the LATEST internal `stay` of each admission (any earlier one is its sending span). */
function latestStayStartByRef(chain: readonly Record<string, unknown>[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const s of chain) {
    if (s.source !== "internal" || knownKind(s) !== "stay" || typeof s.ref !== "string") continue;
    const start = String(s.start);
    const seen = latest.get(s.ref);
    if (seen === undefined || start > seen) latest.set(s.ref, start);
  }
  return latest;
}

function isOldSendingSpan(
  span: Record<string, unknown>,
  ctx: StoredRhcCarryOverContext,
  latestStart: ReadonlyMap<string, string>,
): boolean {
  if (span.source !== "internal" || knownKind(span) !== "stay") return false;
  if (typeof span.hospiceNpi === "string" && span.hospiceNpi !== "") return true;
  if (typeof span.ref !== "string") return false;
  if (span.ref === ctx.admissionId) return true;
  const latest = latestStart.get(span.ref);
  return latest !== undefined && String(span.start) < latest;
}

/** The stored carry-over in today's vocabulary (a new object; the stored value is never touched). */
export function normalizeStoredRhcCarryOver(
  raw: unknown,
  ctx: StoredRhcCarryOverContext,
): RhcCarryOverView | null {
  if (!isRecord(raw) || !Array.isArray(raw.chain)) return null;
  const chain = raw.chain.filter(isRecord);
  const latestStart = latestStayStartByRef(chain);
  return {
    ...raw,
    chain: chain.map((s) => ({
      ...s,
      kind: isOldSendingSpan(s, ctx, latestStart) ? "sending_hospice" : knownKind(s),
    })),
  } as unknown as RhcCarryOverView;
}
