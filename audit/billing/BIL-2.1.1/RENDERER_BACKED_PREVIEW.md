# Renderer-backed preview

`GET /api/v1/billing/claims/:id/preparation` continues to use the existing read authorization (`billing.claim.read` plus claim caseload/provider ABAC). The composition root injects an M23 preview callback. It opens an organization-scoped transaction, resolves the same admission, patient, address, provider, EDI profile and payer readers as the submit renderer, then calls `renderClaim837iPreview`.

The helper runs `loadAndRender837i` and the established 837I mapper/builder. It supplies preview-only envelope values (interchange number `1` and the preview clock); it does not reserve an attempt or enqueue work. The rendered `SensitiveValue` is never revealed by this helper. The HTTP projection consists of TOB, service period, rendered service-line summaries, diagnosis codes, totals, and safe validation gaps. `payloadDigest` remains null with `not_available_from_read_projection`: the final outbound bytes include attempt/envelope values that only exist at send time.

This establishes renderer-backed previewability, not byte identity or a source-staleness guarantee. The route may say renderer `blocked` and keeps submission ineligible when the renderer cannot build the claim.
