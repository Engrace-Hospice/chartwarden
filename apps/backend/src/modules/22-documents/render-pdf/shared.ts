// apps/backend/src/modules/22-documents/render-pdf/shared.ts — small tolerant readers + formatters shared by
// the template builders. Render payloads arrive as `unknown` off the outbox (`Type.Unknown()` in the M14
// catalog), so every accessor degrades to "absent" rather than throwing: a malformed field must never turn
// into a retry-then-DLQ render loop for a compliance document.

export type Rec = Readonly<Record<string, unknown>>;

export const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const rec = (v: unknown): Rec => (isRec(v) ? v : {});
export const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
export const bool = (v: unknown): boolean => v === true;

const LOWER_WORDS = new Set(["of", "and", "to", "for", "in", "on"]);
const UPPER_WORDS = new Set([
  "idg",
  "hope",
  "sfv",
  "f2f",
  "loc",
  "dpoa",
  "sud",
  "rn",
  "msw",
  "md",
  "np",
  "cfr",
  "cti",
  "nor",
]);

/** `snake_case` / `kebab-case` -> "Title Case" ("md_np" -> "MD NP", "missed_dose" -> "Missed Dose"). */
export function humanize(v: unknown): string {
  const s = str(v);
  if (s === undefined) return "-";
  return s
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 0)
    .map((w) =>
      UPPER_WORDS.has(w.toLowerCase())
        ? w.toUpperCase()
        : LOWER_WORDS.has(w.toLowerCase())
          ? w.toLowerCase()
          : w[0]?.toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

/** "2026-09-30T14:05:00.000Z" -> "2026-09-30 14:05 UTC" (deterministic; never the viewer's locale/zone). */
export function fmtInstant(v: unknown): string {
  const s = str(v);
  if (s === undefined) return "-";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function fmtDate(v: unknown): string {
  const s = str(v);
  if (s === undefined) return "-";
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : s;
}

/** Short opaque reference for an id that has no display name in the payload ("a1b2c3d4"). */
export const shortId = (v: unknown): string => {
  const s = str(v);
  return s === undefined ? "-" : s.slice(0, 8);
};

export const PART2_WITHHELD = "Withheld — 42 CFR Part 2";

/** Discipline keys the packet uses (§2.5) plus the free-form `discipline` strings the meeting records. */
const DISCIPLINE_LABELS: Readonly<Record<string, string>> = {
  rn: "Registered Nurse (RN)",
  msw: "Social Work (MSW)",
  chaplain: "Spiritual Care (Chaplain)",
  aide: "Hospice Aide",
  md_np: "Physician / Nurse Practitioner",
  volunteer: "Volunteer Coordinator",
  medical_director: "Medical Director",
};
export const disciplineLabel = (v: unknown): string => {
  const s = str(v);
  return s === undefined ? "-" : (DISCIPLINE_LABELS[s] ?? humanize(s));
};
