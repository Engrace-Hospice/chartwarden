// apps/backend/src/modules/19-oncall/routes/page-sizes.ts — the §4.1.1 list routes' page sizes, verbatim.
// The keyset cursor, `?offset=` refusal and `If-Match`/`Idempotency-Key` guards are the shared route kit's.
import type { PageSizePolicy } from "@chartwarden/shared/route-kit";

export const M19_PAGE_SIZES = {
  triageCalls: { defaultSize: 25, maxSize: 100 },
  escalations: { defaultSize: 25, maxSize: 100 },
  shifts: { defaultSize: 50, maxSize: 200 },
  protocols: { defaultSize: 50, maxSize: 200 },
  portalRecent: { defaultSize: 10, maxSize: 30 },
} as const satisfies Record<string, PageSizePolicy>;
