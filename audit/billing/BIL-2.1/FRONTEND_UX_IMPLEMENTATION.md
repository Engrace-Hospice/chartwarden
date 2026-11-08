# Frontend implementation

`claim-editor.tsx` adds a preparation panel between claim context and pricing/lines. It communicates route verification or a held route, the claim version under review, validation readiness, and that the exact payload digest is created at send time. It uses existing server detail/line projections, `role=status`/`role=alert`, and does not request or display raw X12 or protected identifiers.

The Submit action is enabled only when the claim is `ready` and the preparation projection confirms submission eligibility. The ceremony title differentiates a verified Claim.MD destination from the legacy MAC route. Existing step-up, `If-Match`, permissions and server-side submit route remain authoritative.

The broader editor already contains service lines, pricing, validation summary, claim history and replacement/void workflows; this phase adds a focused readiness layer rather than a new multi-step wizard. A retry-specific UI for preparation fetch and exact-payload digest preview remain follow-up work.
