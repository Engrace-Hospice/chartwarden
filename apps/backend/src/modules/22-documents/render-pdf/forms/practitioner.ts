// apps/backend/src/modules/22-documents/render-pdf/forms/practitioner.ts - how a physician prints on an order:
// "Dr. Imani Okafor, MD (NPI 1234567893)". Pure; shared by the order forms.
import type { RenderPractitioner } from "@wardenx/types";

export function practitionerLine(p: RenderPractitioner | null): string {
  if (p === null) return "Not recorded";
  const who = [p.name, p.credentials].filter((v) => v !== null && v !== "").join(", ");
  return p.npi ? `${who} (NPI ${p.npi})` : who;
}
