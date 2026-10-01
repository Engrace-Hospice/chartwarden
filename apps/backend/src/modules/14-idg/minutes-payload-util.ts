// apps/backend/src/modules/14-idg/minutes-payload-util.ts — tolerant readers for the untyped jsonb payloads the
// render-context builders walk (a malformed stored payload must degrade to "absent", never throw at emit time).
export type Rec = Readonly<Record<string, unknown>>;
export const asRec = (v: unknown): Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {};
export const asArr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
export const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
