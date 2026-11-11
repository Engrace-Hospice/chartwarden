# BIL-2.1.1 — Renderer-backed Medicare preview

## Result

The existing preparation route now invokes the M23 claim-to-837I loader and renderer using the same source readers as the submission worker. It returns only a structured billing projection and field/reason validation gaps; it never returns the protected MBI, provider TIN, raw X12, or a claimed final-byte digest. MBI unlock has a separate audited purpose, `claim_837i_preview`.

This is a partial completion. The route still reports the claim row version and verified payer-route state, and submit retains its existing `If-Match` and route-fingerprint checks. There is not yet an opaque preview confirmation token spanning claim, coverage, provider identity, route and rendering inputs, nor does the queued worker compare a reviewed source snapshot before sending. Therefore BIL-2.1.1 is **NO-GO as a complete stale-source guard**; the API must not be described as a final immutable preview.

No claim was transmitted, no worker or feature flag was activated, and no migration was run.

## Evidence

- Renderer path: `apps/backend/src/modules/23-billing-medicare/services/claim-837i-loader.ts`.
- Route projection and boot binding: `apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts`, `routes/index.ts`, `routes/mount.ts`, and `apps/backend/src/index.ts`.
- Safe editor summary: `apps/web/src/modules/23-billing-medicare/claim-editor.tsx`.
- MBI purpose allowlist: `packages/types/src/patient.ts`.

See [renderer contract](RENDERER_BACKED_PREVIEW.md), [MBI security](MBI_DISCLOSURE_AND_SECURITY.md), and [remaining blockers](REMAINING_BLOCKERS.md).
