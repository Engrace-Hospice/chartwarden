# Remaining blockers

## P1 — Exact pre-submit payload preview is incomplete

The preparation API returns authoritative claim/line reads and route readiness, but does not render and hash the final 837I. It explicitly returns a null digest. A renderer-backed preview needs a separately audited MBI disclosure purpose, source-version fingerprint, and a submit-time stale-preview check. Until then the UI must continue describing the digest as send-time evidence only.

## P1 — Vendor route mapping not externally certified

No Claim.MD payer identifier was invented or tested. Platform operations must populate `CLAIMMD_M23_PAYER_ROUTES` from authoritative vendor/payer configuration and verify it against an active M40 payer entry, exact Claim.MD account reference and test/production usage. No controlled or production route activation is authorized.

## P2 — Configuration audit and location nuance

Route edits are deployment configuration changes, not append-only application audit records. M23 claims do not currently persist a location ID, so route resolution uses provider entity + MAC. Introduce location as a key only after source domain cardinality and claim snapshot semantics are established.

## P2 — Repository-wide validation debt outside M23

The web TypeScript project check remains red on M16 bereavement API/generated-client and implicit-any diagnostics; the final check reports no error in the changed M23 editor. `arch:openapi-coverage` remains red on two M25 and two bootstrap coverage gaps unrelated to the enriched M23 preparation endpoint. These should be corrected in their owning workstreams and are not evidence that this M23 route has a missing OpenAPI entry.

## Not changed

No notice behavior, M41/M24/M25 behavior, Claim.MD worker flags or automatic ERA posting was changed.
