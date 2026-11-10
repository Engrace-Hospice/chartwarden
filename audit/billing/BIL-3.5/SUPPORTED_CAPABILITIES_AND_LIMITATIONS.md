# Supported capabilities and limitations

## Proven narrow case

One staged, ownership-verified synthetic commercial ERA; one verified M41 claim and actual historical sent submission; positive payment equal to charge; zero patient responsibility; no CAS, remarks, service-line facts, PLB, reversal, recoupment, or unknown segments. Plan, distinct approval, and explicit execution produce one M25 remittance line and transactional outbox events.

## Intentionally blocked

Multiple claims; partial or zero payment; patient responsibility; CAS/other adjustments; PLB; service-line adjudication; unsupported remarks/segments; reversal/recoupment; ambiguous or unmatched claims; missing historical source evidence; Medicare posting; payer-specific unverified semantics. These remain reviewable/held where the existing M25 review permits, but do not partially post.

M25 posting is not bank-deposit confirmation. M23/M24/M26 downstream consumers run asynchronously. Cross-source legacy intake after a Claim.MD stage is blocked before advice creation; legacy-first plan refusal is enforced but not separately integration-tested in this run.
