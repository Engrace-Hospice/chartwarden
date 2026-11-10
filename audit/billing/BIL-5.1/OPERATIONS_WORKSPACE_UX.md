# Operations workspace UX

The new entry point reuses `apps/web/src/modules/23-billing-medicare/screens.ts` and the existing `BillingTabs`; `/billing/queue` and module workbenches remain available. The page has provider/location context, source filters, an attention toggle, source summaries, a compact financial worklist, source-specific links, refresh, and independent source-page continuation.

Each source remains separately identified as M23, M24, M25 or M41. The amount column labels ERA payment versus billed claim charge. It does not call an ERA posted, a claim paid, or a bank deposit settled based on a generic display state. Posting controls are absent.

The summary is intentionally labelled as counts on loaded pages. The worklist fetches a bounded 30 items from each owner API and advances each owner cursor independently. A denied or failed owner is shown as unavailable; its count is `—`, not zero. `Needs attention` is a presentation filter over loaded rows, not a server-wide count.

Responsive table overflow remains scrollable on narrow screens; dedicated mobile cards, date/payer filters across all claim modules, global search, and a global cross-source cursor are not part of this increment.
