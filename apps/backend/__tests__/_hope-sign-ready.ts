// apps/backend/__tests__/_hope-sign-ready.ts — the ONE shared "complete this HOPE draft until the server
// says it is sign-ready" helper for the live suites (m10-hope-write, -answer-engine, -record-initialization).
//
// `signTimepoint` refuses (HopeAssessmentNotReadyToSignError) any record whose active, applicable items are
// unanswered or that carries an error finding. Two kinds of blocker need different handling, exactly as they
// do for a clinician in the workspace:
//
//  1. UNANSWERED_APPLICABLE_ITEM — filled generically (first CMS option, a date, or text).
//  2. The CMS "select all that apply" checklists. A1005 (ethnicity, rule -3080), A1010 (race, rule -3090) and
//     A1400 (payer, rule -3081) each require AT LEAST ONE box checked. Those items are deliberately NOT
//     UNANSWERED blockers (CHECKLIST_GROUP_ITEMS in the v1.00.1 validation engine, 2ca1e875), so the generic
//     loop can never satisfy them: answering every box "0" (the old first-option behaviour) is now a
//     VALIDATION_ERROR. The helper therefore checks ONE real CMS value per group and writes the group's other
//     applicable boxes as "0", which is what the web TileGroup does on a click (hope-assessment-detail.tsx).
//     A group the record already carries a "1" in (admission prefill from M5 demographics, or a caller
//     override) is left alone, so this never creates the -3080/-3090 mutual-exclusivity conflict.
import type { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";

type HopeSvc = ReturnType<typeof createDbHopeBackend>;

/** Items the workflow owns (A0050 type-of-record, J2052/J2053 SFV outputs, ...) — never generically answered. */
// (A0600A is answered up front in `answerHopeForSign` with a valid SSN; it is not a generic text item.)
export const HOPE_WORKFLOW_ITEMS = /^(A0050|A0220|A0250|A0270|J2052[A-C]|J2053[A-H]|Z0350|Z0500B)$/;

/** Required-at-least-one checklists: [stem, the real CMS value we check when the record has none]. */
const CHECKLIST_GROUPS: ReadonlyArray<readonly [stem: string, pick: string]> = [
  ["A1005", "A1005A"], // Ethnicity: No, not Hispanic, Latino/a, or Spanish origin
  ["A1010", "A1010B"], // Race: Black or African American
];

const GENERIC_SKIP_CODES = ["Text", "YYYYMMDD", "YYYYMM", "YYYY", "^", "-"];

export interface HopeSignReadyDeps {
  readonly svc: HopeSvc;
  readonly orgId: string;
  readonly membershipId: string;
  /** The date every generic date answer gets (the draft's target date). */
  readonly answerDate: string;
}

export async function answerHopeForSign(
  deps: HopeSignReadyDeps,
  id: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const { svc, orgId, membershipId } = deps;
  const patch = async (changes: Record<string, string>) => {
    const ws = await svc.getAssessmentWorkspace(orgId, id);
    await svc.patchAssessmentAnswers(orgId, membershipId, id, {
      ifVersion: ws.assessment.version,
      changes: Object.entries(changes).map(([itemCode, value]) => ({
        itemCode,
        action: "set" as const,
        value,
      })),
    });
  };

  // A1400A (Medicare payer) satisfies CMS rule -3081 unless the caller picks a payer itself.
  // A0600A (SSN) is a free-text item the generic loop would fill with "Test", which the CMS fatal SSN format
  // edits (-3015 digits only, -3001 nine digits, -3003 placeholder numbers) now reject: answer a real-shaped,
  // non-placeholder number unless the caller supplies one.
  const first: Record<string, string> = { A1400A: "1", A0600A: "492817365", ...overrides };
  {
    const ws = await svc.getAssessmentWorkspace(orgId, id);
    const items = ws.sections.flatMap((s) => s.items);
    for (const [stem, pick] of CHECKLIST_GROUPS) {
      const group = items.filter(
        (i) => /^A\d{4}[A-Z]$/.test(i.itemCode) && i.itemCode.startsWith(stem),
      );
      const applicable = group.filter((i) => i.applicability === "applicable");
      const alreadyChecked =
        applicable.some((i) => String(i.value ?? "") === "1") ||
        Object.entries(first).some(([code, v]) => code.startsWith(stem) && v === "1");
      if (alreadyChecked || !applicable.some((i) => i.itemCode === pick)) continue;
      for (const i of applicable) {
        if (first[i.itemCode] === undefined) first[i.itemCode] = i.itemCode === pick ? "1" : "0";
      }
    }
  }
  await patch(first);

  for (let round = 0; round < 6; round++) {
    const review = await svc.getAssessmentReview(orgId, id);
    if (review.readiness.readyToSign) return;
    const ws = await svc.getAssessmentWorkspace(orgId, id);
    const items = new Map(ws.sections.flatMap((s) => s.items).map((i) => [i.itemCode, i]));
    const changes: Record<string, string> = {};
    for (const b of review.readiness.blockers) {
      if (b.code !== "UNANSWERED_APPLICABLE_ITEM" || !b.itemCode) continue;
      if (HOPE_WORKFLOW_ITEMS.test(b.itemCode)) continue;
      const item = items.get(b.itemCode);
      if (!item) continue;
      const codes = [...item.options]
        .sort((x, y) => x.sortOrder - y.sortOrder)
        .map((o) => o.valueCode);
      const real = codes.filter((c) => !GENERIC_SKIP_CODES.includes(c));
      changes[b.itemCode] =
        codes.includes("YYYYMMDD") || /date/i.test(item.cmsItemTypeCode)
          ? deps.answerDate
          : codes.includes("Text")
            ? "Test"
            : (real[0] ?? "0");
    }
    if (Object.keys(changes).length === 0) {
      throw new Error(`HOPE ${id} is not sign-ready: ${JSON.stringify(review.readiness.blockers)}`);
    }
    await patch(changes);
  }
  throw new Error(`HOPE ${id} did not reach sign readiness`);
}
