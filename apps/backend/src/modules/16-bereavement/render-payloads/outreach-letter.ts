// apps/backend/src/modules/16-bereavement/render-payloads/outreach-letter.ts — ADR-0109 D2.
//
// Which M22 template a started LETTER touchpoint renders under, and the content it ships. The condolence, sympathy and anniversary letters
// share the generic `bereavement_letter` template (the outreach kind rides the content blob). The day-390 `closeout_letter` floor item is a
// different letter — it ENDS the program — so it renders under `bereavement_closeout_letter` with a typed payload. Both file under the
// `bereavement_letter` aggregate type with the OUTREACH as the aggregate, so M16's `m22.document.rendered` back-ref stamps either one.
import {
  BEREAVEMENT_CLOSEOUT_LETTER_TEMPLATE_KEY,
  type BereavementCloseoutLetterRenderPayload,
} from "@chartwarden/types";

/** GAP-130 / D14 — M22's published bereavement-letter template key (`22-documents/seams/renderer.ts`). */
export const BEREAVEMENT_LETTER_TEMPLATE_KEY = "bereavement_letter";

/** The `bereavement_outreach.cadence_mark` of the closeout letter floor item. */
const CLOSEOUT_CADENCE_MARK = "closeout_letter";

export interface OutreachLetterFacts {
  readonly kind: string;
  readonly cadenceMark: string | null;
  readonly anniversaryMark: string | null;
  readonly dueAt: Date;
}

export interface OutreachLetterRequest {
  readonly templateKey: string;
  readonly payloadJsonb: Record<string, unknown>;
}

/** The template and content a started letter touchpoint requests. Pure. `plan.deathDate` is the local `YYYY-MM-DD`. */
export function outreachLetterRequestOf(
  outreach: OutreachLetterFacts,
  plan: { readonly deathDate: string },
): OutreachLetterRequest {
  if (outreach.cadenceMark === CLOSEOUT_CADENCE_MARK) {
    const payload: BereavementCloseoutLetterRenderPayload = {
      cadenceMark: CLOSEOUT_CADENCE_MARK,
      outreachKind: outreach.kind,
      deathDate: plan.deathDate,
      dueAt: outreach.dueAt.toISOString(),
    };
    return { templateKey: BEREAVEMENT_CLOSEOUT_LETTER_TEMPLATE_KEY, payloadJsonb: payload };
  }
  return {
    templateKey: BEREAVEMENT_LETTER_TEMPLATE_KEY,
    payloadJsonb: {
      outreachKind: outreach.kind,
      anniversaryMark: outreach.anniversaryMark,
      deathDate: plan.deathDate,
      dueAt: outreach.dueAt.toISOString(),
    },
  };
}
