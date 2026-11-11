# Filtering and pagination

The list accepts `state`, `payer`, `fromDate`, `toDate`, provider filter (still constrained by authenticated scope), `limit` and `cursor`. Organization/provider and filters are applied before stable `(createdAt DESC, id DESC)` keyset traversal. Date filters apply to staging creation day. Payer name/identifier is protected detail, so matching decrypts at most 500 tenant-scoped summaries per request; `searchWindowLimited` indicates more older stages may remain. Cursors never supply tenant scope and are reset by UI filter changes. Page size remains capped at 100.
